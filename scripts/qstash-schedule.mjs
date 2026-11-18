// Creates or updates the QStash schedule that takes a meter reading every POLL_MINUTES (default 3).
//   QSTASH_TOKEN=… [POLL_MINUTES=3] node scripts/qstash-schedule.mjs https://<your-app>.vercel.app
// Rerunning it updates the same schedule (fixed scheduleId) instead of adding another one.
// Set the same POLL_MINUTES in Vercel: the dashboard averages "Právě teď" over that window.
// Every 3 minutes = 480 messages/day, under the QStash free plan's daily cap.
import { Client } from "@upstash/qstash";

const SCHEDULE_ID = "collect-meter";
const POLL_MINUTES = Number(process.env.POLL_MINUTES?.trim() || 3);
if (!Number.isInteger(POLL_MINUTES) || POLL_MINUTES < 1 || POLL_MINUTES > 30) {
  console.error(`POLL_MINUTES must be a whole number 1–30, got "${process.env.POLL_MINUTES}"`);
  process.exit(1);
}
const CRON = `*/${POLL_MINUTES} * * * *`;

const origin = (process.argv[2] ?? process.env.APP_URL ?? "").replace(/\/+$/, "");
const token = process.env.QSTASH_TOKEN;
if (!/^https:\/\//.test(origin) || !token) {
  console.error("Usage: QSTASH_TOKEN=… node scripts/qstash-schedule.mjs https://<your-app>.vercel.app");
  process.exit(1);
}

const destination = `${origin}/api/collect`;
const client = new Client({ token, baseUrl: process.env.QSTASH_URL || undefined });
const { scheduleId } = await client.schedules.create({
  scheduleId: SCHEDULE_ID,
  destination,
  cron: CRON,
  method: "POST",
  // No retries: the next run comes in POLL_MINUTES, and a retry could hit Shelly Cloud's 1 request/s limit.
  retries: 0,
  timeout: 30,
});
console.log(`Schedule "${scheduleId}": POST ${destination} at "${CRON}" (UTC)`);
console.log(`Set POLL_MINUTES=${POLL_MINUTES} in Vercel so the dashboard averages over the same window.`);
console.log(`If ${origin} isn't the Vercel production domain, set QSTASH_COLLECT_URL=${destination} in Vercel.`);
