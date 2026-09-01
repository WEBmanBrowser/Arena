/**
 * B.3.2 — Eupago HTTP transport + OAuth token handling.
 *
 * • fetch()-based (Cloudflare Workers / OpenNext compatible, no Node http).
 * • URLs come exclusively from the compiled-in allowlist in ./config.
 * • Ambiguity is explicit: timeouts, 5xx, malformed bodies and OAuth failures
 *   are returned as `ambiguous` outcomes, NEVER as "absent" or "failed create".
 * • OAuth tokens live in memory for the lifetime of the isolate only. They are
 *   never persisted to the database and never logged or serialized.
 */

import { ProviderError } from "../errors";
import {
  EUPAGO_PROVIDER_ID,
  eupagoUrl,
  type EupagoEndpoint,
  type EupagoEnvironment,
} from "./config";

export const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Normalized transport outcome.
 *
 *  ok        — a well-formed HTTP response was received and parsed. NOTE:
 *              `ok` says NOTHING about semantic success: Eupago returns
 *              HTTP 200 for semantic failures too.
 *  ambiguous — timeout / network error / 5xx / unparseable body. The provider
 *              may or may not have performed the operation. Callers MUST NOT
 *              retry a create blindly and MUST NOT treat this as absence.
 */
export type EupagoResponse =
  | { readonly kind: "ok"; readonly status: number; readonly body: Record<string, unknown> }
  | { readonly kind: "ambiguous"; readonly reason: AmbiguityReason; readonly status?: number };

export type AmbiguityReason =
  | "timeout"
  | "network_error"
  | "server_error"
  | "malformed_response"
  | "oauth_failure";

export interface EupagoRequestOptions {
  readonly environment: EupagoEnvironment;
  readonly endpoint: EupagoEndpoint;
  readonly method: "GET" | "POST";
  readonly body?: unknown;
  readonly query?: Record<string, string>;
  /** Extra headers. Secrets are passed here and never logged. */
  readonly headers?: Record<string, string>;
  readonly timeoutMs?: number;
  readonly trid?: string;
  /** Injected transport for tests — defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Perform exactly ONE HTTP request. This function never retries: retry policy
 * is a domain decision (and for create/refund the answer is always "no").
 */
export async function eupagoRequest(options: EupagoRequestOptions): Promise<EupagoResponse> {
  const doFetch = options.fetchImpl ?? fetch;
  let url = eupagoUrl(options.environment, options.endpoint, { trid: options.trid });
  if (options.query && Object.keys(options.query).length > 0) {
    url += `?${new URLSearchParams(options.query).toString()}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await doFetch(url, {
      method: options.method,
      headers: {
        Accept: "application/json",
        ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: controller.signal,
    });
  } catch (e) {
    const aborted = e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError");
    return { kind: "ambiguous", reason: aborted ? "timeout" : "network_error" };
  } finally {
    clearTimeout(timeout);
  }

  // 5xx: the provider may still have performed the operation.
  if (response.status >= 500) {
    return { kind: "ambiguous", reason: "server_error", status: response.status };
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    return { kind: "ambiguous", reason: "malformed_response", status: response.status };
  }

  let parsed: unknown;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    return { kind: "ambiguous", reason: "malformed_response", status: response.status };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "ambiguous", reason: "malformed_response", status: response.status };
  }

  return { kind: "ok", status: response.status, body: parsed as Record<string, unknown> };
}

// ─── OAuth (server-to-server, client_credentials) ─────────

interface CachedToken {
  readonly accessToken: string;
  readonly expiresAtMs: number;
}

/**
 * In-memory only. Deliberately NOT persisted: a stored bearer token is a
 * long-lived credential at rest, and the token endpoint is cheap to re-call.
 */
const tokenCache = new Map<string, CachedToken>();

/** Safety margin so a token is never used in the last seconds of its life. */
const TOKEN_EXPIRY_SKEW_MS = 30_000;

export function clearEupagoTokenCache(): void {
  tokenCache.clear();
}

export type TokenResult =
  | { readonly kind: "ok"; readonly accessToken: string }
  | { readonly kind: "ambiguous"; readonly reason: AmbiguityReason };

export interface TokenOptions {
  readonly environment: EupagoEnvironment;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

/**
 * Obtain an OAuth access token using the documented `client_credentials`
 * grant. No scopes are invented. Failures are AMBIGUOUS for the caller's
 * purposes — an OAuth failure must never be interpreted as "reference absent".
 */
export async function getEupagoAccessToken(options: TokenOptions): Promise<TokenResult> {
  const now = options.now ?? Date.now;
  const cacheKey = `${options.environment}:${options.clientId}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAtMs - TOKEN_EXPIRY_SKEW_MS > now()) {
    return { kind: "ok", accessToken: cached.accessToken };
  }

  const response = await eupagoRequest({
    environment: options.environment,
    endpoint: "authToken",
    method: "POST",
    body: {
      client_id: options.clientId,
      client_secret: options.clientSecret,
      grant_type: "client_credentials",
    },
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  });

  if (response.kind === "ambiguous") {
    return { kind: "ambiguous", reason: response.reason };
  }
  if (response.status >= 400) {
    return { kind: "ambiguous", reason: "oauth_failure" };
  }

  const accessToken = response.body.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    return { kind: "ambiguous", reason: "oauth_failure" };
  }
  const expiresIn = typeof response.body.expires_in === "number" ? response.body.expires_in : 300;

  tokenCache.set(cacheKey, {
    accessToken,
    expiresAtMs: now() + Math.max(0, expiresIn) * 1000,
  });
  return { kind: "ok", accessToken };
}

/** Normalized "provider unavailable" error for ambiguous transport outcomes. */
export function ambiguousError(reason: AmbiguityReason): ProviderError {
  return new ProviderError("PROVIDER_UNAVAILABLE", {
    provider: EUPAGO_PROVIDER_ID,
    internalDetail: `ambiguous provider outcome: ${reason}`,
  });
}
