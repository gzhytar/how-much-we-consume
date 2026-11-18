import { NextResponse } from "next/server";
import { collectAllowed } from "@/lib/auth";
import { collect } from "@/lib/collector";
import { getConfig } from "@/lib/config";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handle(req: Request) {
  const cfg = getConfig();
  if (!collectAllowed(cfg.collectSecrets, req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await collect(cfg, getStore());
  const status = result.status === "error" ? 502 : 200;
  return NextResponse.json(result, { status, headers: { "Cache-Control": "no-store" } });
}

export const GET = handle;
export const POST = handle;
