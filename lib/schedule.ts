import type { AppConfig } from "./config";
import { fetchEgdEntries, selectSchedule } from "./hdo";
import type { Store } from "./store";
import { parseFallback, type WeeklySchedule } from "./tariff";

interface Cached {
  schedule: WeeklySchedule;
  label: string;
  code: string;
}

const CACHE_KEY = "hdo:schedule";
const FAIL_KEY = "hdo:failed";

/**
 * NT schedule: EG.D data (cached 24 h) when EGD_HDO_CODE is set, otherwise HDO_FALLBACK.
 * A failed download is remembered for 1 h, so the 1.5 MB file isn't refetched on every poll.
 */
export async function getSchedule(
  cfg: AppConfig,
  store: Store,
  now = Date.now(),
): Promise<{ schedule: WeeklySchedule; source: string; warning?: string }> {
  const fallback = () => ({ schedule: parseFallback(cfg.hdoFallback), source: `ruční nastavení (${cfg.hdoFallback})` });
  if (!cfg.hdo || cfg.demo) return fallback();

  const cacheId = `${cfg.hdo.code}|${cfg.hdo.region ?? ""}|${cfg.hdo.tariff ?? ""}`;
  const cached = await store.getJSON<Cached>(CACHE_KEY);
  if (cached && cached.code === cacheId) return { schedule: cached.schedule, source: cached.label };

  const failed = await store.getJSON<{ error: string }>(FAIL_KEY);
  if (failed) return { ...fallback(), warning: `Časy HDO z EG.D nejsou k dispozici: ${failed.error}` };

  try {
    const entries = await fetchEgdEntries();
    const match = selectSchedule(entries, cfg.hdo, now);
    await store.setJSON(CACHE_KEY, { schedule: match.schedule, label: match.label, code: cacheId }, 24 * 3600);
    return { schedule: match.schedule, source: match.label };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await store.setJSON(FAIL_KEY, { error }, 3600);
    return { ...fallback(), warning: `Časy HDO z EG.D nejsou k dispozici: ${error}` };
  }
}
