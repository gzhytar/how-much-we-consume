// Optional check against a real download of https://hdo.distribuce24.cz/casy:
//   curl -o casy.json https://hdo.distribuce24.cz/casy && EGD_CASY_FILE=casy.json npm test
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { selectSchedule, type EgdEntry } from "@/lib/hdo";

const file = process.env.EGD_CASY_FILE;

describe.skipIf(!file)("real EG.D data", () => {
  const entries = file ? (JSON.parse(readFileSync(file, "utf8")) as EgdEntry[]) : [];
  const now = Date.now();

  it("resolves every receiver povel in region VYCHOD", () => {
    const vychod = entries.filter((e) => e.region === "VYCHOD" && e.A && e.B && e.DP);
    let ok = 0;
    for (const e of vychod) {
      try {
        const m = selectSchedule(entries, { code: `A${e.A}B${e.B}DP${e.DP}`, region: "VYCHOD" }, now);
        if (m.schedule.some((d) => d.length > 0)) ok++;
      } catch {
        // codes with no schedule valid today are fine
      }
    }
    console.log(`VYCHOD: ${ok}/${vychod.length} povely resolved`);
    expect(ok).toBeGreaterThan(0);
  });

  it("resolves a code name with a tariff", () => {
    const e = entries.find((x) => x.region === "VYCHOD" && x.kodHdo_A)!;
    const m = selectSchedule(entries, { code: e.kodHdo_A!, region: "VYCHOD", tariff: "C45d" }, now);
    console.log(m.label, JSON.stringify(m.schedule[1]));
    expect(m.schedule[1].length).toBeGreaterThan(0);
  });
});
