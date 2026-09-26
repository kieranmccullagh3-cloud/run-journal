#!/usr/bin/env node
/* setup.js — one-time Strava sign-in for the CSV sync.
   Asks for the Strava API Client ID and Secret (typed in your terminal, secret hidden), opens Strava's
   approval page, catches the redirect on http://localhost:8723, and saves the tokens to
   ~/.config/run-journal/strava.json (readable only by you). Re-run it any time the sync logs "AUTH". */
'use strict';
const http = require('http');
const readline = require('readline');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { DEFAULTS } = require('./strava-sync.js');

const PORT = 8723;
const REDIRECT = `http://localhost:${PORT}/callback`;
const SCOPE = 'activity:read_all,profile:read_all';

function ask(question, hidden) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = s => { if (s.includes(question)) process.stdout.write(s); else if (!/[\r\n]/.test(s)) process.stdout.write('*'); };
    }
    rl.question(question, a => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a.trim()); });
  });
}

function waitForCode() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, REDIRECT);
      if (u.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
      const code = u.searchParams.get('code'), err = u.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(code ? '<h2>Run Journal sync connected.</h2><p>You can close this tab and return to the terminal.</p>'
                   : `<h2>Strava sign-in was not completed (${err || 'no code'}).</h2>`);
      server.close();
      code ? resolve({ code, scope: u.searchParams.get('scope') || '' }) : reject(new Error(`Strava returned: ${err || 'no code'}`));
    });
    server.on('error', reject);
    server.listen(PORT, '127.0.0.1');
    setTimeout(() => { server.close(); reject(new Error('Timed out after 5 minutes waiting for Strava.')); }, 5 * 60 * 1000).unref();
  });
}

async function main() {
  const credsPath = DEFAULTS.credsPath;
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(credsPath, 'utf8')); } catch (e) { /* first run */ }

  let clientId = prev.client_id, clientSecret = prev.client_secret;
  if (clientId && clientSecret) {
    const again = await ask(`Reuse saved Client ID ${clientId}? [Y/n] `);
    if (/^n/i.test(again)) clientId = clientSecret = null;
  }
  if (!clientId) clientId = await ask('Strava Client ID: ');
  if (!clientSecret) clientSecret = await ask('Strava Client Secret (hidden): ', true);
  if (!clientId || !clientSecret) throw new Error('Client ID and Secret are both required (strava.com/settings/api).');

  const auth = 'https://www.strava.com/oauth/authorize?' + new URLSearchParams({
    client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', approval_prompt: 'auto', scope: SCOPE,
  });
  const pending = waitForCode();
  console.log('\nOpening Strava in your browser. If it does not open, visit:\n' + auth + '\n');
  execFile('open', [auth], () => {});
  const { code, scope } = await pending;

  const r = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, grant_type: 'authorization_code' }),
  });
  if (!r.ok) throw new Error(`Token exchange failed (${r.status}): ${await r.text()}`);
  const j = await r.json();

  fs.mkdirSync(path.dirname(credsPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(credsPath, JSON.stringify({
    client_id: clientId, client_secret: clientSecret,
    access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at,
  }, null, 2), { mode: 0o600 });
  fs.chmodSync(credsPath, 0o600);

  const who = j.athlete ? `${j.athlete.firstname || ''} ${j.athlete.lastname || ''}`.trim() : 'your account';
  console.log(`Connected as ${who}. Tokens saved to ${credsPath} (owner read/write only).`);
  if (!scope.includes('activity:read_all')) console.log('WARNING: activity:read_all was not granted, so private activities will be skipped. Re-run and tick every box.');
  console.log('Next: node sync/strava-sync.js');
}

main().catch(e => { console.error('Setup failed: ' + e.message); process.exit(1); });
