/**
 * C.4 — Wintouch Cloud configuration + endpoint allowlist.
 *
 * SECRETS
 *  WINTOUCH_API_KEY lives in the server environment only (secret binding in
 *  production, .env locally — never committed, see .gitignore). It is never
 *  persisted, never logged, never serialized and never reachable from client
 *  bundles: this module is server-only (imported exclusively by server-side
 *  services, scripts and route handlers). Configuration FAILS CLOSED — a
 *  missing or malformed value throws a normalized ProviderError.
 *
 * BASE URL
 *  Unlike Eupago (compiled-in hosts), the Wintouch BaseAddress is
 *  tenant-specific, so WINTOUCH_API_BASE_URL is operator-configured. It must
 *  include the full prefix up to the resource root (scheme + host + any path
 *  prefix such as /api, WITHOUT a trailing slash) and is strictly validated:
 *  https only (http allowed for loopback only), no userinfo, no query string,
 *  no fragment. It is still environment-controlled — never derived from a
 *  request, a database row or any other runtime input.
 *
 * ENDPOINTS
 *  Resource segments below come from the official Wintouch ApiDemo as
 *  validated for this phase (entities, Document_Types, payment_methods,
 *  product_documents). They are a literal allowlist — nothing is invented
 *  and no caller input can influence the path.
 */

import { ProviderError } from "../errors";

export const WINTOUCH_PROVIDER_ID = "wintouch" as const;

/** Literal resource paths in scope for the C.4 PROBE phase (read-only). */
const WINTOUCH_PATHS = {
  documentTypes: "/Document_Types",
  paymentMethods: "/payment_methods",
  entities: "/entities",
  productDocuments: "/product_documents",
} as const;

export type WintouchEndpoint = keyof typeof WINTOUCH_PATHS;

export interface WintouchConfig {
  /** Normalized base URL: validated, no trailing slash. */
  readonly baseUrl: string;
  /** Raw API key. In-memory only — never log, persist or serialize. */
  readonly apiKey: string;
}

/**
 * Minimal environment shape (a subset of NodeJS.ProcessEnv): the resolver
 * only reads two variables, and tests inject plain objects.
 */
export type WintouchEnv = Record<string, string | undefined>;

function configError(kind: "missing" | "invalid", name: string): ProviderError {
  // The VALUE is never included — only the variable name.
  return new ProviderError("PROVIDER_UNAVAILABLE", {
    provider: WINTOUCH_PROVIDER_ID,
    internalDetail: `${kind} configuration: ${name}`,
  });
}

function requiredVar(env: WintouchEnv, name: string): string {
  const raw = env[name];
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value.length === 0) throw configError("missing", name);
  if (/[\r\n\0]/.test(value)) throw configError("invalid", name);
  return value;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Validate + normalize WINTOUCH_API_BASE_URL. Throws (fail closed) on
 * anything that is not an https origin (+ optional path prefix), except
 * plain http on loopback for local development and tests.
 */
export function normalizeBaseUrl(raw: string): string {
  // Reject control characters BEFORE parsing: the WHATWG URL parser silently
  // strips tabs/newlines, which would otherwise launder a malformed value.
  if (/[\r\n\0\t]/.test(raw)) throw configError("invalid", "WINTOUCH_API_BASE_URL");
  const trimmed = raw.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw configError("invalid", "WINTOUCH_API_BASE_URL");
  }
  const isLoopback = LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  const schemeOk = url.protocol === "https:" || (url.protocol === "http:" && isLoopback);
  if (!schemeOk) throw configError("invalid", "WINTOUCH_API_BASE_URL");
  // No credentials, query string or fragment in a base URL — ever.
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw configError("invalid", "WINTOUCH_API_BASE_URL");
  }
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path}`;
}

/**
 * Full server-side configuration. Throws (fail closed) when anything is
 * missing or malformed — a partially configured provider is never usable.
 * The optional `env` parameter exists for tests; production always passes
 * the real process environment.
 */
export function resolveWintouchConfig(env: WintouchEnv = process.env): WintouchConfig {
  const baseUrl = normalizeBaseUrl(requiredVar(env, "WINTOUCH_API_BASE_URL"));
  const apiKey = requiredVar(env, "WINTOUCH_API_KEY");
  return { baseUrl, apiKey };
}

/**
 * Resolve an allowlisted absolute URL. There are no variable path segments
 * in this phase, so `endpoint` is the only input and it is type-restricted
 * to the allowlist keys.
 */
export function wintouchUrl(config: WintouchConfig, endpoint: WintouchEndpoint): string {
  const path: string | undefined = WINTOUCH_PATHS[endpoint];
  if (!path) {
    throw new ProviderError("OPERATION_NOT_SUPPORTED", {
      provider: WINTOUCH_PROVIDER_ID,
      internalDetail: "endpoint not allowlisted",
    });
  }
  return `${config.baseUrl}${path}`;
}
