import { isNT, type Prices, type WeeklySchedule } from "./tariff";
import { MINUTE, floorMinute } from "./time";

/** One meter reading. `wh` is the cumulative imported-energy counter, `w` the live power. */
export interface Sample {
  ts: number; // epoch ms
  wh: number;
  w: number;
  /** Live power per phase L1–L3 in W, when the meter reports it. */
  phases?: number[];
  /** Cumulative imported-energy counter per phase L1–L3 in Wh, when the meter reports it. */
  phaseWh?: number[];
}

/** A gap longer than this between two readings still has its energy spread out, but doesn't count as "covered". */
export const MAX_COVERED_GAP = 15 * MINUTE;

export interface MinuteCell {
  kwh: number;
  czk: number;
  ntKwh: number;
  coveredMs: number;
}

/** Energy and cost per minute (keyed by the minute's start, epoch ms). */
export type Ledger = Map<number, MinuteCell>;

/**
 * Turns cumulative-counter readings into per-minute energy and cost.
 * The energy between two readings is exact (counter delta); it is spread evenly over the
 * interval, so a gap is split proportionally across hours and VT/NT windows.
 * A negative delta (counter reset, device replaced) contributes nothing.
 */
export function buildLedger(samples: Sample[], schedule: WeeklySchedule, prices: Prices): Ledger {
  const ledger: Ledger = new Map();
  const sorted = [...samples].sort((a, b) => a.ts - b.ts);
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    const dt = b.ts - a.ts;
    if (dt <= 0) continue;
    const dWh = Math.max(0, b.wh - a.wh);
    const covered = dt <= MAX_COVERED_GAP;
    let t = a.ts;
    while (t < b.ts) {
      const minute = floorMinute(t);
      const end = Math.min(minute + MINUTE, b.ts);
      const share = (end - t) / dt;
      const kwh = (dWh * share) / 1000;
      const nt = isNT(schedule, minute);
      let cell = ledger.get(minute);
      if (!cell) {
        cell = { kwh: 0, czk: 0, ntKwh: 0, coveredMs: 0 };
        ledger.set(minute, cell);
      }
      cell.kwh += kwh;
      cell.czk += kwh * (nt ? prices.nt : prices.vt);
      if (nt) cell.ntKwh += kwh;
      if (covered) cell.coveredMs += end - t;
      t = end;
    }
  }
  return ledger;
}

export interface RangeTotal {
  kwh: number;
  czk: number;
  ntKwh: number;
  /** Share of the range with readings no more than MAX_COVERED_GAP apart, 0…1. */
  coverage: number;
}

/** Sums the ledger over [from, to). `from`/`to` are floored to whole minutes. */
export function sumRange(ledger: Ledger, from: number, to: number): RangeTotal {
  const start = floorMinute(from);
  const end = floorMinute(to);
  let kwh = 0;
  let czk = 0;
  let ntKwh = 0;
  let covered = 0;
  for (let m = start; m < end; m += MINUTE) {
    const cell = ledger.get(m);
    if (!cell) continue;
    kwh += cell.kwh;
    czk += cell.czk;
    ntKwh += cell.ntKwh;
    covered += cell.coveredMs;
  }
  const span = end - start;
  return { kwh, czk, ntKwh, coverage: span > 0 ? Math.min(1, covered / span) : 0 };
}
