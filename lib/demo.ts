// Synthetic household so the dashboard can be built and checked without a meter (DEMO=1).

import type { Sample } from "./energy";
import { DAY, MINUTE, pragueLocal } from "./time";

/** Typical family load in W for a Prague local time, with some deterministic noise. */
export function demoPower(ms: number): number {
  const { hour, isoWeekday, minuteOfDay } = pragueLocal(ms);
  const weekend = isoWeekday >= 6;
  let w = 180; // fridge, router, standby
  if (hour >= 6 && hour < 8) w += 900; // breakfast, kettle
  if (hour >= 11 && hour < 13 && weekend) w += 1400; // cooking at home
  if (hour >= 17 && hour < 21) w += 1100; // cooking, lights, TV
  if (hour >= 21 && hour < 23) w += 400;
  if (hour >= 0 && hour < 5) w += 1600; // water heater in NT
  // Pseudo-random spikes (washing machine, oven) that recur by minute of day.
  const seed = Math.sin(Math.floor(ms / (10 * MINUTE)) * 12.9898) * 43758.5453;
  const r = seed - Math.floor(seed);
  if (r > 0.93) w += 2000;
  return w + 60 * Math.sin(minuteOfDay / 7);
}

export function generateDemoSamples(now: number, days = 15, stepMs = MINUTE): Sample[] {
  const out: Sample[] = [];
  let wh = 1_234_000;
  const start = Math.floor((now - days * DAY) / stepMs) * stepMs;
  for (let t = start; t <= now; t += stepMs) {
    const w = demoPower(t);
    out.push({ ts: t, wh, w });
    wh += (w * stepMs) / 3_600_000;
  }
  return out;
}

/** The next demo reading after `last`, as if the meter had been read now. */
export function nextDemoSample(last: Sample | null, now: number): Sample {
  if (!last) return { ts: now, wh: 1_234_000, w: demoPower(now) };
  const w = demoPower(now);
  return { ts: now, wh: last.wh + ((last.w + w) / 2) * ((now - last.ts) / 3_600_000), w };
}
