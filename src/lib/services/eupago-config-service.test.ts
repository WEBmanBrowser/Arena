/**
 * Backoffice Eupago config service: validation, atomic Backoffice>ENV
 * precedence, encrypted-at-rest secrets, and the presence-only status view.
 *
 * DB-backed (runs under scripts/test-runner.cjs with embedded Postgres).
 * All credential-looking strings here are test fixtures, generated per run —
 * no real secrets, and random AES keys exist only in memory.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { db } from "@/db";
import { settings } from "@/db/schema";
import { inArray } from "drizzle-orm";
import { isProviderError } from "@/lib/providers/errors";
import {
  EupagoConfigValidationError,
  getEupagoConfigStatus,
  recordEupagoConnectionTest,
  resolveEupagoConfig,
  resolveEupagoWebhookKey,
  saveEupagoBackofficeConfig,
  validateEupagoBackofficeUpdate,
} from "./eupago-config-service";

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

/** Random test-only fixture value (never a real credential). */
function fixture(prefix: string): string {
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
  return `${prefix}-test-${rand}`;
}

beforeEach(async () => {
  savedEnv = {};
  for (const name of ENV_VARS) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
  process.env[ENC_KEY] = randomHexKey();
  await db.delete(settings).where(inArray(settings.key, ALL_EUPAGO_SETTING_KEYS));
});

afterEach(async () => {
  await db.delete(settings).where(inArray(settings.key, ALL_EUPAGO_SETTING_KEYS));
  for (const name of ENV_VARS) {
    const value = savedEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

async function storedRows(): Promise<Map<string, string>> {
  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(inArray(settings.key, ALL_EUPAGO_SETTING_KEYS));
  return new Map(rows.map((r) => [r.key, r.value ?? ""]));
}

function fullBlock() {
  return {
    environment: "sandbox" as const,
    apiKey: fixture("ak"),
    oauthClientId: fixture("cid"),
    oauthClientSecret: fixture("csec"),
    webhookKey: fixture("wk"),
  };
}

describe("validateEupagoBackofficeUpdate", () => {
  it("rejects non-object bodies", () => {
    for (const bad of [null, [], "x", 42]) {
      expect(() => validateEupagoBackofficeUpdate(bad)).toThrowError(
        expect.objectContaining({ code: "INVALID_VALUE" })
      );
    }
  });

  it("rejects unknown fields (incl. lastTest, never operator-writable)", () => {
    for (const body of [{ nope: 1 }, { lastTest: { ok: true } }, { eupago_api_key: "x" }]) {
      let error: unknown;
      try {
        validateEupagoBackofficeUpdate(body);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(EupagoConfigValidationError);
      expect(error).toMatchObject({ code: "UNKNOWN_FIELD" });
    }
  });

  it("rejects invalid environment values", () => {
    expect(() => validateEupagoBackofficeUpdate({ environment: "prod" })).toThrowError(
      expect.objectContaining({ code: "INVALID_VALUE", field: "environment" })
    );
  });

  it("rejects empty / overlong / control-char secrets", () => {
    expect(() => validateEupagoBackofficeUpdate({ apiKey: "   " })).toThrowError(
      expect.objectContaining({ code: "EMPTY_VALUE", field: "apiKey" })
    );
    expect(() => validateEupagoBackofficeUpdate({ apiKey: "a".repeat(501) })).toThrowError(
      expect.objectContaining({ code: "INVALID_VALUE", field: "apiKey" })
    );
    expect(() => validateEupagoBackofficeUpdate({ webhookKey: "abc\ndef" })).toThrowError(
      expect.objectContaining({ code: "INVALID_VALUE", field: "webhookKey" })
    );
    expect(() => validateEupagoBackofficeUpdate({ oauthClientId: 42 })).toThrowError(
      expect.objectContaining({ code: "INVALID_VALUE", field: "oauthClientId" })
    );
  });

  it("validates the webhook endpoint as an operator https URL", () => {
    expect(() =>
      validateEupagoBackofficeUpdate({
        webhookEndpoint: "https://loja.example.com/api/webhooks/eupago",
      })
    ).not.toThrow();
    for (const bad of [
      "http://loja.example.com/x",
      "not-a-url",
      "https://user:pass@loja.example.com/x",
      "https://loja.example.com/x\ny",
      "",
    ]) {
      expect(() => validateEupagoBackofficeUpdate({ webhookEndpoint: bad })).toThrowError(
        expect.objectContaining({ field: "webhookEndpoint" })
      );
    }
  });

  it("requires a strict boolean for webhookEncryption", () => {
    expect(() =>
      validateEupagoBackofficeUpdate({ webhookEncryption: "true" })
    ).toThrowError(expect.objectContaining({ code: "INVALID_VALUE", field: "webhookEncryption" }));
    expect(() => validateEupagoBackofficeUpdate({ webhookEncryption: true })).not.toThrow();
  });

  it("validates webhookTypes as a unique subset of the 5 portal types", () => {
    expect(() =>
      validateEupagoBackofficeUpdate({ webhookTypes: ["pagamento", "reembolso"] })
    ).not.toThrow();
    for (const bad of [
      ["pagamento", "pagamento"],
      ["settlement"],
      "pagamento",
      [42],
    ]) {
      expect(() => validateEupagoBackofficeUpdate({ webhookTypes: bad })).toThrowError(
        expect.objectContaining({ field: "webhookTypes" })
      );
    }
  });
});

describe("save + resolve precedence (atomic block)", () => {
  it("uses ENV when Backoffice is untouched (existing behavior preserved)", async () => {
    process.env.EUPAGO_API_KEY = fixture("env-ak");
    process.env.EUPAGO_OAUTH_CLIENT_ID = fixture("env-cid");
    process.env.EUPAGO_OAUTH_CLIENT_SECRET = fixture("env-csec");
    process.env.EUPAGO_WEBHOOK_KEY = fixture("env-wk");
    const config = await resolveEupagoConfig();
    expect(config.environment).toBe("sandbox");
    expect(config.apiKey).toBe(process.env.EUPAGO_API_KEY);
    expect(await resolveEupagoWebhookKey()).toBe(process.env.EUPAGO_WEBHOOK_KEY);
  });

  it("complete Backoffice block wins over ENV (no mixing)", async () => {
    process.env.EUPAGO_API_KEY = fixture("env-ak");
    process.env.EUPAGO_OAUTH_CLIENT_ID = fixture("env-cid");
    process.env.EUPAGO_OAUTH_CLIENT_SECRET = fixture("env-csec");
    process.env.EUPAGO_WEBHOOK_KEY = fixture("env-wk");
    const block = { ...fullBlock(), environment: "production" as const };
    const saved = await saveEupagoBackofficeConfig(block);
    expect(saved.updated.sort()).toEqual(
      ["apiKey", "environment", "oauthClientId", "oauthClientSecret", "webhookKey"].sort()
    );
    const config = await resolveEupagoConfig();
    expect(config).toEqual({
      environment: "production",
      apiKey: block.apiKey,
      oauthClientId: block.oauthClientId,
      oauthClientSecret: block.oauthClientSecret,
      webhookKey: block.webhookKey,
    });
    expect(await resolveEupagoWebhookKey()).toBe(block.webhookKey);
  });

  it("partial Backoffice block fails closed (never mixed with ENV)", async () => {
    process.env.EUPAGO_API_KEY = fixture("env-ak");
    process.env.EUPAGO_OAUTH_CLIENT_ID = fixture("env-cid");
    process.env.EUPAGO_OAUTH_CLIENT_SECRET = fixture("env-csec");
    process.env.EUPAGO_WEBHOOK_KEY = fixture("env-wk");
    await saveEupagoBackofficeConfig({ apiKey: fixture("bo-ak") });
    const configError = await resolveEupagoConfig().then(
      () => null,
      (e: unknown) => e
    );
    expect(isProviderError(configError)).toBe(true);
    expect(configError).toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    const keyError = await resolveEupagoWebhookKey().then(
      () => null,
      (e: unknown) => e
    );
    expect(isProviderError(keyError)).toBe(true);
    expect(keyError).toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  it("null clears fields; clearing everything restores ENV fallback", async () => {
    process.env.EUPAGO_API_KEY = fixture("env-ak");
    process.env.EUPAGO_OAUTH_CLIENT_ID = fixture("env-cid");
    process.env.EUPAGO_OAUTH_CLIENT_SECRET = fixture("env-csec");
    process.env.EUPAGO_WEBHOOK_KEY = fixture("env-wk");
    await saveEupagoBackofficeConfig(fullBlock());
    const cleared = await saveEupagoBackofficeConfig({
      environment: null,
      apiKey: null,
      oauthClientId: null,
      oauthClientSecret: null,
      webhookKey: null,
    });
    expect(cleared.cleared).toHaveLength(5);
    expect(await storedRows().then((m) => m.size)).toBe(0);
    expect((await resolveEupagoConfig()).apiKey).toBe(process.env.EUPAGO_API_KEY);
  });

  it("auxiliary fields alone never trigger Backoffice mode", async () => {
    process.env.EUPAGO_API_KEY = fixture("env-ak");
    process.env.EUPAGO_OAUTH_CLIENT_ID = fixture("env-cid");
    process.env.EUPAGO_OAUTH_CLIENT_SECRET = fixture("env-csec");
    process.env.EUPAGO_WEBHOOK_KEY = fixture("env-wk");
    await saveEupagoBackofficeConfig({
      webhookEndpoint: "https://loja.example.com/api/webhooks/eupago",
      webhookEncryption: true,
      webhookTypes: ["pagamento"],
    });
    // Still ENV mode — must NOT throw, must return ENV values.
    expect((await resolveEupagoConfig()).apiKey).toBe(process.env.EUPAGO_API_KEY);
    const status = await getEupagoConfigStatus();
    expect(status.origin).toBe("env");
    expect(status.status).toBe("configured");
  });
});

describe("encrypted at rest", () => {
  it("stores secrets as enc:v1: envelopes, never plaintext", async () => {
    const block = fullBlock();
    await saveEupagoBackofficeConfig(block);
    const rows = await storedRows();
    for (const key of [
      "eupago_api_key",
      "eupago_oauth_client_id",
      "eupago_oauth_client_secret",
      "eupago_webhook_key",
    ]) {
      const stored = rows.get(key) ?? "";
      expect(stored.startsWith("enc:v1:")).toBe(true);
    }
    const dumped = [...rows.values()].join("\n");
    expect(dumped).not.toContain(block.apiKey);
    expect(dumped).not.toContain(block.oauthClientId);
    expect(dumped).not.toContain(block.oauthClientSecret);
    expect(dumped).not.toContain(block.webhookKey);
    expect(rows.get("eupago_environment")).toBe("sandbox");
  });

  it("fails closed before ANY write when the encryption key is missing", async () => {
    delete process.env[ENC_KEY];
    await expect(saveEupagoBackofficeConfig(fullBlock())).rejects.toMatchObject({
      code: "ENCRYPTION_KEY_MISSING",
    });
    expect((await storedRows()).size).toBe(0);
  });

  it("plaintext planted in a secret row fails closed (resolve + status)", async () => {
    const block = fullBlock();
    await saveEupagoBackofficeConfig(block);
    // Simulate tampering/manual edit: overwrite one secret row with plaintext.
    await db
      .insert(settings)
      .values({ key: "eupago_api_key", value: "planted-plaintext", group: "eupago" })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: "planted-plaintext", group: "eupago" },
      });
    await expect(resolveEupagoConfig()).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
    const status = await getEupagoConfigStatus();
    expect(status.status).toBe("error");
    expect(status.error).toBe("BACKOFFICE_UNREADABLE");
  });

  it("key rotation without re-encrypt fails closed (resolve + status)", async () => {
    await saveEupagoBackofficeConfig(fullBlock());
    process.env[ENC_KEY] = randomHexKey();
    await expect(resolveEupagoConfig()).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
    const status = await getEupagoConfigStatus();
    expect(status.status).toBe("error");
    expect(status.error).toBe("BACKOFFICE_UNREADABLE");
  });
});

describe("getEupagoConfigStatus (presence-only)", () => {
  it("empty Backoffice + empty ENV → incomplete/origin none with ENV var names", async () => {
    const status = await getEupagoConfigStatus();
    expect(status.status).toBe("incomplete");
    expect(status.origin).toBe("none");
    expect(status.missing.sort()).toEqual(
      [
        "EUPAGO_API_KEY",
        "EUPAGO_OAUTH_CLIENT_ID",
        "EUPAGO_OAUTH_CLIENT_SECRET",
        "EUPAGO_WEBHOOK_KEY",
      ].sort()
    );
    expect(status.error).toBeNull();
  });

  it("empty Backoffice + invalid EUPAGO_ENVIRONMENT → error ENV_INVALID", async () => {
    process.env.EUPAGO_ENVIRONMENT = "prod";
    process.env.EUPAGO_API_KEY = fixture("env-ak");
    process.env.EUPAGO_OAUTH_CLIENT_ID = fixture("env-cid");
    process.env.EUPAGO_OAUTH_CLIENT_SECRET = fixture("env-csec");
    process.env.EUPAGO_WEBHOOK_KEY = fixture("env-wk");
    const status = await getEupagoConfigStatus();
    expect(status.status).toBe("error");
    expect(status.error).toBe("ENV_INVALID");
  });

  it("partial Backoffice → incomplete with Backoffice field ids", async () => {
    await saveEupagoBackofficeConfig({ apiKey: fixture("bo-ak"), environment: "sandbox" });
    const status = await getEupagoConfigStatus();
    expect(status.status).toBe("incomplete");
    expect(status.origin).toBe("backoffice");
    expect(status.missing.sort()).toEqual(
      ["oauthClientId", "oauthClientSecret", "webhookKey"].sort()
    );
  });

  it("complete Backoffice → configured with presence flags and webhook metadata", async () => {
    await saveEupagoBackofficeConfig({
      ...fullBlock(),
      environment: "production",
      webhookEndpoint: "https://loja.example.com/api/webhooks/eupago",
      webhookEncryption: false,
      webhookTypes: ["pagamento", "erro"],
    });
    const status = await getEupagoConfigStatus();
    expect(status.status).toBe("configured");
    expect(status.origin).toBe("backoffice");
    expect(status.environment).toBe("production");
    expect(status.fields).toEqual({
      environment: { set: true },
      apiKey: { set: true },
      oauthClientId: { set: true },
      oauthClientSecret: { set: true },
      webhookKey: { set: true },
    });
    expect(status.webhook).toEqual({
      endpoint: "https://loja.example.com/api/webhooks/eupago",
      encryption: false,
      types: ["pagamento", "erro"],
    });
  });

  it("warns (non-blocking) when encryption is on but the key is not 32 bytes", async () => {
    const block = fullBlock();
    await saveEupagoBackofficeConfig({ ...block, webhookEncryption: true });
    const warned = await getEupagoConfigStatus();
    expect(warned.status).toBe("configured");
    expect(warned.warnings).toContain("WEBHOOK_KEY_NOT_32_BYTES");

    await saveEupagoBackofficeConfig({ webhookKey: "k".repeat(32) });
    const clean = await getEupagoConfigStatus();
    expect(clean.status).toBe("configured");
    expect(clean.warnings).not.toContain("WEBHOOK_KEY_NOT_32_BYTES");
  });

  it("echoes the stored (non-secret) environment for the form", async () => {
    await saveEupagoBackofficeConfig({ environment: "production", apiKey: fixture("bo-ak") });
    const partial = await getEupagoConfigStatus();
    expect(partial.status).toBe("incomplete");
    expect(partial.environment).toBeNull();
    expect(partial.storedEnvironment).toBe("production");
  });

  it("invalid stored environment → error BACKOFFICE_INVALID", async () => {
    await saveEupagoBackofficeConfig(fullBlock());
    await db
      .insert(settings)
      .values({ key: "eupago_environment", value: "prod", group: "eupago" })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: "prod", group: "eupago" },
      });
    const status = await getEupagoConfigStatus();
    expect(status.status).toBe("error");
    expect(status.error).toBe("BACKOFFICE_INVALID");
  });

  it("status JSON never contains secret values", async () => {
    const block = fullBlock();
    await saveEupagoBackofficeConfig(block);
    const status = await getEupagoConfigStatus();
    const dumped = JSON.stringify(status);
    expect(dumped).not.toContain(block.apiKey);
    expect(dumped).not.toContain(block.oauthClientId);
    expect(dumped).not.toContain(block.oauthClientSecret);
    expect(dumped).not.toContain(block.webhookKey);
  });

  it("records and surfaces connection-test metadata (never operator input)", async () => {
    await saveEupagoBackofficeConfig(fullBlock());
    await recordEupagoConnectionTest({ ok: true, environment: "sandbox", latencyMs: 123 });
    const status = await getEupagoConfigStatus();
    expect(status.lastTest).toMatchObject({ ok: true, environment: "sandbox", latencyMs: 123 });
    expect(typeof status.lastTest?.at).toBe("string");
    await expect(
      recordEupagoConnectionTest({ ok: true, environment: "prod" as never })
    ).rejects.toBeInstanceOf(EupagoConfigValidationError);
  });
});
