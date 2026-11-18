import { sumRange, type Ledger } from "./energy";
import { DAY, isWeekend } from "./time";

export type Level = "ok" | "warn" | "alert";

const RANK: Record<Level, number> = { ok: 0, warn: 1, alert: 2 };

export function worst(...levels: (Level | null | undefined)[]): Level {
  let out: Level = "ok";
  for (const l of levels) if (l && RANK[l] > RANK[out]) out = l;
  return out;
}

/** Fixed CZK limit: amber from 80 %, red from 100 %. */
export function levelFromLimit(czk: number, limit: number): Level {
  if (!(limit > 0)) return "ok";
  if (czk >= limit) return "alert";
  if (czk >= 0.8 * limit) return "warn";
  return "ok";
}

/**
 * Compared to usual usage: amber above 1.3× the median, red above 1.6×.
 * `minExtraCzk` avoids alarms when both numbers are tiny (e.g. 0.40 vs 0.20 CZK).
 */
export function levelFromBaseline(czk: number, median: number, minExtraCzk: number): Level {
  if (!(median > 0)) return "ok";
  if (czk - median < minExtraCzk) return "ok";
  if (czk > 1.6 * median) return "alert";
  if (czk > 1.3 * median) return "warn";
  return "ok";
}

export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export interface Baseline {
  median: number;
  days: number; // how many past days went into the median
}

export interface BaselineOptions {
  lookbackDays?: number; // default 14
  sameDayType?: boolean; // compare weekdays with weekdays, weekends with weekends
  minDays?: number; // minimum usable days, default 3
  minCoverage?: number; // default 0.9
}

/**
 * Median cost of the same time window on previous days.
 * Each past window is the current one shifted back by whole 24 h steps. Across a DST change
 * that is one local hour off for a single day. That's accepted, because a median is robust to it.
 */
export function baselineFor(
  ledger: Ledger,
  from: number,
  to: number,
  opts: BaselineOptions = {},
): Baseline | null {
  const { lookbackDays = 14, sameDayType = false, minDays = 3, minCoverage = 0.9 } = opts;
  const mid = (from + to) / 2;
  const weekend = isWeekend(mid);
  const values: number[] = [];
  for (let d = 1; d <= lookbackDays; d++) {
    const shift = d * DAY;
    if (sameDayType && isWeekend(mid - shift) !== weekend) continue;
    const r = sumRange(ledger, from - shift, to - shift);
    if (r.coverage >= minCoverage) values.push(r.czk);
  }
  if (values.length < minDays) return null;
  return { median: median(values), days: values.length };
}
