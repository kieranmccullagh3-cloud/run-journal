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
last 0.42 km: 4:58 /km, +0 m / -2 m, HR 163 (Z3), 176 spm
```

## Files

| File | Purpose |
|---|---|
| `index.html` | Page layout and styles |
| `app.js` | Strava sign-in (OAuth), Strava API calls, Open-Meteo weather, copy/share |
| `journal.js` | Pure logic: per-km splits, elevation gain/loss, HR zones, weather summary, text formatting |
| `test/journal.test.js` | Unit tests (`node --test test/`) |

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
| HR zones | Your zones from Strava (Settings → My Performance); falls back to no zone label |
| Conditions | Open-Meteo (free, no key) hourly data at the run's start location, averaged over the hours the run overlapped: temperature, feels-like, cloud cover, humidity, wind speed/direction/gusts, rain |

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
node --test test/
```
