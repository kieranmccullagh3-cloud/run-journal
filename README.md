# Run Journal

A single-page web app that turns a Strava run into a plain-text "journal entry" you can paste
into your trainers' app. It runs entirely in the browser: no server, nothing on your laptop
needs to be switched on. Host the three files anywhere static and open the page from your phone,
desktop or work computer.

Example output:

```
Morning Run
Date: Sat 12 Sep 2026, 06:12
Distance: 10.02 km
Avg Pace: 5:12 /km
Moving Time: 52:08 (elapsed 53:30)
Elevation Gain / Loss: +124 m / -118 m
Calories: 612 kcal
Average HR: 152 bpm (Z3), max 171 bpm
Average Cadence: 172 spm
RPE: 6/10
Conditions: morning (06:12), 11 °C (feels like 9 °C), partly cloudy (42% cloud), 78% humidity, wind 13 km/h from SW
Splits (per km):
km 1: 5:20 /km, +12 m / -5 m, HR 145 (Z2), 168 spm
km 2: 5:10 /km, +3 m / -14 m, HR 151 (Z2), 172 spm
...
last 0.42 km: 4:58 /km, 0 m / -2 m, HR 163 (Z3), 176 spm
Laps (as recorded on watch):
Lap 1: 10:00 (1.92 km), 5:12 /km, +8 m / -6 m, HR 141 (Z2, max 150), 168 spm
Lap 2: 3:00 (0.82 km), 3:40 /km, +1 m / -2 m, HR 165 (Z3, max 174), 180 spm
Lap 3: 2:00 (0.34 km), 5:53 /km, 0 m / -1 m, HR 148 (Z2, max 166), 164 spm
...
```

The "Laps" section lists every lap your watch recorded (lap button or auto-lap), so interval and
fartlek sessions show each effort on its own. It is left out when the run has only one lap.

## Files

| File | Purpose |
|---|---|
| `index.html` | Page layout and styles |
| `app.js` | Strava sign-in (OAuth), Strava API calls, Open-Meteo weather, copy/share |
| `journal.js` | Pure logic: per-km splits, elevation gain/loss, HR zones, weather summary, text formatting |
| `test/journal.test.js` | Unit tests for the journal logic |
| `sync/` | Mac-only CSV sync: `setup.js` (one-time Strava sign-in), `strava-sync.js` (the sync), `install-schedule.sh` (twice-daily launchd job) |
| `test/sync.test.js` | Sync tests against a fake Strava and weather server |

## Setup (once)

### 1. Host the page

Strava has to redirect back to a real web address, so the page cannot run from a `file://` path.
Any static host works. The simplest free option is GitHub Pages:

1. Create a **public** repository and push `index.html`, `app.js`, `journal.js` to it. (GitHub Pages
   on a private repository needs a paid GitHub plan. The code contains no secrets, so public is fine:
   your Client Secret is typed into the browser later and never lives in the repo.)
2. In the repo: Settings → Pages → Source: "Deploy from a branch", branch `main`, folder `/ (root)`.
3. After a minute your page is at `https://<your-user>.github.io/<repo>/`.

Alternatives: Netlify Drop (drag the folder onto app.netlify.com/drop), Cloudflare Pages, or any
web space you already have. For testing on your own machine run `python3 -m http.server 8765`
inside the folder and open `http://localhost:8765/`.

### 2. Create a Strava API application

1. Open https://www.strava.com/settings/api and create an application. Name and description are
   up to you; category "Data Importer"; website can be your page's address.
2. Set **Authorization Callback Domain** to the host name of your page only, without `https://`
   or a path. For GitHub Pages that is `<your-user>.github.io`. For local testing use `localhost`.
   The app's Settings screen shows you the exact value to use.
3. Note the **Client ID** and **Client Secret**.

### 3. Connect

Open the page, press **Settings**, paste the Client ID and Client Secret, press
**Save & connect to Strava**, and approve the permissions on Strava (leave every box ticked:
`activity:read_all` is needed for private runs and `profile:read_all` for your HR zones).

You do this once per device. The credentials and the Strava tokens live only in that browser's
local storage and are only ever sent to strava.com. On a phone, use "Add to Home Screen" to make
it feel like an app.

## Using it

1. Open the page. Your recent runs are listed (tick "show all activity types" for anything else).
2. Tap a run. The app fetches the activity, its per-second streams, your HR zones and the weather
   for that hour and place, then shows the journal text.
3. Edit anything you like (RPE is left as `__/10` when it was not recorded in Strava), then
   **Copy** (or **Share** on a phone) and paste into the trainers' app.

## Where each number comes from

| Line | Source |
|---|---|
| Title, date, distance, pace, moving/elapsed time, calories, average/max HR, cadence, RPE | Strava activity (`perceived_exertion` is the RPE you enter in Strava after a run) |
| Elevation gain | Strava's official total |
| Elevation loss and per-km gain/loss | Computed from Strava's altitude stream (2 m hysteresis), scaled so per-km gains add up to Strava's official total |
| Per-km pace, moving time, avg HR, cadence | Computed from Strava's streams using Strava's own "moving" flags. Cadence is doubled to steps/min the way the Strava UI does |
| Laps | Strava's lap records for the activity (distance, time); elevation, HR and cadence for each lap are computed from the streams over that lap's samples |
| HR zones | Your zones from Strava (Settings → My Performance); falls back to no zone label |
| Conditions | Open-Meteo (free, no key) hourly data at the run's start location, averaged over the hours the run overlapped: temperature, feels-like, cloud cover, humidity, wind speed/direction/gusts, rain. Runs older than 5 days use the historical archive, because the forecast API only keeps about 60 days of history; if one source comes back empty the other is tried |

Runs without GPS or streams (treadmill, manual entries) fall back to Strava's own per-km splits,
which have no cadence and only net elevation; weather is skipped when there is no location.

## Privacy notes

* Nothing is sent anywhere except strava.com (your data) and open-meteo.com (only a
  latitude/longitude rounded by the API and a date).
* The Client Secret sits in the browser's local storage. That is acceptable for a personal,
  single-user app; do not share the hosted page with anyone else. If you would rather not have the
  code public, host on Netlify Drop or Cloudflare Pages instead of GitHub Pages.
* To revoke access later: Strava → Settings → My Apps → Revoke, and press Disconnect in the page.

## Tweaks

* `ELEVATION_THRESHOLD_M` at the top of `journal.js` controls how much a climb has to rise before
  it counts. Raise it if per-km elevation looks noisy.
* The output wording is all in `format()` in `journal.js`.
* `?demo=1` on the page address shows the output with synthetic data, no Strava needed.

## Tests

```bash
npm test
```

## CSV sync (Mac)

A small Node script saves every Strava activity as one row of
`~/Documents/jarvis-inputs/strava/activities.csv`, twice a day. It reuses the web app's calculations,
so the numbers match the journal text exactly.

### How it works, and why

* **Incremental.** The first run backfills the last 90 days. Later runs fetch only activities newer than
  the latest row, plus anything from the last 3 days again, so an RPE or title you add after a run
  still lands in the CSV. Rows are keyed by Strava activity ID, so re-runs never duplicate.
* **Every activity type, detail for runs.** All activities get a row (the file is "activities").
  Streams, per-km splits, laps and cadence are fetched only for runs, which is where they mean
  something and keeps each sync inside Strava's read limit of 100 requests per 15 minutes.
* **Rate-limit safe.** At most 40 activities per run (about 2 requests each). If Strava still returns
  "429 Too Many Requests", the script saves what it has and the next run carries on.
* **Safe for readers.** The CSV is written to a temporary file and renamed into place, so anything
  reading it never sees a half-written file.
* **One line per activity.** Splits and laps sit in the `splits_json` and `laps_json` columns as JSON
  arrays rather than multi-line text, so line-based tools still work.
* **Credentials.** Tokens live in `~/.config/run-journal/strava.json`, readable only by your user.
  Strava issues a new refresh token on refresh and retires the old one, so the file is rewritten
  after each refresh. A plain file was chosen over the Keychain because an unattended job has to
  rewrite it regularly, and Keychain prompts can block a background job.
* **Scheduler.** A user-level launchd job (no sudo) at 09:15 and 21:15 local time. Unlike cron,
  launchd runs a slot that was missed while the Mac slept as soon as it wakes (see `man launchd.plist`).

### Columns

| Column | Meaning |
|---|---|
| `activity_id`, `name`, `sport_type`, `strava_url`, `device_name` | Identity of the activity |
| `start_local`, `start_utc`, `timezone`, `time_of_day` | When it started (local wall-clock and UTC) |
| `distance_km`, `moving_time_s`, `elapsed_time_s`, `moving_time` | Distance and duration |
| `avg_pace_min_per_km`, `avg_pace_s_per_km` | Average moving pace (runs only) |
| `elevation_gain_m`, `elevation_loss_m` | Strava's gain; loss computed from the altitude stream (runs) |
| `calories_kcal`, `avg_hr_bpm`, `max_hr_bpm`, `avg_hr_zone`, `avg_cadence_spm`, `rpe` | Effort |
| `temp_c`, `feels_like_c`, `humidity_pct`, `cloud_cover_pct`, `wind_kmh`, `wind_gust_kmh`, `wind_from`, `precip_mm`, `conditions` | Open-Meteo weather averaged over the activity's hours |
| `lap_count`, `splits_json`, `laps_json` | Per-km splits and watch laps as JSON arrays (runs) |
| `synced_at_utc` | When this row was last written |

Missing values are empty cells.

### Run Card

**Prerequisites**

* macOS with Node 18 or later (`node --version`).
* The Strava API application you already use for the web app (Client ID and Secret from
  https://www.strava.com/settings/api). No changes to it are needed: Strava always allows
  `localhost` as a callback.

**One-time setup**

```bash
cd ~/run-journal && node sync/setup.js
```

Type the Client ID and Secret when asked (the Secret is hidden), approve on the Strava page that
opens, and wait for "Connected as …".

Then install the schedule:

```bash
cd ~/run-journal && ./sync/install-schedule.sh
```

**Run it by hand**

```bash
cd ~/run-journal && node sync/strava-sync.js
```

Or trigger the scheduled job immediately:

```bash
launchctl kickstart gui/$(id -u)/com.run-journal.strava-sync
```

**Pass checks**

* The script prints a line starting `OK: added N, updated N, total N rows`.
* `~/Documents/jarvis-inputs/strava/activities.csv` exists and its first line is the column header.
* `launchctl print gui/$(id -u)/com.run-journal.strava-sync` shows the job, and after 09:15 or
  21:15 the log has a fresh `OK:` line:

```bash
tail -n 5 ~/Library/Logs/run-journal-sync.log
```

**Top failure modes**

| Symptom in the log | Cause | Fix |
|---|---|---|
| `AUTH: … Run: node sync/setup.js` | Strava retired the refresh token (for example a newer sign-in elsewhere) or access was revoked | Run `node sync/setup.js` again and choose to reuse the saved Client ID |
| `PERMISSION: macOS blocked access …` | macOS privacy protection on `~/Documents` blocked the background job | System Settings > Privacy & Security > Files and Folders: allow `node` to access Documents, then kickstart the job |
| `… left for next run` | Rate limit or the 40-per-run cap during a big backfill | Nothing: the next run continues. Or run by hand again after 15 minutes |
| Blank weather columns for runs that have a location | Open-Meteo was unreachable during that sync | Re-fetch them: `node sync/strava-sync.js --refresh-days 14` (keep the window small enough to fit one run) |
| No new log lines at all | The Mac was shut down at both times, or `node` moved (for example after a Node upgrade to a new path) | Kickstart by hand; re-run `./sync/install-schedule.sh` after changing Node |
| Web app says "sign-in needs renewing" | The sync's refresh retired the browser's token | Press "Save & connect to Strava" once on that device |

**Remove it**

```bash
cd ~/run-journal && ./sync/install-schedule.sh uninstall
```
