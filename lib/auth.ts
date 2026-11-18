import { timingSafeEqual } from "node:crypto";
import { Receiver } from "@upstash/qstash";

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Dashboard access: no DASHBOARD_TOKEN set means open (local development only). */
export function dashboardAllowed(expected: string | null, given: string | null | undefined): boolean {
  if (!expected) return process.env.NODE_ENV !== "production" || process.env.DEMO === "1";
  return !!given && safeEqual(expected, given);
}

/** Collect access: `Authorization: Bearer <secret>` (Vercel Cron sends CRON_SECRET this way) or `?key=<secret>`. */
export function collectAllowed(secrets: string[], req: Request): boolean {
  if (secrets.length === 0) return process.env.NODE_ENV !== "production";
  const auth = req.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  const key = new URL(req.url).searchParams.get("key");
  return secrets.some((s) => (bearer && safeEqual(s, bearer)) || (key && safeEqual(s, key)));
}

/**
 * The URL the QStash schedule publishes to. QStash signs it into the token (`sub`), and checking it
 * stops a signature made for another endpoint of the same Upstash account from being accepted here.
 * QSTASH_COLLECT_URL overrides; otherwise Vercel's production domain is used.
 */
export function qstashCollectUrl(): string | undefined {
  const explicit = process.env.QSTASH_COLLECT_URL?.trim();
  if (explicit) return explicit;
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  return host ? `https://${host}/api/collect` : undefined;
}

export type QStashCheck = { ok: true; signature: string } | { ok: false; reason: string };

/** Verifies the `Upstash-Signature` JWT that QStash puts on every scheduled call. */
export async function verifyQStash(req: Request, rawBody: string, url = qstashCollectUrl()): Promise<QStashCheck> {
  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY?.trim();
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY?.trim();
  const signature = req.headers.get("upstash-signature");
  if (!signature) return { ok: false, reason: "no signature" };
  if (!currentSigningKey || !nextSigningKey) return { ok: false, reason: "QStash signing keys not set" };
  try {
    await new Receiver({ currentSigningKey, nextSigningKey, devMode: false }).verify({
      signature,
      body: rawBody,
      url,
      clockTolerance: 5,
    });
    return { ok: true, signature };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
