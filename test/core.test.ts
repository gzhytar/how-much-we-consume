import { describe, expect, it } from "vitest";
import { buildLedger, sumRange, type Sample } from "@/lib/energy";
import { selectSchedule, type EgdEntry } from "@/lib/hdo";
import { parseStatus } from "@/lib/shelly";
import { decode, encode } from "@/lib/store";
import { buildSummary } from "@/lib/summary";
import { emptySchedule, isNT, nextChange, parseFallback } from "@/lib/tariff";
import { baselineFor, levelFromBaseline, levelFromLimit, median, worst } from "@/lib/thresholds";
import { DAY, HOUR, MINUTE, pragueLocal, pragueOffsetMin } from "@/lib/time";

const prices = { vt: 6, nt: 3 };
// Prague local "YYYY-MM-DD HH:MM" in winter (UTC+1) / summer (UTC+2) → epoch ms.
const cet = (s: string) => Date.parse(`${s.replace(" ", "T")}:00+01:00`);
const cest = (s: string) => Date.parse(`${s.replace(" ", "T")}:00+02:00`);

/** Constant power `w` sampled every `step` ms over [from, to]. */
function constant(from: number, to: number, w: number, step = MINUTE, startWh = 1000): Sample[] {
  const out: Sample[] = [];
  for (let t = from; t <= to; t += step) out.push({ ts: t, wh: startWh + (w * (t - from)) / HOUR, w });
  return out;
}

describe("Prague time", () => {
  it("knows winter and summer offsets", () => {
    expect(pragueOffsetMin(cet("2026-01-15 12:00"))).toBe(60);
    expect(pragueOffsetMin(cest("2026-07-15 12:00"))).toBe(120);
  });
  it("gives local hour and ISO weekday across DST", () => {
    // 2026-03-29 is the spring-forward Sunday: 02:00 CET → 03:00 CEST.
    expect(pragueLocal(cet("2026-03-29 01:30"))).toMatchObject({ hour: 1, isoWeekday: 7 });
    expect(pragueLocal(cest("2026-03-29 03:30"))).toMatchObject({ hour: 3, isoWeekday: 7 });
    expect(pragueLocal(cet("2026-11-16 00:10"))).toMatchObject({ hour: 0, isoWeekday: 1 });
  });
});

describe("tariff schedule", () => {
  const sched = parseFallback("00:00-06:00,13:00-15:00");
  it("parses fallback windows", () => {
    expect(sched[1]).toEqual([
      [0, 360],
      [780, 900],
    ]);
    expect(sched[7]).toEqual(sched[1]);
  });
  it("parses per-day groups and windows across midnight", () => {
    const s = parseFallback("1-5=22:00-06:00;6-7=00:00-08:00");
    // A night window belongs to the day it starts on: Mon 22:00 → Tue 06:00.
    expect(s[1]).toEqual([[1320, 1440]]);
    expect(s[2]).toEqual([
      [0, 360],
      [1320, 1440],
    ]);
    // Saturday: Friday night's 00:00–06:00 merges with Saturday's own 00:00–08:00.
    expect(s[6]).toEqual([[0, 480]]);
  });
  it("uses Prague local time, not UTC", () => {
    expect(isNT(sched, cet("2026-01-15 05:59"))).toBe(true);
    expect(isNT(sched, cet("2026-01-15 06:00"))).toBe(false);
    expect(isNT(sched, cest("2026-07-15 13:30"))).toBe(true); // 11:30 UTC
    expect(isNT(sched, cest("2026-07-15 12:30"))).toBe(false);
  });
  it("finds the next change", () => {
    expect(nextChange(sched, cet("2026-01-15 10:17"))).toEqual({ at: cet("2026-01-15 13:00"), to: "NT" });
    expect(nextChange(emptySchedule(), cet("2026-01-15 10:17"))).toBeNull();
  });
  it("treats 23:59 as end of day", () => {
    expect(parseFallback("23:00-23:59")[3]).toEqual([[1380, 1440]]);
  });
});

describe("cost from counter deltas", () => {
  const sched = parseFallback("00:00-06:00");
  it("prices a constant 1 kW hour in VT", () => {
    const from = cet("2026-01-15 10:00");
    const l = buildLedger(constant(from, from + HOUR, 1000), sched, prices);
    const r = sumRange(l, from, from + HOUR);
    expect(r.kwh).toBeCloseTo(1, 6);
    expect(r.czk).toBeCloseTo(6, 6);
    expect(r.coverage).toBeCloseTo(1, 6);
  });
  it("splits an interval that crosses the VT/NT boundary proportionally", () => {
    // One reading at 05:30 and the next at 06:30 → 1 kWh, half NT, half VT.
    const a = cet("2026-01-15 05:30");
    const l = buildLedger(
      [
        { ts: a, wh: 0, w: 0 },
        { ts: a + HOUR, wh: 1000, w: 0 },
      ],
      sched,
      prices,
    );
    const r = sumRange(l, a, a + HOUR);
    expect(r.kwh).toBeCloseTo(1, 6);
    expect(r.ntKwh).toBeCloseTo(0.5, 6);
    expect(r.czk).toBeCloseTo(0.5 * 3 + 0.5 * 6, 6);
    // A one-hour gap is spread out but doesn't count as covered.
    expect(r.coverage).toBe(0);
  });
  it("ignores a counter reset instead of producing negative cost", () => {
    const a = cet("2026-01-15 10:00");
    const s: Sample[] = [
      { ts: a, wh: 5000, w: 0 },
      { ts: a + MINUTE, wh: 5010, w: 0 },
      { ts: a + 2 * MINUTE, wh: 3, w: 0 }, // reset
      { ts: a + 3 * MINUTE, wh: 13, w: 0 },
    ];
    const r = sumRange(buildLedger(s, sched, prices), a, a + 3 * MINUTE);
    expect(r.kwh).toBeCloseTo(0.02, 6);
  });
  it("gives the same total from 5-minute and 1-minute readings", () => {
    const from = cet("2026-01-15 05:00");
    const to = from + 2 * HOUR;
    const fine = sumRange(buildLedger(constant(from, to, 1500, MINUTE), sched, prices), from, to);
    const coarse = sumRange(buildLedger(constant(from, to, 1500, 5 * MINUTE), sched, prices), from, to);
    expect(coarse.kwh).toBeCloseTo(fine.kwh, 6);
    expect(coarse.czk).toBeCloseTo(fine.czk, 6);
  });
  it("handles the 25-hour autumn DST day", () => {
    // 2026-10-25: 03:00 CEST → 02:00 CET. 24 h of real time at 1 kW = 24 kWh regardless.
    const to = cet("2026-10-25 12:00");
    const from = to - DAY;
    const r = sumRange(buildLedger(constant(from, to, 1000), parseFallback(""), prices), from, to);
    expect(r.kwh).toBeCloseTo(24, 6);
  });
});

describe("thresholds", () => {
  it("limit levels: amber from 80 %, red from 100 %", () => {
    expect(levelFromLimit(15.9, 20)).toBe("ok");
    expect(levelFromLimit(16, 20)).toBe("warn");
    expect(levelFromLimit(20, 20)).toBe("alert");
  });
  it("baseline levels need both ratio and an absolute difference", () => {
    expect(levelFromBaseline(14, 10, 2)).toBe("warn"); // 1.4×
    expect(levelFromBaseline(17, 10, 2)).toBe("alert"); // 1.7×
    expect(levelFromBaseline(0.5, 0.2, 2)).toBe("ok"); // tiny numbers
  });
  it("median and worst", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(worst("ok", null, "warn")).toBe("warn");
  });
  it("baseline compares weekdays with weekdays", () => {
    const now = cet("2026-11-18 19:00"); // Wednesday
    const from = now - 15 * DAY;
    const samples: Sample[] = [];
    let wh = 0;
    for (let t = from; t <= now; t += MINUTE) {
      // Weekends use 3 kW, weekdays 1 kW.
      const w = pragueLocal(t).isoWeekday >= 6 ? 3000 : 1000;
      samples.push({ ts: t, wh, w });
      wh += (w * MINUTE) / HOUR;
    }
    const l = buildLedger(samples, parseFallback(""), prices);
    const b = baselineFor(l, now - HOUR, now, { sameDayType: true });
    expect(b?.median).toBeCloseTo(6, 6); // 1 kWh × 6 CZK
    expect(b?.days).toBe(10);
  });
});

describe("summary", () => {
  it("adds up 1 h and 24 h and flags the hour limit", () => {
    const now = cet("2026-11-18 19:00");
    const s = buildSummary({
      samples: constant(now - DAY, now, 4000),
      schedule: parseFallback(""),
      scheduleSource: "test",
      prices,
      limits: { hourCzk: 20, dayCzk: 1000 },
      now,
    });
    expect(s.hour.czk).toBeCloseTo(24, 6);
    expect(s.hour.level).toBe("alert");
    expect(s.day.kwh).toBeCloseTo(96, 6);
    expect(s.day.level).toBe("ok");
    expect(s.hour.usual).toBeNull(); // less than 7 days of history
    expect(s.bars).toHaveLength(24);
    expect(s.stale).toBe(false);
    expect(s.tips[0]).toMatch(/nad limitem/);
  });
  it("marks old data as stale and hides the live power", () => {
    const now = cet("2026-11-18 19:00");
    const s = buildSummary({
      samples: constant(now - DAY, now - 10 * MINUTE, 500),
      schedule: parseFallback(""),
      scheduleSource: "test",
      prices,
      limits: { hourCzk: 20, dayCzk: 200 },
      now,
    });
    expect(s.stale).toBe(true);
    expect(s.powerW).toBeNull();
  });
});

describe("Shelly status parsing", () => {
  const now = 1_763_000_000_000;
  it("reads the triphase profile", () => {
    const s = parseStatus(
      { sys: { unixtime: now / 1000 - 5 }, "em:0": { total_act_power: 1234.5 }, "emdata:0": { total_act: 98765.4 } },
      now,
    );
    expect(s).toEqual({ ts: now, wh: 98765.4, w: 1234.5 });
    const withPhases = parseStatus(
      {
        "em:0": { total_act_power: 600, a_act_power: 100, b_act_power: 200, c_act_power: 300 },
        "emdata:0": { total_act: 5 },
      },
      now,
    );
    expect(withPhases.phases).toEqual([100, 200, 300]);
    expect(withPhases.phaseWh).toBeUndefined();
    const withCounters = parseStatus(
      {
        "em:0": { total_act_power: 600, a_act_power: 100, b_act_power: 200, c_act_power: 300 },
        "emdata:0": { total_act: 60, a_total_act_energy: 10, b_total_act_energy: 20, c_total_act_energy: 30 },
      },
      now,
    );
    expect(withCounters.phaseWh).toEqual([10, 20, 30]);
  });
  it("sums the monophase profile", () => {
    const s = parseStatus(
      {
        "em1:0": { act_power: 100 },
        "em1:1": { act_power: 200 },
        "em1:2": { act_power: 300 },
        "em1data:0": { total_act_energy: 10 },
        "em1data:1": { total_act_energy: 20 },
        "em1data:2": { total_act_energy: 30 },
      },
      now,
    );
    expect(s).toEqual({ ts: now, wh: 60, w: 600, phases: [100, 200, 300], phaseWh: [10, 20, 30] });
  });
  it("fails clearly without energy data", () => {
    expect(() => parseStatus({ "switch:0": {} }, now)).toThrow(/emdata:0/);
  });
});

describe("EG.D HDO selection", () => {
  const day = (d: number, casy: [string, string][]) => ({ denVTydnu: d, casy: casy.map(([od, d2]) => ({ od, do: d2 })) });
  const entries: EgdEntry[] = [
    {
      region: "VYCHOD",
      kodHdo_A: "405",
      A: "1",
      B: "4",
      DP: "06",
      od: { den: "01", mesic: "01", rok: "1900" },
      do: { den: "31", mesic: "12", rok: "9999" },
      sazby: [
        { sazba: "C25d,D25d-relé1-TAR", dny: [1, 2, 3, 4, 5, 6, 7].map((d) => day(d, [["00:00:00", "06:00:00"], ["20:00:00", "23:59:00"]])) },
        { sazba: "D25d-relé2-TUV", dny: [day(1, [["01:00:00", "03:00:00"]])] },
      ],
    },
    {
      region: "PH",
      kodHdo_A: "PH8_13",
      od: { den: "01", mesic: "10", rok: "9999" },
      do: { den: "31", mesic: "03", rok: "9999" },
      sazby: [{ sazba: "D25d", dny: [day(1, [["13:00:00", "15:00:00"]])] }],
    },
  ];
  const now = cet("2026-11-18 12:00");

  it("matches a receiver povel and picks the TAR relay", () => {
    const m = selectSchedule(entries, { code: "A1B4DP6", tariff: "D25d" }, now);
    expect(m.schedule[3]).toEqual([
      [0, 360],
      [1200, 1440],
    ]);
    expect(m.label).toContain("VYCHOD");
  });
  it("matches by code name and a winter-only season", () => {
    expect(selectSchedule(entries, { code: "ph8_13" }, now).schedule[1]).toEqual([[780, 900]]);
    expect(() => selectSchedule(entries, { code: "PH8_13" }, cest("2026-07-01 12:00"))).toThrow(/platný/);
  });
  it("explains an unknown code", () => {
    expect(() => selectSchedule(entries, { code: "XYZ" }, now)).toThrow(/nebyl/);
  });
});

describe("storage encoding", () => {
  it("round-trips phases and reads old members without them", () => {
    expect(decode(encode({ ts: 1, wh: 2, w: 3, phases: [1.04, 0, -5] }))).toEqual({ ts: 1, wh: 2, w: 3, phases: [1, 0, -5] });
    expect(decode("1:2:3")).toEqual({ ts: 1, wh: 2, w: 3 });
  });
  it("round-trips per-phase energy counters, with or without live phase power", () => {
    const full = { ts: 1, wh: 2, w: 3, phases: [1, 2, 3], phaseWh: [10.1234, 20, 30] };
    expect(decode(encode(full))).toEqual({ ...full, phaseWh: [10.123, 20, 30] });
    expect(decode(encode({ ts: 1, wh: 2, w: 3, phaseWh: [10, 20, 30] }))).toEqual({ ts: 1, wh: 2, w: 3, phaseWh: [10, 20, 30] });
  });
  it("round-trips a sample", () => {
    expect(decode(encode({ ts: 1_763_000_000_000, wh: 12345.6789, w: 456.78 }))).toEqual({
      ts: 1_763_000_000_000,
      wh: 12345.679,
      w: 456.8,
    });
  });
});

describe("Shelly server and network errors", () => {
  it("normalizes SHELLY_SERVER", async () => {
    const { baseUrl } = await import("@/lib/shelly");
    expect(baseUrl("shelly-103-eu.shelly.cloud")).toBe("https://shelly-103-eu.shelly.cloud");
    expect(baseUrl(" https://shelly-103-eu.shelly.cloud/ ")).toBe("https://shelly-103-eu.shelly.cloud");
    expect(baseUrl('"https://shelly-103-eu.shelly.cloud/device/status"')).toBe("https://shelly-103-eu.shelly.cloud");
    expect(() => baseUrl("shelly-XX-eu.shelly.cloud")).toThrow(/SHELLY_SERVER/);
    expect(() => baseUrl("my shelly")).toThrow(/SHELLY_SERVER/);
    expect(() => baseUrl("shelly-api-eu.shelly.cloud:6022/jrpc")).toThrow(/samotný měřák/);
  });
  it("explains fetch failed", async () => {
    const { describeFetchError } = await import("@/lib/shelly");
    const dns = Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND x" } });
    expect(describeFetchError(dns)).toMatch(/SHELLY_SERVER/);
    const tls = Object.assign(new TypeError("fetch failed"), { cause: { code: "CERT_HAS_EXPIRED", message: "certificate has expired" } });
    expect(describeFetchError(tls)).toBe("fetch failed (CERT_HAS_EXPIRED certificate has expired)");
  });
});

describe("live rate and chart levels", () => {
  const now = cet("2026-11-18 19:00");
  const base = (w: number, extra = 0) =>
    constant(now - DAY, now, w).map((x, i, all) =>
      i >= all.length - 5 ? { ...x, phases: [extra, w, 0] } : { ...x, phases: [0, w, 0] },
    );

  it("averages over the configured reading interval", () => {
    // 1 kW all day, then 4 kW extra for the last 5 minutes: a 10-minute window sees half of it.
    const samples: Sample[] = [];
    let wh = 0;
    for (let t = now - DAY; t <= now; t += MINUTE) {
      const w = t >= now - 5 * MINUTE ? 5000 : 1000;
      samples.push({ ts: t, wh, w });
      wh += (w * MINUTE) / HOUR;
    }
    const input = { samples, schedule: parseFallback(""), scheduleSource: "t", prices, limits: { hourCzk: 20, dayCzk: 1000 }, now };
    expect(buildSummary(input).live?.windowMinutes).toBe(3);
    expect(buildSummary(input).live?.kw).toBeCloseTo(5, 6);
    const ten = buildSummary({ ...input, pollMinutes: 10 }).live;
    expect(ten?.windowMinutes).toBe(10);
    expect(ten?.kw).toBeCloseTo(3, 6);
  });

  it("treats data as stale after max(5, poll + 2) minutes", () => {
    const input = { samples: constant(now - DAY, now - 8 * MINUTE, 500), schedule: parseFallback(""), scheduleSource: "t", prices, limits: { hourCzk: 20, dayCzk: 200 }, now };
    expect(buildSummary(input).stale).toBe(true);
    expect(buildSummary({ ...input, pollMinutes: 10 }).stale).toBe(false);
  });

  it("splits the headline by per-phase energy, so the rows add up to it", () => {
    // Over the last 3 minutes L1 used 1.1 kW, L2 1.5 kW and L3 0.1 kW on average (2.7 kW), but L2
    // only just jumped to 2.2 kW: the latest live power (3.4 kW) must not be what the rows show.
    const samples: Sample[] = [];
    let e = [0, 0, 0];
    for (let t = now - HOUR; t <= now; t += MINUTE) {
      const w = t > now - 3 * MINUTE ? [1100, 1500, 100] : [300, 300, 100];
      const live = t === now ? [1100, 2200, 100] : w;
      samples.push({ ts: t, wh: e[0] + e[1] + e[2], w: live[0] + live[1] + live[2], phases: live, phaseWh: e });
      e = e.map((x, i) => x + (w[i] * MINUTE) / HOUR);
    }
    const s = buildSummary({ samples, schedule: parseFallback(""), scheduleSource: "t", prices, limits: { hourCzk: 30, dayCzk: 1000 }, now });
    const live = s.live!;
    expect(live.phaseSplit).toBe("energy");
    const sumCzk = live.phases!.reduce((a, p) => a + p.czkShown, 0);
    const sumKw = live.phases!.reduce((a, p) => a + p.kwShown, 0);
    expect(sumCzk).toBe(Math.ceil(live.czkPerHour - 1e-9));
    expect(sumKw).toBeCloseTo(Math.round(live.kw * 10) / 10, 6);
    expect(live.phases!.reduce((a, p) => a + p.czkPerHour, 0)).toBeCloseTo(live.czkPerHour, 6);
    // L2's part follows its energy in the window, not its live 2.2 kW.
    expect(live.phases![1].w / 1000).toBeLessThan(2);
  });

  it("splits the last 24 h per circuit, adding up even when older readings lack counters", () => {
    // 1 kW per phase all day; per-phase counters only for the last 2 hours (stored since a deploy),
    // live power before that, and the first 2 hours with no phase data at all.
    const samples: Sample[] = [];
    let e = [0, 0, 0];
    const w = [500, 300, 200];
    for (let t = now - DAY - HOUR; t <= now; t += 5 * MINUTE) {
      const s: Sample = { ts: t, wh: e[0] + e[1] + e[2], w: 1000 };
      if (t > now - DAY + HOUR) s.phases = w;
      if (t >= now - 2 * HOUR) s.phaseWh = e;
      samples.push(s);
      e = e.map((x, i) => x + (w[i] * 5 * MINUTE) / HOUR);
    }
    const s = buildSummary({ samples, schedule: parseFallback(""), scheduleSource: "t", prices, limits: { hourCzk: 20, dayCzk: 1000 }, now, phaseNames: ["Kuchyň", "Obývák", "Děti"] });
    expect(s.daySplit).toBe("mixed");
    expect(s.parts).toEqual(["Kuchyň", "Obývák", "Děti", "Nerozlišeno"]);
    const parts = s.dayParts!;
    expect(parts.map((p) => p.name)).toEqual(["Kuchyň", "Obývák", "Děti", "Nerozlišeno"]);
    expect(parts.reduce((a, p) => a + p.czk, 0)).toBeCloseTo(s.day.czk, 6);
    expect(parts.reduce((a, p) => a + p.czkShown, 0)).toBe(Math.ceil(s.day.czk - 1e-9));
    // Attributed hours keep the 5:3:2 split; the hour with no phase data goes to "Nerozlišeno".
    expect(parts[0].czk / parts[1].czk).toBeCloseTo(5 / 3, 6);
    expect(parts[3].czk).toBeGreaterThan(0);
    // Each hourly column adds up to the hour's total.
    for (const b of s.bars) expect(b.parts!.reduce((a, x) => a + x, 0)).toBeCloseTo(b.czk, 6);
    expect(s.live?.phaseSplit).toBe("energy");
  });

  it("rounds among the shown parts only, when a sliver of energy is unattributed", () => {
    // 3 readings in 24 h lack phase data: a sliver goes to "Nerozlišeno" and is hidden (≤ 0,5 %),
    // yet the shown rows must still sum to the shown day total.
    const samples: Sample[] = [];
    let e = [0, 0, 0];
    const w = [1817, 1709, 2470];
    for (let t = now - DAY - HOUR; t <= now; t += MINUTE) {
      const gap = t > now - 10 * HOUR && t <= now - 10 * HOUR + 2 * MINUTE;
      samples.push({ ts: t, wh: e[0] + e[1] + e[2], w: 0, ...(gap ? {} : { phases: w, phaseWh: e }) });
      e = e.map((x, i) => x + (w[i] * MINUTE) / HOUR);
    }
    const s = buildSummary({ samples, schedule: parseFallback(""), scheduleSource: "t", prices, limits: { hourCzk: 20, dayCzk: 1000 }, now });
    const parts = s.dayParts!;
    expect(parts).toHaveLength(3);
    expect(parts.reduce((a, p) => a + p.czkShown, 0)).toBe(Math.ceil(s.day.czk - 1e-9));
  });

  it("treats readings with unchanged counters as exact, not an estimate", () => {
    // Readings every 30 s, counters advancing only every minute (cached by Shelly Cloud).
    const samples: Sample[] = [];
    let e = [0, 0, 0];
    for (let t = now - 2 * HOUR; t <= now; t += 30_000) {
      samples.push({ ts: t, wh: e[0] + e[1] + e[2], w: 900, phases: [300, 300, 300], phaseWh: e });
      if ((t / 30_000) % 2 === 1) e = e.map((x) => x + (300 * MINUTE) / HOUR);
    }
    const s = buildSummary({ samples, schedule: parseFallback(""), scheduleSource: "t", prices, limits: { hourCzk: 20, dayCzk: 1000 }, now });
    expect(s.live?.phaseSplit).toBe("energy");
  });

  it("apportions whole numbers that sum to the total", async () => {
    const { apportion } = await import("@/lib/summary");
    expect(apportion([1.1, 2.2, 0.1], 13)).toEqual([4, 9, 0]);
    expect(apportion([1, 1, 1], 10).reduce((a, b) => a + b, 0)).toBe(10);
    expect(apportion([0, 0, 0], 5)).toEqual([0, 0, 0]);
  });

  it("averages the last 5 minutes into Kč/h and flags it against the hourly limit", () => {
    // 1 kW all day, then 4 kW extra for the last 5 minutes.
    const samples: Sample[] = [];
    let wh = 0;
    for (let t = now - DAY; t <= now; t += MINUTE) {
      const w = t >= now - 5 * MINUTE ? 5000 : 1000;
      samples.push({ ts: t, wh, w, phases: [w - 1000, 1000, 0] });
      wh += (w * MINUTE) / HOUR;
    }
    const s = buildSummary({
      samples,
      schedule: parseFallback(""),
      scheduleSource: "t",
      prices,
      limits: { hourCzk: 20, dayCzk: 1000 },
      now,
      phaseNames: ["Kuchyň", "", "Bojler"],
    });
    expect(s.live?.kw).toBeCloseTo(5, 6);
    expect(s.live?.czkPerHour).toBeCloseTo(30, 6);
    expect(s.live?.level).toBe("alert");
    expect(s.level).toBe("alert");
    // No per-phase counters here, so the headline is split by the latest live power.
    expect(s.live?.phaseSplit).toBe("power");
    expect(s.live?.phases?.map((p) => [p.name, p.czkShown, p.kwShown])).toEqual([
      ["Kuchyň", 24, 4],
      ["L2", 6, 1],
      ["Bojler", 0, 0],
    ]);
    expect(s.live?.phases?.[0].czkPerHour).toBeCloseTo(24, 6);
    expect(s.tips[0]).toMatch(/Právě teď.*Nejvíc Kuchyň \(24 Kč\/h\)/);
    expect(s.timeline.stretches[0].from).toBe(now);
  });

  it("marks bars over the hourly limit", () => {
    const s = buildSummary({
      samples: base(4000),
      schedule: parseFallback("00:00-06:00"),
      scheduleSource: "t",
      prices,
      limits: { hourCzk: 20, dayCzk: 1000 },
      now,
    });
    // 4 kW costs 24 Kč/h in VT (over the 20 Kč limit) but only 12 Kč/h in NT.
    const full = s.bars.slice(0, 23);
    expect(full.filter((b) => b.ntShare === 0).every((b) => b.level === "alert")).toBe(true);
    expect(full.filter((b) => b.ntShare === 1).every((b) => b.level === "ok")).toBe(true);
    // From 19:00, 12 h ahead: VT until 00:00, NT 00:00–06:00, VT until 07:00.
    expect(s.timeline.stretches).toEqual([
      { from: now, to: now + 5 * HOUR, tariff: "VT" },
      { from: now + 5 * HOUR, to: now + 11 * HOUR, tariff: "NT" },
      { from: now + 11 * HOUR, to: now + 12 * HOUR, tariff: "VT" },
    ]);
    expect(s.timeline.headline).toBe("Levný tarif za 5 h (od 00:00)");
    expect(s.timeline.hint).toBe("Levný tarif za 5 h (od 00:00) – pračku, myčku a sušičku spusťte až potom.");
  });

  it("has no live value when the data is stale", () => {
    const s = buildSummary({
      samples: constant(now - DAY, now - 10 * MINUTE, 500),
      schedule: parseFallback(""),
      scheduleSource: "t",
      prices,
      limits: { hourCzk: 20, dayCzk: 200 },
      now,
    });
    expect(s.live).toBeNull();
  });
});

describe("display helpers", () => {
  it("rounds costs up to whole crowns", async () => {
    const { fmtCzk, ceilCzk } = await import("@/lib/summary");
    expect(ceilCzk(8.01)).toBe(9);
    expect(ceilCzk(8)).toBe(8);
    expect(ceilCzk(8.0000000001)).toBe(8); // float noise isn't a whole extra crown
    expect(ceilCzk(0)).toBe(0);
    expect(fmtCzk(1234.2)).toBe("1\u00a0235 Kč");
  });
  it("formats durations", async () => {
    const { fmtDuration } = await import("@/lib/summary");
    expect(fmtDuration(45 * MINUTE)).toBe("45 min");
    expect(fmtDuration(2 * HOUR + 15 * MINUTE)).toBe("2 h 15 min");
    expect(fmtDuration(3 * HOUR)).toBe("3 h");
  });
  it("hints how long cheap power lasts when it's on", () => {
    const at = cet("2026-11-18 01:00");
    const s = buildSummary({
      samples: constant(at - HOUR, at, 500),
      schedule: parseFallback("00:00-06:00"),
      scheduleSource: "t",
      prices,
      limits: { hourCzk: 20, dayCzk: 200 },
      now: at,
    });
    expect(s.timeline.headline).toBe("Levný tarif ještě 5 h (do 06:00)");
    expect(s.timeline.hint).toBe("Teď je levný tarif ještě 5 h (do 06:00) – dobrá chvíle pro pračku a myčku.");
  });
});
