/* record.js — turns one Strava activity (+ streams, zones, weather) into a flat CSV row. Pure, no I/O. */
'use strict';
const J = require('../journal.js');

const COLUMNS = [
  'activity_id', 'name', 'sport_type', 'start_local', 'start_utc', 'timezone', 'time_of_day',
  'distance_km', 'moving_time_s', 'elapsed_time_s', 'moving_time', 'avg_pace_min_per_km', 'avg_pace_s_per_km',
  'elevation_gain_m', 'elevation_loss_m', 'calories_kcal',
  'avg_hr_bpm', 'max_hr_bpm', 'avg_hr_zone', 'avg_cadence_spm', 'rpe',
  'temp_c', 'feels_like_c', 'humidity_pct', 'cloud_cover_pct', 'wind_kmh', 'wind_gust_kmh', 'wind_from',
  'precip_mm', 'conditions',
  'lap_count', 'splits_json', 'laps_json', 'device_name', 'strava_url', 'synced_at_utc',
];

const isNum = x => typeof x === 'number' && isFinite(x);
// round to dp decimals; blank cell when the value is missing
const r = (x, dp) => { if (!isNum(x)) return ''; const f = Math.pow(10, dp || 0); return Math.round(x * f) / f; };
const pad2 = n => String(n).padStart(2, '0');
const localIso = d => `${J.ymd(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
const isRun = a => J.RUN_TYPES.includes(a.sport_type || a.type);

function segmentJson(s, zones, withLapFields) {
  const o = {
    n: s.n,
    km: r(s.km, 3),
    pace_s_per_km: isNum(s.paceSecPerKm) ? Math.round(s.paceSecPerKm) : null,
    moving_s: isNum(s.moving) ? Math.round(s.moving) : null,
    gain_m: isNum(s.gain) ? r(s.gain, 1) : null,
    loss_m: isNum(s.loss) ? r(s.loss, 1) : null,
    avg_hr: isNum(s.avgHr) ? Math.round(s.avgHr) : null,
    hr_zone: J.hrZone(s.avgHr, zones),
    spm: isNum(s.spm) ? Math.round(s.spm) : null,
  };
  if (withLapFields) { o.elapsed_s = isNum(s.elapsed) ? Math.round(s.elapsed) : null; o.max_hr = isNum(s.maxHr) ? Math.round(s.maxHr) : null; }
  else o.partial = !!s.partial;
  return o;
}

/* detail: Strava DetailedActivity; split/laps: Journal.buildSplits/buildLaps results (runs only, else null);
   weather: Journal.summarizeWeather result or null; zones: heart_rate.zones or null; now: Date. */
function toRecord(detail, split, laps, weather, zones, now) {
  const a = detail || {};
  const start = J.parseLocal(a.start_date_local);
  const km = (a.distance || 0) / 1000;
  const run = isRun(a);
  const paceS = run && km > 0 && a.moving_time ? a.moving_time / km : null;
  const loss = split && isNum(split.loss) ? split.loss : null;
  const w = weather || {};
  const splits = split && Array.isArray(split.splits) ? split.splits : [];
  const lapList = Array.isArray(laps) ? laps : [];
  return {
    activity_id: a.id,
    name: a.name || '',
    sport_type: a.sport_type || a.type || '',
    start_local: start ? localIso(start) : '',
    start_utc: a.start_date || '',
    timezone: J.ianaTimezone(a.timezone) || '',
    time_of_day: start ? J.timeOfDay(start.getHours()) : '',
    distance_km: r(km, 3),
    moving_time_s: isNum(a.moving_time) ? a.moving_time : '',
    elapsed_time_s: isNum(a.elapsed_time) ? a.elapsed_time : '',
    moving_time: isNum(a.moving_time) ? J.fmtDuration(a.moving_time) : '',
    avg_pace_min_per_km: paceS ? J.fmtPace(paceS) : '',
    avg_pace_s_per_km: paceS ? Math.round(paceS) : '',
    elevation_gain_m: r(a.total_elevation_gain, 1),
    elevation_loss_m: r(loss, 1),
    calories_kcal: r(a.calories, 0),
    avg_hr_bpm: r(a.average_heartrate, 0),
    max_hr_bpm: r(a.max_heartrate, 0),
    avg_hr_zone: J.hrZone(a.average_heartrate, zones) || '',
    avg_cadence_spm: run ? (J.toSpm(a.average_cadence) ? Math.round(J.toSpm(a.average_cadence)) : '') : '',
    rpe: isNum(a.perceived_exertion) ? a.perceived_exertion : '',
    temp_c: r(w.temp, 1),
    feels_like_c: r(w.feels, 1),
    humidity_pct: r(w.humidity, 0),
    cloud_cover_pct: r(w.cloud, 0),
    wind_kmh: r(w.wind, 0),
    wind_gust_kmh: r(w.gust, 0),
    wind_from: J.compass(w.windDir) || '',
    precip_mm: r(w.precip, 1),
    conditions: weather ? [J.cloudWords(w.cloud), J.wmoWords(w.code)].filter(Boolean).join(', ') : '',
    lap_count: Array.isArray(a.laps) ? a.laps.length : '',
    splits_json: splits.length ? JSON.stringify(splits.map(s => segmentJson(s, zones, false))) : '',
    laps_json: lapList.length > 1 ? JSON.stringify(lapList.map(l => segmentJson(l, zones, true))) : '',
    device_name: a.device_name || '',
    strava_url: a.id ? `https://www.strava.com/activities/${a.id}` : '',
    synced_at_utc: (now || new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

module.exports = { COLUMNS, toRecord, isRun };
