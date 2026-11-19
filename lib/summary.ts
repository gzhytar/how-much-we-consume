import { buildLedger, sumRange, type Ledger, type Sample } from "./energy";
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
  /** Cost of the hour per part, in Summary.parts order (circuits, then "Nerozlišeno"); null without phase data. */
  parts: number[] | null;
}

/** One circuit's (phase's) share of the last 24 hours. */
export interface DayPart {
  name: string;
  czk: number;
  kwh: number;
  /** Whole crowns for display, rounded so the parts sum to the day's shown (rounded-up) total. */
  czkShown: number;
  /** Share of the day's cost, 0…1. */
  share: number;
}

/** Where a split comes from: per-phase energy counters (exact), live power per phase (estimate), or both. */
export type SplitSource = "energy" | "power" | "mixed";


/**
 * One circuit's part of "Právě teď", over the same window as the headline, so the parts add up to it.
 * See `attribute` for how the energy between two readings is split between circuits.
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
  /** Per circuit, plus "Nerozlišeno" when some energy can't be attributed; null without phase data. */
  phases: PhasePower[] | null;
  phaseSplit: SplitSource | null;
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
   * Names of the parts the cost is split into, in a fixed order: L1–L3 (or PHASE_NAMES), then
   * "Nerozlišeno" for energy no reading could attribute. Null when no reading has phase data.
   */
  parts: string[] | null;
  /** The last 24 hours per part (same order as `parts`); null without phase data. */
  dayParts: DayPart[] | null;
  daySplit: SplitSource | null;
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

  const currentHour = floorHour(now);
  const names = input.phaseNames ?? [];
  const partNames = [0, 1, 2].map((i) => names[i] || `L${i + 1}`).concat(UNATTRIBUTED);
  const attr = attribute(sorted, Math.min(end - DAY, currentHour - 23 * HOUR), schedule, prices);

  const bars: Bar[] = [];
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
      parts: attr ? attr.ledgers.map((l) => sumRange(l, start, start + HOUR).czk) : null,
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
    const perHour = HOUR / liveWindow;
    const czkPerHour = r.czk * perHour;
    const limitLevel = levelFromLimit(czkPerHour, limits.hourCzk);
    const usualCzkPerHour = hour.usual ? hour.usual.median : null;
    const usualLevel = usualCzkPerHour !== null ? levelFromBaseline(czkPerHour, usualCzkPerHour, 3) : null;
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
      ...splitLive(attr, end - liveWindow, end, perHour, r.kwh * perHour, czkPerHour, partNames),
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
    ...splitDay(attr, end - DAY, end, day.czk, partNames),
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

export const UNATTRIBUTED = "Nerozlišeno";

interface Attribution {
  /** Per-minute energy and cost per part: L1, L2, L3, unattributed. */
  ledgers: Ledger[];
  /** How each interval between two readings was split. */
  intervals: { from: number; to: number; source: "energy" | "power" | "none" }[];
}

/**
 * Splits the energy between consecutive readings (the exact total-counter delta) between circuits:
 * by the per-phase counter deltas when both readings have them, else by the two readings' average
 * live power per phase (an estimate), else to "Nerozlišeno". The parts always sum to the total, so
 * every split adds up to the matching headline. Starts at the last reading at or before `from`.
 * Null when no reading has any phase data.
 */
function attribute(sorted: Sample[], from: number, schedule: WeeklySchedule, prices: Prices): Attribution | null {
  const start = floorMinute(from);
  let i0 = 0;
  for (let i = 0; i < sorted.length; i++) if (sorted[i].ts <= start) i0 = i;
  const span = sorted.slice(i0);
  if (span.length < 2 || !span.some((s) => s.phaseWh?.length === 3 || s.phases?.length === 3)) return null;

  const cum = [0, 0, 0, 0];
  const series: Sample[][] = cum.map(() => [{ ts: span[0].ts, wh: 0, w: 0 }]);
  const intervals: Attribution["intervals"] = [];
  for (let i = 1; i < span.length; i++) {
    const a = span[i - 1];
    const b = span[i];
    const dWh = Math.max(0, b.wh - a.wh);
    let shares: number[] | null = null;
    let source: "energy" | "power" | "none" = "none";
    if (a.phaseWh?.length === 3 && b.phaseWh?.length === 3) {
      const d = [0, 1, 2].map((p) => Math.max(0, b.phaseWh![p] - a.phaseWh![p]));
      shares = normalize(d);
      if (shares) source = "energy";
    }
    if (!shares && a.phases?.length === 3 && b.phases?.length === 3) {
      shares = normalize([0, 1, 2].map((p) => (Math.max(0, a.phases![p]) + Math.max(0, b.phases![p])) / 2));
      if (shares) source = "power";
    }
    const all = shares ? [...shares, 0] : [0, 0, 0, 1];
    for (let k = 0; k < 4; k++) {
      cum[k] += dWh * all[k];
      series[k].push({ ts: b.ts, wh: cum[k], w: 0 });
    }
    intervals.push({ from: a.ts, to: b.ts, source });
  }
  return { ledgers: series.map((x) => buildLedger(x, schedule, prices)), intervals };
}

function normalize(v: number[]): number[] | null {
  const sum = v.reduce((a, b) => a + b, 0);
  return sum > 0 ? v.map((x) => x / sum) : null;
}

/** Which source(s) the intervals overlapping [from, to) were split with. */
function sourceIn(attr: Attribution, from: number, to: number): SplitSource | null {
  const used = new Set(attr.intervals.filter((x) => x.to > from && x.from < to).map((x) => x.source));
  if (used.size === 1 && used.has("energy")) return "energy";
  if (used.size === 1 && used.has("power")) return "power";
  return used.size ? "mixed" : null;
}

/** Keeps the circuits always, "Nerozlišeno" only when it's more than a rounding error. */
const keepPart = (i: number, value: number, total: number) => i < 3 || (total > 0 && value / total > 0.005);

function splitLive(
  attr: Attribution | null,
  from: number,
  to: number,
  perHour: number,
  kw: number,
  czkPerHour: number,
  names: string[],
): { phases: PhasePower[] | null; phaseSplit: SplitSource | null } {
  if (!attr) return { phases: null, phaseSplit: null };
  // Pick the parts first, then round among them only, so the shown rows sum to the headline.
  const r = attr.ledgers.map((l) => sumRange(l, from, to)).filter((x, i) => keepPart(i, x.czk * perHour, czkPerHour));
  const czkShown = apportion(r.map((x) => x.czk), ceilCzk(czkPerHour));
  const tenths = apportion(r.map((x) => x.kwh), Math.round(kw * 10));
  return {
    phaseSplit: sourceIn(attr, from, to),
    phases: r.map((x, i) => ({
      name: names[i],
      w: x.kwh * perHour * 1000,
      czkPerHour: x.czk * perHour,
      czkShown: czkShown[i],
      kwShown: tenths[i] / 10,
    })),
  };
}

function splitDay(
  attr: Attribution | null,
  from: number,
  to: number,
  totalCzk: number,
  names: string[],
): { parts: string[] | null; dayParts: DayPart[] | null; daySplit: SplitSource | null } {
  if (!attr) return { parts: null, dayParts: null, daySplit: null };
  const r = attr.ledgers.map((l) => sumRange(l, from, to)).filter((x, i) => keepPart(i, x.czk, totalCzk));
  const shown = apportion(r.map((x) => x.czk), ceilCzk(totalCzk));
  return {
    parts: names,
    daySplit: sourceIn(attr, from, to),
    dayParts: r.map((x, i) => ({
      name: names[i],
      czk: x.czk,
      kwh: x.kwh,
      czkShown: shown[i],
      share: totalCzk > 0 ? x.czk / totalCzk : 0,
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

