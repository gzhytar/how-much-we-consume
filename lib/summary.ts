import { buildLedger, sumRange, type Sample } from "./energy";
import { nextChange, tariffAt, tariffStretches, type Prices, type Tariff, type TariffStretch, type WeeklySchedule } from "./tariff";
import {
  baselineFor,
  levelFromBaseline,
  levelFromLimit,
  worst,
  type Baseline,
  type Level,
} from "./thresholds";
import { DAY, HOUR, MINUTE, floorHour, floorMinute } from "./time";

/** Default reading interval (POLL_MINUTES): the QStash schedule's period. */
export const DEFAULT_POLL_MINUTES = 3;
/** Data counts as out of date when the newest reading is older than this (at least 5 min). */
export function staleAfter(pollMinutes: number): number {
  return Math.max(5, pollMinutes + 2) * MINUTE;
}
/** How far ahead the "Kdy je elektřina levná" timeline looks. */
export const TIMELINE_HOURS = 12;
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
  /** alert = over the hourly limit, warn = well above usual for that hour. */
  level: Level;
}


/**
 * One phase's part of "Právě teď", over the same window as the headline, so the parts add up to it.
 * Split by each phase's energy counter when every reading in the window has one; otherwise
 * (readings stored before per-phase counters, or a meter without them) by the latest live power.
 */
export interface PhasePower {
  name: string;
  /** Average power over the window, W. */
  w: number;
  czkPerHour: number;
  /** Whole crowns for display: rounded so the phases sum to the headline's shown (rounded-up) value. */
  czkShown: number;
  /** kW to one decimal for display, rounded so the phases sum to the headline's shown kW. */
  kwShown: number;
}

/** Cost rate right now, averaged over one reading interval and compared with the hourly limit. */
export interface LiveSummary {
  /** Length of the averaging window in minutes (= POLL_MINUTES). */
  windowMinutes: number;
  kw: number;
  czkPerHour: number;
  limitCzkPerHour: number;
  limitLevel: Level;
  usualCzkPerHour: number | null;
  usualLevel: Level | null;
  vsUsualPct: number | null;
  level: Level;
  /** Live (not averaged) power per phase from the latest reading. */
  phases: PhasePower[] | null;
  /** Where the phase split comes from: per-phase energy counters (exact) or the latest live power. */
  phaseSplit: "energy" | "power" | null;
}

export interface Summary {
  now: number;
  lastSampleAt: number | null;
  stale: boolean;
  powerW: number | null;
  live: LiveSummary | null;
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
  /**
   * VT/NT stretches from now to TIMELINE_HOURS ahead; a short headline stating when power is cheap
   * (the timeline's title); and one sentence on when to run big appliances (shown in the banner when
   * nothing is wrong), or null when there's no advice to give.
   */
  timeline: { stretches: TariffStretch[]; headline: string; hint: string | null };
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
  phaseNames?: string[];
  /**
   * Minutes between scheduled readings (POLL_MINUTES). "Right now" is the average over this window:
   * it always spans at least one reading, and a kettle doesn't spike the headline.
   */
  pollMinutes?: number;
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

  const ntShare = (start: number) => {
    let ntMinutes = 0;
    for (let m = start; m < start + HOUR; m += 5 * MINUTE) if (tariffAt(schedule, m) === "NT") ntMinutes += 5;
    return ntMinutes / 60;
  };

  const bars: Bar[] = [];
  const currentHour = floorHour(now);
  for (let i = 23; i >= 0; i--) {
    const start = currentHour - i * HOUR;
    const r = sumRange(ledger, start, start + HOUR);
    const usual = baselineOn
      ? baselineFor(ledger, start, start + HOUR, { sameDayType: true, minDays: 3 })
      : null;
    const overLimit = limits.hourCzk > 0 && r.czk >= limits.hourCzk;
    const overUsual = usual ? levelFromBaseline(r.czk, usual.median, 2) !== "ok" : false;
    bars.push({
      start,
      czk: r.czk,
      kwh: r.kwh,
      ntShare: ntShare(start),
      usualCzk: usual ? usual.median : null,
      partial: i === 0,
      level: overLimit ? "alert" : overUsual && i > 0 ? "warn" : "ok",
    });
  }
  const current = tariffAt(schedule, now);
  const priceNow = current === "NT" ? prices.nt : prices.vt;
  const change = nextChange(schedule, now);
  const stretches = tariffStretches(schedule, now, now + TIMELINE_HOURS * HOUR);
  const pollMinutes = input.pollMinutes ?? DEFAULT_POLL_MINUTES;
  const stale = !latest || now - latest.ts > staleAfter(pollMinutes);

  let live: LiveSummary | null = null;
  if (latest && !stale) {
    const liveWindow = pollMinutes * MINUTE;
    const r = sumRange(ledger, end - liveWindow, end);
    const split = phaseSplit(sorted, end - liveWindow, end, schedule, prices);
    const perHour = HOUR / liveWindow;
    const czkPerHour = r.czk * perHour;
    const limitLevel = levelFromLimit(czkPerHour, limits.hourCzk);
    const usualCzkPerHour = hour.usual ? hour.usual.median : null;
    const usualLevel = usualCzkPerHour !== null ? levelFromBaseline(czkPerHour, usualCzkPerHour, 3) : null;
    const names = input.phaseNames ?? [];
    live = {
      windowMinutes: pollMinutes,
      kw: r.kwh * perHour,
      czkPerHour,
      limitCzkPerHour: limits.hourCzk,
      limitLevel,
      usualCzkPerHour,
      usualLevel,
      vsUsualPct: usualCzkPerHour && usualCzkPerHour > 0 ? (czkPerHour / usualCzkPerHour - 1) * 100 : null,
      level: worst(limitLevel, usualLevel),
      ...splitLive(split, r.kwh * perHour, czkPerHour, names),
    };
  }

  const tips: string[] = [];
  if (live && live.limitLevel === "alert") {
    const top = live.phases ? [...live.phases].sort((a, b) => b.czkPerHour - a.czkPerHour)[0] : null;
    tips.push(
      `Právě teď to stojí ${fmtCzk(live.czkPerHour)} za hodinu – nad limitem ${fmtCzk(live.limitCzkPerHour)} za hodinu.` +
        (top && top.w > 300 ? ` Nejvíc stojí ${top.name} (${top.czkShown} Kč za hodinu).` : "") +
        " Co můžete vypnout?",
    );
  } else if (live && live.usualLevel && live.usualLevel !== "ok" && live.vsUsualPct !== null) {
    tips.push(`Právě teď o ${Math.round(live.vsUsualPct)} % víc než obvykle v tuto dobu.`);
  }
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

  return {
    now,
    lastSampleAt: latest ? latest.ts : null,
    stale,
    powerW: latest && !stale ? latest.w : null,
    live,
    tariff: {
      current,
      nextChangeAt: change ? change.at : null,
      nextTariff: change ? change.to : null,
      priceNow,
      prices,
      source: input.scheduleSource,
    },
    hour,
    day,
    bars,
    timeline: { stretches, ...timelineText(current, change, now) },
    historyDays,
    level: worst(live?.level, hour.level, day.level),
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

/**
 * Each phase's share of the window [from, to). From the per-phase energy counters when every reading
 * that the window's energy comes from has them (cost-weighted, so a VT/NT change inside the window is
 * exact); otherwise from the latest reading's live power per phase. Null when there's neither.
 */
function phaseSplit(
  sorted: Sample[],
  from: number,
  to: number,
  schedule: WeeklySchedule,
  prices: Prices,
): { shares: number[]; source: "energy" | "power" } | null {
  // The window's energy comes from the last reading at or before its start and every reading after.
  const start = floorMinute(from);
  let i0 = 0;
  for (let i = 0; i < sorted.length; i++) if (sorted[i].ts <= start) i0 = i;
  const span = sorted.slice(i0).filter((s) => s.ts <= to);
  if (span.length >= 2 && span.every((s) => s.phaseWh?.length === 3)) {
    const czk = [0, 1, 2].map((p) => {
      const perPhase = span.map((s) => ({ ts: s.ts, wh: s.phaseWh![p], w: 0 }));
      return sumRange(buildLedger(perPhase, schedule, prices), from, to).czk;
    });
    const total = czk.reduce((a, b) => a + b, 0);
    if (total > 0) return { shares: czk.map((c) => c / total), source: "energy" };
  }
  const live = sorted[sorted.length - 1]?.phases;
  if (live?.length === 3) {
    const w = live.map((x) => Math.max(0, x));
    const total = w.reduce((a, b) => a + b, 0);
    return { shares: w.map((x) => (total > 0 ? x / total : 0)), source: "power" };
  }
  return null;
}

function splitLive(
  split: { shares: number[]; source: "energy" | "power" } | null,
  kw: number,
  czkPerHour: number,
  names: string[],
): { phases: PhasePower[] | null; phaseSplit: "energy" | "power" | null } {
  if (!split) return { phases: null, phaseSplit: null };
  const czkShown = apportion(split.shares, ceilCzk(czkPerHour));
  const tenths = apportion(split.shares, Math.round(kw * 10));
  return {
    phaseSplit: split.source,
    phases: split.shares.map((share, i) => ({
      name: names[i] || `L${i + 1}`,
      w: share * kw * 1000,
      czkPerHour: share * czkPerHour,
      czkShown: czkShown[i],
      kwShown: tenths[i] / 10,
    })),
  };
}

/** Splits a whole number by shares so the parts are whole and sum to it (largest remainder). */
export function apportion(shares: number[], total: number): number[] {
  const sum = shares.reduce((a, b) => a + b, 0);
  if (sum <= 0 || total <= 0) return shares.map(() => 0);
  const exact = shares.map((s) => (s / sum) * total);
  const out = exact.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = exact.map((v, i) => ({ i, frac: v - Math.floor(v) })).sort((a, b) => b.frac - a.frac);
  for (const { i } of order) {
    if (left <= 0) break;
    out[i]++;
    left--;
  }
  return out;
}

/** Costs are shown in whole crowns, rounded up (8,1 → 9 Kč). */
export function ceilCzk(v: number): number {
  return Math.max(0, Math.ceil(v - 1e-9));
}

export function fmtCzk(v: number): string {
  return `${ceilCzk(v).toLocaleString("cs-CZ")} Kč`;
}

export function fmtDuration(ms: number): string {
  const total = Math.round(ms / MINUTE);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

function timelineText(
  current: Tariff,
  change: { at: number; to: Tariff } | null,
  now: number,
): { headline: string; hint: string | null } {
  const within = change && change.at - now <= TIMELINE_HOURS * HOUR;
  if (current === "VT") {
    return within
      ? {
          headline: `Levný tarif za ${fmtDuration(change.at - now)} (od ${fmtTime(change.at)})`,
          hint: `Levný tarif za ${fmtDuration(change.at - now)} (od ${fmtTime(change.at)}) – pračku, myčku a sušičku spusťte až potom.`,
        }
      : { headline: `Příštích ${TIMELINE_HOURS} h levný tarif nebude`, hint: null };
  }
  return within
    ? {
        headline: `Levný tarif ještě ${fmtDuration(change.at - now)} (do ${fmtTime(change.at)})`,
        hint: `Teď je levný tarif ještě ${fmtDuration(change.at - now)} (do ${fmtTime(change.at)}) – dobrá chvíle pro pračku a myčku.`,
      }
    : {
        headline: `Levný tarif celých příštích ${TIMELINE_HOURS} h`,
        hint: `Levný tarif platí celých příštích ${TIMELINE_HOURS} hodin – dobrá chvíle pro pračku a myčku.`,
      };
}

export function fmtKw(w: number): string {
  return `${(w / 1000).toLocaleString("cs-CZ", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} kW`;
}

export function fmtTime(ms: number): string {
  return new Intl.DateTimeFormat("cs-CZ", { timeZone: "Europe/Prague", hour: "2-digit", minute: "2-digit" }).format(ms);
}

