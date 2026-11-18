import { NextResponse } from "next/server";
import { dashboardAllowed } from "@/lib/auth";
import { collect, COLLECT_IF_OLDER_THAN } from "@/lib/collector";
import { getConfig } from "@/lib/config";
import { getSchedule } from "@/lib/schedule";
import { getStore } from "@/lib/store";
import { buildSummary } from "@/lib/summary";
import { DAY } from "@/lib/time";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const cfg = getConfig();
  const token = new URL(req.url).searchParams.get("t");
  if (!dashboardAllowed(cfg.dashboardToken, token)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const store = getStore();
  const warnings: string[] = [];

  // Keeps the data fresh while the TV shows the page, even if the external cron is late.
  const c = await collect(cfg, store, { maxAgeMs: COLLECT_IF_OLDER_THAN });
  if (c.status === "error") warnings.push(c.error);

  const now = Date.now();
  const { schedule, source, warning } = await getSchedule(cfg, store, now);
  if (warning) warnings.push(warning);
  if (cfg.pricesAreDefaults) warnings.push("Ceny VT/NT nejsou nastavené – používám odhad 6,50 / 4,50 Kč/kWh.");
  if (store.kind === "memory" && !cfg.demo) warnings.push("Bez databáze: historie se po restartu ztratí.");

  // 14 days for the baseline + 1 day for the 24 h window.
  const samples = await store.getSamples(now - 15 * DAY - 60 * 60_000);
  const summary = buildSummary({
    samples,
    schedule,
    scheduleSource: source,
    prices: cfg.prices,
    limits: cfg.limits,
    now,
    warnings,
  });
  return NextResponse.json(summary, { headers: { "Cache-Control": "no-store" } });
}
