// Shelly Cloud Control API client for the Shelly Pro 3EM.
// v2 (recommended by Shelly): POST https://<server>/v2/devices/api/get?auth_key=…
//   body {"ids":["<device id>"],"select":["status"]} → [{ id, online, status: { "em:0": …, "emdata:0": … } }]
// v1 (deprecated): POST https://<server>/device/status, form id + auth_key → { isok, data: { online, device_status } }
// Cloud API limit: 1 request per second.

import type { Sample } from "./energy";

export interface ShellyConfig {
  server: string; // e.g. "shelly-123-eu.shelly.cloud"
  deviceId: string; // 12 hex chars, from the Shelly app
  authKey: string;
  apiVersion: "v1" | "v2";
}

export class ShellyError extends Error {}

type Status = Record<string, unknown>;

export function baseUrl(server: string): string {
  const host = server.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return `https://${host}`;
}

export async function fetchShellySample(cfg: ShellyConfig, now = Date.now()): Promise<Sample> {
  const status = cfg.apiVersion === "v1" ? await fetchV1(cfg) : await fetchV2(cfg);
  return parseStatus(status, now);
}

async function fetchV2(cfg: ShellyConfig): Promise<Status> {
  const url = `${baseUrl(cfg.server)}/v2/devices/api/get?auth_key=${encodeURIComponent(cfg.authKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [cfg.deviceId], select: ["status"] }),
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  });
  if (res.status === 429) throw new ShellyError("Shelly Cloud: příliš mnoho požadavků (limit 1/s)");
  if (!res.ok) throw new ShellyError(`Shelly Cloud: HTTP ${res.status}`);
  const body = (await res.json()) as unknown;
  const list = Array.isArray(body) ? body : [];
  const dev = list.find((d: { id?: string }) => d?.id?.toLowerCase() === cfg.deviceId.toLowerCase()) ?? list[0];
  if (!dev) throw new ShellyError("Shelly Cloud: zařízení nebylo v odpovědi nalezeno (zkontrolujte SHELLY_DEVICE_ID)");
  if (dev.online === 0 || dev.online === false) throw new ShellyError("Shelly Cloud: měřák je offline");
  if (!dev.status) throw new ShellyError("Shelly Cloud: odpověď neobsahuje status");
  return dev.status as Status;
}

async function fetchV1(cfg: ShellyConfig): Promise<Status> {
  const res = await fetch(`${baseUrl(cfg.server)}/device/status`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ id: cfg.deviceId, auth_key: cfg.authKey }).toString(),
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  });
  if (res.status === 429) throw new ShellyError("Shelly Cloud: příliš mnoho požadavků (limit 1/s)");
  if (!res.ok) throw new ShellyError(`Shelly Cloud: HTTP ${res.status}`);
  const body = (await res.json()) as { isok?: boolean; errors?: unknown; data?: { online?: boolean; device_status?: Status } };
  if (!body.isok) throw new ShellyError(`Shelly Cloud: ${JSON.stringify(body.errors ?? "chyba")}`);
  if (body.data?.online === false) throw new ShellyError("Shelly Cloud: měřák je offline");
  if (!body.data?.device_status) throw new ShellyError("Shelly Cloud: odpověď neobsahuje device_status");
  return body.data.device_status;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Reads the cumulative energy counter (Wh) and live power (W) from a Gen2 status object.
 * Pro 3EM in triphase profile: em:0.total_act_power + emdata:0.total_act.
 * Pro 3EM in monophase profile: em1:0..2.act_power + em1data:0..2.total_act_energy (summed).
 */
export function parseStatus(status: Status, now: number): Sample {
  // Stamp with the time we received it. The cloud's cached sys.unixtime isn't guaranteed to be
  // refreshed together with emdata, and cost comes from counter deltas anyway.
  const ts = now;

  const em = status["em:0"] as Status | undefined;
  const emdata = status["emdata:0"] as Status | undefined;
  if (emdata) {
    const wh = num(emdata.total_act);
    if (wh === null) throw new ShellyError("Shelly: emdata:0.total_act chybí");
    return { ts, wh, w: num(em?.total_act_power) ?? 0 };
  }

  let wh = 0;
  let w = 0;
  let found = 0;
  for (let i = 0; i < 3; i++) {
    const d = status[`em1data:${i}`] as Status | undefined;
    if (!d) continue;
    const e = num(d.total_act_energy);
    if (e === null) continue;
    wh += e;
    w += num((status[`em1:${i}`] as Status | undefined)?.act_power) ?? 0;
    found++;
  }
  if (found > 0) return { ts, wh, w };

  const keys = Object.keys(status).filter((k) => k.startsWith("em")).join(", ") || "žádné";
  throw new ShellyError(`Shelly: ve statusu chybí emdata:0 i em1data:N (nalezeno: ${keys})`);
}
