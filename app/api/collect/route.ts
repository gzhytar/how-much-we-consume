import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { collectAllowed, verifyQStash } from "@/lib/auth";
import { collect } from "@/lib/collector";
import { getConfig } from "@/lib/config";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

/**
 * Takes one meter reading. Accepted callers:
 * - the Upstash QStash schedule (signed `Upstash-Signature` header), or
 * - anyone with COLLECT_SECRET / CRON_SECRET (`Authorization: Bearer …` or `?key=…`), e.g. a manual test.
 */
async function handle(req: Request) {
  const cfg = getConfig();
  const store = getStore();
  const rawBody = req.method === "POST" ? await req.text() : "";

  if (req.headers.has("upstash-signature")) {
    const check = await verifyQStash(req, rawBody);
    if (!check.ok) {
      console.warn(`collect: QStash signature rejected (${check.reason})`);
      return json({ error: "unauthorized" }, 401);
    }
    // A signature stays valid for 5 minutes; refuse to run the same one twice.
    const id = createHash("sha256").update(check.signature).digest("hex").slice(0, 32);
    if (!(await store.tryLock(`qstash:${id}`, 6 * 60_000))) return json({ status: "duplicate" });
  } else if (!collectAllowed(cfg.collectSecrets, req)) {
    return json({ error: "unauthorized" }, 401);
  }

  const result = await collect(cfg, store);
  return json(result, result.status === "error" ? 502 : 200);
}

export const GET = handle;
export const POST = handle;
