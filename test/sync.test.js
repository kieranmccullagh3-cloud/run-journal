const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const CSV = require('../sync/csv.js');
const { COLUMNS } = require('../sync/record.js');
const { syncOnce, AuthError } = require('../sync/strava-sync.js');

const NOW = new Date('2026-09-26T02:00:00Z');
const DAY = 86400000;

function streamsFor(n) {
  const time = [], distance = [], altitude = [], heartrate = [], cadence = [], moving = [];
  for (let i = 0; i < n; i++) { time.push(i); distance.push(i * 3.2); altitude.push(20 + 5 * Math.sin(i / 200)); heartrate.push(150); cadence.push(86); moving.push(true); }
  const wrap = d => ({ data: d });
  return { time: wrap(time), distance: wrap(distance), altitude: wrap(altitude), heartrate: wrap(heartrate), cadence: wrap(cadence), moving: wrap(moving) };
}

function activity(id, daysAgo, type) {
  const start = new Date(NOW.getTime() - daysAgo * DAY);
  const local = new Date(start.getTime() + 10 * 3600000).toISOString().replace('.000Z', 'Z');
  return {
    id, name: `Act ${id}, "quoted"`, sport_type: type || 'Run', type: type || 'Run',
    start_date: start.toISOString().replace('.000Z', 'Z'), start_date_local: local,
    timezone: '(GMT+10:00) Australia/Brisbane', start_latlng: [-27.55, 152.82],
    distance: 3200, moving_time: 1000, elapsed_time: 1000, total_elevation_gain: 12,
    average_heartrate: 150, max_heartrate: 160, average_cadence: 86, calories: 250, perceived_exertion: 6,
    laps: [
      { lap_index: 1, start_index: 0, end_index: 400, distance: 1280, elapsed_time: 400, moving_time: 400 },
      { lap_index: 2, start_index: 400, end_index: 999, distance: 1917, elapsed_time: 599, moving_time: 599 },
    ],
    device_name: 'Garmin Forerunner',
  };
}

function fakeServer(acts, opts = {}) {
  const calls = [];
  let tokenCalls = 0, apiCalls = 0;
  const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
  const fetch = async (url, init) => {
    calls.push(url);
    if (url.startsWith('https://www.strava.com/oauth/token')) {
      tokenCalls++;
      if (opts.refreshStatus) return json({ message: 'Bad Request' }, opts.refreshStatus);
      return json({ access_token: 'access-2', refresh_token: 'refresh-ROTATED', expires_at: Math.floor(Date.now() / 1000) + 21600 });
    }
    if (url.includes('open-meteo.com')) {
      const hours = Array.from({ length: 48 }, (_, h) => h);
      const d0 = new URL(url).searchParams.get('start_date');
      const time = hours.map(h => { const d = new Date(`${d0}T00:00:00Z`); d.setUTCHours(h); return d.toISOString().slice(0, 13) + ':00'; });
      return json({ hourly: { time, temperature_2m: hours.map(() => 18), apparent_temperature: hours.map(() => 17), relative_humidity_2m: hours.map(() => 70), cloud_cover: hours.map(() => 50), wind_speed_10m: hours.map(() => 10), wind_gusts_10m: hours.map(() => 20), wind_direction_10m: hours.map(() => 90), precipitation: hours.map(() => 0), weather_code: hours.map(() => 2) } });
    }
    apiCalls++;
    if (opts.rateLimitAfter && apiCalls > opts.rateLimitAfter) return json({ message: 'Rate Limit Exceeded' }, 429);
    const u = new URL(url);
    const p = u.pathname.replace('/api/v3', '');
    if (p === '/athlete/activities') {
      const after = Number(u.searchParams.get('after')) * 1000;
      const page = Number(u.searchParams.get('page'));
      const list = acts.filter(a => new Date(a.start_date).getTime() > after);
      return json(page === 1 ? list.slice().reverse() : []);
    }
    if (p === '/athlete/zones') return json({ heart_rate: { zones: [{ min: 0, max: 120 }, { min: 120, max: 145 }, { min: 145, max: 165 }, { min: 165, max: 180 }, { min: 180, max: -1 }] } });
    let m = /^\/activities\/(\d+)\/streams$/.exec(p);
    if (m) return json(streamsFor(1000));
    m = /^\/activities\/(\d+)$/.exec(p);
    if (m) { const a = acts.find(x => String(x.id) === m[1]); return a ? json(a) : json({}, 404); }
    return json({}, 404);
  };
  return { fetch, calls, stats: () => ({ tokenCalls, apiCalls }) };
}

function tmpSetup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rj-sync-'));
  const credsPath = path.join(dir, 'creds', 'strava.json');
  fs.mkdirSync(path.dirname(credsPath));
  fs.writeFileSync(credsPath, JSON.stringify({ client_id: '1', client_secret: 's', refresh_token: 'refresh-1', access_token: 'old', expires_at: 0 }));
  return { dir, credsPath, csvPath: path.join(dir, 'out', 'strava', 'activities.csv') };
}
const quiet = () => {};

test('csv round-trips quotes, commas and newlines', () => {
  const rows = [{ a: 'plain', b: 'has, comma', c: 'say "hi"' }, { a: 'line\nbreak', b: '', c: '[{"x":1}]' }];
  assert.deepEqual(CSV.parse(CSV.stringify(['a', 'b', 'c'], rows)), rows);
  assert.deepEqual(CSV.parse(''), []);
});

test('first sync backfills, writes all columns, rotates refresh token with 0600 perms', async () => {
  const t = tmpSetup();
  const acts = [activity(101, 30), activity(102, 10, 'Ride'), activity(103, 1), activity(999, 200)];
  const srv = fakeServer(acts);
  const res = await syncOnce({ fetch: srv.fetch, now: NOW, csvPath: t.csvPath, credsPath: t.credsPath, log: quiet });
  assert.equal(res.added, 3, '200-day-old activity is outside the 90-day backfill');
  const text = fs.readFileSync(t.csvPath, 'utf8');
  assert.equal(text.split('\r\n')[0], COLUMNS.join(','));
  const rows = CSV.parse(text);
  assert.deepEqual(rows.map(r => r.activity_id), ['101', '102', '103'], 'sorted oldest first');
  const run = rows[0];
  assert.equal(run.name, 'Act 101, "quoted"');
  assert.equal(run.distance_km, '3.2');
  assert.equal(run.avg_pace_min_per_km, '5:13');
  assert.equal(run.avg_cadence_spm, '172');
  assert.equal(run.avg_hr_zone, '3');
  assert.equal(run.rpe, '6');
  assert.equal(run.temp_c, '18');
  assert.equal(run.wind_from, 'E');
  assert.equal(run.conditions, 'partly cloudy');
  assert.equal(run.timezone, 'Australia/Brisbane');
  const splits = JSON.parse(run.splits_json);
  assert.equal(splits.length, 4);
  assert.equal(splits[0].avg_hr, 150); assert.equal(splits[0].hr_zone, 3); assert.equal(splits[0].spm, 172);
  const laps = JSON.parse(run.laps_json);
  assert.equal(laps.length, 2); assert.equal(laps[0].elapsed_s, 400);
  const ride = rows[1];
  assert.equal(ride.sport_type, 'Ride');
  assert.equal(ride.splits_json, ''); assert.equal(ride.avg_cadence_spm, ''); assert.equal(ride.avg_pace_min_per_km, '');
  assert.ok(!srv.calls.some(u => u.includes('/activities/102/streams')), 'no streams fetched for rides');
  const creds = JSON.parse(fs.readFileSync(t.credsPath, 'utf8'));
  assert.equal(creds.refresh_token, 'refresh-ROTATED');
  assert.equal(fs.statSync(t.credsPath).mode & 0o777, 0o600);
});

test('second sync only fetches new and recent activities and keeps older rows', async () => {
  const t = tmpSetup();
  const acts = [activity(101, 30), activity(103, 5)];
  await syncOnce({ fetch: fakeServer(acts).fetch, now: NOW, csvPath: t.csvPath, credsPath: t.credsPath, log: quiet });
  acts.push(activity(104, 0.5));
  const srv = fakeServer(acts);
  const res = await syncOnce({ fetch: srv.fetch, now: NOW, csvPath: t.csvPath, credsPath: t.credsPath, log: quiet });
  assert.equal(res.added, 1);
  assert.equal(res.updated, 0, '5-day-old run is outside the 3-day refresh window');
  assert.ok(!srv.calls.some(u => /\/activities\/101$/.test(u)), 'old activity not refetched');
  assert.deepEqual(CSV.parse(fs.readFileSync(t.csvPath, 'utf8')).map(r => r.activity_id), ['101', '103', '104']);
});

test('recent activities are refreshed so later edits (RPE) land in the CSV', async () => {
  const t = tmpSetup();
  const a = activity(201, 1); delete a.perceived_exertion;
  await syncOnce({ fetch: fakeServer([a]).fetch, now: NOW, csvPath: t.csvPath, credsPath: t.credsPath, log: quiet });
  assert.equal(CSV.parse(fs.readFileSync(t.csvPath, 'utf8'))[0].rpe, '');
  a.perceived_exertion = 8;
  const res = await syncOnce({ fetch: fakeServer([a]).fetch, now: NOW, csvPath: t.csvPath, credsPath: t.credsPath, log: quiet });
  assert.equal(res.updated, 1);
  const rows = CSV.parse(fs.readFileSync(t.csvPath, 'utf8'));
  assert.equal(rows.length, 1); assert.equal(rows[0].rpe, '8');
});

test('rate limit mid-run saves what it has and reports the remainder', async () => {
  const t = tmpSetup();
  const acts = [activity(301, 20), activity(302, 15), activity(303, 10), activity(304, 5)];
  // list(1) + [detail, streams, zones](301) + [detail, streams](302) = 6 calls, then 429
  const res = await syncOnce({ fetch: fakeServer(acts, { rateLimitAfter: 6 }).fetch, now: NOW, csvPath: t.csvPath, credsPath: t.credsPath, log: quiet });
  assert.equal(res.rateLimited, true);
  assert.equal(res.added, 2); assert.equal(res.remaining, 2);
  assert.equal(CSV.parse(fs.readFileSync(t.csvPath, 'utf8')).length, 2);
  const res2 = await syncOnce({ fetch: fakeServer(acts).fetch, now: NOW, csvPath: t.csvPath, credsPath: t.credsPath, log: quiet });
  assert.equal(res2.added, 2);
  assert.equal(CSV.parse(fs.readFileSync(t.csvPath, 'utf8')).length, 4);
});

test('maxPerRun caps the batch, oldest first', async () => {
  const t = tmpSetup();
  const acts = [activity(401, 20), activity(402, 15), activity(403, 10)];
  const res = await syncOnce({ fetch: fakeServer(acts).fetch, now: NOW, csvPath: t.csvPath, credsPath: t.credsPath, log: quiet, maxPerRun: 2 });
  assert.equal(res.added, 2); assert.equal(res.remaining, 1);
  assert.deepEqual(CSV.parse(fs.readFileSync(t.csvPath, 'utf8')).map(r => r.activity_id), ['401', '402']);
});

test('a retired refresh token raises AuthError and leaves the CSV untouched', async () => {
  const t = tmpSetup();
  fs.mkdirSync(path.dirname(t.csvPath), { recursive: true });
  fs.writeFileSync(t.csvPath, 'activity_id,name\r\n1,keep me\r\n');
  await assert.rejects(
    syncOnce({ fetch: fakeServer([activity(501, 1)], { refreshStatus: 400 }).fetch, now: NOW, csvPath: t.csvPath, credsPath: t.credsPath, log: quiet }),
    e => e instanceof AuthError && /setup\.js/.test(e.message));
  assert.equal(fs.readFileSync(t.csvPath, 'utf8'), 'activity_id,name\r\n1,keep me\r\n');
});

test('missing credentials give a clear AuthError', async () => {
  await assert.rejects(syncOnce({ fetch: async () => { throw new Error('should not fetch'); }, credsPath: '/nonexistent/strava.json', csvPath: '/tmp/x.csv', log: quiet }), AuthError);
});
