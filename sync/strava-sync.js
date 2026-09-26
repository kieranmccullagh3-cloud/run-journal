#!/usr/bin/env node
/* strava-sync.js — fetch Strava activities and upsert them into a CSV (one row per activity).

   Usage:  node sync/strava-sync.js [--csv PATH] [--backfill-days N] [--max N]
   Credentials come from ~/.config/run-journal/strava.json, created by `node sync/setup.js`.
   Designed to run unattended (launchd) twice a day; safe to run by hand at any time. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const J = require('../journal.js');
const CSV = require('./csv.js');
const { COLUMNS, toRecord, isRun } = require('./record.js');

const DEFAULTS = {
  csvPath: path.join(os.homedir(), 'Documents', 'jarvis-inputs', 'strava', 'activities.csv'),
  credsPath: path.join(os.homedir(), '.config', 'run-journal', 'strava.json'),
  backfillDays: 90,   // how far back the very first sync reaches
  refreshDays: 3,     // recent activities are re-fetched each run to pick up edits (RPE, title)
  maxPerRun: 40,      // ~2 Strava requests per run activity; keeps a run under the 100 per 15 min read limit
};
const STREAM_KEYS = 'time,distance,altitude,heartrate,cadence,moving';

class AuthError extends Error {}
class RateLimitError extends Error {}

// ---------- credentials ----------
function readCreds(p) {
  let c;
  try { c = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { throw new AuthError(`No credentials at ${p}. Run: node sync/setup.js`); }
  if (!c.client_id || !c.client_secret || !c.refresh_token) throw new AuthError(`Incomplete credentials in ${p}. Run: node sync/setup.js`);
  return c;
}
function writeCreds(p, c) {
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, p);
}

// ---------- strava client ----------
function stravaClient(fetchImpl, credsPath, log) {
  let creds = readCreds(credsPath);
  let requests = 0;

  async function token() {
    if (creds.access_token && creds.expires_at && creds.expires_at - 120 > Date.now() / 1000) return creds.access_token;
    const body = new URLSearchParams({ client_id: creds.client_id, client_secret: creds.client_secret, grant_type: 'refresh_token', refresh_token: creds.refresh_token });
    const r = await fetchImpl('https://www.strava.com/oauth/token', { method: 'POST', body });
    if (r.status === 400 || r.status === 401) throw new AuthError('Strava refused the refresh token (it may have been replaced by a newer sign-in). Run: node sync/setup.js');
    if (!r.ok) throw new Error(`Strava token refresh failed (${r.status})`);
    const j = await r.json();
    creds = Object.assign({}, creds, { access_token: j.access_token, refresh_token: j.refresh_token || creds.refresh_token, expires_at: j.expires_at });
    writeCreds(credsPath, creds); // Strava may rotate the refresh token; the newest one must be kept
    return creds.access_token;
  }

  async function get(pathAndQuery) {
    const t = await token();
    requests++;
    const r = await fetchImpl('https://www.strava.com/api/v3' + pathAndQuery, { headers: { Authorization: 'Bearer ' + t } });
    if (r.status === 429) throw new RateLimitError('Strava rate limit reached; remaining activities will be picked up next run.');
    if (r.status === 401) throw new AuthError('Strava rejected the access token. Run: node sync/setup.js');
    if (!r.ok) { const e = new Error(`Strava API ${r.status} for ${pathAndQuery}`); e.status = r.status; throw e; }
    return r.json();
  }

  return { get, requestCount: () => requests };
}

// ---------- csv file ----------
function readCsv(p) {
  try { return CSV.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
function writeCsvAtomic(p, rows) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = path.join(path.dirname(p), `.${path.basename(p)}.tmp`);
  fs.writeFileSync(tmp, CSV.stringify(COLUMNS, rows));
  fs.renameSync(tmp, p); // readers never see a half-written file
}
function mergeRows(existing, fresh) {
  const byId = new Map(existing.map(r => [String(r.activity_id), r]));
  fresh.forEach(r => byId.set(String(r.activity_id), r));
  return Array.from(byId.values()).sort((a, b) => String(a.start_utc).localeCompare(String(b.start_utc)));
}

// ---------- sync ----------
async function syncOnce(opts) {
  const o = Object.assign({}, DEFAULTS, opts);
  const fetchImpl = o.fetch || fetch;
  const now = o.now || new Date();
  const log = o.log || (m => console.log(`[${new Date().toISOString()}] ${m}`));
  const api = stravaClient(fetchImpl, o.credsPath, log);

  const existing = readCsv(o.csvPath);
  const known = new Set(existing.map(r => String(r.activity_id)));
  const latest = existing.reduce((m, r) => (r.start_utc > m ? r.start_utc : m), '');
  const sinceMs = latest
    ? new Date(latest).getTime() - o.refreshDays * 86400000
    : now.getTime() - o.backfillDays * 86400000;
  const refreshFromMs = now.getTime() - o.refreshDays * 86400000;

  // list activities after `since`, oldest first
  const listed = [];
  for (let page = 1; page < 50; page++) {
    const batch = await api.get(`/athlete/activities?after=${Math.floor(sinceMs / 1000)}&per_page=100&page=${page}`);
    listed.push(...batch);
    if (batch.length < 100) break;
  }
  listed.sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)));
  const todo = listed.filter(a => !known.has(String(a.id)) || new Date(a.start_date).getTime() >= refreshFromMs);
  const batch = todo.slice(0, o.maxPerRun);

  let zones; // fetched lazily, once
  const fresh = [];
  let stopped = null;
  for (const summary of batch) {
    try {
      const detail = await api.get(`/activities/${summary.id}`);
      let split = null, laps = null;
      if (isRun(detail)) {
        const streams = await api.get(`/activities/${summary.id}/streams?keys=${STREAM_KEYS}&key_by_type=true`).catch(e => { if (e instanceof RateLimitError || e instanceof AuthError) throw e; return null; });
        const elevOpts = { officialGain: detail.total_elevation_gain };
        split = J.buildSplits(streams, elevOpts);
        if (!split.splits.length) split = J.splitsFromStravaMetric(detail.splits_metric);
        laps = J.buildLaps(detail.laps, streams, elevOpts);
        if (zones === undefined) {
          zones = await api.get('/athlete/zones')
            .then(z => (z && z.heart_rate && Array.isArray(z.heart_rate.zones) ? z.heart_rate.zones : null))
            .catch(e => { if (e instanceof RateLimitError || e instanceof AuthError) throw e; return null; });
        }
      }
      const weather = await fetchWeather(fetchImpl, detail, now);
      fresh.push(toRecord(detail, split, laps, weather, zones || null, now));
    } catch (e) {
      if (e instanceof RateLimitError) { stopped = e.message; break; }
      throw e;
    }
  }

  const rows = mergeRows(existing, fresh);
  if (fresh.length || !existing.length) writeCsvAtomic(o.csvPath, rows);
  const added = fresh.filter(r => !known.has(String(r.activity_id))).length;
  const remaining = todo.length - fresh.length;
  const summaryLine = `added ${added}, updated ${fresh.length - added}, total ${rows.length} rows, ${api.requestCount()} Strava requests` +
    (remaining > 0 ? `, ${remaining} left for next run` : '') + ` -> ${o.csvPath}`;
  log(stopped ? `${stopped} ${summaryLine}` : `OK: ${summaryLine}`);
  return { added, updated: fresh.length - added, total: rows.length, remaining, rateLimited: !!stopped };
}

async function fetchWeather(fetchImpl, act, now) {
  const req = J.weatherRequest(act, now.getTime());
  if (!req) return null;
  try {
    const r = await fetchImpl(req.url);
    if (!r.ok) return null;
    const j = await r.json();
    return J.summarizeWeather(j.hourly, req.start, req.durationSec);
  } catch (e) { return null; }
}

// ---------- cli ----------
function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = argv[i + 1];
    if (a === '--csv') { o.csvPath = path.resolve(v.replace(/^~(?=\/)/, os.homedir())); i++; }
    else if (a === '--backfill-days') { o.backfillDays = Number(v); i++; }
    else if (a === '--max') { o.maxPerRun = Number(v); i++; }
    else if (a === '-h' || a === '--help') { console.log('Usage: node sync/strava-sync.js [--csv PATH] [--backfill-days N] [--max N]'); process.exit(0); }
    else { console.error(`Unknown option: ${a}`); process.exit(2); }
  }
  return o;
}

if (require.main === module) {
  syncOnce(parseArgs(process.argv.slice(2))).then(() => process.exit(0)).catch(e => {
    const stamp = `[${new Date().toISOString()}]`;
    if (e instanceof AuthError) console.error(`${stamp} AUTH: ${e.message}`);
    else if (e.code === 'EPERM' || e.code === 'EACCES') console.error(`${stamp} PERMISSION: macOS blocked access to ${e.path}. Allow "node" under System Settings > Privacy & Security > Files and Folders (Documents). ${e.message}`);
    else console.error(`${stamp} ERROR: ${e.stack || e.message}`);
    process.exit(1);
  });
}

module.exports = { syncOnce, mergeRows, readCsv, writeCsvAtomic, parseArgs, DEFAULTS, AuthError, RateLimitError };
