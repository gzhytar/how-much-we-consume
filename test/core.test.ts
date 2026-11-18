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
    expect(s).toEqual({ ts: now, wh: 60, w: 600 });
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
  it("round-trips a sample", () => {
    expect(decode(encode({ ts: 1_763_000_000_000, wh: 12345.6789, w: 456.78 }))).toEqual({
      ts: 1_763_000_000_000,
      wh: 12345.679,
      w: 456.8,
    });
  });
});
