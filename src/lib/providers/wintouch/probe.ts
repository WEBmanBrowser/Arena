/**
 * C.4 — Wintouch Cloud connectivity probe (READ-ONLY diagnostics).
 *
 * Runs a fixed sequence of GET requests against the allowlisted resources
 * (Document_Types, payment_methods, entities, product_documents) and returns
 * a SAFE summary. This module performs NO writes and issues NO POSTs.
 *
 * SAFETY CONTRACT (enforced by unit tests, including adversarial cases where
 * the API echoes the key back inside response values or error bodies):
 * • Response VALUES are never included — only statuses, array counts and
 *   sorted field-name shapes (keys, never values).
 * • Error excerpts are truncated, passed through sanitizeErrorMessage AND
 *   swept for the configured API key.
 * • The final serialized result is swept for the API key once more, so no
 *   future field can leak it by accident.
 * The output NEVER contains the API key, the Authorization header, passwords
 * or tokens. It is safe to paste into tickets and logs.
 */

import { sanitizeErrorMessage } from "../errors";
import { isAuthFailure, wintouchRequest } from "./client";
import { resolveWintouchConfig, type WintouchConfig, type WintouchEndpoint, type WintouchEnv } from "./config";

/** Cap on reported field names per check (shapes stay small and stable). */
const MAX_SHAPE_KEYS = 40;
/** Cap on the sanitized error excerpt per failed check. */
const MAX_ERROR_EXCERPT = 300;

const REDACTED = "[REDACTED]";

/**
 * Deterministic redaction of KNOWN secrets (the configured API key). Unlike
 * pattern-based sanitization this cannot miss: any occurrence of the exact
 * secret value is removed, wherever it appears.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length > 0) {
      out = out.split(secret).join(REDACTED);
    }
  }
  return out;
}

export type WintouchProbeOutcome = "ok" | "auth_failed" | "client_error" | "not_found" | "ambiguous";

export interface WintouchProbeCheck {
  readonly name: string;
  readonly endpoint: WintouchEndpoint;
  /** True only for 2xx with a parseable body. */
  readonly ok: boolean;
  readonly status: number | null;
  readonly outcome: WintouchProbeOutcome;
  /** Ambiguity reason (transport level) or null. */
  readonly reason: string | null;
  /** Array length when the body is a JSON array, else null. */
  readonly count: number | null;
  /** Sorted field names (keys only — values are NEVER included), else null. */
  readonly shape: readonly string[] | null;
  /** Sanitized, truncated error excerpt for failed checks, else null. */
  readonly error: string | null;
  readonly durationMs: number;
}

export interface WintouchProbeResult {
  /** True only when every check returned 2xx with a parseable body. */
  readonly ok: boolean;
  /** The configured base URL (operator input — needed to identify the target). */
  readonly baseUrl: string;
  /**
   * True when at least one endpoint answered with an HTTP status other than
   * 401/403 (no auth rejection observed). False means "auth not established"
   * — either rejected (401/403) or never reached (transport failure);
   * per-check outcomes carry the detail.
   */
  readonly authenticated: boolean;
  readonly checks: readonly WintouchProbeCheck[];
  readonly durationMs: number;
  readonly probedAt: string;
}

export interface ProbeWintouchOptions {
  /** Pre-resolved config. When omitted it is resolved from `env`/process.env. */
  readonly config?: WintouchConfig;
  readonly env?: WintouchEnv;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /** Include the optional GET product_documents check. Default true. */
  readonly includeProductDocuments?: boolean;
}

function shapeOf(body: unknown): readonly string[] | null {
  const target = Array.isArray(body) ? body[0] : body;
  if (typeof target !== "object" || target === null) return null;
  return Object.keys(target).sort().slice(0, MAX_SHAPE_KEYS);
}

function excerptOf(body: unknown, secrets: readonly string[]): string | null {
  if (body === null || body === undefined) return null;
  const text = typeof body === "string" ? body : (JSON.stringify(body) ?? "unserializable");
  return sanitizeErrorMessage(redactSecrets(text, secrets), MAX_ERROR_EXCERPT);
}

async function runCheck(
  name: string,
  endpoint: WintouchEndpoint,
  config: WintouchConfig,
  secrets: readonly string[],
  options: Pick<ProbeWintouchOptions, "fetchImpl" | "timeoutMs">
): Promise<WintouchProbeCheck> {
  const started = Date.now();
  const response = await wintouchRequest({
    config,
    endpoint,
    method: "GET",
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  });
  const durationMs = Date.now() - started;

  if (response.kind === "ambiguous") {
    return {
      name,
      endpoint,
      ok: false,
      status: response.status ?? null,
      outcome: "ambiguous",
      reason: response.reason,
      count: null,
      shape: null,
      error: null,
      durationMs,
    };
  }

  const status = response.status;
  if (status >= 200 && status < 300) {
    const count = Array.isArray(response.body) ? response.body.length : null;
    const shape = shapeOf(response.body)?.map((key) => redactSecrets(key, secrets)) ?? null;
    return {
      name,
      endpoint,
      ok: true,
      status,
      outcome: "ok",
      reason: null,
      count,
      shape,
      error: null,
      durationMs,
    };
  }

  const outcome: WintouchProbeOutcome = isAuthFailure(status)
    ? "auth_failed"
    : status === 404
      ? "not_found"
      : "client_error";
  return {
    name,
    endpoint,
    ok: false,
    status,
    outcome,
    reason: null,
    count: null,
    shape: null,
    error: excerptOf(response.body, secrets),
    durationMs,
  };
}

/**
 * Run the read-only probe. Resolves configuration first (fail closed —
 * missing/invalid config throws ProviderError before any network call),
 * then issues the GET checks sequentially (deterministic order, gentle on
 * the provider).
 */
export async function probeWintouch(options: ProbeWintouchOptions = {}): Promise<WintouchProbeResult> {
  const started = Date.now();
  const config = options.config ?? resolveWintouchConfig(options.env ?? process.env);
  const secrets = [config.apiKey];

  const plan: Array<{ name: string; endpoint: WintouchEndpoint }> = [
    { name: "document_types", endpoint: "documentTypes" },
    { name: "payment_methods", endpoint: "paymentMethods" },
    { name: "entities", endpoint: "entities" },
  ];
  if (options.includeProductDocuments !== false) {
    plan.push({ name: "product_documents", endpoint: "productDocuments" });
  }

  const checks: WintouchProbeCheck[] = [];
  for (const step of plan) {
    checks.push(await runCheck(step.name, step.endpoint, config, secrets, options));
  }

  const result: WintouchProbeResult = {
    ok: checks.every((check) => check.ok),
    baseUrl: config.baseUrl,
    authenticated: checks.some((check) => check.status !== null && !isAuthFailure(check.status)),
    checks,
    durationMs: Date.now() - started,
    probedAt: new Date(started).toISOString(),
  };

  // Absolute guarantee: sweep the serialized output for the known secret so
  // no field — present or future — can carry it out.
  return JSON.parse(redactSecrets(JSON.stringify(result), secrets)) as WintouchProbeResult;
}
