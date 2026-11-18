// Sample storage. Upstash Redis in production (request-priced, so a write every minute is fine
// on the free tier), in-memory for local development and demo mode.
//
// Redis layout:
//   s:raw  sorted set, every reading, kept 2 h      (member "ts:wh:w", score ts)
//   s:5m   sorted set, one reading per 5 min, 35 d  (enough for the 14-day "usual usage" baseline)
// Readings are cumulative counters, so the 5-minute downsample loses no energy, only time detail.

import { Redis } from "@upstash/redis";
import type { Sample } from "./energy";
import { DAY, HOUR, MINUTE } from "./time";

export const RAW_KEEP = 2 * HOUR;
export const COARSE_KEEP = 35 * DAY;
export const COARSE_STEP = 5 * MINUTE;

export interface Store {
  kind: "redis" | "memory";
  /** `prev` is the latest stored reading (the caller already has it), used to pick 5-minute readings. */
  addSample(s: Sample, prev: Sample | null): Promise<void>;
  getLatest(): Promise<Sample | null>;
  /** Readings since `from`: 5-minute ones for older data, every reading for the last 2 h. */
  getSamples(from: number): Promise<Sample[]>;
  getJSON<T>(key: string): Promise<T | null>;
  setJSON(key: string, value: unknown, ttlSec: number): Promise<void>;
  /** Returns true if the lock was taken (SET NX PX). */
  tryLock(key: string, ttlMs: number): Promise<boolean>;
}

export const encode = (s: Sample) => `${s.ts}:${round(s.wh, 3)}:${round(s.w, 1)}`;

export function decode(m: string): Sample | null {
  const [ts, wh, w] = m.split(":").map(Number);
  return Number.isFinite(ts) && Number.isFinite(wh) ? { ts, wh, w: Number.isFinite(w) ? w : 0 } : null;
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

class RedisStore implements Store {
  kind = "redis" as const;
  constructor(private r: Redis) {}

  async addSample(s: Sample, prev: Sample | null) {
    const p = this.r.pipeline();
    p.zadd("s:raw", { score: s.ts, member: encode(s) });
    p.set("s:latest", encode(s));
    // The first reading in each new 5-minute bucket also goes into the long-term set.
    if (!prev || Math.floor(s.ts / COARSE_STEP) > Math.floor(prev.ts / COARSE_STEP)) {
      p.zadd("s:5m", { score: s.ts, member: encode(s) });
      // Pruning once per 5-minute bucket keeps the command count low.
      p.zremrangebyscore("s:raw", 0, s.ts - RAW_KEEP);
      p.zremrangebyscore("s:5m", 0, s.ts - COARSE_KEEP);
    }
    await p.exec();
  }

  async getLatest() {
    const m = await this.r.get<string>("s:latest");
    return m ? decode(String(m)) : null;
  }

  async getSamples(from: number) {
    const raw = (await this.r.zrange<string[]>("s:raw", from, "+inf", { byScore: true }))
      .map((m) => decode(String(m)))
      .filter((s): s is Sample => !!s);
    const rawStart = raw.length ? raw[0].ts : Infinity;
    const coarse =
      from < rawStart
        ? (await this.r.zrange<string[]>("s:5m", from, rawStart === Infinity ? "+inf" : `(${rawStart}`, { byScore: true }))
            .map((m) => decode(String(m)))
            .filter((s): s is Sample => !!s)
        : [];
    return [...coarse, ...raw];
  }

  async getJSON<T>(key: string) {
    const v = await this.r.get<string>(key);
    if (v === null || v === undefined) return null;
    return (typeof v === "string" ? JSON.parse(v) : v) as T;
  }

  async setJSON(key: string, value: unknown, ttlSec: number) {
    await this.r.set(key, JSON.stringify(value), { ex: ttlSec });
  }

  async tryLock(key: string, ttlMs: number) {
    return (await this.r.set(key, "1", { nx: true, px: ttlMs })) === "OK";
  }
}

export class MemoryStore implements Store {
  kind = "memory" as const;
  samples: Sample[] = [];
  private kv = new Map<string, { v: string; until: number }>();

  async addSample(s: Sample) {
    const last = this.samples[this.samples.length - 1];
    if (last && s.ts <= last.ts) return;
    this.samples.push(s);
    const cutoff = s.ts - COARSE_KEEP;
    if (this.samples[0] && this.samples[0].ts < cutoff) this.samples = this.samples.filter((x) => x.ts >= cutoff);
  }
  async getLatest() {
    return this.samples[this.samples.length - 1] ?? null;
  }
  async getSamples(from: number) {
    return this.samples.filter((s) => s.ts >= from);
  }
  async getJSON<T>(key: string) {
    const e = this.kv.get(key);
    return e && e.until > Date.now() ? (JSON.parse(e.v) as T) : null;
  }
  async setJSON(key: string, value: unknown, ttlSec: number) {
    this.kv.set(key, { v: JSON.stringify(value), until: Date.now() + ttlSec * 1000 });
  }
  async tryLock(key: string, ttlMs: number) {
    const e = this.kv.get(key);
    if (e && e.until > Date.now()) return false;
    this.kv.set(key, { v: "1", until: Date.now() + ttlMs });
    return true;
  }
}

// Survive Next.js dev hot reloads.
const g = globalThis as unknown as { __store?: Store };

export function getStore(): Store {
  if (g.__store) return g.__store;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (process.env.DEMO !== "1" && url && token) {
    g.__store = new RedisStore(new Redis({ url, token, automaticDeserialization: false }));
  } else {
    g.__store = new MemoryStore();
  }
  return g.__store;
}
