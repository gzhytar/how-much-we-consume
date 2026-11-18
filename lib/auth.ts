import { timingSafeEqual } from "node:crypto";

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
