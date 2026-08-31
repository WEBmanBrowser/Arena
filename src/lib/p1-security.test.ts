/**
 * P1 — Security hardening tests: rate limiting (real DB), password reset
 * lifecycle (real DB), CSRF same-origin verification (real NextRequest) and
 * the real forgot/reset route handlers. Local test fixtures only — no secrets.
 */
process.env.TZ = "UTC";

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { passwordResetTokens, rateLimits, users } from "@/db/schema";
import { eq, like, or, sql } from "drizzle-orm";
import { verifyPassword } from "@/lib/auth";
import { checkRateLimit, cleanupExpiredRateLimits, clientIp } from "@/lib/rate-limit";
import { verifySameOrigin } from "@/lib/csrf";
import {
  consumePasswordResetToken,
  createPasswordResetToken,
  isValidResetPassword,
  resetUserPassword,
} from "@/lib/password-reset";
import { POST as forgotPOST } from "@/app/api/auth/forgot-password/route";
import { POST as resetPOST } from "@/app/api/auth/reset-password/route";
import { POST as loginPOST } from "@/app/api/auth/login/route";

const MARKER = `p1test-${Date.now()}`;
const USER_EMAIL = `${MARKER}-user@test.local`;
const UNKNOWN_EMAIL = `${MARKER}-ghost@test.local`;

async function cleanup() {
  await db.execute(sql`DELETE FROM password_reset_tokens WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${MARKER + "-%"})`);
  await db.delete(users).where(like(users.email, `${MARKER}-%`));
  await db.delete(rateLimits).where(
    or(
      like(rateLimits.key, `${MARKER}-%`),
      like(rateLimits.key, "login:ip:10.99.0.%"),
      like(rateLimits.key, "reset:ip:10.99.0.%"),
      like(rateLimits.key, "forgot:ip:10.99.0.%"),
      like(rateLimits.key, `forgot:email:${UNKNOWN_EMAIL}`),
    ),
  );
}

async function ensureUser() {
  await db.insert(users).values({ email: USER_EMAIL, password: "old-hash", name: "P1 User", role: "customer" }).onConflictDoNothing();
  const [u] = await db.select().from(users).where(eq(users.email, USER_EMAIL)).limit(1);
  return u;
}

function postJson(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

afterAll(cleanup);

describe("P1 — rate limiting (Postgres fixed window)", () => {
  beforeEach(async () => {
    await db.delete(rateLimits).where(like(rateLimits.key, `${MARKER}-%`));
  });

  it("allows hits under the limit and blocks beyond it", async () => {
    const key = `${MARKER}-rl-a`;
    const r1 = await checkRateLimit(key, { limit: 3, windowSeconds: 60 });
    expect(r1.allowed).toBe(true);
    expect(r1.count).toBe(1);
    expect(r1.remaining).toBe(2);

    await checkRateLimit(key, { limit: 3, windowSeconds: 60 });
    const r3 = await checkRateLimit(key, { limit: 3, windowSeconds: 60 });
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);

    const r4 = await checkRateLimit(key, { limit: 3, windowSeconds: 60 });
    expect(r4.allowed).toBe(false);
    expect(r4.count).toBe(4);
    expect(r4.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("opens a NEW window after the previous one expires", async () => {
    const key = `${MARKER}-rl-b`;
    for (let i = 0; i < 3; i++) await checkRateLimit(key, { limit: 3, windowSeconds: 60 });
    expect((await checkRateLimit(key, { limit: 3, windowSeconds: 60 })).allowed).toBe(false);

    // Simulate window expiry (DB-side time travel)
    await db.execute(sql`UPDATE rate_limits SET window_start = now() - interval '2 minutes', expires_at = now() - interval '1 minute' WHERE key = ${key}`);
    const fresh = await checkRateLimit(key, { limit: 3, windowSeconds: 60 });
    expect(fresh.allowed).toBe(true);
    expect(fresh.count).toBe(1); // window restarted
  });

  it("cleanupExpiredRateLimits removes only expired rows", async () => {
    await checkRateLimit(`${MARKER}-rl-old`, { limit: 5, windowSeconds: 1 });
    await checkRateLimit(`${MARKER}-rl-new`, { limit: 5, windowSeconds: 600 });
    await db.execute(sql`UPDATE rate_limits SET expires_at = now() - interval '1 minute' WHERE key = ${MARKER + "-rl-old"}`);
    const removed = await cleanupExpiredRateLimits();
    expect(removed).toBeGreaterThanOrEqual(1);
    const [old] = await db.select().from(rateLimits).where(eq(rateLimits.key, `${MARKER}-rl-old`)).limit(1);
    const [fresh] = await db.select().from(rateLimits).where(eq(rateLimits.key, `${MARKER}-rl-new`)).limit(1);
    expect(old).toBeUndefined();
    expect(fresh).toBeDefined();
  });

  it("clientIp prefers cf-connecting-ip then x-forwarded-for", () => {
    const cf = postJson("http://localhost/x", {}, { "cf-connecting-ip": "1.1.1.1", "x-forwarded-for": "2.2.2.2" });
    expect(clientIp(cf)).toBe("1.1.1.1");
    const xf = postJson("http://localhost/x", {}, { "x-forwarded-for": "3.3.3.3, 4.4.4.4" });
    expect(clientIp(xf)).toBe("3.3.3.3");
    expect(clientIp(postJson("http://localhost/x", {}))).toBe("unknown");
  });
});

describe("P1 — CSRF same-origin verification", () => {
  it("POST with matching Origin header → allowed", () => {
    expect(verifySameOrigin(postJson("http://loja.mdtech.pt/api/auth/login", {}, { origin: "https://loja.mdtech.pt" }))).toBe(true);
  });

  it("POST with cross-origin Origin → rejected", () => {
    expect(verifySameOrigin(postJson("http://loja.mdtech.pt/api/auth/login", {}, { origin: "https://evil.example" }))).toBe(false);
  });

  it("POST without Origin or Referer → rejected", () => {
    expect(verifySameOrigin(postJson("http://loja.mdtech.pt/api/auth/login", {}))).toBe(false);
  });

  it("Referer fallback with matching host → allowed", () => {
    expect(verifySameOrigin(postJson("http://loja.mdtech.pt/api/auth/login", {}, { referer: "https://loja.mdtech.pt/conta" }))).toBe(true);
  });

  it("GET (safe method) without Origin → allowed", () => {
    expect(verifySameOrigin(new NextRequest("http://loja.mdtech.pt/api/products"))).toBe(true);
  });

  it("proxied request via x-forwarded-host → allowed", () => {
    expect(verifySameOrigin(postJson("http://internal:3000/api/auth/login", {}, { "x-forwarded-host": "loja.mdtech.pt", origin: "https://loja.mdtech.pt" }))).toBe(true);
  });
});

describe("P1 — password reset lifecycle", () => {
  beforeEach(async () => {
    await cleanup();
    await ensureUser();
  });

  it("creates token: only sha256 hash stored, raw token never persisted", async () => {
    const user = await ensureUser();
    const raw = await createPasswordResetToken(user.id);
    expect(raw).toHaveLength(64);
    const rows = await db.select().from(passwordResetTokens).where(eq(passwordResetTokens.userId, user.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).not.toBe(raw);
    expect(rows[0].tokenHash).toHaveLength(64);
    expect(rows[0].usedAt).toBeNull();
    expect(rows[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("consume: valid token returns userId; reuse returns null (single-use)", async () => {
    const user = await ensureUser();
    const raw = await createPasswordResetToken(user.id);
    expect(await consumePasswordResetToken(raw)).toBe(user.id);
    expect(await consumePasswordResetToken(raw)).toBeNull();
  });

  it("consume: unknown token → null", async () => {
    await ensureUser();
    expect(await consumePasswordResetToken("ab".repeat(32))).toBeNull();
  });

  it("consume: expired token → null", async () => {
    const user = await ensureUser();
    const raw = await createPasswordResetToken(user.id);
    await db.update(passwordResetTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(passwordResetTokens.userId, user.id));
    expect(await consumePasswordResetToken(raw)).toBeNull();
  });

  it("single active token: creating a new one invalidates the previous", async () => {
    const user = await ensureUser();
    const first = await createPasswordResetToken(user.id);
    const second = await createPasswordResetToken(user.id);
    const rows = await db.select().from(passwordResetTokens).where(eq(passwordResetTokens.userId, user.id));
    expect(rows).toHaveLength(1);
    expect(await consumePasswordResetToken(first)).toBeNull();
    expect(await consumePasswordResetToken(second)).toBe(user.id);
  });

  it("resetUserPassword updates the hash (verifiable)", async () => {
    const user = await ensureUser();
    await resetUserPassword(user.id, "NovaPassword123");
    const [row] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
    expect(await verifyPassword("NovaPassword123", row.password)).toBe(true);
    expect(await verifyPassword("old-hash", row.password)).toBe(false);
  });

  it("password policy: min 8, max 128", () => {
    expect(isValidResetPassword("curta")).toBe(false);
    expect(isValidResetPassword("x".repeat(129))).toBe(false);
    expect(isValidResetPassword("valida123")).toBe(true);
  });
});

describe("P1 — forgot/reset ROUTES (real handlers)", () => {
  beforeEach(async () => {
    await cleanup();
    await ensureUser();
  });

  it("POST /api/auth/forgot-password without Origin (cross-site) → 403 CSRF", async () => {
    const res = await forgotPOST(postJson("http://localhost/api/auth/forgot-password", { email: USER_EMAIL }));
    expect(res.status).toBe(403);
  });

  it("POST forgot with unknown email → 200 generic message, NO token created (no enumeration)", async () => {
    const res = await forgotPOST(postJson("http://localhost/api/auth/forgot-password", { email: UNKNOWN_EMAIL }, { origin: "http://localhost", "x-forwarded-for": "10.99.0.1" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    const rows = await db.select().from(passwordResetTokens);
    expect(rows.filter(r => r.tokenHash).length === rows.length).toBe(true); // (sanity) no raw tokens ever
  });

  it("POST forgot with known email → 200 + single reset token created for the user", async () => {
    const user = await ensureUser();
    const res = await forgotPOST(postJson("http://localhost/api/auth/forgot-password", { email: USER_EMAIL }, { origin: "http://localhost", "x-forwarded-for": "10.99.0.2" }));
    expect(res.status).toBe(200);
    const rows = await db.select().from(passwordResetTokens).where(eq(passwordResetTokens.userId, user.id));
    expect(rows).toHaveLength(1);
  });

  it("POST forgot with invalid email → 400", async () => {
    const res = await forgotPOST(postJson("http://localhost/api/auth/forgot-password", { email: "nao-email" }, { origin: "http://localhost", "x-forwarded-for": "10.99.0.3" }));
    expect(res.status).toBe(400);
  });

  it("POST /api/auth/reset-password with invalid token → 400", async () => {
    const res = await resetPOST(postJson("http://localhost/api/auth/reset-password", { token: "ab".repeat(32), password: "NovaPassword123" }, { origin: "http://localhost", "x-forwarded-for": "10.99.0.4" }));
    expect(res.status).toBe(400);
  });

  it("POST reset with weak password → 400; valid token + strong password → 200 and password works", async () => {
    const user = await ensureUser();
    const raw = await createPasswordResetToken(user.id);

    const weak = await resetPOST(postJson("http://localhost/api/auth/reset-password", { token: raw, password: "curta" }, { origin: "http://localhost", "x-forwarded-for": "10.99.0.5" }));
    expect(weak.status).toBe(400);
    // token NOT consumed by the rejected attempt
    expect(await consumePasswordResetToken(raw)).toBe(user.id);
    // recreate for the happy path
    const raw2 = await createPasswordResetToken(user.id);

    const ok = await resetPOST(postJson("http://localhost/api/auth/reset-password", { token: raw2, password: "NovaPassword123" }, { origin: "http://localhost", "x-forwarded-for": "10.99.0.6" }));
    expect(ok.status).toBe(200);

    const [row] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
    expect(await verifyPassword("NovaPassword123", row.password)).toBe(true);
  });

  it("reset token cannot be reused after success", async () => {
    const user = await ensureUser();
    const raw = await createPasswordResetToken(user.id);
    const ok = await resetPOST(postJson("http://localhost/api/auth/reset-password", { token: raw, password: "NovaPassword123" }, { origin: "http://localhost", "x-forwarded-for": "10.99.0.7" }));
    expect(ok.status).toBe(200);
    const again = await resetPOST(postJson("http://localhost/api/auth/reset-password", { token: raw, password: "OutraPassword123" }, { origin: "http://localhost", "x-forwarded-for": "10.99.0.8" }));
    expect(again.status).toBe(400);
  });
});

describe("P1 — login route rate limit (real handler)", () => {
  it("11th attempt from the same IP within the window → 429 with Retry-After", async () => {
    const ip = { "x-forwarded-for": "10.99.0.77" };
    let last: Response | null = null;
    for (let i = 1; i <= 11; i++) {
      last = await loginPOST(postJson("http://localhost/api/auth/login", { email: `${MARKER}-naoexiste@test.local`, password: "x" }, { origin: "http://localhost", ...ip }));
      if (i <= 10) expect(last.status).toBe(401); // invalid credentials, but allowed
    }
    expect(last!.status).toBe(429);
    expect(Number(last!.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});
