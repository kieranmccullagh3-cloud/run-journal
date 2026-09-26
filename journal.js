/* journal.js — pure computation + formatting for Run Journal.
   No DOM, no network. Works in the browser (window.Journal) and in Node (module.exports). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Journal = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Minimum climb/descent (metres) before a change of direction counts as real.
  // Raise it if per-km elevation looks noisy; lower it if it looks too small.
  const ELEVATION_THRESHOLD_M = 2;

  const RUN_TYPES = ['Run', 'TrailRun', 'VirtualRun'];
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const pad2 = n => String(n).padStart(2, '0');
  const isNum = x => typeof x === 'number' && isFinite(x);
  const round = (x, dp) => { const f = Math.pow(10, dp || 0); return Math.round(x * f) / f; };
  const mean = arr => { const v = arr.filter(x => isNum(x) && x > 0); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

  function fmtDuration(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
  }

  // seconds per km -> "5:12"
  function fmtPace(secPerKm) {
    if (!isNum(secPerKm) || secPerKm <= 0) return 'n/a';
    const t = Math.round(secPerKm);
    return `${Math.floor(t / 60)}:${pad2(t % 60)}`;
  }

  // Strava's start_date_local is the athlete's wall-clock time with a misleading trailing "Z".
  function parseLocal(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(iso || '');
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  }
  const ymd = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const hm = d => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const fmtDate = d => `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;

  function timeOfDay(h) {
    if (h < 5) return 'night';
    if (h < 12) return 'morning';
    if (h < 17) return 'afternoon';
    if (h < 21) return 'evening';
    return 'night';
  }

  // "(GMT+10:00) Australia/Melbourne" -> "Australia/Melbourne"
  function ianaTimezone(s) {
    const m = /([A-Za-z_]+\/[A-Za-z_\/+\-0-9]+)\s*$/.exec(s || '');
    return m ? m[1] : null;
  }

  // Elevation gain/loss with hysteresis: small wobbles against the current direction are ignored
  // until they exceed `threshold`. Returns per-sample increments so they can be bucketed into splits.
  function elevationIncrements(alt, threshold) {
    const thr = isNum(threshold) ? threshold : ELEVATION_THRESHOLD_M;
    const n = alt ? alt.length : 0;
    const gainAt = new Array(n).fill(0), lossAt = new Array(n).fill(0);
    let gain = 0, loss = 0;
    if (n < 2) return { gainAt, lossAt, gain, loss };
    let dir = 0, ref = alt[0];
    for (let i = 1; i < n; i++) {
      const a = alt[i];
      if (!isNum(a)) continue;
      const d = a - ref;
      if (d > 0 && (dir >= 0 || d >= thr)) { dir = 1; gainAt[i] = d; gain += d; ref = a; }
      else if (d < 0 && (dir <= 0 || -d >= thr)) { dir = -1; lossAt[i] = -d; loss += -d; ref = a; }
    }
    return { gainAt, lossAt, gain, loss };
  }

  // zones: Strava /athlete/zones -> heart_rate.zones = [{min,max}, ...], max -1 = open-ended.
  function hrZone(bpm, zones) {
    if (!isNum(bpm) || !Array.isArray(zones) || !zones.length) return null;
    for (let i = 0; i < zones.length; i++) {
      const z = zones[i];
      const max = (!isNum(z.max) || z.max < 0) ? Infinity : z.max;
      if (bpm >= (z.min || 0) && bpm < max) return i + 1;
    }
    return bpm >= zones[zones.length - 1].min ? zones.length : null;
  }

  // Running cadence from Strava is usually single-leg (~85) and the Strava UI doubles it to steps/min.
  // Some devices already report full steps/min, so only double plausible single-leg values.
  function toSpm(cadence) {
    if (!isNum(cadence) || cadence <= 0) return null;
    return cadence > 130 ? cadence : cadence * 2;
  }

  /* streams: Strava /activities/{id}/streams?key_by_type=true
     -> { time:{data}, distance:{data}, altitude:{data}, heartrate:{data}, cadence:{data}, moving:{data} }
     Returns a context for segmentStats, or null when the essential streams are missing.
     opts.officialGain: Strava's total_elevation_gain; gain/loss are scaled so segments add up to it. */
  function prepareStreams(streams, opts) {
    opts = opts || {};
    const S = k => (streams && streams[k] && Array.isArray(streams[k].data)) ? streams[k].data : null;
    const dist = S('distance'), time = S('time');
    if (!dist || !time || dist.length < 2 || time.length !== dist.length) return null;
    const n = dist.length;
    const alt = S('altitude');
    const elev = alt && alt.length === n ? elevationIncrements(alt, opts.elevationThreshold) : null;
    let factor = 1;
    if (elev && isNum(opts.officialGain) && opts.officialGain > 0 && elev.gain > 0) factor = opts.officialGain / elev.gain;
    return { n, dist, time, hr: S('heartrate'), cad: S('cadence'), mov: S('moving'), elev, factor };
  }

  // Stats for the samples i0..i1 (inclusive) of a prepared stream context.
  function segmentStats(ctx, i0, i1) {
    const { dist, time, hr, cad, mov, elev, factor } = ctx;
    const d = dist[i1] - dist[i0];
    const elapsed = time[i1] - time[i0];
    let moving = 0, gain = 0, loss = 0;
    const hrs = [], cads = [];
    for (let j = i0 + 1; j <= i1; j++) {
      const dt = time[j] - time[j - 1];
      if (!mov || mov[j] !== false) moving += dt;
      if (elev) { gain += elev.gainAt[j]; loss += elev.lossAt[j]; }
      if (hr) hrs.push(hr[j]);
      if (cad) cads.push(cad[j]);
    }
    if (moving <= 0) moving = elapsed;
    const validHr = hrs.filter(x => isNum(x) && x > 0);
    return {
      km: d / 1000, elapsed, moving,
      paceSecPerKm: d > 0 ? moving / (d / 1000) : NaN,
      gain: elev ? gain * factor : null,
      loss: elev ? loss * factor : null,
      avgHr: hr ? mean(hrs) : null,
      maxHr: validHr.length ? Math.max.apply(null, validHr) : null,
      spm: toSpm(cad ? mean(cads) : null),
    };
  }

  // Per-km splits computed from the streams.
  function buildSplits(streams, opts) {
    opts = opts || {};
    const splitM = opts.splitMeters || 1000;
    const ctx = prepareStreams(streams, opts);
    if (!ctx) return { splits: [], gain: null, loss: null, factor: 1 };
    const { n, dist, elev, factor } = ctx;

    // split boundary indices: first sample at or past each k*splitM, then the final sample
    const idx = [0];
    let k = 1;
    for (let i = 1; i < n; i++) {
      if (dist[i] >= k * splitM) { idx.push(i); k = Math.floor(dist[i] / splitM) + 1; }
    }
    if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);

    const splits = [];
    for (let s = 0; s < idx.length - 1; s++) {
      const i0 = idx[s], i1 = idx[s + 1];
      const d = dist[i1] - dist[i0];
      if (d < 20) continue; // ignore a trailing stub of a few metres
      const st = segmentStats(ctx, i0, i1);
      splits.push(Object.assign({ n: s + 1, partial: d < splitM * 0.98 }, st));
    }
    return { splits, gain: elev ? elev.gain * factor : null, loss: elev ? elev.loss * factor : null, factor };
  }

  /* laps: Strava DetailedActivity.laps (each lap records the watch's lap button / auto-lap, with
     start_index/end_index into the streams). Distance and times come from Strava's lap record;
     elevation, HR and cadence are computed from the streams when available, else taken from the lap. */
  function buildLaps(laps, streams, opts) {
    if (!Array.isArray(laps) || !laps.length) return [];
    const ctx = prepareStreams(streams, opts);
    return laps.map((lap, i) => {
      const km = (lap.distance || 0) / 1000;
      const elapsed = isNum(lap.elapsed_time) ? lap.elapsed_time : null;
      const moving = isNum(lap.moving_time) && lap.moving_time > 0 ? lap.moving_time : elapsed;
      let st = null;
      const i0 = lap.start_index, i1 = lap.end_index;
      if (ctx && isNum(i0) && isNum(i1) && i0 >= 0 && i1 > i0 && i1 < ctx.n) st = segmentStats(ctx, i0, i1);
      return {
        n: isNum(lap.lap_index) ? lap.lap_index : i + 1,
        name: lap.name || null,
        km, elapsed, moving,
        paceSecPerKm: km > 0 && isNum(moving) ? moving / km : NaN,
        gain: st ? st.gain : (isNum(lap.total_elevation_gain) ? lap.total_elevation_gain : null),
        loss: st ? st.loss : null,
        avgHr: st && isNum(st.avgHr) ? st.avgHr : (isNum(lap.average_heartrate) ? lap.average_heartrate : null),
        maxHr: st && isNum(st.maxHr) ? st.maxHr : (isNum(lap.max_heartrate) ? lap.max_heartrate : null),
        spm: st && isNum(st.spm) ? st.spm : toSpm(lap.average_cadence),
      };
    });
  }

  // Fallback when streams are unavailable: Strava's own splits_metric (no cadence, net elevation only).
  function splitsFromStravaMetric(splitsMetric) {
    if (!Array.isArray(splitsMetric)) return { splits: [], gain: null, loss: null, factor: 1 };
    const splits = splitsMetric.map((s, i) => {
      const km = (s.distance || 0) / 1000;
      const ed = isNum(s.elevation_difference) ? s.elevation_difference : null;
      return {
        n: i + 1, km, partial: km < 0.98,
        elapsed: s.elapsed_time, moving: s.moving_time,
        paceSecPerKm: km > 0 ? s.moving_time / km : NaN,
        gain: ed == null ? null : Math.max(ed, 0),
        loss: ed == null ? null : Math.max(-ed, 0),
        avgHr: isNum(s.average_heartrate) ? s.average_heartrate : null,
        spm: null,
      };
    }).filter(s => s.km > 0.02);
    return { splits, gain: null, loss: null, factor: 1, fromStravaSplits: true };
  }

  function cloudWords(pct) {
    if (!isNum(pct)) return null;
    if (pct < 10) return 'clear';
    if (pct < 30) return 'mostly clear';
    if (pct < 60) return 'partly cloudy';
    if (pct < 85) return 'mostly cloudy';
    return 'overcast';
  }
  function compass(deg) {
    if (!isNum(deg)) return null;
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return dirs[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
  }
  // WMO weather code -> a word, only for things cloud cover doesn't already say
  function wmoWords(code) {
    if (!isNum(code)) return null;
    if (code === 45 || code === 48) return 'fog';
    if (code >= 51 && code <= 57) return 'drizzle';
    if (code >= 61 && code <= 67) return 'rain';
    if (code >= 71 && code <= 77) return 'snow';
    if (code >= 80 && code <= 82) return 'showers';
    if (code >= 85 && code <= 86) return 'snow showers';
    if (code >= 95) return 'thunderstorm';
    return null;
  }

  const WEATHER_HOURLY = 'temperature_2m,apparent_temperature,relative_humidity_2m,cloud_cover,wind_speed_10m,wind_gusts_10m,wind_direction_10m,precipitation,weather_code';

  const OPEN_METEO_FORECAST = 'https://api.open-meteo.com/v1/forecast';
  const OPEN_METEO_ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';
  // The forecast API only keeps ~60 days of history (older hours come back as nulls), while the archive
  // lags real time by ~2 days. So: archive for anything older than this, forecast for recent activities,
  // and the other API as a fallback when the first returns no values.
  const ARCHIVE_AFTER_DAYS = 5;

  /* Open-Meteo requests for the hours an activity covered, best source first, or null without a start location. */
  function weatherRequest(act, nowMs) {
    if (!act || !Array.isArray(act.start_latlng) || act.start_latlng.length < 2) return null;
    const start = parseLocal(act.start_date_local);
    if (!start) return null;
    const dur = act.elapsed_time || act.moving_time || 0;
    const end = new Date(start.getTime() + dur * 1000);
    const ageDays = ((isNum(nowMs) ? nowMs : Date.now()) - new Date(act.start_date).getTime()) / 86400000;
    const q = [
      ['latitude', act.start_latlng[0]], ['longitude', act.start_latlng[1]], ['hourly', WEATHER_HOURLY],
      ['start_date', ymd(start)], ['end_date', ymd(end)], ['timezone', ianaTimezone(act.timezone) || 'auto'],
    ].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const bases = ageDays > ARCHIVE_AFTER_DAYS ? [OPEN_METEO_ARCHIVE, OPEN_METEO_FORECAST] : [OPEN_METEO_FORECAST, OPEN_METEO_ARCHIVE];
    const urls = bases.map(b => `${b}?${q}`);
    return { url: urls[0], urls, start, durationSec: dur };
  }

  /* hourly: Open-Meteo "hourly" block ({ time:[...], temperature_2m:[...], ... }) with times in the
     activity's local timezone. Averages the hours the run overlapped. */
  function summarizeWeather(hourly, start, durationSec) {
    if (!hourly || !Array.isArray(hourly.time) || !(start instanceof Date)) return null;
    const end = new Date(start.getTime() + Math.max(durationSec || 0, 0) * 1000);
    const key = d => `${ymd(d)}T${pad2(d.getHours())}:00`;
    const k0 = key(start), k1 = key(end);
    const rows = [];
    hourly.time.forEach((t, i) => { if (t >= k0 && t <= k1) rows.push(i); });
    if (!rows.length) return null;
    const pick = name => rows.map(i => (hourly[name] || [])[i]).filter(isNum);
    const avg = name => { const v = pick(name); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    let sx = 0, sy = 0;
    rows.forEach(i => {
      const d = (hourly.wind_direction_10m || [])[i];
      if (isNum(d)) { sx += Math.cos(d * Math.PI / 180); sy += Math.sin(d * Math.PI / 180); }
    });
    const windDir = (sx || sy) ? ((Math.atan2(sy, sx) * 180 / Math.PI) + 360) % 360 : null;
    if (!['temperature_2m', 'cloud_cover', 'relative_humidity_2m', 'wind_speed_10m'].some(k => pick(k).length)) return null; // all nulls
    const gusts = pick('wind_gusts_10m'), codes = pick('weather_code'), precip = pick('precipitation');
    return {
      temp: avg('temperature_2m'),
      feels: avg('apparent_temperature'),
      humidity: avg('relative_humidity_2m'),
      cloud: avg('cloud_cover'),
      wind: avg('wind_speed_10m'),
      gust: gusts.length ? Math.max.apply(null, gusts) : null,
      windDir,
      precip: precip.length ? precip.reduce((a, b) => a + b, 0) : null,
      code: codes.length ? Math.max.apply(null, codes) : null,
    };
  }

  function conditionsLine(start, w) {
    const parts = [`${timeOfDay(start.getHours())} (${hm(start)})`];
    if (!w) { parts.push('weather unavailable'); return parts.join(', '); }
    if (isNum(w.temp)) {
      let t = `${round(w.temp)} °C`;
      if (isNum(w.feels) && Math.abs(w.feels - w.temp) >= 1.5) t += ` (feels like ${round(w.feels)} °C)`;
      parts.push(t);
    }
    if (isNum(w.cloud)) parts.push(`${cloudWords(w.cloud)} (${round(w.cloud)}% cloud)`);
    const wx = wmoWords(w.code);
    if (wx) parts.push(wx);
    if (isNum(w.humidity)) parts.push(`${round(w.humidity)}% humidity`);
    if (isNum(w.wind)) {
      let s = `wind ${round(w.wind)} km/h`;
      if (isNum(w.windDir)) s += ` from ${compass(w.windDir)}`;
      if (isNum(w.gust) && w.gust >= w.wind + 8) s += ` (gusts ${round(w.gust)} km/h)`;
      parts.push(s);
    }
    if (isNum(w.precip) && w.precip >= 0.2) parts.push(`${round(w.precip, 1)} mm rain`);
    return parts.join(', ');
  }

  // "+12 m", "-5 m", or "0 m" (never "-0 m")
  function metres(v, sign) { const r = round(v || 0); return r === 0 ? '0 m' : `${sign}${r} m`; }

  function formatSplit(s, zones) {
    const label = s.partial ? `last ${s.km.toFixed(2)} km` : `km ${s.n}`;
    const parts = [`${fmtPace(s.paceSecPerKm)} /km`];
    if (isNum(s.gain) || isNum(s.loss)) parts.push(`${metres(s.gain, '+')} / ${metres(s.loss, '-')}`);
    if (isNum(s.avgHr)) {
      const z = hrZone(s.avgHr, zones);
      parts.push(`HR ${round(s.avgHr)}${z ? ` (Z${z})` : ''}`);
    }
    if (isNum(s.spm)) parts.push(`${round(s.spm)} spm`);
    return `${label}: ${parts.join(', ')}`;
  }

  // "Lap 3: 3:00 (0.82 km), 3:40 /km, +1 m / -2 m, HR 165 (Z4, max 174), 180 spm"
  function formatLap(l, zones) {
    const parts = [];
    let head = '';
    if (isNum(l.elapsed)) head = fmtDuration(l.elapsed);
    if (l.km > 0) head += head ? ` (${l.km.toFixed(2)} km)` : `${l.km.toFixed(2)} km`;
    if (head) parts.push(head);
    if (isNum(l.paceSecPerKm) && l.paceSecPerKm > 0) parts.push(`${fmtPace(l.paceSecPerKm)} /km`);
    if (isNum(l.gain) || isNum(l.loss)) parts.push(`${metres(l.gain, '+')} / ${metres(l.loss, '-')}`);
    if (isNum(l.avgHr)) {
      const z = hrZone(l.avgHr, zones);
      const extra = [z ? `Z${z}` : null, isNum(l.maxHr) ? `max ${round(l.maxHr)}` : null].filter(Boolean);
      parts.push(`HR ${round(l.avgHr)}${extra.length ? ` (${extra.join(', ')})` : ''}`);
    }
    if (isNum(l.spm)) parts.push(`${round(l.spm)} spm`);
    return `Lap ${l.n}: ${parts.join(', ') || 'n/a'}`;
  }

  /* activity: Strava DetailedActivity; split: result of buildSplits/splitsFromStravaMetric;
     weather: result of summarizeWeather (or null); zones: heart_rate.zones array (or null);
     laps: result of buildLaps (or null). Laps are only listed when there is more than one, since a
     single lap is just the whole run again. */
  function format(activity, split, weather, zones, laps) {
    const a = activity || {};
    const start = parseLocal(a.start_date_local) || new Date();
    const km = (a.distance || 0) / 1000;
    const movingSec = a.moving_time || 0;
    const gain = isNum(a.total_elevation_gain) ? a.total_elevation_gain : (split && isNum(split.gain) ? split.gain : null);
    const loss = split && isNum(split.loss) ? split.loss : null;
    const L = [];
    L.push(a.name || 'Run');
    L.push(`Date: ${fmtDate(start)}, ${hm(start)}`);
    L.push(`Distance: ${km.toFixed(2)} km`);
    L.push(`Avg Pace: ${fmtPace(km > 0 ? movingSec / km : NaN)} /km`);
    let mt = `Moving Time: ${fmtDuration(movingSec)}`;
    if (isNum(a.elapsed_time) && a.elapsed_time - movingSec >= 30) mt += ` (elapsed ${fmtDuration(a.elapsed_time)})`;
    L.push(mt);
    L.push(`Elevation Gain / Loss: ${isNum(gain) ? metres(gain, '+') : 'n/a'} / ${isNum(loss) ? metres(loss, '-') : 'n/a'}`);
    L.push(`Calories: ${isNum(a.calories) ? `${round(a.calories)} kcal` : 'n/a'}`);
    if (isNum(a.average_heartrate)) {
      const z = hrZone(a.average_heartrate, zones);
      let h = `${round(a.average_heartrate)} bpm${z ? ` (Z${z})` : ''}`;
      if (isNum(a.max_heartrate)) h += `, max ${round(a.max_heartrate)} bpm`;
      L.push(`Average HR: ${h}`);
    } else L.push('Average HR: n/a');
    const spm = toSpm(a.average_cadence);
    L.push(`Average Cadence: ${spm ? `${round(spm)} spm` : 'n/a'}`);
    L.push(`RPE: ${isNum(a.perceived_exertion) ? `${a.perceived_exertion}/10` : '__/10'}`);
    L.push(`Conditions: ${conditionsLine(start, weather)}`);
    L.push('Splits (per km):');
    if (split && split.splits && split.splits.length) split.splits.forEach(s => L.push(formatSplit(s, zones)));
    else L.push('(no split data for this activity)');
    if (Array.isArray(laps) && laps.length > 1) {
      L.push('Laps (as recorded on watch):');
      laps.forEach(l => L.push(formatLap(l, zones)));
    }
    return L.join('\n');
  }

  return {
    ELEVATION_THRESHOLD_M, RUN_TYPES,
    fmtDuration, fmtPace, parseLocal, ymd, hm, fmtDate, timeOfDay, ianaTimezone,
    elevationIncrements, hrZone, toSpm, prepareStreams, segmentStats, buildSplits, buildLaps, splitsFromStravaMetric,
    cloudWords, compass, wmoWords, weatherRequest, summarizeWeather, conditionsLine, metres, formatSplit, formatLap, format,
  };
});
