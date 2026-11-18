import { MINUTE, pragueLocal } from "./time";

/** [startMinute, endMinute) within a local day, 0…1440. */
export type Window = [number, number];
/** Index 1…7 = Monday…Sunday (index 0 unused). Windows are low-tariff (NT) periods. */
export type WeeklySchedule = Window[][];

export type Tariff = "VT" | "NT";

export interface Prices {
  vt: number; // CZK per kWh, all-in incl. distribution and VAT
  nt: number;
}

export function emptySchedule(): WeeklySchedule {
  return Array.from({ length: 8 }, () => []);
}

export function parseHHMM(s: string): number {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s.trim());
  if (!m) throw new Error(`Neplatný čas "${s}" (očekáván HH:MM)`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59) throw new Error(`Neplatný čas "${s}"`);
  const total = h * 60 + min;
  // EG.D uses 23:59 as "end of day".
  return total >= 1439 ? 1440 : total;
}

/** Adds a window, splitting one that crosses midnight (e.g. 22:00-06:00) into two days. */
export function addWindow(schedule: WeeklySchedule, isoWeekday: number, start: number, end: number) {
  if (end > start) {
    schedule[isoWeekday].push([start, end]);
  } else if (end < start) {
    schedule[isoWeekday].push([start, 1440]);
    if (end > 0) schedule[(isoWeekday % 7) + 1].push([0, end]);
  }
}

export function normalizeSchedule(schedule: WeeklySchedule): WeeklySchedule {
  return schedule.map((windows) => {
    const sorted = [...windows].sort((a, b) => a[0] - b[0]);
    const merged: Window[] = [];
    for (const w of sorted) {
      const last = merged[merged.length - 1];
      if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1]);
      else merged.push([w[0], w[1]]);
    }
    return merged;
  });
}

/**
 * Parses HDO_FALLBACK. Two forms:
 *   "00:00-06:00,13:00-15:00"                       – same windows every day
 *   "1-5=00:00-06:00,13:00-15:00;6-7=00:00-08:00"   – per ISO weekday range
 */
export function parseFallback(spec: string): WeeklySchedule {
  const schedule = emptySchedule();
  const trimmed = spec.trim();
  if (!trimmed) return schedule;
  const groups = trimmed.includes("=") ? trimmed.split(";") : [`1-7=${trimmed}`];
  for (const group of groups) {
    if (!group.trim()) continue;
    const [daysPart, windowsPart] = group.split("=");
    if (!windowsPart) throw new Error(`HDO_FALLBACK: chybí "=" ve skupině "${group}"`);
    const days = parseDayRange(daysPart);
    for (const w of windowsPart.split(",")) {
      if (!w.trim()) continue;
      const [a, b] = w.split("-");
      if (!b) throw new Error(`HDO_FALLBACK: neplatné okno "${w}"`);
      const start = parseHHMM(a);
      const end = parseHHMM(b);
      for (const d of days) addWindow(schedule, d, start, end);
    }
  }
  return normalizeSchedule(schedule);
}

function parseDayRange(s: string): number[] {
  const m = /^\s*([1-7])\s*(?:-\s*([1-7]))?\s*$/.exec(s);
  if (!m) throw new Error(`HDO_FALLBACK: neplatné dny "${s}" (použijte 1-7)`);
  const from = Number(m[1]);
  const to = m[2] ? Number(m[2]) : from;
  const out: number[] = [];
  for (let d = from; d <= to; d++) out.push(d);
  return out;
}

export function isNT(schedule: WeeklySchedule, ms: number): boolean {
  const { isoWeekday, minuteOfDay } = pragueLocal(ms);
  for (const [s, e] of schedule[isoWeekday]) {
    if (minuteOfDay >= s && minuteOfDay < e) return true;
  }
  return false;
}

export function tariffAt(schedule: WeeklySchedule, ms: number): Tariff {
  return isNT(schedule, ms) ? "NT" : "VT";
}

export function priceAt(schedule: WeeklySchedule, prices: Prices, ms: number): number {
  return isNT(schedule, ms) ? prices.nt : prices.vt;
}

/** Next time the tariff changes, searching up to 8 days ahead (minute resolution). */
export function nextChange(schedule: WeeklySchedule, ms: number): { at: number; to: Tariff } | null {
  const current = tariffAt(schedule, ms);
  let t = Math.floor(ms / MINUTE) * MINUTE + MINUTE;
  const limit = ms + 8 * 24 * 60 * MINUTE;
  for (; t < limit; t += MINUTE) {
    const tariff = tariffAt(schedule, t);
    if (tariff !== current) return { at: t, to: tariff };
  }
  return null;
}

export interface TariffStretch {
  from: number;
  to: number;
  tariff: Tariff;
}

/** Splits [from, to) into consecutive VT/NT stretches (minute resolution). */
export function tariffStretches(schedule: WeeklySchedule, from: number, to: number): TariffStretch[] {
  const out: TariffStretch[] = [];
  let start = from;
  let current = tariffAt(schedule, from);
  for (let t = Math.floor(from / MINUTE) * MINUTE + MINUTE; t < to; t += MINUTE) {
    const tariff = tariffAt(schedule, t);
    if (tariff !== current) {
      out.push({ from: start, to: t, tariff: current });
      start = t;
      current = tariff;
    }
  }
  out.push({ from: start, to, tariff: current });
  return out;
}
