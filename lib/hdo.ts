// EG.D HDO (low-tariff) schedule.
// Source: https://hdo.distribuce24.cz/casy – the undocumented public JSON that EG.D's own
// "časy platnosti nízkého tarifu" page and community Home Assistant integrations
// (github.com/mkutlak/ha-egd-hdo) use. No login. The format can change without notice,
// so HDO_FALLBACK is always used if the download or the match fails.

import { addWindow, emptySchedule, normalizeSchedule, parseHHMM, type WeeklySchedule } from "./tariff";
import { pragueLocal } from "./time";

export const EGD_HDO_URL = "https://hdo.distribuce24.cz/casy";

interface EgdDate {
  den: string;
  mesic: string;
  rok: string;
}

export interface EgdEntry {
  region: string;
  skupinaPovelu?: string;
  kodHdo_A?: string;
  A?: string;
  B?: string;
  DP?: string;
  od?: EgdDate;
  do?: EgdDate;
  sazby?: { sazba: string; dny: { denVTydnu: number; casy: { od: string; do: string }[] }[] }[];
}

export interface HdoQuery {
  /** HDO code: either the receiver povel "A1B4DP6" or the code name (kodHdo_A), e.g. "PH8_13". */
  code: string;
  /** Optional EG.D region, e.g. "VYCHOD", "ZAPAD", "PH", "SM" (needed when a code exists in several regions). */
  region?: string;
  /** Optional distribution tariff, e.g. "D25d" or the exact "D25d-relé1-TAR". */
  tariff?: string;
}

export interface HdoMatch {
  schedule: WeeklySchedule;
  label: string;
}

/** Picks the matching EG.D record valid on `now` and turns it into a weekly NT schedule. */
export function selectSchedule(entries: EgdEntry[], q: HdoQuery, now: number): HdoMatch {
  const povel = /^A(\d+)B(\d+)DP(\d+)$/i.exec(q.code.replace(/\s+/g, ""));
  const codeLc = q.code.trim().toLowerCase();
  const regionLc = q.region?.trim().toLowerCase();

  let candidates = entries.filter((e) => {
    if (regionLc && e.region?.toLowerCase() !== regionLc) return false;
    if (povel) {
      return (
        Number(e.A) === Number(povel[1]) &&
        Number(e.B) === Number(povel[2]) &&
        Number(e.DP) === Number(povel[3])
      );
    }
    return e.kodHdo_A?.toLowerCase() === codeLc;
  });
  if (candidates.length === 0) {
    throw new Error(`HDO kód "${q.code}"${q.region ? ` v regionu ${q.region}` : ""} nebyl v datech EG.D nalezen`);
  }

  const today = pragueLocal(now);
  candidates = candidates.filter((e) => isValidOn(e, today.year, today.month, today.day));
  if (candidates.length === 0) throw new Error(`HDO kód "${q.code}" nemá pro dnešek platný rozvrh`);
  candidates.sort((a, b) => specificity(b) - specificity(a));

  const regions = new Set(candidates.map((c) => c.region));
  if (regions.size > 1 && !regionLc) {
    throw new Error(`HDO kód "${q.code}" existuje ve více regionech (${[...regions].join(", ")}); nastavte EGD_HDO_REGION`);
  }

  const entry = candidates[0];
  const sazba = pickSazba(entry, q.tariff);
  const schedule = emptySchedule();
  for (const day of sazba.dny) {
    for (const c of day.casy) addWindow(schedule, day.denVTydnu, parseHHMM(c.od), parseHHMM(c.do));
  }
  return {
    schedule: normalizeSchedule(schedule),
    label: `EG.D ${entry.region} ${entry.kodHdo_A ?? q.code} (${sazba.sazba})`,
  };
}

function pickSazba(entry: EgdEntry, tariff?: string) {
  const sazby = entry.sazby ?? [];
  if (sazby.length === 0) throw new Error("Záznam HDO neobsahuje žádné časy");
  if (!tariff) return sazby[0];
  const t = tariff.trim().toLowerCase();
  const items = (s: string) => s.split(",").map((x) => x.trim().toLowerCase());
  return (
    sazby.find((s) => items(s.sazba).includes(t)) ??
    // "D25d" should match "D25d-relé1-TAR". Prefer the TAR relay, which is the one that switches the tariff.
    sazby.find((s) => items(s.sazba).some((i) => i.startsWith(`${t}-`) && i.includes("tar"))) ??
    sazby.find((s) => items(s.sazba).some((i) => i.startsWith(t))) ??
    sazby[0]
  );
}

function isValidOn(e: EgdEntry, y: number, m: number, d: number): boolean {
  if (!e.od || !e.do) return true;
  const from = toDate(e.od);
  const to = toDate(e.do);
  const today = m * 100 + d;
  if (from.y === 9999 || to.y === 9999) {
    // Recurring every year (e.g. 1 Oct – 31 Mar), unless it's "1900 → 9999" = all year.
    if (from.y === 1900 || from.y < 2000) return true;
    const f = from.m * 100 + from.d;
    const t = to.m * 100 + to.d;
    return f <= t ? today >= f && today <= t : today >= f || today <= t;
  }
  const v = y * 10000 + today;
  return v >= from.y * 10000 + from.m * 100 + from.d && v <= to.y * 10000 + to.m * 100 + to.d;
}

function specificity(e: EgdEntry): number {
  if (!e.od || !e.do) return 0;
  const fy = Number(e.od.rok);
  const ty = Number(e.do.rok);
  if (fy !== 9999 && ty !== 9999) return 3; // fixed dates
  if (fy === 9999) return 2; // yearly season
  return 1; // open-ended
}

function toDate(x: EgdDate) {
  return { y: Number(x.rok), m: Number(x.mesic), d: Number(x.den) };
}

export async function fetchEgdEntries(timeoutMs = 20_000): Promise<EgdEntry[]> {
  const res = await fetch(EGD_HDO_URL, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`EG.D HDO: HTTP ${res.status}`);
  const data = (await res.json()) as unknown;
  if (!Array.isArray(data)) throw new Error("EG.D HDO: neočekávaný formát odpovědi");
  return data as EgdEntry[];
}
