import type { ShellyConfig } from "./shelly";
import type { Limits } from "./summary";
import type { Prices } from "./tariff";

function numEnv(name: string, fallback: number): { value: number; isDefault: boolean } {
  const raw = process.env[name]?.trim().replace(",", ".");
  if (!raw) return { value: fallback, isDefault: true };
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`${name} musí být číslo, je "${raw}"`);
  return { value: v, isDefault: false };
}

export interface AppConfig {
  demo: boolean;
  prices: Prices;
  pricesAreDefaults: boolean;
  limits: Limits;
  shelly: ShellyConfig | null;
  hdo: { code: string; region?: string; tariff?: string } | null;
  hdoFallback: string;
  dashboardToken: string | null;
  collectSecrets: string[];
}

export function getConfig(): AppConfig {
  const vt = numEnv("PRICE_VT_CZK", 6.5);
  const nt = numEnv("PRICE_NT_CZK", 4.5);
  const server = process.env.SHELLY_SERVER?.trim();
  const deviceId = process.env.SHELLY_DEVICE_ID?.trim();
  const authKey = process.env.SHELLY_AUTH_KEY?.trim();
  const code = process.env.EGD_HDO_CODE?.trim();
  return {
    demo: process.env.DEMO === "1",
    prices: { vt: vt.value, nt: nt.value },
    pricesAreDefaults: vt.isDefault || nt.isDefault,
    limits: {
      hourCzk: numEnv("LIMIT_HOUR_CZK", 20).value,
      dayCzk: numEnv("LIMIT_DAY_CZK", 200).value,
    },
    shelly:
      server && deviceId && authKey
        ? { server, deviceId, authKey, apiVersion: process.env.SHELLY_API_VERSION === "v1" ? "v1" : "v2" }
        : null,
    hdo: code
      ? {
          code,
          region: process.env.EGD_HDO_REGION?.trim() || undefined,
          tariff: process.env.EGD_HDO_TARIFF?.trim() || undefined,
        }
      : null,
    // Placeholder default: NT 00:00–06:00 and 13:00–15:00 every day. Replace with your own windows.
    hdoFallback: process.env.HDO_FALLBACK?.trim() || "00:00-06:00,13:00-15:00",
    dashboardToken: process.env.DASHBOARD_TOKEN?.trim() || null,
    collectSecrets: [process.env.COLLECT_SECRET, process.env.CRON_SECRET]
      .map((s) => s?.trim())
      .filter((s): s is string => !!s),
  };
}
