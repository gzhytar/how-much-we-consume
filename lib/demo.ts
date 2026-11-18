// Synthetic household so the dashboard can be built and checked without a meter (DEMO=1).
// DEMO_EXTRA_W=3000 adds a load to L1 for the last 15 minutes, to preview the alert state.

import type { Sample } from "./energy";
import { DAY, MINUTE, pragueLocal } from "./time";

const EXTRA_WINDOW = 15 * MINUTE;

/** Typical family load per phase in W (L1 kitchen, L2 living, L3 water heater + laundry). */
export function demoPhases(ms: number): number[] {
  const { hour, isoWeekday, minuteOfDay } = pragueLocal(ms);
  const weekend = isoWeekday >= 6;
  let l1 = 60; // fridge
  let l2 = 120; // router, standby
  let l3 = 0;
  if (hour >= 6 && hour < 8) l1 += 900; // breakfast, kettle
  if (hour >= 11 && hour < 13 && weekend) l1 += 1400; // cooking at home
  if (hour >= 17 && hour < 21) {
    l1 += 700; // cooking
    l2 += 400; // lights, TV
  }
  if (hour >= 21 && hour < 23) l2 += 400;
  if (hour >= 0 && hour < 5) l3 += 1600; // water heater in NT
  // Pseudo-random spikes (washing machine, oven) that recur in 10-minute blocks.
  const seed = Math.sin(Math.floor(ms / (10 * MINUTE)) * 12.9898) * 43758.5453;
  const r = seed - Math.floor(seed);
  if (r > 0.93) l3 += 2000;
  l2 += 60 * Math.sin(minuteOfDay / 7) + 60;
  return [l1, l2, l3];
}

function extraW(): number {
  const v = Number(process.env.DEMO_EXTRA_W);
  return Number.isFinite(v) ? v : 0;
}

function sampleAt(t: number, wh: number, now: number): Sample {
  const phases = demoPhases(t);
  if (t > now - EXTRA_WINDOW) phases[0] += extraW();
  return { ts: t, wh, w: phases.reduce((a, b) => a + b, 0), phases };
}

export function generateDemoSamples(now: number, days = 15, stepMs = MINUTE): Sample[] {
  const out: Sample[] = [];
  let wh = 1_234_000;
  const start = Math.floor((now - days * DAY) / stepMs) * stepMs;
  for (let t = start; t <= now; t += stepMs) {
    const s = sampleAt(t, wh, now + MINUTE);
    out.push(s);
    wh += (s.w * stepMs) / 3_600_000;
  }
  return out;
}

/** The next demo reading after `last`, as if the meter had been read now. */
export function nextDemoSample(last: Sample | null, now: number): Sample {
  if (!last) return sampleAt(now, 1_234_000, now);
  const s = sampleAt(now, 0, now);
  return { ...s, wh: last.wh + ((last.w + s.w) / 2) * ((now - last.ts) / 3_600_000) };
}
