/**
 * Backoffice-manageable Eupago configuration (server-only).
 *
 * STORAGE
 *  Reuses the existing `settings` key/value table (`group = "eupago"`). No new
 *  table, no migration. Secret fields are stored ENCRYPTED (AES-256-GCM, see
 *  `@/lib/settings-secrets`); operational fields are plaintext. Secrets are
 *  NEVER written in plaintext by this module — a secret row that is not an
 *  `enc:v1:` envelope is treated as corrupt (fail closed).
 *
 * PRECEDENCE (D2: atomic block, no silent cross-origin mixing)
 *  The five CORE fields (environment, apiKey, oauthClientId,
 *  oauthClientSecret, webhookKey) form ONE atomic block:
 *   - no core value stored in Backoffice  → ENV mode (`getEupagoConfig()` /
 *     `getEupagoWebhookKey()`, behavior unchanged);
 *   - at least one core value stored      → Backoffice mode: ALL FIVE are
 *     required. A partial Backoffice block is a HARD ERROR — the provider is
 *     unusable until the operator completes or clears it. Backoffice values
 *     are NEVER mixed with ENV values.
 *  The operational fields (webhook endpoint URL, encryption flag, portal
 *  event types, last connection test) are INFORMATIONAL ONLY: they never
 *  trigger Backoffice mode, are never consumed by payment runtime code, and
 *  can never influence a request URL (the Eupago hosts/paths stay compiled-in
 *  constants per the SSRF guarantees in `providers/eupago/config`).
 *
 * NO-LEAK
 *  `getEupagoConfigStatus()` (the GET backing view) exposes presence booleans
 *  and metadata ONLY — never secret values, never fragments of secret values
 *  (D4: presence-only). Errors name FIELDS, never values.
 *
 * SERVER-ONLY: reads `process.env` and decrypted secrets. Never imported by
 * client components.
 */

import { db } from "@/db";
import { settings } from "@/db/schema";
import { inArray, eq } from "drizzle-orm";
import { ProviderError, isProviderError } from "@/lib/providers/errors";
import {
  EUPAGO_PROVIDER_ID,
  getEupagoConfig,
  getEupagoWebhookKey,
  resolveEupagoEnvironment,
  type EupagoConfig,
  type EupagoEnvironment,
} from "@/lib/providers/eupago/config";
import {
  SettingsSecretError,
  decryptSettingValue,
  encryptSettingValue,
  isEncryptedSettingValue,
} from "@/lib/settings-secrets";

const GROUP = "eupago";

/** Core block: Backoffice mode trigger + atomic credential set. */
const CORE_KEYS = {
  environment: "eupago_environment",
  apiKey: "eupago_api_key",
  oauthClientId: "eupago_oauth_client_id",
  oauthClientSecret: "eupago_oauth_client_secret",
  webhookKey: "eupago_webhook_key",
} as const;

type CoreField = keyof typeof CORE_KEYS;

/** Core fields persisted encrypted. `environment` is the only plaintext core field. */
const ENCRYPTED_CORE_FIELDS: ReadonlySet<CoreField> = new Set([
  "apiKey",
  "oauthClientId",
  "oauthClientSecret",
  "webhookKey",
]);

const AUX_KEYS = {
  webhookEndpoint: "eupago_webhook_endpoint",
  webhookEncryption: "eupago_webhook_encryption",
  webhookTypes: "eupago_webhook_types",
  lastTest: "eupago_last_test",
} as const;

const ALL_KEYS = [...Object.values(CORE_KEYS), ...Object.values(AUX_KEYS)];

/**
 * Eupago portal webhook event subscriptions (operational checklist, stored as
 * ASCII slugs). Informational only — Arena normalizes deliveries to its own
 * `payment | refund` kinds regardless of this list.
 */
export const EUPAGO_WEBHOOK_TYPES = [
  "pagamento",
  "cancelamento",
  "expiracao",
  "erro",
  "reembolso",
] as const;

export type EupagoWebhookType = (typeof EUPAGO_WEBHOOK_TYPES)[number];

const MAX_SECRET_CHARS = 500;
const MAX_URL_CHARS = 500;
/** Control characters (incl. CR/LF/NUL/TAB) are never valid inside a secret or URL. */
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]/;

export type EupagoConfigOrigin = "backoffice" | "env" | "none";

export interface EupagoFieldPresence {
  readonly set: boolean;
}

export interface EupagoConnectionTestRecord {
  readonly at: string;
  readonly ok: boolean;
  readonly environment: EupagoEnvironment;
  readonly latencyMs?: number;
}

export interface EupagoConfigStatus {
  readonly status: "configured" | "incomplete" | "error";
  readonly origin: EupagoConfigOrigin;
  /** Effective environment when `status === "configured"`, else null. */
  readonly environment: EupagoEnvironment | null;
  /**
   * Backoffice-stored environment (plaintext, non-secret echo for the form).
   * Null when unset. Independent of `environment` (the effective value).
   */
  readonly storedEnvironment: EupagoEnvironment | null;
  /** Backoffice presence per core field (D4: booleans only, no values/fragments). */
  readonly fields: Record<CoreField, EupagoFieldPresence>;
  /**
   * Missing items by NAME only: Backoffice field ids in Backoffice mode
   * (`environment`, `apiKey`, …) or ENV var names in ENV mode
   * (`EUPAGO_API_KEY`, …). Empty unless `status === "incomplete"`.
   */
  readonly missing: string[];
  /** Non-blocking warning codes (never values). */
  readonly warnings: string[];
  /** Machine code when `status === "error"`, else null. */
  readonly error: string | null;
  readonly webhook: {
    readonly endpoint: string | null;
    readonly encryption: boolean | null;
    readonly types: EupagoWebhookType[];
  };
  readonly lastTest: EupagoConnectionTestRecord | null;
}

export type EupagoConfigValidationCode =
  | "UNKNOWN_FIELD"
  | "INVALID_VALUE"
  | "EMPTY_VALUE";

export class EupagoConfigValidationError extends Error {
  readonly code: EupagoConfigValidationCode;
  readonly field: string | null;
  constructor(code: EupagoConfigValidationCode, field: string | null, detail: string) {
    super(`${code}${field ? `:${field}` : ""}: ${detail}`);
    this.name = "EupagoConfigValidationError";
    this.code = code;
    this.field = field;
  }
}

/** Operator-writable update: optional per field; explicit `null` clears. */
export interface EupagoBackofficeUpdate {
  environment?: EupagoEnvironment | null;
  apiKey?: string | null;
  oauthClientId?: string | null;
  oauthClientSecret?: string | null;
  webhookKey?: string | null;
  webhookEndpoint?: string | null;
  webhookEncryption?: boolean | null;
  webhookTypes?: EupagoWebhookType[] | null;
}

const OPERATOR_FIELDS = [
  "environment",
  "apiKey",
  "oauthClientId",
  "oauthClientSecret",
  "webhookKey",
  "webhookEndpoint",
  "webhookEncryption",
  "webhookTypes",
] as const;

// ─── Internal row access ────────────────────────────────────

type QueryDb = typeof db;

async function readRows(database: QueryDb = db): Promise<Map<string, string>> {
  const rows = await database
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(inArray(settings.key, ALL_KEYS));
  const map = new Map<string, string>();
  for (const row of rows) {
    if (typeof row.value === "string" && row.value.length > 0) map.set(row.key, row.value);
  }
  return map;
}

async function writeRow(key: string, value: string, database: QueryDb = db): Promise<void> {
  await database
    .insert(settings)
    .values({ key, value, group: GROUP })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, group: GROUP },
    });
}

async function deleteRow(key: string, database: QueryDb = db): Promise<void> {
  const { eq } = await import("drizzle-orm");
  await database.delete(settings).where(eq(settings.key, key));
}

// ─── Validation (service-owned; routes map errors to HTTP) ─

function isValidEnvironment(value: unknown): value is EupagoEnvironment {
  return value === "sandbox" || value === "production";
}

function cleanSecret(field: string, value: unknown): string {
  if (typeof value !== "string") {
    throw new EupagoConfigValidationError("INVALID_VALUE", field, "must be a string");
  }
  // Pasted tokens frequently carry surrounding whitespace; significant inner
  // content is preserved exactly (only ASCII-trimmed at the edges).
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new EupagoConfigValidationError("EMPTY_VALUE", field, "must not be empty");
  }
  if (trimmed.length > MAX_SECRET_CHARS) {
    throw new EupagoConfigValidationError(
      "INVALID_VALUE",
      field,
      `must be at most ${MAX_SECRET_CHARS} chars`
    );
  }
  if (CONTROL_CHARS_RE.test(trimmed)) {
    throw new EupagoConfigValidationError(
      "INVALID_VALUE",
      field,
      "must not contain control characters"
    );
  }
  return trimmed;
}

function cleanEndpoint(value: unknown): string {
  if (typeof value !== "string") {
    throw new EupagoConfigValidationError("INVALID_VALUE", "webhookEndpoint", "must be a string");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new EupagoConfigValidationError("EMPTY_VALUE", "webhookEndpoint", "must not be empty");
  }
  if (trimmed.length > MAX_URL_CHARS) {
    throw new EupagoConfigValidationError(
      "INVALID_VALUE",
      "webhookEndpoint",
      `must be at most ${MAX_URL_CHARS} chars`
    );
  }
  // Reject control chars BEFORE `new URL` (WHATWG silently strips tabs/newlines).
  if (CONTROL_CHARS_RE.test(trimmed)) {
    throw new EupagoConfigValidationError(
      "INVALID_VALUE",
      "webhookEndpoint",
      "must not contain control characters"
    );
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new EupagoConfigValidationError("INVALID_VALUE", "webhookEndpoint", "must be a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new EupagoConfigValidationError(
      "INVALID_VALUE",
      "webhookEndpoint",
      "must use https"
    );
  }
  if (!url.hostname) {
    throw new EupagoConfigValidationError(
      "INVALID_VALUE",
      "webhookEndpoint",
      "must include a host"
    );
  }
  if (url.username || url.password) {
    throw new EupagoConfigValidationError(
      "INVALID_VALUE",
      "webhookEndpoint",
      "credentials in URL are forbidden"
    );
  }
  return trimmed;
}

function cleanWebhookTypes(value: unknown): EupagoWebhookType[] {
  if (!Array.isArray(value)) {
    throw new EupagoConfigValidationError("INVALID_VALUE", "webhookTypes", "must be an array");
  }
  const allowed = new Set<string>(EUPAGO_WEBHOOK_TYPES);
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || !allowed.has(entry)) {
      throw new EupagoConfigValidationError(
        "INVALID_VALUE",
        "webhookTypes",
        `unknown webhook type: ${typeof entry === "string" ? entry : typeof entry}`
      );
    }
    if (seen.has(entry)) {
      throw new EupagoConfigValidationError(
        "INVALID_VALUE",
        "webhookTypes",
        `duplicate webhook type: ${entry}`
      );
    }
    seen.add(entry);
  }
  return [...seen] as EupagoWebhookType[];
}

interface ValidatedUpdate {
  set: Array<{ field: string; key: string; value: string }>;
  clear: Array<{ field: string; key: string }>;
}

/**
 * Validate an operator update (unknown shape in). `lastTest` is NEVER
 * operator-writable (dedicated writer only) — rejected as UNKNOWN_FIELD.
 */
export function validateEupagoBackofficeUpdate(input: unknown): ValidatedUpdate {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new EupagoConfigValidationError("INVALID_VALUE", null, "body must be an object");
  }
  const body = input as Record<string, unknown>;
  const allowed = new Set<string>(OPERATOR_FIELDS);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      throw new EupagoConfigValidationError("UNKNOWN_FIELD", key, "unknown field");
    }
  }
  const set: ValidatedUpdate["set"] = [];
  const clear: ValidatedUpdate["clear"] = [];
  const handle = (
    field: (typeof OPERATOR_FIELDS)[number],
    key: string,
    clean: (value: unknown) => string | null
  ): void => {
    if (!(field in body)) return;
    const raw = body[field];
    if (raw === null) {
      clear.push({ field, key });
      return;
    }
    set.push({ field, key, value: clean(raw) ?? "" });
  };

  handle("environment", CORE_KEYS.environment, (v) => {
    if (!isValidEnvironment(v)) {
      throw new EupagoConfigValidationError(
        "INVALID_VALUE",
        "environment",
        "must be sandbox|production"
      );
    }
    return v;
  });
  handle("apiKey", CORE_KEYS.apiKey, (v) => cleanSecret("apiKey", v));
  handle("oauthClientId", CORE_KEYS.oauthClientId, (v) => cleanSecret("oauthClientId", v));
  handle("oauthClientSecret", CORE_KEYS.oauthClientSecret, (v) =>
    cleanSecret("oauthClientSecret", v)
  );
  handle("webhookKey", CORE_KEYS.webhookKey, (v) => cleanSecret("webhookKey", v));
  handle("webhookEndpoint", AUX_KEYS.webhookEndpoint, (v) => cleanEndpoint(v));
  handle("webhookEncryption", AUX_KEYS.webhookEncryption, (v) => {
    if (typeof v !== "boolean") {
      throw new EupagoConfigValidationError(
        "INVALID_VALUE",
        "webhookEncryption",
        "must be a boolean"
      );
    }
    return v ? "true" : "false";
  });
  handle("webhookTypes", AUX_KEYS.webhookTypes, (v) => JSON.stringify(cleanWebhookTypes(v)));

  return { set, clear };
}

// ─── Save ───────────────────────────────────────────────────

/**
 * Apply a validated operator update. Secret values are encrypted BEFORE
 * touching the DB (fail closed when the encryption key is unavailable — no
 * partial/plaintext write is possible). Returns the field names written and
 * cleared (names only, never values).
 */
export async function saveEupagoBackofficeConfig(
  input: unknown,
  database: QueryDb = db
): Promise<{ updated: string[]; cleared: string[] }> {
  const validated = validateEupagoBackofficeUpdate(input);
  const encrypted = new Map<string, string>();
  for (const entry of validated.set) {
    if (
      entry.key === CORE_KEYS.apiKey ||
      entry.key === CORE_KEYS.oauthClientId ||
      entry.key === CORE_KEYS.oauthClientSecret ||
      entry.key === CORE_KEYS.webhookKey
    ) {
      encrypted.set(entry.key, await encryptSettingValue(entry.value));
    } else {
      encrypted.set(entry.key, entry.value);
    }
  }
  for (const entry of validated.set) {
    await writeRow(entry.key, encrypted.get(entry.key)!, database);
  }
  for (const entry of validated.clear) {
    await deleteRow(entry.key, database);
  }
  return {
    updated: validated.set.map((e) => e.field),
    cleared: validated.clear.map((e) => e.field),
  };
}

/** Dedicated writer for the connection-test record (never operator input). */
export async function recordEupagoConnectionTest(
  result: { ok: boolean; environment: EupagoEnvironment; latencyMs?: number },
  database: QueryDb = db
): Promise<void> {
  if (typeof result?.ok !== "boolean" || !isValidEnvironment(result.environment)) {
    throw new EupagoConfigValidationError("INVALID_VALUE", "lastTest", "invalid test record");
  }
  const record: EupagoConnectionTestRecord = {
    at: new Date().toISOString(),
    ok: result.ok,
    environment: result.environment,
    ...(typeof result.latencyMs === "number" &&
    Number.isInteger(result.latencyMs) &&
    result.latencyMs >= 0
      ? { latencyMs: result.latencyMs }
      : {}),
  };
  await writeRow(AUX_KEYS.lastTest, JSON.stringify(record), database);
}

// ─── Resolution (Backoffice-first, ENV fallback, atomic) ────

function incompleteError(missing: string[]): ProviderError {
  // Field/variable NAMES only — never values (mirrors `required()` in config.ts).
  return new ProviderError("PROVIDER_UNAVAILABLE", {
    provider: EUPAGO_PROVIDER_ID,
    internalDetail: `incomplete eupago configuration: missing ${missing.join(", ")}`,
  });
}

function unreadableError(): ProviderError {
  return new ProviderError("PROVIDER_UNAVAILABLE", {
    provider: EUPAGO_PROVIDER_ID,
    internalDetail:
      "Backoffice eupago secrets are unreadable (wrong/missing SETTINGS_ENCRYPTION_KEY or tampered rows)",
  });
}

interface BackofficeCore {
  mode: boolean;
  environment: EupagoEnvironment | null;
  secrets: Record<"apiKey" | "oauthClientId" | "oauthClientSecret" | "webhookKey", string | null>;
}

/** Load + decrypt the core block. Throws `unreadableError()` on any crypto/data failure. */
async function loadBackofficeCore(rows: Map<string, string>): Promise<BackofficeCore> {
  const rawEnv = rows.get(CORE_KEYS.environment) ?? null;
  const rawSecrets = {
    apiKey: rows.get(CORE_KEYS.apiKey) ?? null,
    oauthClientId: rows.get(CORE_KEYS.oauthClientId) ?? null,
    oauthClientSecret: rows.get(CORE_KEYS.oauthClientSecret) ?? null,
    webhookKey: rows.get(CORE_KEYS.webhookKey) ?? null,
  };
  const mode = rawEnv !== null || Object.values(rawSecrets).some((v) => v !== null);
  if (!mode) {
    return {
      mode: false,
      environment: null,
      secrets: { apiKey: null, oauthClientId: null, oauthClientSecret: null, webhookKey: null },
    };
  }
  let environment: EupagoEnvironment | null = null;
  if (rawEnv !== null) {
    if (!isValidEnvironment(rawEnv)) {
      throw new ProviderError("PROVIDER_UNAVAILABLE", {
        provider: EUPAGO_PROVIDER_ID,
        internalDetail: "Backoffice eupago_environment invalid (must be sandbox|production)",
      });
    }
    environment = rawEnv;
  }
  const secrets = { apiKey: null, oauthClientId: null, oauthClientSecret: null, webhookKey: null } as Record<
    keyof typeof rawSecrets,
    string | null
  >;
  for (const [field, stored] of Object.entries(rawSecrets) as Array<
    [keyof typeof rawSecrets, string | null]
  >) {
    if (stored === null) continue;
    // A secret row that is not an envelope (plaintext/tampered) fails closed.
    if (!isEncryptedSettingValue(stored)) throw unreadableError();
    try {
      secrets[field] = await decryptSettingValue(stored);
    } catch (e) {
      if (e instanceof SettingsSecretError) throw unreadableError();
      throw e;
    }
  }
  return { mode: true, environment, secrets };
}

/**
 * Effective configuration for payment/refund flows. Backoffice-complete wins;
 * untouched Backoffice falls back to ENV (`getEupagoConfig()` unchanged);
 * partial Backoffice fails closed (never mixed with ENV).
 */
export async function resolveEupagoConfig(database: QueryDb = db): Promise<EupagoConfig> {
  const core = await loadBackofficeCore(await readRows(database));
  if (!core.mode) return getEupagoConfig();
  const missing: string[] = [];
  if (!core.environment) missing.push("environment");
  if (!core.secrets.apiKey) missing.push("apiKey");
  if (!core.secrets.oauthClientId) missing.push("oauthClientId");
  if (!core.secrets.oauthClientSecret) missing.push("oauthClientSecret");
  if (!core.secrets.webhookKey) missing.push("webhookKey");
  if (missing.length > 0) throw incompleteError(missing);
  return {
    environment: core.environment!,
    apiKey: core.secrets.apiKey!,
    oauthClientId: core.secrets.oauthClientId!,
    oauthClientSecret: core.secrets.oauthClientSecret!,
    webhookKey: core.secrets.webhookKey!,
  };
}

/** Effective webhook key for the settlement pipeline. Same atomic rule. */
export async function resolveEupagoWebhookKey(database: QueryDb = db): Promise<string> {
  const core = await loadBackofficeCore(await readRows(database));
  if (!core.mode) return getEupagoWebhookKey();
  const missing: string[] = [];
  if (!core.environment) missing.push("environment");
  if (!core.secrets.apiKey) missing.push("apiKey");
  if (!core.secrets.oauthClientId) missing.push("oauthClientId");
  if (!core.secrets.oauthClientSecret) missing.push("oauthClientSecret");
  if (!core.secrets.webhookKey) missing.push("webhookKey");
  if (missing.length > 0) throw incompleteError(missing);
  return core.secrets.webhookKey!;
}

// ─── Status (GET backing view — presence/metadata only) ─────

const ENV_VAR_BY_FIELD: Record<CoreField, string> = {
  environment: "EUPAGO_ENVIRONMENT",
  apiKey: "EUPAGO_API_KEY",
  oauthClientId: "EUPAGO_OAUTH_CLIENT_ID",
  oauthClientSecret: "EUPAGO_OAUTH_CLIENT_SECRET",
  webhookKey: "EUPAGO_WEBHOOK_KEY",
};

function envPresent(name: string): boolean {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0;
}

function parseLastTest(raw: string | null): EupagoConnectionTestRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<EupagoConnectionTestRecord>;
    if (
      typeof parsed.at !== "string" ||
      typeof parsed.ok !== "boolean" ||
      !isValidEnvironment(parsed.environment)
    ) {
      return null;
    }
    return {
      at: parsed.at,
      ok: parsed.ok,
      environment: parsed.environment,
      ...(typeof parsed.latencyMs === "number" &&
      Number.isInteger(parsed.latencyMs) &&
      parsed.latencyMs >= 0
        ? { latencyMs: parsed.latencyMs }
        : {}),
    };
  } catch {
    return null;
  }
}

function parseWebhookTypes(raw: string | null): EupagoWebhookType[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const allowed = new Set<string>(EUPAGO_WEBHOOK_TYPES);
    return parsed.filter((e): e is EupagoWebhookType => typeof e === "string" && allowed.has(e));
  } catch {
    return [];
  }
}

/**
 * Backoffice status view. NEVER throws for missing/incomplete configuration
 * (that is data, not an exception) and NEVER exposes secret values or
 * fragments — presence booleans + metadata only (D4).
 */
export async function getEupagoConfigStatus(database: QueryDb = db): Promise<EupagoConfigStatus> {
  const rows = await readRows(database);
  const fields = {
    environment: { set: rows.has(CORE_KEYS.environment) },
    apiKey: { set: rows.has(CORE_KEYS.apiKey) },
    oauthClientId: { set: rows.has(CORE_KEYS.oauthClientId) },
    oauthClientSecret: { set: rows.has(CORE_KEYS.oauthClientSecret) },
    webhookKey: { set: rows.has(CORE_KEYS.webhookKey) },
  };
  const webhook = {
    endpoint: rows.get(AUX_KEYS.webhookEndpoint) ?? null,
    encryption: rows.has(AUX_KEYS.webhookEncryption)
      ? rows.get(AUX_KEYS.webhookEncryption) === "true"
      : null,
    types: parseWebhookTypes(rows.get(AUX_KEYS.webhookTypes) ?? null),
  };
  const lastTest = parseLastTest(rows.get(AUX_KEYS.lastTest) ?? null);

  const backofficeTouched = Object.values(fields).some((f) => f.set);
  if (!backofficeTouched) {
    // ── ENV mode ──
    const missing: string[] = [];
    if (!envPresent("EUPAGO_API_KEY")) missing.push("EUPAGO_API_KEY");
    if (!envPresent("EUPAGO_OAUTH_CLIENT_ID")) missing.push("EUPAGO_OAUTH_CLIENT_ID");
    if (!envPresent("EUPAGO_OAUTH_CLIENT_SECRET")) missing.push("EUPAGO_OAUTH_CLIENT_SECRET");
    if (!envPresent("EUPAGO_WEBHOOK_KEY")) missing.push("EUPAGO_WEBHOOK_KEY");
    let environment: EupagoEnvironment | null = null;
    try {
      environment = resolveEupagoEnvironment();
    } catch {
      return {
        status: "error",
        origin: "env",
        environment: null,
        storedEnvironment: null,
        fields,
        missing: [],
        warnings: [],
        error: "ENV_INVALID",
        webhook,
        lastTest,
      };
    }
    if (missing.length > 0) {
      return {
        status: "incomplete",
        origin: "none",
        environment: null,
        storedEnvironment: null,
        fields,
        missing,
        warnings: [],
        error: null,
        webhook,
        lastTest,
      };
    }
    return {
      status: "configured",
      origin: "env",
      environment,
      storedEnvironment: null,
      fields,
      missing: [],
      warnings: [],
      error: null,
      webhook,
      lastTest,
    };
  }

  // ── Backoffice mode ──
  let core: BackofficeCore;
  try {
    core = await loadBackofficeCore(rows);
  } catch (e) {
    const detail = isProviderError(e) ? (e.internalDetail ?? "") : "";
    const error = detail.includes("eupago_environment invalid")
      ? "BACKOFFICE_INVALID"
      : "BACKOFFICE_UNREADABLE";
    return {
      status: "error",
      origin: "backoffice",
      environment: null,
      storedEnvironment: null,
      fields,
      missing: [],
      warnings: [],
      error,
      webhook,
      lastTest,
    };
  }
  const missing: string[] = [];
  if (!core.environment) missing.push("environment");
  if (!core.secrets.apiKey) missing.push("apiKey");
  if (!core.secrets.oauthClientId) missing.push("oauthClientId");
  if (!core.secrets.oauthClientSecret) missing.push("oauthClientSecret");
  if (!core.secrets.webhookKey) missing.push("webhookKey");
  if (missing.length > 0) {
    return {
      status: "incomplete",
      origin: "backoffice",
      environment: null,
      storedEnvironment: core.environment,
      fields,
      missing,
      warnings: [],
      error: null,
      webhook,
      lastTest,
    };
  }
  const warnings: string[] = [];
  // Encrypted webhooks require EXACTLY 32 UTF-8 bytes (enforced at decryption).
  // Non-blocking: the portal flag may legitimately differ; warn only.
  if (webhook.encryption === true) {
    const keyBytes = new TextEncoder().encode(core.secrets.webhookKey!).length;
    if (keyBytes !== 32) warnings.push("WEBHOOK_KEY_NOT_32_BYTES");
  }
  return {
    status: "configured",
    origin: "backoffice",
    environment: core.environment,
    storedEnvironment: core.environment,
    fields,
    missing: [],
    warnings,
    error: null,
    webhook,
    lastTest,
  };
}
