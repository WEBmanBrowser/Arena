/**
 * Backoffice Eupago routes: RBAC + CSRF + validation + no-leak contract.
 *
 * Mirrors the C.3.4.2 admin-API test pattern (mocked getCurrentUser, Origin
 * header for CSRF, real DB via scripts/test-runner.cjs). Credential-looking
 * strings are per-run test fixtures — no real secrets.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { settings, users } from "@/db/schema";
import { inArray, sql } from "drizzle-orm";

const getCurrentUserMock = vi.fn();
const accessTokenMock = vi.fn();

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getCurrentUser: () => getCurrentUserMock() };
});

vi.mock("@/lib/providers/eupago/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/providers/eupago/client")>();
  return {
    ...actual,
    getEupagoAccessToken: (...args: unknown[]) => accessTokenMock(...args),
  };
});

import { GET as eupagoGET, PUT as eupagoPUT } from "@/app/api/admin/settings/eupago/route";
import { POST as eupagoTestPOST } from "@/app/api/admin/settings/eupago/test/route";

const TAG = "EUPAGOCFG";
const USER_ID = 990044;
const ENC_KEY = "SETTINGS_ENCRYPTION_KEY";
const ENV_VARS = [
  ENC_KEY,
  "EUPAGO_ENVIRONMENT",
  "EUPAGO_API_KEY",
  "EUPAGO_OAUTH_CLIENT_ID",
  "EUPAGO_OAUTH_CLIENT_SECRET",
  "EUPAGO_WEBHOOK_KEY",
] as const;

const ALL_EUPAGO_SETTING_KEYS = [
  "eupago_environment",
  "eupago_api_key",
  "eupago_oauth_client_id",
  "eupago_oauth_client_secret",
  "eupago_webhook_key",
  "eupago_webhook_endpoint",
  "eupago_webhook_encryption",
  "eupago_webhook_types",
  "eupago_last_test",
];

let savedEnv: Record<string, string | undefined> = {};

function randomHexKey(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

function fixture(prefix: string): string {
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
  return `${prefix}-test-${rand}`;
}

function user(role: string | null) {
  if (!role) return null;
  return {
    id: USER_ID,
    email: `${TAG}-${role}@test.local`,
    name: TAG,
    role,
    phone: null,
    nif: null,
    company: null,
  };
}

function req(
  url: string,
  init: { method?: string; body?: unknown; rawBody?: string; csrf?: boolean } = {}
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.csrf !== false) headers.origin = "http://localhost";
  return new NextRequest(new URL(url, "http://localhost").toString(), {
    method: init.method ?? "GET",
    headers,
    body:
      init.rawBody !== undefined
        ? init.rawBody
        : init.body === undefined
          ? undefined
          : JSON.stringify(init.body),
  });
}

beforeEach(async () => {
  savedEnv = {};
  for (const name of ENV_VARS) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
  process.env[ENC_KEY] = randomHexKey();
  getCurrentUserMock.mockReset();
  accessTokenMock.mockReset();
  await db
    .insert(users)
    .values({ id: USER_ID, email: `${TAG}@test.local`, password: "x", name: TAG, role: "admin" })
    .onConflictDoNothing();
  await db.delete(settings).where(inArray(settings.key, ALL_EUPAGO_SETTING_KEYS));
});

afterEach(async () => {
  await db.delete(settings).where(inArray(settings.key, ALL_EUPAGO_SETTING_KEYS));
  await db.execute(sql`DELETE FROM audit_logs WHERE user_id = ${USER_ID}`);
  await db.execute(sql`DELETE FROM users WHERE id = ${USER_ID}`);
  for (const name of ENV_VARS) {
    const value = savedEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("GET /api/admin/settings/eupago", () => {
  it("requires authentication", async () => {
    getCurrentUserMock.mockReturnValue(null);
    const res = await eupagoGET();
    expect(res.status).toBe(401);
  });

  it("allows manager+ and forbids staff/customer", async () => {
    for (const role of ["manager", "admin"]) {
      getCurrentUserMock.mockReturnValue(user(role));
      const res = await eupagoGET();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("incomplete");
      expect(body.origin).toBe("none");
    }
    for (const role of ["staff", "customer"]) {
      getCurrentUserMock.mockReturnValue(user(role));
      const res = await eupagoGET();
      expect(res.status).toBe(403);
    }
  });

  it("never exposes secret values or fragments", async () => {
    const ak = fixture("ak");
    const cid = fixture("cid");
    const csec = fixture("csec");
    const wk = fixture("wk");
    getCurrentUserMock.mockReturnValue(user("admin"));
    const put = await eupagoPUT(
      req("/api/admin/settings/eupago", {
        method: "PUT",
        body: { environment: "sandbox", apiKey: ak, oauthClientId: cid, oauthClientSecret: csec, webhookKey: wk },
      })
    );
    expect(put.status).toBe(200);
    const res = await eupagoGET();
    expect(res.status).toBe(200);
    const dumped = JSON.stringify(await res.json());
    expect(dumped).not.toContain(ak);
    expect(dumped).not.toContain(cid);
    expect(dumped).not.toContain(csec);
    expect(dumped).not.toContain(wk);
    // Presence-only: no fragment of any secret (first/last 8 chars) leaks either.
    for (const secret of [ak, cid, csec, wk]) {
      expect(dumped).not.toContain(secret.slice(0, 8));
      expect(dumped).not.toContain(secret.slice(-8));
    }
  });
});

describe("PUT /api/admin/settings/eupago", () => {
  it("enforces CSRF (missing Origin/Referer on unsafe method → 403)", async () => {
    getCurrentUserMock.mockReturnValue(user("admin"));
    const res = await eupagoPUT(
      req("/api/admin/settings/eupago", { method: "PUT", body: {}, csrf: false })
    );
    expect(res.status).toBe(403);
  });

  it("requires admin (manager cannot mutate)", async () => {
    for (const role of [null, "customer", "staff", "manager"]) {
      getCurrentUserMock.mockReturnValue(user(role));
      const res = await eupagoPUT(
        req("/api/admin/settings/eupago", { method: "PUT", body: { environment: "sandbox" } })
      );
      expect(res.status).toBe(role === null ? 401 : 403);
    }
  });

  it("rejects malformed JSON and invalid payloads with safe codes", async () => {
    getCurrentUserMock.mockReturnValue(user("admin"));
    const badJson = await eupagoPUT(
      req("/api/admin/settings/eupago", { method: "PUT", rawBody: "{not-json" })
    );
    expect(badJson.status).toBe(400);
    expect(await badJson.json()).toEqual({ error: "INVALID_JSON" });

    for (const [body, error] of [
      [{ nope: 1 }, "UNKNOWN_FIELD"],
      [{ lastTest: { ok: true } }, "UNKNOWN_FIELD"],
      [{ apiKey: "" }, "EMPTY_VALUE"],
      [{ environment: "prod" }, "INVALID_VALUE"],
      [{ webhookEndpoint: "http://x.example/y" }, "INVALID_VALUE"],
    ] as const) {
      const res = await eupagoPUT(
        req("/api/admin/settings/eupago", { method: "PUT", body })
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(error);
    }
  });

  it("saves, encrypts secrets, audits field names, and returns fresh status", async () => {
    getCurrentUserMock.mockReturnValue(user("admin"));
    const ak = fixture("ak");
    const res = await eupagoPUT(
      req("/api/admin/settings/eupago", {
        method: "PUT",
        body: {
          environment: "sandbox",
          apiKey: ak,
          oauthClientId: fixture("cid"),
          oauthClientSecret: fixture("csec"),
          webhookKey: fixture("wk"),
          webhookTypes: ["pagamento", "reembolso"],
        },
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.updated.sort()).toEqual(
      ["apiKey", "environment", "oauthClientId", "oauthClientSecret", "webhookKey", "webhookTypes"].sort()
    );
    expect(body.status.status).toBe("configured");
    expect(JSON.stringify(body)).not.toContain(ak);

    const rows = await db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(inArray(settings.key, ALL_EUPAGO_SETTING_KEYS));
    const stored = rows.find((r) => r.key === "eupago_api_key")?.value ?? "";
    expect(stored.startsWith("enc:v1:")).toBe(true);
    expect(stored).not.toContain(ak);

    const audits = await db.execute(
      sql`SELECT action, details FROM audit_logs WHERE user_id = ${USER_ID} AND action = 'eupago_config_updated'`
    );
    expect(audits.rows).toHaveLength(1);
    expect(JSON.stringify(audits.rows[0])).not.toContain(ak);
  });

  it("fails with EUPAGO_ENCRYPTION_UNAVAILABLE when saving secrets without a key", async () => {
    delete process.env[ENC_KEY];
    getCurrentUserMock.mockReturnValue(user("admin"));
    const res = await eupagoPUT(
      req("/api/admin/settings/eupago", { method: "PUT", body: { apiKey: fixture("ak") } })
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "EUPAGO_ENCRYPTION_UNAVAILABLE" });
  });
});

describe("POST /api/admin/settings/eupago/test", () => {
  it("enforces CSRF and admin-only", async () => {
    getCurrentUserMock.mockReturnValue(user("admin"));
    const noCsrf = await eupagoTestPOST(
      req("/api/admin/settings/eupago/test", { method: "POST", body: {}, csrf: false })
    );
    expect(noCsrf.status).toBe(403);
    for (const role of [null, "customer", "staff", "manager"]) {
      getCurrentUserMock.mockReturnValue(user(role));
      const res = await eupagoTestPOST(
        req("/api/admin/settings/eupago/test", { method: "POST", body: {} })
      );
      expect(res.status).toBe(role === null ? 401 : 403);
    }
  });

  it("attempts no network call when config is incomplete", async () => {
    getCurrentUserMock.mockReturnValue(user("admin"));
    accessTokenMock.mockResolvedValue({ kind: "ok", accessToken: "should-never-be-called" });
    const res = await eupagoTestPOST(
      req("/api/admin/settings/eupago/test", { method: "POST", body: {} })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe("EUPAGO_CONFIG_INCOMPLETE");
    expect(body.config.missing).toContain("EUPAGO_API_KEY");
    expect(accessTokenMock).not.toHaveBeenCalled();
  });

  it("reports success without ever exposing the token or secrets", async () => {
    const csec = fixture("csec");
    getCurrentUserMock.mockReturnValue(user("admin"));
    await eupagoPUT(
      req("/api/admin/settings/eupago", {
        method: "PUT",
        body: {
          environment: "sandbox",
          apiKey: fixture("ak"),
          oauthClientId: fixture("cid"),
          oauthClientSecret: csec,
          webhookKey: fixture("wk"),
        },
      })
    );
    accessTokenMock.mockResolvedValue({ kind: "ok", accessToken: "live-bearer-token" });
    const res = await eupagoTestPOST(
      req("/api/admin/settings/eupago/test", { method: "POST", body: {} })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.environment).toBe("sandbox");
    expect(typeof body.latencyMs).toBe("number");
    const dumped = JSON.stringify(body);
    expect(dumped).not.toContain("live-bearer-token");
    expect(dumped).not.toContain(csec);
    // Credentials used for the probe came from Backoffice (effective config).
    expect(accessTokenMock).toHaveBeenCalledTimes(1);
    expect(accessTokenMock.mock.calls[0][0]).toMatchObject({ environment: "sandbox" });

    const rows = await db
      .select({ value: settings.value })
      .from(settings)
      .where(inArray(settings.key, ["eupago_last_test"]));
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].value ?? "{}")).toMatchObject({ ok: true, environment: "sandbox" });
  });

  it("maps provider failures to a safe 502 with reason metadata", async () => {
    getCurrentUserMock.mockReturnValue(user("admin"));
    process.env.EUPAGO_API_KEY = fixture("env-ak");
    process.env.EUPAGO_OAUTH_CLIENT_ID = fixture("env-cid");
    process.env.EUPAGO_OAUTH_CLIENT_SECRET = fixture("env-csec");
    process.env.EUPAGO_WEBHOOK_KEY = fixture("env-wk");
    accessTokenMock.mockResolvedValue({ kind: "ambiguous", reason: "oauth_failure" });
    const res = await eupagoTestPOST(
      req("/api/admin/settings/eupago/test", { method: "POST", body: {} })
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      ok: false,
      error: "EUPAGO_CONNECTION_FAILED",
      reason: "oauth_failure",
      environment: "sandbox",
    });
  });

  it("maps transport throws to a safe 502 without internals", async () => {
    getCurrentUserMock.mockReturnValue(user("admin"));
    process.env.EUPAGO_API_KEY = fixture("env-ak");
    process.env.EUPAGO_OAUTH_CLIENT_ID = fixture("env-cid");
    process.env.EUPAGO_OAUTH_CLIENT_SECRET = fixture("env-csec");
    process.env.EUPAGO_WEBHOOK_KEY = fixture("env-wk");
    accessTokenMock.mockRejectedValue(new Error("socket hang up"));
    const res = await eupagoTestPOST(
      req("/api/admin/settings/eupago/test", { method: "POST", body: {} })
    );
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toEqual({
      ok: false,
      error: "EUPAGO_CONNECTION_FAILED",
      environment: "sandbox",
    });
  });
});
