/**
 * B.3.2 — Eupago configuration + endpoint allowlist.
 *
 * SSRF SAFETY
 *  There is NO configurable base URL. The two Eupago hosts are compiled-in
 *  constants and every endpoint is a literal member of an allowlist. An
 *  operator can only choose the ENVIRONMENT (sandbox | production), exactly as
 *  Eupago documents ("replace sandbox with clientes"). Nothing derived from a
 *  request, a database row or a webhook payload can ever influence the URL.
 *
 * SECRETS
 *  API key / OAuth client id + secret / webhook key are read from the server
 *  environment only. They are never persisted, never logged, never serialized
 *  and never reachable from client bundles (this module is server-only: it is
 *  imported exclusively by server-side services and route handlers).
 *  Configuration FAILS CLOSED — a missing or malformed value throws a
 *  normalized ProviderError instead of falling back to a default.
 */

import { ProviderError } from "../errors";

export const EUPAGO_PROVIDER_ID = "eupago" as const;

/** The ONLY two hosts this integration may ever contact. */
const EUPAGO_HOSTS = {
  sandbox: "https://sandbox.eupago.pt",
  production: "https://clientes.eupago.pt",
} as const;

export type EupagoEnvironment = keyof typeof EUPAGO_HOSTS;

/** Documented Eupago paths in scope for B.3.2 (Multibanco / MB WAY / Card). */
const EUPAGO_PATHS = {
  /** Body-auth REST API (chave in body). */
  multibancoCreate: "/clientes/rest_api/multibanco/create",
  /** ApiKey-authenticated v1.02 endpoints. */
  mbwayCreate: "/api/v1.02/mbway/create",
  creditCardCreate: "/api/v1.02/creditcard/create",
  /** OAuth2 token endpoint (server-to-server only). */
  authToken: "/api/auth/token",
  /** Management advanced search — pre-create recovery primitive. */
  referencesInfo: "/api/management/v1.02/references/info",
} as const;

export type EupagoEndpoint = keyof typeof EUPAGO_PATHS | "refund";

/**
 * Resolve an allowlisted absolute URL.
 *
 * `refund` is the only path with a variable segment (`{trid}`); the trid is
 * strictly validated as an opaque token so it can never inject a path
 * traversal, a query string or a different host.
 */
export function eupagoUrl(
  environment: EupagoEnvironment,
  endpoint: EupagoEndpoint,
  params?: { trid?: string }
): string {
  const host = EUPAGO_HOSTS[environment];
  if (!host) {
    throw new ProviderError("PROVIDER_UNAVAILABLE", {
      provider: EUPAGO_PROVIDER_ID,
      internalDetail: "unknown eupago environment",
    });
  }

  if (endpoint === "refund") {
    const trid = params?.trid ?? "";
    if (!isValidTrid(trid)) {
      throw new ProviderError("INVALID_PROVIDER_RESPONSE", {
        provider: EUPAGO_PROVIDER_ID,
        internalDetail: "invalid trid for refund path",
      });
    }
    return `${host}/api/management/v1.02/refund/${trid}`;
  }

  const path = EUPAGO_PATHS[endpoint];
  if (!path) {
    throw new ProviderError("OPERATION_NOT_SUPPORTED", {
      provider: EUPAGO_PROVIDER_ID,
      internalDetail: "endpoint not allowlisted",
    });
  }
  return `${host}${path}`;
}

/** Provider fund-movement id: opaque, bounded, no path/query metacharacters. */
export function isValidTrid(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(value);
}

// ─── Environment-backed configuration (fail closed) ───────

export interface EupagoConfig {
  readonly environment: EupagoEnvironment;
  /** Body-auth `chave` for the Multibanco REST API. */
  readonly apiKey: string;
  readonly oauthClientId: string;
  readonly oauthClientSecret: string;
  /** Shared key used for BOTH webhook HMAC and AES-256-CBC. */
  readonly webhookKey: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    // The VALUE is never included — only the variable name.
    throw new ProviderError("PROVIDER_UNAVAILABLE", {
      provider: EUPAGO_PROVIDER_ID,
      internalDetail: `missing configuration: ${name}`,
    });
  }
  return value;
}

export function resolveEupagoEnvironment(): EupagoEnvironment {
  const raw = process.env.EUPAGO_ENVIRONMENT ?? "sandbox";
  if (raw !== "sandbox" && raw !== "production") {
    throw new ProviderError("PROVIDER_UNAVAILABLE", {
      provider: EUPAGO_PROVIDER_ID,
      internalDetail: "EUPAGO_ENVIRONMENT must be sandbox|production",
    });
  }
  return raw;
}

/**
 * Full server-side configuration. Throws (fail closed) when anything is
 * missing — a partially configured provider is never usable.
 */
export function getEupagoConfig(): EupagoConfig {
  return {
    environment: resolveEupagoEnvironment(),
    apiKey: required("EUPAGO_API_KEY"),
    oauthClientId: required("EUPAGO_OAUTH_CLIENT_ID"),
    oauthClientSecret: required("EUPAGO_OAUTH_CLIENT_SECRET"),
    webhookKey: required("EUPAGO_WEBHOOK_KEY"),
  };
}

/**
 * Webhook key only. Encrypted (AES-256-CBC) webhooks additionally require the
 * key to be EXACTLY 32 UTF-8 bytes — enforced where decryption happens.
 */
export function getEupagoWebhookKey(): string {
  return required("EUPAGO_WEBHOOK_KEY");
}
