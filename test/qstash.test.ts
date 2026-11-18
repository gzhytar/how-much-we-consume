import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { qstashCollectUrl, verifyQStash } from "@/lib/auth";

const CURRENT = "sig_current_test_key";
const NEXT = "sig_next_test_key";
const URL_ = "https://kolik.example.app/api/collect";

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** Builds the HS256 JWT that QStash puts in `Upstash-Signature`. */
function sign(body: string, key = CURRENT, claims: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: "Upstash",
      sub: URL_,
      exp: now + 300,
      nbf: now,
      iat: now,
      jti: `msg_${now}`,
      body: b64url(createHash("sha256").update(body).digest()),
      ...claims,
    }),
  );
  const sig = b64url(createHmac("sha256", key).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}

const request = (signature?: string) =>
  new Request(URL_, { method: "POST", headers: signature ? { "upstash-signature": signature } : {} });

describe("QStash signature check", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.QSTASH_CURRENT_SIGNING_KEY = CURRENT;
    process.env.QSTASH_NEXT_SIGNING_KEY = NEXT;
    process.env.QSTASH_COLLECT_URL = URL_;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("accepts a correctly signed call", async () => {
    expect((await verifyQStash(request(sign("")), "")).ok).toBe(true);
  });
  it("accepts the next key during key rotation", async () => {
    expect((await verifyQStash(request(sign("x", NEXT)), "x")).ok).toBe(true);
  });
  it("rejects a wrong key", async () => {
    expect((await verifyQStash(request(sign("", "someone-else")), "")).ok).toBe(false);
  });
  it("rejects a changed body", async () => {
    expect((await verifyQStash(request(sign("a")), "b")).ok).toBe(false);
  });
  it("rejects a signature for another endpoint", async () => {
    const r = await verifyQStash(request(sign("", CURRENT, { sub: "https://other.app/api/x" })), "");
    expect(r).toMatchObject({ ok: false });
  });
  it("rejects an expired signature", async () => {
    const old = Math.floor(Date.now() / 1000) - 3600;
    expect((await verifyQStash(request(sign("", CURRENT, { exp: old + 300, nbf: old })), "")).ok).toBe(false);
  });
  it("rejects a missing header or missing keys", async () => {
    expect(await verifyQStash(request(), "")).toEqual({ ok: false, reason: "no signature" });
    delete process.env.QSTASH_NEXT_SIGNING_KEY;
    expect((await verifyQStash(request(sign("")), "")).ok).toBe(false);
  });
  it("derives the expected URL from Vercel's production domain", () => {
    delete process.env.QSTASH_COLLECT_URL;
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "kolik.vercel.app";
    expect(qstashCollectUrl()).toBe("https://kolik.vercel.app/api/collect");
  });
});
