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
import { DAY, HOUR, MINUTE, floorHour } from "./time";

export const STALE_AFTER = 5 * MINUTE;
/** "Right now" is the average over this window, so a kettle doesn't spike the headline. */
export const LIVE_WINDOW = 5 * MINUTE;
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


export interface PhasePower {
  name: string;
  w: number;
}

/** Cost rate right now, averaged over LIVE_WINDOW and compared with the hourly limit. */
export interface LiveSummary {
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
  /** VT/NT stretches from now to TIMELINE_HOURS ahead, and one sentence on when to run big appliances. */
  timeline: { stretches: TariffStretch[]; hint: string };
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
  const change = nextChange(schedule, now);
  const stretches = tariffStretches(schedule, now, now + TIMELINE_HOURS * HOUR);
  const stale = !latest || now - latest.ts > STALE_AFTER;

  let live: LiveSummary | null = null;
  if (latest && !stale) {
    const r = sumRange(ledger, end - LIVE_WINDOW, end);
    const perHour = HOUR / LIVE_WINDOW;
    const czkPerHour = r.czk * perHour;
    const limitLevel = levelFromLimit(czkPerHour, limits.hourCzk);
    const usualCzkPerHour = hour.usual ? hour.usual.median : null;
    const usualLevel = usualCzkPerHour !== null ? levelFromBaseline(czkPerHour, usualCzkPerHour, 3) : null;
    const names = input.phaseNames ?? [];
    live = {
      kw: r.kwh * perHour,
      czkPerHour,
      limitCzkPerHour: limits.hourCzk,
      limitLevel,
      usualCzkPerHour,
      usualLevel,
      vsUsualPct: usualCzkPerHour && usualCzkPerHour > 0 ? (czkPerHour / usualCzkPerHour - 1) * 100 : null,
      level: worst(limitLevel, usualLevel),
      phases:
        latest.phases?.length === 3
          ? latest.phases.map((w, i) => ({ name: names[i] || `L${i + 1}`, w: Math.max(0, w) }))
          : null,
    };
  }

  const tips: string[] = [];
  if (live && live.limitLevel === "alert") {
    const top = live.phases ? [...live.phases].sort((a, b) => b.w - a.w)[0] : null;
    tips.push(
      `Právě teď to stojí ${fmtCzk(live.czkPerHour)} za hodinu – nad limitem ${fmtCzk(live.limitCzkPerHour)} za hodinu.` +
        (top && top.w > 300 ? ` Nejvíc odebírá ${top.name} (${fmtKw(top.w)}).` : "") +
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
      priceNow: current === "NT" ? prices.nt : prices.vt,
      prices,
      source: input.scheduleSource,
    },
    hour,
    day,
    bars,
    timeline: { stretches, hint: timelineHint(current, change, now) },
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

function timelineHint(current: Tariff, change: { at: number; to: Tariff } | null, now: number): string {
  const within = change && change.at - now <= TIMELINE_HOURS * HOUR;
  if (current === "VT") {
    return within
      ? `Levný tarif za ${fmtDuration(change.at - now)} (od ${fmtTime(change.at)}) – pračku, myčku a sušičku spusťte až potom.`
      : `V příštích ${TIMELINE_HOURS} hodinách levný tarif nebude.`;
  }
  return within
    ? `Teď je levný tarif ještě ${fmtDuration(change.at - now)} (do ${fmtTime(change.at)}) – dobrá chvíle pro pračku a myčku.`
    : `Levný tarif platí celých příštích ${TIMELINE_HOURS} hodin.`;
}

export function fmtKw(w: number): string {
  return `${(w / 1000).toLocaleString("cs-CZ", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} kW`;
}

export function fmtTime(ms: number): string {
  return new Intl.DateTimeFormat("cs-CZ", { timeZone: "Europe/Prague", hour: "2-digit", minute: "2-digit" }).format(ms);
}

