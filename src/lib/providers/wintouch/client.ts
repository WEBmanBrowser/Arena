/**
 * C.4 — Wintouch Cloud HTTP transport (server-side, read-only in this phase).
 *
 * Mirrors the Eupago transport contract (../eupago/client.ts):
 * • fetch()-based (Cloudflare Workers / OpenNext compatible, no Node http).
 * • Authentication is `Authorization: ApiKey <key>`, exactly as the official
 *   Wintouch ApiDemo initializes the API. The key travels in the header only;
 *   it is never placed in the URL, never logged and never serialized.
 * • Exactly ONE request per call. This function never retries: retry policy
 *   is a domain decision (and for a future invoice create the answer — as
 *   with Eupago creates — will be "no blind retries", see docs).
 * • Outcomes distinguish DEFINITIVE answers from AMBIGUOUS transport
 *   states. Auth rejections (401/403) and client errors (400/404/…) are
 *   definitive `ok` outcomes — the status and the parsed error body are
 *   preserved for the caller. Only timeouts, network errors, 5xx and
 *   unparseable bodies are `ambiguous`: the provider may or may not have
 *   performed the operation.
 */

import { ProviderError } from "../errors";
import { WINTOUCH_PROVIDER_ID, wintouchUrl, type WintouchConfig, type WintouchEndpoint } from "./config";

export const WINTOUCH_DEFAULT_TIMEOUT_MS = 15_000;

export type WintouchAmbiguityReason = "timeout" | "network_error" | "server_error" | "malformed_response";

/**
 * Normalized transport outcome.
 *
 *  ok        — an HTTP response was received (any non-5xx status) and its
 *              body parsed (empty body → null). `ok` says NOTHING about
 *              semantic success: 401/403/400/404 arrive here WITH their
 *              status and error body preserved.
 *  ambiguous — timeout / network error / 5xx / unparseable body. No
 *              definitive statement about provider state is possible.
 */
export type WintouchResponse =
  | { readonly kind: "ok"; readonly status: number; readonly body: unknown }
  | { readonly kind: "ambiguous"; readonly reason: WintouchAmbiguityReason; readonly status?: number };

export interface WintouchRequestOptions {
  readonly config: WintouchConfig;
  readonly endpoint: WintouchEndpoint;
  readonly method: "GET" | "POST";
  /** Optional query string (string values only). Unused by the C.4 probe. */
  readonly query?: Record<string, string>;
  readonly body?: unknown;
  readonly timeoutMs?: number;
  /** Injected transport for tests — defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

/** 401/403 are definitive auth rejections — never ambiguous, never retried. */
export function isAuthFailure(status: number): boolean {
  return status === 401 || status === 403;
}

export async function wintouchRequest(options: WintouchRequestOptions): Promise<WintouchResponse> {
  const doFetch = options.fetchImpl ?? fetch;
  let url = wintouchUrl(options.config, options.endpoint);
  if (options.query && Object.keys(options.query).length > 0) {
    url += `?${new URLSearchParams(options.query).toString()}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? WINTOUCH_DEFAULT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await doFetch(url, {
      method: options.method,
      headers: {
        Accept: "application/json",
        ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
        Authorization: `ApiKey ${options.config.apiKey}`,
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

  if (text.length === 0) {
    return { kind: "ok", status: response.status, body: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "ambiguous", reason: "malformed_response", status: response.status };
  }

  return { kind: "ok", status: response.status, body: parsed };
}

/** Normalized "provider unavailable" error for ambiguous transport outcomes. */
export function wintouchAmbiguousError(reason: WintouchAmbiguityReason): ProviderError {
  return new ProviderError("PROVIDER_UNAVAILABLE", {
    provider: WINTOUCH_PROVIDER_ID,
    internalDetail: `ambiguous provider outcome: ${reason}`,
  });
}
