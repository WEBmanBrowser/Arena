/**
 * B.6 — Login email normalization + role-based post-login routing.
 *
 * Route-level tests: the real POST /api/auth/login handler runs against the
 * real database. Only CSRF/rate-limit are neutralised so the test can focus on
 * credential matching (both guards keep their own dedicated tests elsewhere).
 *
 * Covers:
 *  - an account stored lowercase (as admin:create writes it) can log in with
 *    mixed-case / padded input;
 *  - wrong password is still rejected;
 *  - inactive users are still rejected;
 *  - the pure role helpers that decide where the browser lands after login.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import bcryptjs from "bcryptjs";

// Same-origin guard: exercised by p1-security.test.ts. Here it would reject
// every synthetic request, so it is stubbed to allow the call through.
vi.mock("@/lib/csrf", () => ({
  csrfGuard: () => null,
  verifySameOrigin: () => true,
  isSafeMethod: () => false,
  csrfFailureResponse: () => new Response(null, { status: 403 }),
}));

// Rate limiting has its own tests; keep it permissive so repeated logins here
// do not trip the 10-per-5-minutes window.
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return {
    ...actual,
    checkRateLimit: async () => ({ allowed: true, count: 1, remaining: 9, retryAfterSeconds: 0 }),
  };
});

import { POST as loginPOST } from "@/app/api/auth/login/route";
import { isStaffRole, postLoginRedirect, STAFF_ROLES } from "@/lib/roles";

// createToken() requires JWT_SECRET; a successful login would otherwise 500.
// Scoped to this file and restored afterwards — no real secret is used.
let prevJwtSecret: string | undefined;

const EMAIL = "b6.login.admin@test.local";
const PASSWORD = "B6-Str0ng!Password";

function loginRequest(email: unknown, password: unknown) {
  return new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "http://localhost", host: "localhost" },
    body: JSON.stringify({ email, password }),
  }) as unknown as Parameters<typeof loginPOST>[0];
}

beforeAll(async () => {
  prevJwtSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "b6-test-only-jwt-secret-0123456789abcdef";
  await db.execute(sql`DELETE FROM users WHERE email LIKE 'b6.login.%'`);
  const hash = await bcryptjs.hash(PASSWORD, 4); // low cost: test speed only
  await db.insert(users).values({ email: EMAIL, password: hash, name: "B6 Admin", role: "admin" });
});

afterAll(async () => {
  if (prevJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = prevJwtSecret;
  await db.execute(sql`DELETE FROM users WHERE email LIKE 'b6.login.%'`);
});

beforeEach(async () => {
  await db.update(users).set({ isActive: true }).where(eq(users.email, EMAIL));
});

describe("B.6 — login email normalization", () => {
  it("accepts the exact lowercase email", async () => {
    const res = await loginPOST(loginRequest(EMAIL, PASSWORD));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.email).toBe(EMAIL);
    expect(body.user.role).toBe("admin");
  });

  it("accepts an uppercase email (normalized to lowercase)", async () => {
    const res = await loginPOST(loginRequest(EMAIL.toUpperCase(), PASSWORD));
    expect(res.status).toBe(200);
    expect((await res.json()).user.email).toBe(EMAIL);
  });

  it("accepts an email with surrounding whitespace", async () => {
    const res = await loginPOST(loginRequest(`   ${EMAIL}  `, PASSWORD));
    expect(res.status).toBe(200);
    expect((await res.json()).user.email).toBe(EMAIL);
  });

  it("accepts mixed case with padding", async () => {
    const res = await loginPOST(loginRequest("  B6.Login.Admin@Test.Local ", PASSWORD));
    expect(res.status).toBe(200);
  });

  it("still rejects a wrong password with 401 and the generic message", async () => {
    const res = await loginPOST(loginRequest(EMAIL.toUpperCase(), "wrong-password-1234"));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Credenciais inválidas");
  });

  it("still rejects an unknown email with 401", async () => {
    const res = await loginPOST(loginRequest("b6.login.ghost@test.local", PASSWORD));
    expect(res.status).toBe(401);
  });

  it("still rejects an inactive user even with the right password", async () => {
    await db.update(users).set({ isActive: false }).where(eq(users.email, EMAIL));
    const res = await loginPOST(loginRequest(EMAIL, PASSWORD));
    expect(res.status).toBe(401);
  });

  it("rejects a blank email with 400", async () => {
    const res = await loginPOST(loginRequest("   ", PASSWORD));
    expect(res.status).toBe(400);
  });
});

describe("B.6 — role helpers drive post-login routing", () => {
  it("treats staff, manager and admin as backoffice roles", () => {
    for (const role of STAFF_ROLES) {
      expect(isStaffRole(role)).toBe(true);
      expect(postLoginRedirect(role)).toBe("/admin");
    }
  });

  it("keeps customers in the client area", () => {
    expect(isStaffRole("customer")).toBe(false);
    expect(postLoginRedirect("customer")).toBe("/conta");
  });

  it("treats missing or unknown roles as non-staff", () => {
    expect(isStaffRole(null)).toBe(false);
    expect(isStaffRole(undefined)).toBe(false);
    expect(isStaffRole("")).toBe(false);
    expect(isStaffRole("supervisor")).toBe(false);
    expect(postLoginRedirect(null)).toBe("/conta");
  });
});
