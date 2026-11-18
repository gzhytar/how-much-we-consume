import { buildLedger, sumRange, type Sample } from "./energy";
import { nextChange, tariffAt, type Prices, type Tariff, type WeeklySchedule } from "./tariff";
import {
  baselineFor,
  levelFromBaseline,
  levelFromLimit,
  worst,
  type Baseline,
  type Level,
} from "./thresholds";
import { DAY, HOUR, MINUTE, floorHour } from "./time";

export const STALE_AFTER = 5 * MINUTE;
/** The "usual usage" comparison is only switched on after this much history. */
export const MIN_HISTORY_DAYS = 7;

export interface Limits {
  hourCzk: number;
  dayCzk: number;
}

export interface PeriodSummary {
  czk: number;
  kwh: number;
  ntShare: number; // share of kWh in NT, 0…1
  coverage: number;
  limitCzk: number;
  limitLevel: Level;
  usual: Baseline | null;
  usualLevel: Level | null;
  vsUsualPct: number | null; // +60 means 60 % above usual
  level: Level;
}

export interface Bar {
  start: number; // epoch ms, start of the Prague hour
  czk: number;
  kwh: number;
  ntShare: number; // share of the hour scheduled as NT, 0…1
  usualCzk: number | null;
  partial: boolean;
}

export interface Summary {
  now: number;
  lastSampleAt: number | null;
  stale: boolean;
  powerW: number | null;
  tariff: {
    current: Tariff;
    nextChangeAt: number | null;
    nextTariff: Tariff | null;
    priceNow: number;
    prices: Prices;
    source: string;
  };
  hour: PeriodSummary;
  day: PeriodSummary;
  bars: Bar[];
  historyDays: number;
  level: Level;
  tips: string[];
  warnings: string[];
}

export interface SummaryInput {
  samples: Sample[];
  schedule: WeeklySchedule;
  scheduleSource: string;
  prices: Prices;
  limits: Limits;
  now: number;
  warnings?: string[];
}

export function buildSummary(input: SummaryInput): Summary {
  const { samples, schedule, prices, limits, now } = input;
  const sorted = [...samples].sort((a, b) => a.ts - b.ts);
  const ledger = buildLedger(sorted, schedule, prices);
  const latest = sorted[sorted.length - 1] ?? null;
  const first = sorted[0] ?? null;
  // Count up to the last reading, so a late fetch isn't shown as zero usage.
  const end = latest ? Math.min(now, latest.ts) : now;
  const historyDays = first && latest ? (latest.ts - first.ts) / DAY : 0;
  const baselineOn = historyDays >= MIN_HISTORY_DAYS;

  const hour = period(ledger, end - HOUR, end, limits.hourCzk, baselineOn, {
    sameDayType: true,
    minDays: 3,
    minExtraCzk: 2,
  });
  const day = period(ledger, end - DAY, end, limits.dayCzk, baselineOn, {
    sameDayType: false,
    minDays: 5,
    minExtraCzk: 15,
  });

  const bars: Bar[] = [];
  const currentHour = floorHour(now);
  for (let i = 23; i >= 0; i--) {
    const start = currentHour - i * HOUR;
    const r = sumRange(ledger, start, start + HOUR);
    let ntMinutes = 0;
    for (let m = start; m < start + HOUR; m += 5 * MINUTE) if (tariffAt(schedule, m) === "NT") ntMinutes += 5;
    const usual = baselineOn
      ? baselineFor(ledger, start, start + HOUR, { sameDayType: true, minDays: 3 })
      : null;
    bars.push({
      start,
      czk: r.czk,
      kwh: r.kwh,
      ntShare: ntMinutes / 60,
      usualCzk: usual ? usual.median : null,
      partial: i === 0,
    });
  }

  const current = tariffAt(schedule, now);
  const change = nextChange(schedule, now);
  const stale = !latest || now - latest.ts > STALE_AFTER;

  const tips: string[] = [];
  if (hour.limitLevel === "alert") {
    tips.push(`Poslední hodina stála ${fmtCzk(hour.czk)} – nad limitem ${fmtCzk(hour.limitCzk)}. Vypněte, co právě nepotřebujete.`);
  } else if (hour.usualLevel && hour.usualLevel !== "ok" && hour.vsUsualPct !== null) {
    tips.push(`Spotřeba je o ${Math.round(hour.vsUsualPct)} % vyšší než obvykle v tuto dobu.`);
  }
  if (day.limitLevel === "alert") {
    tips.push(`Za posledních 24 h ${fmtCzk(day.czk)} – nad denním limitem ${fmtCzk(day.limitCzk)}.`);
  } else if (day.usualLevel === "alert" && day.vsUsualPct !== null) {
    tips.push(`Za 24 h o ${Math.round(day.vsUsualPct)} % víc než obvyklý den.`);
  }
  if (current === "VT" && change && change.at - now <= 3 * HOUR && prices.vt > prices.nt) {
    tips.push(`Levnější tarif začne v ${fmtTime(change.at)}. Pračku, myčku nebo sušičku můžete odložit.`);
  }

  return {
    now,
    lastSampleAt: latest ? latest.ts : null,
    stale,
    powerW: latest && !stale ? latest.w : null,
    tariff: {
      current,
      nextChangeAt: change ? change.at : null,
      nextTariff: change ? change.to : null,
      priceNow: current === "NT" ? prices.nt : prices.vt,
      prices,
      source: input.scheduleSource,
    },
    hour,
    day,
    bars,
    historyDays,
    level: worst(hour.level, day.level),
    tips,
    warnings: input.warnings ?? [],
  };
}

function period(
  ledger: ReturnType<typeof buildLedger>,
  from: number,
  to: number,
  limitCzk: number,
  baselineOn: boolean,
  opts: { sameDayType: boolean; minDays: number; minExtraCzk: number },
): PeriodSummary {
  const r = sumRange(ledger, from, to);
  const limitLevel = levelFromLimit(r.czk, limitCzk);
  const usual = baselineOn
    ? baselineFor(ledger, from, to, { sameDayType: opts.sameDayType, minDays: opts.minDays })
    : null;
  const usualLevel = usual ? levelFromBaseline(r.czk, usual.median, opts.minExtraCzk) : null;
  const vsUsualPct = usual && usual.median > 0 ? (r.czk / usual.median - 1) * 100 : null;
  return {
    czk: r.czk,
    kwh: r.kwh,
    ntShare: r.kwh > 0 ? r.ntKwh / r.kwh : 0,
    coverage: r.coverage,
    limitCzk,
    limitLevel,
    usual,
    usualLevel,
    vsUsualPct,
    level: worst(limitLevel, usualLevel),
  };
}

export function fmtCzk(v: number): string {
  return `${v.toLocaleString("cs-CZ", { maximumFractionDigits: v < 100 ? 1 : 0, minimumFractionDigits: v < 100 ? 1 : 0 })} Kč`;
}

export function fmtTime(ms: number): string {
  return new Intl.DateTimeFormat("cs-CZ", { timeZone: "Europe/Prague", hour: "2-digit", minute: "2-digit" }).format(ms);
}

