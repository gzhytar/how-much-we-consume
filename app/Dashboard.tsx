"use client";

import { useEffect, useRef, useState } from "react";
import type { Bar, LiveSummary, PeriodSummary, Summary, UpcomingHour } from "@/lib/summary";
import type { Level } from "@/lib/thresholds";

const POLL_MS = 60_000;
const TZ = "Europe/Prague";

const czk = (v: number) =>
  v.toLocaleString("cs-CZ", {
    minimumFractionDigits: v < 100 ? 1 : 0,
    maximumFractionDigits: v < 100 ? 1 : 0,
  });
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
  const banner = stale
    ? {
        level: "warn" as Level,
        text: error
          ? "⚠ Bez spojení se serverem – čísla nemusí být aktuální."
          : data.lastSampleAt
            ? `⚠ Data nejsou aktuální – poslední měření v ${time(data.lastSampleAt)}. Čísla nemusí odpovídat skutečnosti.`
            : "⚠ Zatím žádná měření z elektroměru.",
      }
    : data.tips.length > 0
      ? { level: data.level, text: data.tips[0] }
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
            {t.current === "NT" ? "Levný tarif NT" : "Drahý tarif VT"} · {price(t.priceNow)} Kč/kWh
          </span>
          {t.nextChangeAt && (
            <span className="next">
              {t.nextTariff === "NT" ? "NT od" : "VT od"} {time(t.nextChangeAt)}
            </span>
          )}
          <span className="clock">{time(clock)}</span>
        </div>
      </header>

      <section className="tiles">
        <LiveTile live={data.live} limit={data.hour.limitCzk} tariffLabel={`${t.current} ${price(t.priceNow)} Kč/kWh`} />
        <div className="side">
          <PeriodTile title="Poslední hodina" p={data.hour} stale={stale} />
          <PeriodTile title="Posledních 24 hodin" p={data.day} stale={stale} />
        </div>
      </section>

      {banner && (
        <section className={`tip tip-${banner.level}`} role="status">
          {banner.text}
        </section>
      )}

      <section className="chart-wrap">
        <ChartHead bars={data.bars} limit={data.hour.limitCzk} />
        <HourChart bars={data.bars} upcoming={data.upcoming} limit={data.hour.limitCzk} />
      </section>

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

function LiveTile({ live, limit, tariffLabel }: { live: LiveSummary | null; limit: number; tariffLabel: string }) {
  const level = live?.level ?? "ok";
  const maxPhase = live?.phases ? Math.max(1000, ...live.phases.map((p) => p.w)) : 1;
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
            {live ? `${kw(live.kw * 1000)} kW · průměr za 5 min · ${tariffLabel}` : "bez aktuálních dat"}
          </p>
          {live && <Meter value={live.czkPerHour} limit={limit} level={live.limitLevel} />}
          <p className="sub row">
            <span>limit {czk(limit)} Kč/h</span>
            {live?.usualCzkPerHour != null && <span>obvykle {czk(live.usualCzkPerHour)} Kč/h</span>}
            {live && <VsUsual pct={live.vsUsualPct} level={live.usualLevel} />}
          </p>
        </div>
        {live?.phases && (
          <div className="phases" aria-label="Odběr po fázích">
            <h3>Co teď běží</h3>
            {live.phases.map((p) => (
              <div className="phase" key={p.name}>
                <span className="phase-name">{p.name}</span>
                <span className="phase-track">
                  <span className="phase-fill" style={{ width: `${Math.min(100, (p.w / maxPhase) * 100)}%` }} />
                </span>
                <span className="phase-value">{kw(p.w)} kW</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PeriodTile({ title, p, stale }: { title: string; p: PeriodSummary; stale: boolean }) {
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
    </div>
  );
}

function ChartHead({ bars, limit }: { bars: Bar[]; limit: number }) {
  const has = (l: Level) => bars.some((b) => b.level === l);
  return (
    <div className="chart-head">
      <h2>Cena po hodinách – posledních 24 h a příští hodiny</h2>
      <div className="legend">
        <span className="lg lg-bar" /> Kč za hodinu
        <span className="lg lg-now" /> tato hodina
        {bars.some((b) => b.usualCzk !== null) && (
          <>
            <span className="lg lg-usual" /> obvykle
          </>
        )}
        {has("warn") && (
          <>
            <span className="lg lg-warn" /> nad obvyklou spotřebou
          </>
        )}
        {has("alert") && (
          <>
            <span className="lg lg-alert" /> nad limitem {czk(limit)} Kč
          </>
        )}
      </div>
    </div>
  );
}

function HourChart({ bars, upcoming, limit }: { bars: Bar[]; upcoming: UpcomingHour[]; limit: number }) {
  // Match the drawing's aspect ratio to the box it sits in, so it fills the space without stretching text.
  const box = useRef<HTMLDivElement>(null);
  const [aspect, setAspect] = useState(300 / 1600);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => el.clientWidth > 0 && el.clientHeight > 0 && setAspect(el.clientHeight / el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const W = 1600;
  const H = Math.max(220, Math.round(W * aspect));
  const pad = { l: 64, r: 16, t: 44, b: 40 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const slots = bars.length + upcoming.length;
  const slot = iw / slots;
  const bw = Math.min(slot * 0.5, 40);
  const nowIndex = bars.length - 1;

  // Scale to the data; include the limit only when it's close enough not to squash the bars.
  const dataMax = Math.max(1, ...bars.map((b) => b.czk), ...bars.map((b) => b.usualCzk ?? 0)) * 1.12;
  const showLimit = limit > 0 && limit <= dataMax * 1.3;
  const max = showLimit ? Math.max(dataMax, limit * 1.08) : dataMax;
  const y = (v: number) => pad.t + ih - (v / max) * ih;
  const base = pad.t + ih;
  const xSlot = (i: number) => pad.l + i * slot;
  const ticks = niceTicks(max);

  const nt = [...bars.map((b) => b.ntShare), ...upcoming.map((u) => u.ntShare)];
  const ntRuns: { from: number; to: number }[] = [];
  nt.forEach((s, i) => {
    if (s <= 0) return;
    const last = ntRuns[ntRuns.length - 1];
    if (last && last.to === i) last.to = i + 1;
    else ntRuns.push({ from: i, to: i + 1 });
  });

  const past = bars.slice(0, -1);
  const peak = past.reduce<Bar | null>((a, b) => (!a || b.czk > a.czk ? b : a), null);
  const allStarts = [...bars.map((b) => b.start), ...upcoming.map((u) => u.start)];

  return (
    <div className="chart-box" ref={box}>
      <svg
        className="chart"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Cena elektřiny po hodinách za posledních 24 hodin a tarif v příštích hodinách"
      >
        {nt.map((s, i) =>
          s > 0 ? <rect key={`nt${i}`} x={xSlot(i)} y={pad.t} width={slot} height={ih} className="nt-band" opacity={s} /> : null,
        )}
        {ntRuns.map((r) => (
          <text key={`ntl${r.from}`} x={xSlot(r.from) + ((r.to - r.from) * slot) / 2} y={pad.t + 26} className="nt-label" textAnchor="middle">
            NT
          </text>
        ))}

        {ticks.map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} className="grid" />
            <text x={pad.l - 10} y={y(v) + 7} className="axis" textAnchor="end">
              {v}
            </text>
          </g>
        ))}
        <line x1={pad.l} x2={W - pad.r} y1={base} y2={base} className="baseline" />

        {bars.map((b, i) => {
          const cx = xSlot(i) + slot / 2;
          const h = Math.max(0, base - y(b.czk));
          const isNow = i === nowIndex;
          const cls = b.level !== "ok" ? `bar bar-${b.level}` : isNow ? "bar bar-now" : "bar";
          return (
            <g key={b.start}>
              <title>{`${hourLabel(b.start)}:00 – ${czk(b.czk)} Kč, ${kwh(b.kwh)} kWh${b.usualCzk !== null ? `, obvykle ${czk(b.usualCzk)} Kč` : ""}`}</title>
              {b.usualCzk !== null && b.usualCzk > 0 && (
                <path d={roundedTop(xSlot(i) + 2, y(b.usualCzk), slot - 4, base - y(b.usualCzk), 4)} className="ghost" />
              )}
              {h > 0 && <path d={roundedTop(cx - bw / 2, base - h, bw, h, Math.min(4, h / 2, bw / 2))} className={cls} />}
            </g>
          );
        })}

        {/* Divider between what happened and what's coming. */}
        <line x1={xSlot(bars.length)} x2={xSlot(bars.length)} y1={pad.t - 30} y2={base} className="divider" />
        <text x={xSlot(bars.length) + 10} y={pad.t - 14} className="axis">
          příští hodiny →
        </text>

        {showLimit ? (
          <line x1={pad.l} x2={xSlot(bars.length)} y1={y(limit)} y2={y(limit)} className="limit" />
        ) : (
          limit > 0 && (
            <text x={pad.l + 10} y={pad.t - 14} className="axis">
              limit {czk(limit)} Kč/h ↑ (nad grafem)
            </text>
          )
        )}

        {peak && peak.czk > 0 && (
          <text
            x={xSlot(bars.indexOf(peak)) + slot / 2}
            y={Math.min(y(peak.czk), peak.usualCzk ? y(peak.usualCzk) : Infinity) - 10}
            className="peak"
            textAnchor="middle"
          >
            {czk(peak.czk)}
          </text>
        )}

        {allStarts.map((start, i) => {
          if (i === nowIndex) {
            return (
              <text key={`x${i}`} x={xSlot(i) + slot / 2} y={H - 10} className="axis-now" textAnchor="middle">
                teď
              </text>
            );
          }
          if (i % 3 !== 0 || Math.abs(i - nowIndex) < 2) return null;
          return (
            <text key={`x${i}`} x={xSlot(i) + slot / 2} y={H - 10} className="axis" textAnchor="middle">
              {hourLabel(start)}
            </text>
          );
        })}
        <text x={pad.l - 10} y={pad.t - 14} className="axis" textAnchor="end">
          Kč
        </text>
      </svg>
    </div>
  );
}

function roundedTop(x: number, y: number, w: number, h: number, r: number) {
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}

function niceTicks(max: number): number[] {
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = step; v <= max; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}
