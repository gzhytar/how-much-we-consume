"use client";

import { useEffect, useState } from "react";
import type { Bar, LiveSummary, PeriodSummary, PhasePower, Summary } from "@/lib/summary";
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
        <LiveTile live={data.live} limit={data.hour.limitCzk} />
        <div className="side">
          <PeriodTile title="Poslední hodina" p={data.hour} stale={stale} />
          <PeriodTile title="Posledních 24 hodin" p={data.day} stale={stale}>
            <Trend bars={data.bars} />
          </PeriodTile>
        </div>
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

function LiveTile({ live, limit }: { live: LiveSummary | null; limit: number }) {
  const level = live?.level ?? "ok";
  return (
    <div className={`tile live level-${level}`}>
      <div className="tile-head">
        <h2>Právě teď</h2>
        {live && <StatusPill level={level} />}
      </div>
      <div className="live-body">
        <div className="live-main">
          <div className="hero">
            {live ? czk(live.czkPerHour) : "–"}
            <span className="unit"> Kč/h</span>
          </div>
          <p className="sub">
            {live ? `${kw(live.kw * 1000)} kW · průměr za ${live.windowMinutes} min` : "bez aktuálních dat"}
          </p>
          {live && <Meter value={live.czkPerHour} limit={limit} level={live.limitLevel} />}
          <p className="sub row">
            <span>limit {czk(limit)} Kč/h</span>
            {live?.usualCzkPerHour != null && <span>obvykle {czk(live.usualCzkPerHour)} Kč/h</span>}
            {live && <VsUsual pct={live.vsUsualPct} level={live.usualLevel} />}
          </p>
        </div>
        {live?.phases && <PhaseCosts phases={live.phases} limit={limit} />}
      </div>
    </div>
  );
}

/**
 * "Co teď běží": what each circuit costs per hour right now. Bars share the hourly limit's scale,
 * so a bar's length means the same as the main meter; the costliest circuit is highlighted.
 */
function PhaseCosts({ phases, limit }: { phases: PhasePower[]; limit: number }) {
  const scale = Math.max(limit, ...phases.map((p) => p.czkPerHour), 1);
  const top = phases.reduce((a, b) => (b.czkPerHour > a.czkPerHour ? b : a), phases[0]);
  const label = phases.map((p) => `${p.name} ${phaseCzk(p.czkPerHour)} Kč za hodinu`).join(", ");
  return (
    <div className="phases" role="group" aria-label={`Co teď běží: ${label}`}>
      <div className="phases-head">
        <h3>Co teď běží</h3>
        <span className="phases-unit">Kč za hodinu</span>
      </div>
      {phases.map((p) => {
        const isTop = p === top && p.czkPerHour >= 1;
        return (
          <div className={`phase${isTop ? " is-top" : ""}`} key={p.name}>
            <span className="phase-name">{p.name}</span>
            <span className="phase-track">
              <span className="phase-fill" style={{ width: `${Math.min(100, (p.czkPerHour / scale) * 100)}%` }} />
            </span>
            <span className="phase-value">
              {phaseCzk(p.czkPerHour)}
              <span className="phase-kw">{kw(p.w)} kW</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Whole crowns rounded up, like every cost on the screen; under 1 Kč reads "<1" rather than "1". */
function phaseCzk(v: number): string {
  return v > 0 && v < 1 ? "<1" : czk(v);
}

function PeriodTile({
  title,
  p,
  stale,
  children,
}: {
  title: string;
  p: PeriodSummary;
  stale: boolean;
  children?: React.ReactNode;
}) {
  // With out-of-date data a green "V pořádku" would be a false all-clear, so show no status.
  return (
    <div className={`tile period${stale ? "" : ` level-${p.level}`}`}>
      <div className="tile-head">
        <h2>{title}</h2>
        {!stale && <StatusPill level={p.level} />}
      </div>
      <div className="period-value">
        {czk(p.czk)}
        <span className="unit"> Kč</span>
        <span className="sub inline">
          {kwh(p.kwh)} kWh{p.kwh > 0 ? ` · ${Math.round(p.ntShare * 100)} % v NT` : ""}
        </span>
      </div>
      <Meter value={p.czk} limit={p.limitCzk} level={p.limitLevel} />
      <p className="sub row">
        <span>limit {czk(p.limitCzk)} Kč</span>
        <VsUsual pct={p.vsUsualPct} level={p.usualLevel} />
      </p>
      {children}
    </div>
  );
}

/** 24 tiny bars, one per hour: the shape of the day, no axis. Red = hour over the hourly limit. */
function Trend({ bars }: { bars: Bar[] }) {
  if (bars.length === 0) return null;
  const W = 480;
  const H = 56;
  const slot = W / bars.length;
  const bw = slot * 0.62;
  const max = Math.max(...bars.map((b) => b.czk), 0.01);
  const anyRed = bars.some((b) => b.level === "alert");
  const peak = bars.reduce((a, b) => (b.czk > a.czk ? b : a), bars[0]);
  return (
    <div className="trend">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Cena po hodinách za 24 h, nejdražší hodina ${hourLabel(peak.start)}:00 za ${czk(peak.czk)} Kč`}
      >
        {bars.map((b, i) => {
          const h = Math.max(2, (b.czk / max) * H);
          const cls = b.level === "alert" ? "tr-alert" : i === bars.length - 1 ? "tr-now" : "tr-bar";
          return <rect key={b.start} x={i * slot + (slot - bw) / 2} y={H - h} width={bw} height={h} rx={2} className={cls} />;
        })}
      </svg>
      <div className="trend-axis">
        <span>{hourLabel(bars[0].start)}:00</span>
        {anyRed && <span className="trend-note">červeně: hodiny nad limitem</span>}
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
