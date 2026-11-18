"use client";

import { useEffect, useRef, useState } from "react";
import type { Bar, PeriodSummary, Summary } from "@/lib/summary";
import type { Level } from "@/lib/thresholds";

const POLL_MS = 60_000;
const TZ = "Europe/Prague";

const czk = (v: number) =>
  v.toLocaleString("cs-CZ", {
    minimumFractionDigits: v < 100 ? 1 : 0,
    maximumFractionDigits: v < 100 ? 1 : 0,
  });
const price = (v: number) => v.toLocaleString("cs-CZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (v: number) => {
  const r = Math.round(v);
  return r === 0 ? "stejně" : `${r > 0 ? "+" : "−"}${Math.abs(r)} %`;
};
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
  return (
    <main className={`screen level-${data.level}`} style={{ transform: `translate(${shift.x}px, ${shift.y}px)` }}>
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
        <PeriodTile title="Poslední hodina" p={data.hour} usualWord="obvykle v tuto dobu" />
        <PeriodTile title="Posledních 24 hodin" p={data.day} usualWord="obvyklý den" />
        <div className="tile now">
          <h2>Právě teď</h2>
          <div className="big">
            {data.powerW === null ? "–" : (data.powerW / 1000).toLocaleString("cs-CZ", { maximumFractionDigits: 1, minimumFractionDigits: 1 })}
            <span className="unit"> kW</span>
          </div>
          <p className="sub">
            {data.powerW === null
              ? "bez aktuálních dat"
              : `≈ ${czk((data.powerW / 1000) * t.priceNow)} Kč za hodinu`}
          </p>
        </div>
      </section>

      {data.tips.length > 0 && (
        <section className={`tip tip-${data.level}`} role="status">
          {data.tips[0]}
        </section>
      )}

      <section className="chart-wrap">
        <div className="chart-head">
          <h2>Cena po hodinách – posledních 24 h</h2>
          <div className="legend">
            <span className="lg lg-bar" /> Kč za hodinu
            <span className="lg lg-nt" /> NT (levný tarif)
            <span className="lg lg-limit" /> limit {czk(data.hour.limitCzk)} Kč/h
            {data.bars.some((b) => b.usualCzk !== null) && (
              <>
                <span className="lg lg-usual" /> obvykle
              </>
            )}
          </div>
        </div>
        <HourChart bars={data.bars} limit={data.hour.limitCzk} />
      </section>

      <footer className="foot">
        <span className={data.stale ? "stale" : ""}>
          {data.lastSampleAt
            ? `${data.stale ? "⚠ Data nejsou aktuální – poslední měření" : "Poslední měření"} ${time(data.lastSampleAt)}`
            : "⚠ Zatím žádná měření"}
        </span>
        {error && <span className="stale">⚠ Bez spojení se serverem ({error})</span>}
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

function PeriodTile({ title, p, usualWord }: { title: string; p: PeriodSummary; usualWord: string }) {
  const s = STATUS[p.level];
  const fill = p.limitCzk > 0 ? Math.min(100, (p.czk / p.limitCzk) * 100) : 0;
  return (
    <div className={`tile period level-${p.level}`}>
      <h2>{title}</h2>
      <div className="big">
        {czk(p.czk)}
        <span className="unit"> Kč</span>
      </div>
      <p className="sub">
        {kwh(p.kwh)} kWh{p.kwh > 0 ? ` · ${Math.round(p.ntShare * 100)} % v NT` : ""}
      </p>
      <div className="meter" aria-label={`${Math.round(fill)} % limitu`}>
        <div className={`meter-fill level-${p.limitLevel}`} style={{ width: `${fill}%` }} />
        <div className="meter-mark" style={{ left: "80%" }} />
      </div>
      <p className="sub">
        limit {czk(p.limitCzk)} Kč
        {p.usual && p.vsUsualPct !== null && (
          <>
            {" · "}
            {usualWord} {czk(p.usual.median)} Kč ({pct(p.vsUsualPct)})
          </>
        )}
      </p>
      <div className={`pill level-${p.level}`}>
        <span className="pill-icon" aria-hidden>
          {s.icon}
        </span>
        {s.label}
      </div>
    </div>
  );
}

function HourChart({ bars, limit }: { bars: Bar[]; limit: number }) {
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
  const pad = { l: 64, r: 16, t: 40, b: 36 };
  const max = Math.max(limit * 1.15, ...bars.map((b) => b.czk), ...bars.map((b) => b.usualCzk ?? 0), 1);
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const slot = iw / bars.length;
  const bw = slot - 6;
  const y = (v: number) => pad.t + ih - (v / max) * ih;
  const ticks = niceTicks(max);
  const peak = bars.reduce((a, b) => (b.czk > a.czk ? b : a), bars[0]);

  return (
    <div className="chart-box" ref={box}>
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Cena elektřiny po hodinách za posledních 24 hodin">
      {bars.map((b, i) =>
        b.ntShare > 0 ? (
          <rect
            key={`nt${i}`}
            x={pad.l + i * slot}
            y={pad.t}
            width={slot}
            height={ih}
            className="nt-band"
            opacity={b.ntShare}
          />
        ) : null,
      )}
      {ticks.map((v) => (
        <g key={v}>
          <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} className="grid" />
          <text x={pad.l - 10} y={y(v) + 6} className="axis" textAnchor="end">
            {v}
          </text>
        </g>
      ))}
      <line x1={pad.l} x2={W - pad.r} y1={pad.t + ih} y2={pad.t + ih} className="baseline" />
      {bars.map((b, i) => {
        const x = pad.l + i * slot + 3;
        const h = Math.max(0, pad.t + ih - y(b.czk));
        const r = Math.min(4, h / 2, bw / 2);
        return (
          <g key={b.start}>
            <title>{`${hourLabel(b.start)}:00 – ${czk(b.czk)} Kč, ${kwh(b.kwh)} kWh${b.usualCzk !== null ? `, obvykle ${czk(b.usualCzk)} Kč` : ""}`}</title>
            {h > 0 && <path d={roundedTop(x, pad.t + ih - h, bw, h, r)} className={b.partial ? "bar partial" : "bar"} />}
            {b.usualCzk !== null && (
              <line x1={x + 2} x2={x + bw - 2} y1={y(b.usualCzk)} y2={y(b.usualCzk)} className="usual" />
            )}
            {i % 3 === 0 && (
              <text x={x + bw / 2} y={H - 10} className="axis" textAnchor="middle">
                {hourLabel(b.start)}
              </text>
            )}
          </g>
        );
      })}
      {limit > 0 && limit <= max && (
        <line x1={pad.l} x2={W - pad.r} y1={y(limit)} y2={y(limit)} className="limit" />
      )}
      {peak && peak.czk > 0 && (
        <text
          x={pad.l + bars.indexOf(peak) * slot + slot / 2}
          y={y(peak.czk) - 8}
          className="peak"
          textAnchor="middle"
        >
          {czk(peak.czk)}
        </text>
      )}
      <text x={pad.l - 10} y={22} className="axis" textAnchor="end">
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
