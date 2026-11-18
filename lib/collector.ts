import type { AppConfig } from "./config";
import { generateDemoSamples, nextDemoSample } from "./demo";
import { fetchShellySample } from "./shelly";
import { MemoryStore, type Store } from "./store";

export type CollectResult =
  | { status: "stored"; ts: number; wh: number; w: number }
  | { status: "fresh" | "locked" | "unchanged"; ts?: number }
  | { status: "error"; error: string };

/** The dashboard triggers a reading itself when the newest one is older than this. */
export const COLLECT_IF_OLDER_THAN = 90_000;

/**
 * Reads the meter once and stores the reading.
 * A 2-second lock keeps the cron and the TV from calling Shelly Cloud in the same second (limit 1/s).
 */
export async function collect(cfg: AppConfig, store: Store, opts: { maxAgeMs?: number } = {}): Promise<CollectResult> {
  const now = Date.now();
  if (cfg.demo) await seedDemo(store, now);

  const latest = await store.getLatest();
  if (opts.maxAgeMs !== undefined && latest && now - latest.ts < opts.maxAgeMs) {
    return { status: "fresh", ts: latest.ts };
  }
  if (!(await store.tryLock("lock:collect", 2_000))) return { status: "locked" };

  try {
    let sample;
    if (cfg.demo) sample = nextDemoSample(latest, now);
    else if (cfg.shelly) sample = await fetchShellySample(cfg.shelly, now);
    else return { status: "error", error: "Shelly není nastaven (SHELLY_SERVER, SHELLY_DEVICE_ID, SHELLY_AUTH_KEY)" };

    if (latest && sample.ts <= latest.ts) return { status: "unchanged", ts: latest.ts };
    await store.addSample(sample, latest);
    return { status: "stored", ts: sample.ts, wh: sample.wh, w: sample.w };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }
}

async function seedDemo(store: Store, now: number) {
  if (store instanceof MemoryStore && store.samples.length === 0) {
    store.samples = generateDemoSamples(now - 60_000);
  }
}
