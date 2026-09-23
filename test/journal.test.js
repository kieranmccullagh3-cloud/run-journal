const test = require('node:test');
const assert = require('node:assert/strict');
const J = require('../journal.js');

function syntheticStreams(n, opts = {}) {
  const time = [], dist = [], alt = [], hr = [], cad = [], mov = [];
  let d = 0;
  for (let i = 0; i < n; i++) {
    const moving = opts.pauses ? (i % 700) < 690 : true;
    d += moving ? 3.2 : 0;
    time.push(i); dist.push(d); mov.push(moving);
    alt.push(50 + 10 * Math.sin(i / 300));
    hr.push(140 + (i > n / 2 ? 20 : 0));
    cad.push(85);
  }
  return { time: { data: time }, distance: { data: dist }, altitude: { data: alt }, heartrate: { data: hr }, cadence: { data: cad }, moving: { data: mov } };
}

test('fmtDuration / fmtPace', () => {
  assert.equal(J.fmtDuration(65), '1:05');
  assert.equal(J.fmtDuration(3661), '1:01:01');
  assert.equal(J.fmtPace(312), '5:12');
  assert.equal(J.fmtPace(NaN), 'n/a');
});

test('parseLocal treats Strava local time as wall-clock', () => {
  const d = J.parseLocal('2026-09-12T06:12:00Z');
  assert.equal(d.getHours(), 6); assert.equal(d.getMinutes(), 12); assert.equal(d.getDate(), 12);
  assert.equal(J.fmtDate(d), 'Sat 12 Sep 2026');
  assert.equal(J.timeOfDay(6), 'morning');
});

test('ianaTimezone', () => {
  assert.equal(J.ianaTimezone('(GMT+10:00) Australia/Melbourne'), 'Australia/Melbourne');
  assert.equal(J.ianaTimezone('(GMT-05:00) America/New_York'), 'America/New_York');
  assert.equal(J.ianaTimezone(undefined), null);
});

test('elevationIncrements ignores wobble below threshold', () => {
  const r = J.elevationIncrements([0, 1, 0.5, 2, 1.5, 3, 0, 1], 2);
  assert.equal(Math.round(r.gain), 3);   // one clean climb 0 -> 3
  assert.equal(Math.round(r.loss), 3);   // then 3 -> 0
});

test('hrZone with Strava-style zones', () => {
  const zones = [{ min: 0, max: 115 }, { min: 115, max: 152 }, { min: 152, max: 171 }, { min: 171, max: 190 }, { min: 190, max: -1 }];
  assert.equal(J.hrZone(100, zones), 1);
  assert.equal(J.hrZone(152, zones), 3);
  assert.equal(J.hrZone(200, zones), 5);
  assert.equal(J.hrZone(null, zones), null);
});

test('toSpm doubles single-leg cadence only', () => {
  assert.equal(J.toSpm(85), 170);
  assert.equal(J.toSpm(172), 172);
  assert.equal(J.toSpm(0), null);
});

test('buildSplits produces per-km splits with a partial last split', () => {
  const s = syntheticStreams(3300, { pauses: true });
  const r = J.buildSplits(s, {});
  const total = s.distance.data[3299];
  assert.equal(r.splits.length, Math.floor(total / 1000) + 1);
  const first = r.splits[0];
  assert.ok(Math.abs(first.km - 1) < 0.005, 'first split ~1 km');
  assert.equal(first.partial, false);
  assert.ok(Math.abs(first.paceSecPerKm - 1000 / 3.2) < 3, 'pace ~ 5:12');
  assert.equal(first.spm, 170);
  assert.equal(Math.round(first.avgHr), 140);
  const last = r.splits[r.splits.length - 1];
  assert.equal(last.partial, true);
  assert.ok(last.km < 1);
  // moving time excludes pauses: total moving across splits equals count of moving samples (minus first)
  const movingTotal = r.splits.reduce((a, x) => a + x.moving, 0);
  assert.ok(movingTotal < 3299, 'pauses removed');
  // gain and loss roughly balance on a sine profile
  assert.ok(Math.abs(r.gain - r.loss) < 15);
});

test('buildSplits scales gain/loss to Strava official total', () => {
  const s = syntheticStreams(2000);
  const raw = J.buildSplits(s, {});
  const scaled = J.buildSplits(s, { officialGain: raw.gain * 2 });
  assert.ok(Math.abs(scaled.gain - raw.gain * 2) < 1e-6);
  const sum = scaled.splits.reduce((a, x) => a + x.gain, 0);
  assert.ok(Math.abs(sum - scaled.gain) < 1e-6, 'splits sum to header gain');
});

test('buildSplits handles missing/partial streams', () => {
  assert.deepEqual(J.buildSplits(null, {}).splits, []);
  const s = syntheticStreams(1500);
  delete s.altitude; delete s.heartrate; delete s.cadence; delete s.moving;
  const r = J.buildSplits(s, {});
  assert.equal(r.splits.length, 5); // 1500 samples * 3.2 m = 4.8 km -> 4 full + 1 partial
  assert.equal(r.splits[0].gain, null);
  assert.equal(r.splits[0].avgHr, null);
  assert.equal(r.gain, null);
});

test('splitsFromStravaMetric fallback', () => {
  const r = J.splitsFromStravaMetric([
    { distance: 1000, elapsed_time: 320, moving_time: 315, elevation_difference: 4.2, average_heartrate: 150 },
    { distance: 1000, elapsed_time: 330, moving_time: 330, elevation_difference: -3, average_heartrate: 155 },
    { distance: 12, elapsed_time: 4, moving_time: 4, elevation_difference: 0 },
  ]);
  assert.equal(r.splits.length, 2);
  assert.equal(r.splits[0].gain, 4.2); assert.equal(r.splits[0].loss, 0);
  assert.equal(r.splits[1].loss, 3);
  assert.equal(r.splits[1].avgHr, 155);
});

test('summarizeWeather averages the hours the run overlapped', () => {
  const hourly = {
    time: ['2026-09-12T05:00', '2026-09-12T06:00', '2026-09-12T07:00', '2026-09-12T08:00'],
    temperature_2m: [8, 10, 12, 16], apparent_temperature: [6, 8, 10, 15], relative_humidity_2m: [90, 80, 70, 60],
    cloud_cover: [100, 40, 20, 0], wind_speed_10m: [5, 10, 14, 30], wind_gusts_10m: [8, 18, 30, 50],
    wind_direction_10m: [350, 10, 30, 90], precipitation: [0, 0, 0.3, 0], weather_code: [3, 2, 1, 0],
  };
  const start = J.parseLocal('2026-09-12T06:12:00Z');
  const w = J.summarizeWeather(hourly, start, 3600); // 06:12 -> 07:12 covers hours 06 and 07
  assert.equal(w.temp, 11); assert.equal(w.humidity, 75); assert.equal(w.cloud, 30); assert.equal(w.wind, 12);
  assert.equal(w.gust, 30); assert.equal(w.precip, 0.3); assert.equal(w.code, 2);
  assert.ok(Math.abs(w.windDir - 20) < 0.5, 'vector mean of 10 and 30');
  assert.equal(J.summarizeWeather(hourly, J.parseLocal('2026-09-13T06:00:00Z'), 60), null);
});

test('conditionsLine wording', () => {
  const start = J.parseLocal('2026-09-12T06:12:00Z');
  const line = J.conditionsLine(start, { temp: 11.2, feels: 9.1, humidity: 78, cloud: 42, wind: 13, gust: 24, windDir: 225, precip: 0, code: 2 });
  assert.equal(line, 'morning (06:12), 11 °C (feels like 9 °C), partly cloudy (42% cloud), 78% humidity, wind 13 km/h from SW (gusts 24 km/h)');
  assert.equal(J.conditionsLine(start, null), 'morning (06:12), weather unavailable');
});

test('format produces the full journal entry', () => {
  const s = syntheticStreams(3300, { pauses: true });
  const act = {
    name: 'Tempo Tuesday', start_date_local: '2026-09-08T17:40:00Z', distance: s.distance.data[3299],
    moving_time: 3250, elapsed_time: 3300, total_elevation_gain: 123, calories: 640,
    average_heartrate: 152.4, max_heartrate: 176, average_cadence: 85, perceived_exertion: 7,
  };
  const zones = [{ min: 0, max: 115 }, { min: 115, max: 152 }, { min: 152, max: 171 }, { min: 171, max: 190 }, { min: 190, max: -1 }];
  const text = J.format(act, J.buildSplits(s, { officialGain: 123 }), null, zones);
  const lines = text.split('\n');
  assert.equal(lines[0], 'Tempo Tuesday');
  assert.equal(lines[1], 'Date: Tue 8 Sep 2026, 17:40');
  assert.match(lines[2], /^Distance: 10\.\d\d km$/);
  assert.match(lines[3], /^Avg Pace: \d:\d\d \/km$/);
  assert.equal(lines[4], 'Moving Time: 54:10 (elapsed 55:00)');
  assert.match(lines[5], /^Elevation Gain \/ Loss: \+123 m \/ (-\d+|0) m$/);
  assert.equal(lines[6], 'Calories: 640 kcal');
  assert.equal(lines[7], 'Average HR: 152 bpm (Z3), max 176 bpm');
  assert.equal(lines[8], 'Average Cadence: 170 spm');
  assert.equal(lines[9], 'RPE: 7/10');
  assert.equal(lines[10], 'Conditions: evening (17:40), weather unavailable');
  assert.equal(lines[11], 'Splits (per km):');
  assert.match(lines[12], /^km 1: \d:\d\d \/km, (\+\d+|0) m \/ (-\d+|0) m, HR 140 \(Z2\), 170 spm$/);
  assert.equal(J.metres(0, '-'), '0 m'); assert.equal(J.metres(0.3, '-'), '0 m'); assert.equal(J.metres(4.6, '-'), '-5 m');
  assert.match(lines[lines.length - 1], /^last 0\.\d\d km: /);
  // missing fields degrade gracefully
  const bare = J.format({ name: 'Manual run', start_date_local: '2026-09-01T07:00:00Z', distance: 5000, moving_time: 1500 }, { splits: [] }, null, null);
  assert.match(bare, /Calories: n\/a/); assert.match(bare, /RPE: __\/10/); assert.match(bare, /\(no split data for this activity\)/);
});

test('buildLaps computes lap stats from streams with Strava distance/time', () => {
  const s = syntheticStreams(1200);
  const laps = [
    { lap_index: 1, start_index: 0, end_index: 180, distance: 576, elapsed_time: 180, moving_time: 180, average_heartrate: 999 },
    { lap_index: 2, start_index: 180, end_index: 300, distance: 384, elapsed_time: 120, moving_time: 120 },
    { lap_index: 3, start_index: 300, end_index: 1199, distance: 2877, elapsed_time: 899, moving_time: 899 },
  ];
  const r = J.buildLaps(laps, s, {});
  assert.equal(r.length, 3);
  assert.equal(r[0].n, 1);
  assert.ok(Math.abs(r[0].km - 0.576) < 1e-9);
  assert.equal(r[0].elapsed, 180);
  assert.ok(Math.abs(r[0].paceSecPerKm - 180 / 0.576) < 1e-9);
  assert.equal(Math.round(r[0].avgHr), 140, 'HR from streams, not the lap record');
  assert.equal(r[0].spm, 170);
  assert.ok(isFinite(r[0].gain) && isFinite(r[0].loss));
  assert.equal(Math.round(r[2].maxHr), 160);
});

test('buildLaps falls back to lap fields without streams', () => {
  const r = J.buildLaps([
    { lap_index: 1, distance: 800, elapsed_time: 200, moving_time: 195, total_elevation_gain: 3.2, average_heartrate: 158, max_heartrate: 170, average_cadence: 88 },
  ], null, {});
  assert.equal(r.length, 1);
  assert.equal(r[0].gain, 3.2); assert.equal(r[0].loss, null);
  assert.equal(r[0].avgHr, 158); assert.equal(r[0].maxHr, 170); assert.equal(r[0].spm, 176);
  assert.ok(Math.abs(r[0].paceSecPerKm - 195 / 0.8) < 1e-9);
  assert.deepEqual(J.buildLaps(undefined, null, {}), []);
});

test('formatLap and lap section in format', () => {
  const zones = [{ min: 0, max: 115 }, { min: 115, max: 152 }, { min: 152, max: 171 }, { min: 171, max: 190 }, { min: 190, max: -1 }];
  const line = J.formatLap({ n: 3, km: 0.82, elapsed: 180, moving: 180, paceSecPerKm: 180 / 0.82, gain: 1.2, loss: 2.4, avgHr: 165, maxHr: 174, spm: 180 }, zones);
  assert.equal(line, 'Lap 3: 3:00 (0.82 km), 3:40 /km, +1 m / -2 m, HR 165 (Z3, max 174), 180 spm');
  assert.equal(J.formatLap({ n: 1, km: 0, elapsed: 120, paceSecPerKm: NaN }, null), 'Lap 1: 2:00');
  const act = { name: 'Fartlek', start_date_local: '2026-09-23T18:00:00Z', distance: 5000, moving_time: 1500 };
  const two = J.format(act, { splits: [] }, null, null, [{ n: 1, km: 1, elapsed: 300 }, { n: 2, km: 1, elapsed: 290 }]);
  assert.match(two, /\nLaps \(as recorded on watch\):\nLap 1: 5:00 \(1\.00 km\)\nLap 2: 4:50 \(1\.00 km\)$/);
  const one = J.format(act, { splits: [] }, null, null, [{ n: 1, km: 5, elapsed: 1500 }]);
  assert.ok(!one.includes('Laps ('), 'a single lap is not listed');
});
