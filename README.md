# Kolik spotřebujeme

A TV dashboard whose job is to make the family **notice a rising cost and act right away**.

- **Right now** (the headline): what electricity costs at this moment in **Kč per hour**, averaged over one reading interval (`POLL_MINUTES`, default 3 minutes) so a kettle doesn't set it off. It's compared with the hourly limit and with what's usual at this time. Next to it, "Co teď běží" shows live power on each of the meter's three phases, which helps find what's running (name them with `PHASE_NAMES`).
- **Past hour** and **past 24 hours** in Kč, each against its limit and the usual level.
- **24 h trend** in the "Posledních 24 hodin" tile: one small bar per hour, the current hour in blue, hours over the hourly limit in red. It shows the shape of the day; the numbers stay in the tiles.
- **Kdy je elektřina levná:** the next 12 hours as expensive (VT) and cheap (NT) stretches with prices and times, plus one sentence on when to run the washing machine or dishwasher.
- Costs are shown in whole crowns, rounded up (8,1 Kč → 9 Kč). Tariff prices per kWh keep their decimals.
- A tile turns amber or red, and a banner says what to do. When data is out of date the numbers are dimmed and the banner says so.

```
Upstash QStash (every 3 min) ─► /api/collect ─► Shelly Cloud API ─► Upstash Redis
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
- **Upstash free tiers:**
  - QStash: the 3-minute schedule sends 480 messages a day. That's under the free daily cap, which the docs give as 1,000 and the pricing page as 500.
  - Redis (500k commands and 10 GB a month): the scheduled readings use about 100k commands. While the TV shows the page, it polls every 60 s and takes its own reading when the newest one is over 90 s old. That's about 10k commands and 180 MB per hour of screen time, so with the TV on all day the total is roughly 400k commands and 5.5 GB. If the page runs on several screens at once, watch the Upstash usage page.

## Setup

1. **Shelly Cloud**
   - In the Shelly app, make sure the Pro 3EM is connected to the cloud.
   - Under *User settings → Authorization cloud key*, copy the **key** and the **server** (e.g. `shelly-123-eu.shelly.cloud`).
   - The device ID is under *Device → Settings → Device information*. It's also the last part of the local hostname `shellypro3em63-<id>.local`.
2. **Vercel**
   - Import this repo as a new project. `vercel.json` pins the functions to Frankfurt (`fra1`), next to Shelly's EU cloud; create the Upstash databases in an EU region too.
   - Under *Storage*, add **Upstash for Redis** from the Marketplace (free plan). This sets `KV_REST_API_URL` / `KV_REST_API_TOKEN`.
   - Add the other variables from `.env.example`. `DASHBOARD_TOKEN` and `COLLECT_SECRET` are mandatory in production; generate them with `openssl rand -hex 24`.
3. **Readings every 3 minutes (Upstash QStash)**
   - Vercel Hobby cron can only run once a day, so QStash calls `/api/collect` on a schedule. Every call is signed, and the app checks the signature.
   - Add **QStash** in Vercel under *Storage* (Upstash in the Marketplace), or copy the keys from the QStash page of the Upstash console. Set `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY` and `QSTASH_NEXT_SIGNING_KEY` in Vercel, then redeploy.
   - Create the schedule once from your computer:
     `QSTASH_TOKEN=<token> npm run schedule -- https://<your-app>.vercel.app`
     Rerunning the command updates the same schedule. You can also create it in the console with the same settings: destination `https://<your-app>.vercel.app/api/collect`, method POST, cron `*/3 * * * *`, retries 0.
   - Other interval: prefix the command with `POLL_MINUTES=<n>` (1–30) and set the same `POLL_MINUTES` in Vercel. "Právě teď" is averaged over that window, and data counts as out of date after `max(5, n + 2)` minutes.
   - The app accepts only signatures made for its production URL (`VERCEL_PROJECT_PRODUCTION_URL`). If the schedule uses another domain, set `QSTASH_COLLECT_URL` to the exact destination URL.
   - Check the deliveries under *QStash → Logs*. A 401 means a signing-key or URL mismatch, and it's logged in Vercel as `QStash signature rejected (…)`. Keep Vercel Deployment Protection off for production, or QStash can't reach the app.
   - Alternatives: a free <https://cron-job.org> job calling `/api/collect?key=<COLLECT_SECRET>`, or on Vercel Pro a Vercel Cron with `CRON_SECRET`.
   - While the dashboard is open it also takes a reading itself when the newest one is older than 90 s, so the live power stays current.
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
DEMO=1 DEMO_EXTRA_W=3500 npx next dev   # same, with an extra 3.5 kW for the last 15 min (alert state)
npm test              # unit tests: tariff, DST, counter deltas, thresholds, HDO matching, Shelly parsing, QStash signatures
cp .env.example .env.local && npm run dev   # with your real meter (data kept in memory without Redis)
```

To check the HDO matching against the live EG.D data:

```bash
curl -o /tmp/casy.json https://hdo.distribuce24.cz/casy && EGD_CASY_FILE=/tmp/casy.json npm test
```
