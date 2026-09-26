/* app.js — UI, Strava OAuth + API, Open-Meteo weather. Depends on journal.js (window.Journal). */
(() => {
  'use strict';

  const LS = { id: 'rj.clientId', secret: 'rj.clientSecret', tokens: 'rj.tokens', zones: 'rj.zones' };
  const SCOPE = 'activity:read_all,profile:read_all';
  const STREAM_KEYS = 'time,distance,altitude,heartrate,cadence,moving';
  const PER_PAGE = 30;

  const ui = {};
  ['status', 'settingsBtn', 'setup', 'callbackDomain', 'clientId', 'clientSecret', 'saveBtn', 'disconnectBtn',
    'fileWarning', 'activityPanel', 'activityList', 'moreBtn', 'allTypes', 'outputPanel', 'outputTitle',
    'output', 'copyBtn', 'shareBtn', 'backBtn'].forEach(id => { ui[id] = document.getElementById(id); });

  const state = { page: 0, activities: [], busy: false, current: null };

  // ---------- storage ----------
  const get = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const set = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { /* private mode */ } };
  const tokens = () => { try { return JSON.parse(get(LS.tokens) || 'null'); } catch (e) { return null; } };
  const configured = () => !!(get(LS.id) && get(LS.secret));

  // ---------- ui helpers ----------
  function setStatus(msg, isError) {
    ui.status.textContent = msg || '';
    ui.status.classList.toggle('error', !!isError);
  }
  function show(panel) {
    ['setup', 'activityPanel', 'outputPanel'].forEach(p => { ui[p].hidden = p !== panel; });
  }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------- strava oauth ----------
  const redirectUri = () => location.origin + location.pathname;

  function authorizeUrl() {
    const q = new URLSearchParams({
      client_id: get(LS.id), redirect_uri: redirectUri(), response_type: 'code',
      approval_prompt: 'auto', scope: SCOPE,
    });
    return 'https://www.strava.com/oauth/authorize?' + q.toString();
  }

  async function tokenRequest(params) {
    const body = new URLSearchParams(Object.assign({ client_id: get(LS.id), client_secret: get(LS.secret) }, params));
    const r = await fetch('https://www.strava.com/oauth/token', { method: 'POST', body });
    if (!r.ok && params.grant_type === 'refresh_token' && (r.status === 400 || r.status === 401)) {
      // Strava retires a refresh token once a newer one is issued (for example by the CSV sync on the Mac).
      set(LS.tokens, null); render();
      throw new Error('Strava sign-in needs renewing on this device. Press "Save & connect to Strava" (one tap).');
    }
    if (!r.ok) throw new Error(`Strava token request failed (${r.status}). Check the Client ID / Secret. ${await r.text()}`);
    const j = await r.json();
    set(LS.tokens, JSON.stringify(j));
    return j;
  }

  async function accessToken() {
    let t = tokens();
    if (!t) return null;
    if (!t.expires_at || t.expires_at - 120 < Date.now() / 1000) {
      t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
    }
    return t.access_token;
  }

  async function api(path) {
    const tok = await accessToken();
    if (!tok) throw new Error('Not connected to Strava.');
    const r = await fetch('https://www.strava.com/api/v3' + path, { headers: { Authorization: 'Bearer ' + tok } });
    if (r.status === 401) { set(LS.tokens, null); render(); throw new Error('Strava session expired. Please reconnect.'); }
    if (r.status === 429) throw new Error('Strava rate limit hit. Wait 15 minutes and try again.');
    if (!r.ok) throw new Error(`Strava API error ${r.status} for ${path}.`);
    return r.json();
  }

  async function hrZones() {
    const cached = get(LS.zones);
    if (cached) { try { return JSON.parse(cached); } catch (e) { /* refetch */ } }
    try {
      const z = await api('/athlete/zones');
      const zones = z && z.heart_rate && Array.isArray(z.heart_rate.zones) ? z.heart_rate.zones : null;
      if (zones) set(LS.zones, JSON.stringify(zones));
      return zones;
    } catch (e) { return null; }
  }

  // ---------- weather (Open-Meteo, no key) ----------
  async function fetchWeather(act) {
    const req = Journal.weatherRequest(act);
    if (!req) return null;
    for (const url of req.urls) {
      try {
        const r = await fetch(url);
        if (!r.ok) continue;
        const w = Journal.summarizeWeather((await r.json()).hourly, req.start, req.durationSec);
        if (w) return w;
      } catch (e) { /* try the next source */ }
    }
    return null;
  }

  // ---------- activities ----------
  const isRun = a => Journal.RUN_TYPES.includes(a.sport_type || a.type);

  async function loadActivities(reset) {
    if (state.busy) return;
    state.busy = true;
    try {
      if (reset) { state.page = 0; state.activities = []; }
      state.page += 1;
      setStatus('Loading activities…');
      const list = await api(`/athlete/activities?per_page=${PER_PAGE}&page=${state.page}`);
      state.activities = state.activities.concat(list);
      ui.moreBtn.hidden = list.length < PER_PAGE;
      setStatus('');
      renderList();
    } catch (e) {
      setStatus(e.message, true);
    } finally { state.busy = false; }
  }

  function renderList() {
    const items = ui.allTypes.checked ? state.activities : state.activities.filter(isRun);
    if (!items.length) {
      ui.activityList.innerHTML = '<p class="note">No runs found in the loaded activities. Try "Load more" or tick "show all activity types".</p>';
      return;
    }
    ui.activityList.innerHTML = items.map(a => {
      const d = Journal.parseLocal(a.start_date_local);
      const km = (a.distance || 0) / 1000;
      const pace = km > 0 ? Journal.fmtPace(a.moving_time / km) : 'n/a';
      const meta = `${d ? Journal.fmtDate(d) + ' ' + Journal.hm(d) : ''} · ${km.toFixed(2)} km · ${pace} /km · ${esc(a.sport_type || a.type || '')}`;
      return `<button class="act" data-id="${a.id}"><b>${esc(a.name || 'Untitled')}</b><span>${meta}</span></button>`;
    }).join('');
  }

  async function generate(id) {
    const summary = state.activities.find(a => String(a.id) === String(id));
    if (!summary || state.busy) return;
    state.busy = true;
    setStatus('Fetching activity, streams, zones and weather…');
    try {
      const [detail, streams, zones, weather] = await Promise.all([
        api(`/activities/${id}`),
        api(`/activities/${id}/streams?keys=${STREAM_KEYS}&key_by_type=true`).catch(() => null),
        hrZones(),
        fetchWeather(summary),
      ]);
      const elevOpts = { officialGain: detail.total_elevation_gain };
      let split = Journal.buildSplits(streams, elevOpts);
      if (!split.splits.length) split = Journal.splitsFromStravaMetric(detail.splits_metric);
      const laps = Journal.buildLaps(detail.laps, streams, elevOpts);
      const text = Journal.format(detail, split, weather, zones, laps);
      showOutput(detail, text);
      const notes = [];
      if (!streams) notes.push('no GPS/sensor streams (per-km elevation and cadence unavailable)');
      if (!weather) notes.push('weather unavailable');
      if (!zones) notes.push('HR zones unavailable (needs profile:read_all)');
      setStatus(notes.length ? 'Done. Note: ' + notes.join('; ') + '.' : 'Done.');
    } catch (e) {
      setStatus(e.message, true);
    } finally { state.busy = false; }
  }

  function showOutput(act, text) {
    state.current = act;
    ui.outputTitle.textContent = act.name || 'Run';
    ui.output.value = text;
    show('outputPanel');
    autosize();
    ui.shareBtn.hidden = !navigator.share;
    window.scrollTo(0, 0);
  }
  function autosize() {
    ui.output.style.height = 'auto';
    ui.output.style.height = (ui.output.scrollHeight + 4) + 'px';
  }

  async function copyText() {
    const t = ui.output.value;
    try { await navigator.clipboard.writeText(t); }
    catch (e) { ui.output.focus(); ui.output.select(); document.execCommand('copy'); }
    const old = ui.copyBtn.textContent;
    ui.copyBtn.textContent = 'Copied ✓';
    setTimeout(() => { ui.copyBtn.textContent = old; }, 1500);
  }
  async function shareText() {
    try { await navigator.share({ title: (state.current && state.current.name) || 'Run', text: ui.output.value }); }
    catch (e) { /* user cancelled */ }
  }

  // ---------- render ----------
  function render() {
    ui.callbackDomain.textContent = location.hostname || '(none — open this page over http/https)';
    ui.fileWarning.hidden = location.protocol !== 'file:';
    ui.clientId.value = get(LS.id) || '';
    ui.clientSecret.value = get(LS.secret) || '';
    ui.disconnectBtn.hidden = !tokens();
    if (!configured() || !tokens()) show('setup');
    else show('activityPanel');
  }

  // ---------- demo mode (?demo=1): synthetic data, no Strava needed ----------
  function runDemo() {
    const n = 3300, time = [], dist = [], alt = [], hr = [], cad = [], mov = [];
    let d = 0;
    for (let i = 0; i < n; i++) {
      const moving = (i % 700) < 690;
      const v = moving ? 3.1 + 0.25 * Math.sin(i / 300) : 0;
      d += v;
      time.push(i); dist.push(round2(d)); mov.push(moving);
      alt.push(round2(40 + 18 * Math.sin(i / 420) + 4 * Math.sin(i / 90)));
      hr.push(Math.round(128 + 28 * (1 - Math.exp(-i / 350)) + 6 * Math.sin(i / 260)));
      cad.push(Math.round(85 + 2 * Math.sin(i / 500)));
    }
    const streams = { time: { data: time }, distance: { data: dist }, altitude: { data: alt }, heartrate: { data: hr }, cadence: { data: cad }, moving: { data: mov } };
    const act = {
      id: 0, name: 'Demo: Morning Run', sport_type: 'Run',
      start_date_local: '2026-09-12T06:12:00Z', start_date: '2026-09-11T20:12:00Z', timezone: '(GMT+10:00) Australia/Melbourne',
      distance: dist[n - 1], moving_time: mov.filter(Boolean).length, elapsed_time: n,
      calories: 642, average_heartrate: hr.reduce((a, b) => a + b, 0) / n, max_heartrate: Math.max.apply(null, hr),
      average_cadence: 85.4, perceived_exertion: 6, start_latlng: [-37.81, 144.96],
    };
    const zones = [{ min: 0, max: 115 }, { min: 115, max: 152 }, { min: 152, max: 171 }, { min: 171, max: 190 }, { min: 190, max: -1 }];
    const weather = { temp: 11.2, feels: 9.1, humidity: 78, cloud: 42, wind: 13, gust: 24, windDir: 225, precip: 0, code: 2 };
    const split = Journal.buildSplits(streams, {});
    const laps = [];
    for (let i0 = 0, k = 0; i0 < n - 1; k++) {
      const i1 = Math.min(i0 + (k % 2 === 0 ? 180 : 120), n - 1);
      laps.push({ lap_index: k + 1, start_index: i0, end_index: i1, distance: dist[i1] - dist[i0], elapsed_time: time[i1] - time[i0], moving_time: time[i1] - time[i0] });
      i0 = i1;
    }
    showOutput(act, Journal.format(act, split, weather, zones, Journal.buildLaps(laps, streams, {})));
    ui.backBtn.hidden = true;
    setStatus('Demo mode: synthetic data. Remove ?demo=1 from the address to use Strava.');
  }
  const round2 = x => Math.round(x * 100) / 100;

  // ---------- events ----------
  ui.settingsBtn.addEventListener('click', () => { render(); show('setup'); });
  ui.saveBtn.addEventListener('click', () => {
    const id = ui.clientId.value.trim(), secret = ui.clientSecret.value.trim();
    if (!id || !secret) { setStatus('Enter both the Client ID and Client Secret from your Strava API application.', true); return; }
    set(LS.id, id); set(LS.secret, secret);
    if (location.protocol === 'file:') { setStatus('Strava cannot redirect back to a file:// page. Host the page (see README) or run a local server.', true); return; }
    location.href = authorizeUrl();
  });
  ui.disconnectBtn.addEventListener('click', () => { set(LS.tokens, null); set(LS.zones, null); state.activities = []; setStatus('Disconnected.'); render(); });
  ui.allTypes.addEventListener('change', renderList);
  ui.moreBtn.addEventListener('click', () => loadActivities(false));
  ui.activityList.addEventListener('click', e => { const b = e.target.closest('button.act'); if (b) generate(b.dataset.id); });
  ui.backBtn.addEventListener('click', () => { show('activityPanel'); setStatus(''); });
  ui.copyBtn.addEventListener('click', copyText);
  ui.shareBtn.addEventListener('click', shareText);
  ui.output.addEventListener('input', autosize);

  // ---------- init ----------
  async function init() {
    const q = new URLSearchParams(location.search);
    if (q.get('demo')) { render(); runDemo(); return; }
    if (q.get('error')) {
      setStatus('Strava authorisation was declined (' + q.get('error') + ').', true);
      history.replaceState({}, '', redirectUri());
    }
    if (q.get('code')) {
      try {
        setStatus('Finishing Strava sign-in…');
        await tokenRequest({ grant_type: 'authorization_code', code: q.get('code') });
        const granted = q.get('scope') || '';
        if (!granted.includes('activity:read_all')) setStatus('Warning: Strava did not grant activity:read_all, so private runs will be missing. Reconnect and tick all boxes.', true);
        else setStatus('');
      } catch (e) { setStatus(e.message, true); }
      history.replaceState({}, '', redirectUri());
    }
    render();
    if (configured() && tokens()) loadActivities(true);
  }
  init();
})();
