"use client";

import { useEffect, useState } from "react";
import type { Bar, DayPart, LiveSummary, PeriodSummary, SplitSource, Summary } from "@/lib/summary";
import type { Prices, TariffStretch } from "@/lib/tariff";
import type { Level } from "@/lib/thresholds";

const POLL_MS = 60_000;
const TZ = "Europe/Prague";
const HOUR = 3_600_000;

/** Costs in whole crowns, rounded up (8,1 → 9). Tariff prices per kWh keep their decimals. */
const czk = (v: number) => Math.max(0, Math.ceil(v - 1e-9)).toLocaleString("cs-CZ");
const price = (v: number) => v.toLocaleString("cs-CZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const kw = (w: number) => (w / 1000).toLocaleString("cs-CZ", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const kwh = (v: number) => v.toLocaleString("cs-CZ", { maximumFractionDigits: v < 10 ? 2 : 1 });
const time = (ms: number) => new Intl.DateTimeFormat("cs-CZ", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(ms);
const hourLabel = (ms: number) => new Intl.DateTimeFormat("cs-CZ", { timeZone: TZ, hour: "numeric" }).format(ms);

const STATUS: Record<Level, { icon: string; label: string }> = {
  ok: { icon: "✓", label: "V pořádku" },
  warn: { icon: "!", label: "Pozor" },
  alert: { icon: "▲", label: "Vysoká spotřeba" },
};

export default function Dashboard({ token }: { token: string }) {
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const [shift, setShift] = useState({ x: 0, y: 0 });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`/api/summary?t=${encodeURIComponent(token)}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as Summary;
        if (!cancelled) {
          setData(json);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    }
    load();
    const poll = setInterval(load, POLL_MS);
    const tick = setInterval(() => setClock(Date.now()), 15_000);
    // Move the whole screen by a few pixels every 3 minutes, so static text doesn't burn in.
    const burn = setInterval(
      () => setShift({ x: Math.round(Math.random() * 8 - 4), y: Math.round(Math.random() * 8 - 4) }),
      180_000,
    );
    return () => {
      cancelled = true;
      clearInterval(poll);
      clearInterval(tick);
      clearInterval(burn);
    };
  }, [token]);

  if (!data) {
    return (
      <main className="screen loading">
        <p>{error ? `Nelze načíst data (${error})` : "Načítám…"}</p>
      </main>
    );
  }

  const t = data.tariff;
  const stale = data.stale || !!error;
  // One "what to do" slot: stale-data warning, else the worst consumption tip, else tariff advice.
  const banner: { level: Level | "info"; text: string } | null = stale
    ? {
        level: "warn",
        text: error
          ? "⚠ Bez spojení se serverem – čísla nemusí být aktuální."
          : data.lastSampleAt
            ? `⚠ Data nejsou aktuální – poslední měření v ${time(data.lastSampleAt)}. Čísla nemusí odpovídat skutečnosti.`
            : "⚠ Zatím žádná měření z elektroměru.",
      }
    : data.tips.length > 0
      ? { level: data.level, text: data.tips[0] }
      : data.timeline.hint
        ? { level: "info", text: data.timeline.hint }
        : null;

  return (
    <main
      className={`screen level-${data.level}${stale ? " is-stale" : ""}`}
      style={{ transform: `translate(${shift.x}px, ${shift.y}px)` }}
    >
      <header className="top">
        <h1>Kolik nás stojí elektřina</h1>
        <div className="top-right">
          <span className={`tariff tariff-${t.current}`}>
            {t.current === "NT" ? "Levný tarif NT" : "Tarif VT"} · {price(t.priceNow)} Kč/kWh
          </span>
          <span className="clock">{time(clock)}</span>
        </div>
      </header>

      <section className="tiles">
        <NowTile live={data.live} hour={data.hour} stale={stale} />
        <DayTile
          day={data.day}
          parts={data.dayParts}
          split={data.daySplit}
          bars={data.bars}
          hourLimit={data.hour.limitCzk}
          stale={stale}
        />
      </section>

      {banner && (
        <section className={`tip tip-${banner.level}`} role="status">
          {banner.text}
        </section>
      )}

      <TariffTimeline stretches={data.timeline.stretches} headline={data.timeline.headline} prices={t.prices} />

      <footer className="foot">
        {data.lastSampleAt && <span>Poslední měření {time(data.lastSampleAt)}</span>}
        {data.warnings.map((w) => (
          <span key={w} className="warn-text">
            {w}
          </span>
        ))}
        <span className="muted">
          Ceny VT {price(t.prices.vt)} / NT {price(t.prices.nt)} Kč/kWh · HDO: {t.source}
        </span>
      </footer>
    </main>
  );
}

function StatusPill({ level }: { level: Level }) {
  const s = STATUS[level];
  return (
    <div className={`pill level-${level}`}>
      <span className="pill-icon" aria-hidden>
        {s.icon}
      </span>
      {s.label}
    </div>
  );
}

function Meter({ value, limit, level }: { value: number; limit: number; level: Level }) {
  const fill = limit > 0 ? Math.min(100, (value / limit) * 100) : 0;
  return (
    <div className={`meter level-${level}`} aria-label={`${Math.round(fill)} % limitu`}>
      <div className="meter-fill" style={{ width: `${fill}%` }} />
      <div className="meter-mark" style={{ left: "80%" }} />
    </div>
  );
}

/** "+60 % než obvykle": a status chip when it's a problem, quiet text otherwise. */
function VsUsual({ pct, level }: { pct: number | null; level: Level | null }) {
  if (pct === null) return null;
  const r = Math.round(pct);
  const text = r === 0 ? "jako obvykle" : `${r > 0 ? "+" : "−"}${Math.abs(r)} % než obvykle`;
  if (level === "warn" || level === "alert") {
    return (
      <span className={`delta level-${level}`}>
        <span aria-hidden>▲</span> {text}
      </span>
    );
  }
  return (
    <span className="delta-quiet">
      {r < 0 && <span aria-hidden>▼ </span>}
      {text}
    </span>
  );
}

/** Colour class per part index: circuits L1–L3 in fixed order, then "Nerozlišeno" in neutral grey. */
const partClass = (i: number) => (i < 3 ? `c${i + 1}` : "c0");

/** Unit label for a split, marked "odhad" when any of it comes from live power instead of energy counters. */
const splitUnit = (unit: string, source: SplitSource | null) => (source && source !== "energy" ? `${unit} · odhad` : unit);

function NowTile({ live, hour, stale }: { live: LiveSummary | null; hour: PeriodSummary; stale: boolean }) {
  // The tile's status is about the rate now; the last hour's state is its own chip on the hour line,
  // so a calm "2 Kč/h" never sits under a red pill.
  const level = live?.level ?? "ok";
  const limit = hour.limitCzk;
  return (
    <div className={`tile level-${level}`}>
      <div className="tile-head">
        <h2>Právě teď</h2>
        {live && <StatusPill level={level} />}
      </div>
      <div className="figure">
        <div className="hero">
          {live ? czk(live.czkPerHour) : "–"}
          <span className="unit"> Kč/h</span>
        </div>
        <div className="figure-side">
          <p className="sub">{live ? `${kw(live.kw * 1000)} kW · průměr za ${live.windowMinutes} min` : "bez aktuálních dat"}</p>
          {live && <Meter value={live.czkPerHour} limit={limit} level={live.limitLevel} />}
          <p className="sub row">
            <span>limit {czk(limit)} Kč/h</span>
            {live?.usualCzkPerHour != null && <span>obvykle {czk(live.usualCzkPerHour)} Kč/h</span>}
            {live && <VsUsual pct={live.vsUsualPct} level={live.usualLevel} />}
          </p>
        </div>
      </div>
      {live?.phases && (
        <Split
          big
          title="Co teď běží"
          unit={splitUnit("Kč za hodinu", live.phaseSplit)}
          rows={live.phases.map((p, i) => ({
            name: p.name,
            cls: partClass(i),
            value: shownCzk(p.czkShown, p.czkPerHour),
            detail: `${tenth(p.kwShown)} kW`,
            ratio: p.czkPerHour / Math.max(limit, live.czkPerHour, 1),
            exact: p.czkPerHour,
          }))}
        />
      )}
      <div className="hourline">
        <span>Poslední hodina</span>
        <strong>{czk(hour.czk)} Kč</strong>
        <span>z limitu {czk(hour.limitCzk)} Kč</span>
        {!stale && <VsUsual pct={hour.vsUsualPct} level={hour.usualLevel} />}
        {!stale && hour.limitLevel === "alert" && <StatusPill level="alert" />}
      </div>
    </div>
  );
}

function DayTile({
  day,
  parts,
  split,
  bars,
  hourLimit,
  stale,
}: {
  day: PeriodSummary;
  parts: DayPart[] | null;
  split: SplitSource | null;
  bars: Bar[];
  hourLimit: number;
  stale: boolean;
}) {
  // With out-of-date data a green "V pořádku" would be a false all-clear, so show no status.
  return (
    <div className={`tile${stale ? "" : ` level-${day.level}`}`}>
      <div className="tile-head">
        <h2>Posledních 24 hodin</h2>
        {!stale && <StatusPill level={day.level} />}
      </div>
      <div className="figure">
        <div className="hero">
          {czk(day.czk)}
          <span className="unit"> Kč</span>
        </div>
        <div className="figure-side">
          <p className="sub">
            {kwh(day.kwh)} kWh{day.kwh > 0 ? ` · ${Math.round(day.ntShare * 100)} % v levném tarifu` : ""}
          </p>
          <Meter value={day.czk} limit={day.limitCzk} level={day.limitLevel} />
          <p className="sub row">
            <span>limit {czk(day.limitCzk)} Kč</span>
            <VsUsual pct={day.vsUsualPct} level={day.usualLevel} />
          </p>
        </div>
      </div>
      {parts && (
        <Split
          title="Co stálo nejvíc"
          unit={splitUnit("Kč za 24 h", split)}
          rows={parts.map((p, i) => ({
            name: p.name,
            cls: partClass(i),
            value: shownCzk(p.czkShown, p.czk),
            detail: `${Math.round(p.share * 100)} %`,
            ratio: p.czk / Math.max(day.limitCzk, day.czk, 1),
            exact: p.czk,
          }))}
        />
      )}
      <HourlyStack bars={bars} parts={parts ? bars[0]?.parts?.length ?? 0 : 0} limit={hourLimit} />
    </div>
  );
}

interface SplitRow {
  name: string;
  cls: string;
  value: string;
  detail: string;
  /** Bar length, 0…1, on the period's limit scale. */
  ratio: number;
  exact: number;
}

/**
 * The cost split per circuit: one row each in fixed circuit order, a swatch carrying the circuit's
 * colour (the same in both tiles and in the hourly chart), the name, a bar on the limit's scale and
 * the value. The costliest circuit is marked by weight, not colour.
 */
function Split({ title, unit, rows, big }: { title: string; unit: string; rows: SplitRow[]; big?: boolean }) {
  const top = rows.reduce((a, b) => (b.exact > a.exact ? b : a), rows[0]);
  return (
    <div className={`split${big ? " split-big" : ""}`} role="group" aria-label={`${title}: ${rows.map((r) => `${r.name} ${r.value} ${unit}`).join(", ")}`}>
      <div className="split-head">
        <h3>{title}</h3>
        <span className="split-unit">{unit}</span>
      </div>
      {rows.map((r) => (
        <div className={`split-row${r === top && r.exact >= 0.5 ? " is-top" : ""}`} key={r.name}>
          <span className={`swatch ${r.cls}`} aria-hidden />
          <span className="split-name">{r.name}</span>
          <span className="split-track">
            <span className={`split-fill ${r.cls}`} style={{ width: `${Math.min(100, r.ratio * 100)}%` }} />
          </span>
          <span className="split-value">
            {r.value}
            <span className="split-detail">{r.detail}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

/** Whole crowns that add up to the headline; a part that costs something but rounds to 0 reads "<1". */
function shownCzk(shown: number, exact: number): string {
  return shown === 0 && exact > 0.05 ? "<1" : String(shown);
}

const tenth = (v: number) => v.toLocaleString("cs-CZ", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/**
 * Cost per hour for the last 24 hours, each column stacked by circuit in the split's colours and
 * order. Over-limit hours are read against the dashed limit line: status colours stay out of the
 * circuit colours.
 */
function HourlyStack({ bars, parts, limit }: { bars: Bar[]; parts: number; limit: number }) {
  if (bars.length === 0) return null;
  // Scale to the tallest hour so the circuit segments stay readable; the limit line is drawn only
  // when it falls inside the plot, and the header says so when every hour is well below it.
  const max = Math.max(...bars.map((b) => b.czk), 0.01) * 1.1;
  const pct = (v: number) => (v / max) * 100;
  const peak = bars.reduce((a, b) => (b.czk > a.czk ? b : a), bars[0]);
  const over = bars.filter((b) => limit > 0 && b.czk >= limit).length;
  const lineShown = limit > 0 && limit <= max;
  const limitText =
    limit <= 0
      ? ""
      : over > 0
        ? `limit ${czk(limit)} Kč/h (${over}× překročen)`
        : lineShown
          ? `limit ${czk(limit)} Kč/h`
          : `všechny hodiny pod limitem ${czk(limit)} Kč/h`;
  const mid = bars[Math.floor(bars.length / 2)];
  return (
    <div className="hours">
      <div className="hours-head">
        <h3>Po hodinách</h3>
        <span className="split-unit">
          {lineShown && <span className="dash" aria-hidden />} {limitText}
          {peak.czk > 0 && ` · nejdražší ${hourLabel(peak.start)}:00 (${czk(peak.czk)} Kč)`}
        </span>
      </div>
      <div
        className="hours-plot"
        role="img"
        aria-label={`Cena po hodinách za 24 h, nejdražší hodina ${hourLabel(peak.start)}:00 za ${czk(peak.czk)} Kč`}
      >
        {bars.map((b) => {
          const segs = parts && b.parts ? b.parts : [b.czk];
          return (
            <div className="hour" key={b.start} title={`${hourLabel(b.start)}:00 – ${czk(b.czk)} Kč`}>
              {segs.map((v, k) =>
                // Skip slivers: a segment under ~2 % of the plot is noise at TV distance.
                pct(v) >= 2 ? (
                  <div key={k} className={`seg ${parts ? partClass(k) : "c-total"}`} style={{ height: `${pct(v)}%` }} />
                ) : null,
              )}
            </div>
          );
        })}
        {lineShown && <div className="limit-line" style={{ bottom: `${pct(limit)}%` }} />}
      </div>
      <div className="trend-axis">
        <span>{hourLabel(bars[0].start)}:00</span>
        <span>{hourLabel(mid.start)}:00</span>
        <span>teď</span>
      </div>
    </div>
  );
}

/** "When is electricity cheap": the next 12 hours as VT/NT blocks, titled with the takeaway. */
function TariffTimeline({ stretches, headline, prices }: { stretches: TariffStretch[]; headline: string; prices: Prices }) {
  if (stretches.length === 0) return null;
  const from = stretches[0].from;
  const to = stretches[stretches.length - 1].to;
  const span = Math.max(1, to - from);
  const pct = (ms: number) => ((ms - from) / span) * 100;

  // Time labels: "teď", every boundary, and the end; skip one that would crowd the previous label.
  const marks: { at: number; label: string }[] = [{ at: from, label: "teď" }];
  for (const s of stretches.slice(1)) marks.push({ at: s.from, label: time(s.from) });
  marks.push({ at: to, label: time(to) });
  const shown: typeof marks = [];
  for (const m of marks) {
    const last = shown[shown.length - 1];
    if (!last || pct(m.at) - pct(last.at) >= 7) shown.push(m);
    else if (m.at === to) shown[shown.length - 1] = m;
  }

  return (
    <section className="timeline" aria-label="Kdy je elektřina levná">
      <div className="timeline-head">
        <h2>{headline}</h2>
        <span className="sub">příštích {Math.round(span / HOUR)} hodin</span>
      </div>
      <div className="tl-strip">
        {stretches.map((s) => {
          const w = pct(s.to) - pct(s.from);
          const nt = s.tariff === "NT";
          const p = price(nt ? prices.nt : prices.vt);
          const label =
            w >= 18 ? `${nt ? "levné" : "drahé"} · ${s.tariff} ${p} Kč/kWh` : w >= 5 ? s.tariff : "";
          return (
            <div key={s.from} className={`tl-block tl-${s.tariff}`} style={{ width: `${w}%` }} title={`${s.tariff} ${time(s.from)}–${time(s.to)}`}>
              {label && <span className="tl-label">{label}</span>}
            </div>
          );
        })}
      </div>
      <div className="tl-times">
        {shown.map((m, i) => (
          <span
            key={m.at}
            className={i === 0 ? "tl-time tl-now" : "tl-time"}
            style={{ left: `${pct(m.at)}%` }}
            data-edge={i === 0 ? "start" : m.at === to ? "end" : undefined}
          >
            {m.label}
          </span>
        ))}
      </div>
    </section>
  );
}
