# Kolik spotřebujeme

A TV dashboard that shows what the household's electricity costs: the **past hour** and the **past 24 hours** in CZK, the current power, VT/NT tariff and when it changes, and an hourly chart. A tile turns amber or red when the cost crosses a fixed CZK limit or is well above usual for that time of day.

```
cron-job.org (every 1 min) ─► /api/collect ─► Shelly Cloud API ─► Upstash Redis
Google TV (Fully Kiosk) ─► /?t=TOKEN ─► /api/summary (every 60 s)
```

## How the numbers are made

- **Cost** comes from the meter's cumulative energy counter (`emdata:0.total_act`, Wh), not from instant power. The energy between two readings is exact. It is spread evenly over the interval, so a reading gap is split proportionally across hours and VT/NT windows. A counter reset counts as 0.
- **VT/NT** follows Europe/Prague local time, using the EG.D HDO schedule for your code. The schedule is downloaded from `https://hdo.distribuce24.cz/casy`, the same data egd.cz and the Home Assistant EG.D integrations use, and cached for 24 h. If that fails, `HDO_FALLBACK` is used and the footer says so.
- **Fixed limits:** amber from 80 % of `LIMIT_HOUR_CZK` / `LIMIT_DAY_CZK`, red from 100 %.
- **Usual usage** is switched on after 7 days of history.
  - Past hour: compared with the median of the same hour on the last 14 days, weekdays with weekdays and weekends with weekends.
  - Past 24 h: compared with the median of the previous 14 days.
  - Amber above 1.3×, red above 1.6×, but only when the difference is at least 2 CZK (hour) or 15 CZK (day).
- **Storage:** every reading is kept for 2 h, then one per 5 min for 35 days.
- **Upstash free tier** (500k commands and 10 GB bandwidth a month): the 1-minute collector uses about 190k commands. Each dashboard poll (every 60 s) uses about 4 commands and reads about 130 KB. With the TV showing the page 24 h a day, that adds about 175k commands and 5.5 GB, for a total of about 365k commands. At 12 h a day it's about half that. If the dashboard runs on several screens at once, watch the Upstash usage page.

## Setup

1. **Shelly Cloud**
   - In the Shelly app, make sure the Pro 3EM is connected to the cloud.
   - Under *User settings → Authorization cloud key*, copy the **key** and the **server** (e.g. `shelly-123-eu.shelly.cloud`).
   - The device ID is under *Device → Settings → Device information*. It's also the last part of the local hostname `shellypro3em63-<id>.local`.
2. **Vercel**
   - Import this repo as a new project.
   - Under *Storage*, add **Upstash for Redis** from the Marketplace (free plan). This sets `KV_REST_API_URL` / `KV_REST_API_TOKEN`.
   - Add the other variables from `.env.example`. `DASHBOARD_TOKEN` and `COLLECT_SECRET` are mandatory in production; generate them with `openssl rand -hex 24`.
3. **Every-minute reading**
   - Vercel Hobby cron can only run once a day. Create a free job at <https://cron-job.org>: URL `https://<your-app>.vercel.app/api/collect?key=<COLLECT_SECRET>`, every 1 minute.
   - On Vercel Pro you can use a Vercel Cron instead. Set `CRON_SECRET` to the same value, and add `vercel.json` with `{"crons":[{"path":"/api/collect","schedule":"* * * * *"}]}`.
   - While the dashboard is open it also triggers a reading itself when the newest one is older than 90 s.
4. **EG.D HDO code**
   - Set `EGD_HDO_CODE` to the povel printed on the HDO receiver (e.g. `A1B4DP6`) or to the code shown on egd.cz *Časy platnosti nízkého tarifu*.
   - Also set `EGD_HDO_TARIFF` (e.g. `D25d`). Set `EGD_HDO_REGION` only if the footer asks for it.
5. **Google TV (Xiaomi)**
   - Install **Fully Kiosk Browser** (Play Store on the TV, or sideload).
   - Set the Start URL to `https://<your-app>.vercel.app/?t=<DASHBOARD_TOKEN>`.
   - Turn on *Keep screen on*. To use the page as a screensaver, use *Screensaver → Screensaver URL* with the same link.
   - Google TV's own screensaver can't show web pages.

## Local development

```bash
npm install
npm run dev:demo      # synthetic 15-day household at http://localhost:3000
npm test              # unit tests: tariff, DST, counter deltas, thresholds, HDO matching, Shelly parsing
cp .env.example .env.local && npm run dev   # with your real meter (data kept in memory without Redis)
```

To check the HDO matching against the live EG.D data:

```bash
curl -o /tmp/casy.json https://hdo.distribuce24.cz/casy && EGD_CASY_FILE=/tmp/casy.json npm test
```
