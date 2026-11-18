// Creates or updates the QStash schedule that takes a meter reading every 3 minutes.
//   QSTASH_TOKEN=… node scripts/qstash-schedule.mjs https://<your-app>.vercel.app
// Rerunning it updates the same schedule (fixed scheduleId) instead of adding another one.
// Every 3 minutes = 480 messages/day, under the QStash free plan's daily cap.
import { Client } from "@upstash/qstash";

const SCHEDULE_ID = "collect-meter";
const CRON = "*/3 * * * *";

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
  // No retries: the next run comes in 3 minutes, and a retry could hit Shelly Cloud's 1 request/s limit.
  retries: 0,
  timeout: 30,
});
console.log(`Schedule "${scheduleId}": POST ${destination} at "${CRON}" (UTC)`);
console.log(`If ${origin} isn't the Vercel production domain, set QSTASH_COLLECT_URL=${destination} in Vercel.`);
