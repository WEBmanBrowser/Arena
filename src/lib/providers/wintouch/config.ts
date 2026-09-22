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
  documentTypes: "/api/v1/document_types",
  documentSeries: "/api/v1/document_series",
  paymentMethods: "/api/v1/payment_methods",
  sectors: "/api/v1/sectors",
  workstations: "/api/v1/settings/commercial/workstations",
  entities: "/api/v1/entities",
  productDocuments: "/api/v1/product_documents",
} as const;

export type WintouchEndpoint = keyof typeof WINTOUCH_PATHS;

export interface WintouchConfig {
  /** Normalized base URL: validated, no trailing slash. */
  readonly baseUrl: string;
  /** Raw API key. In-memory only — never log, persist or serialize. */
  readonly apiKey: string;
}

export interface WintouchFiscalDocumentProfile {
  readonly documentTypeId: string;
  readonly documentSerieId: string;
}

export interface WintouchFiscalConfig {
  /** Optional: paid ecommerce uses FS/FATREC, never FT automatically. */
  readonly invoice: WintouchFiscalDocumentProfile | null;
  readonly simplifiedInvoice: WintouchFiscalDocumentProfile;
  readonly invoiceReceipt: WintouchFiscalDocumentProfile;
  readonly sectorId: string;
  readonly workstationId: string;
  /**
   * WINTOUCH payment methods by checkout method.
   *
   * Optional by design: an unconfigured method must fail closed
   * before fiscal creation instead of being silently substituted.
   */
  readonly paymentMethods: {
    readonly bankTransfer: string | null;
    readonly multibanco: string | null;
    readonly mbway: string | null;
    readonly card: string | null;
  };
  readonly enterpriseId: string;
  readonly currencyId: string;
  readonly countryId: string;
  readonly saveMode: number;
  vatId: string;
  vatRate: number;
  productId: string;
  warehouseId: string;
}

function requiredUuid(env: WintouchEnv, name: string): string {
  const value = requiredVar(env, name);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw configError("invalid", name);
  return value;
}

function optionalUuid(
  env: WintouchEnv,
  name: string,
): string | null {
  const raw = env[name];
  const value =
    typeof raw === "string"
      ? raw.trim()
      : "";

  if (!value) return null;

  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw configError("invalid", name);
  }

  return value;
}

function optionalProfile(
  env: WintouchEnv,
  typeName: string,
  seriesName: string,
): WintouchFiscalDocumentProfile | null {
  const documentTypeId = optionalUuid(env, typeName);
  const documentSerieId = optionalUuid(env, seriesName);

  if (!documentTypeId && !documentSerieId) return null;
  if (!documentTypeId || !documentSerieId) {
    throw configError("invalid", `${typeName}/${seriesName}`);
  }
  return { documentTypeId, documentSerieId };
}

export function resolveWintouchFiscalConfig(env: WintouchEnv = process.env): WintouchFiscalConfig {
  const saveModeRaw = requiredVar(env, "WINTOUCH_SAVE_MODE");
  if (!/^\d+$/.test(saveModeRaw)) throw configError("invalid", "WINTOUCH_SAVE_MODE");
  const saveMode = Number(saveModeRaw);
  if (!Number.isInteger(saveMode) || saveMode < 0 || saveMode > 14) {
    throw configError("invalid", "WINTOUCH_SAVE_MODE");
  }

  const vatRateRaw = requiredVar(env, "WINTOUCH_VAT_RATE");
  const productId = requiredVar(env, "WINTOUCH_PRODUCT_ID");
  const warehouseId = requiredVar(env, "WINTOUCH_WAREHOUSE_ID");
  const vatRate = Number(vatRateRaw);
  if (!Number.isFinite(vatRate) || vatRate < 0 || vatRate > 100) {
    throw configError("invalid", "WINTOUCH_VAT_RATE");
  }
  return {
    invoice: optionalProfile(
      env,
      "WINTOUCH_FT_DOCUMENT_TYPE_ID",
      "WINTOUCH_FT_DOCUMENT_SERIE_ID",
    ),

    simplifiedInvoice: {
      documentTypeId: requiredUuid(
        env,
        "WINTOUCH_FS_DOCUMENT_TYPE_ID",
      ),
      documentSerieId: requiredUuid(
        env,
        "WINTOUCH_FS_DOCUMENT_SERIE_ID",
      ),
    },

    invoiceReceipt: {
      documentTypeId: requiredUuid(
        env,
        "WINTOUCH_FR_DOCUMENT_TYPE_ID",
      ),
      documentSerieId: requiredUuid(
        env,
        "WINTOUCH_FR_DOCUMENT_SERIE_ID",
      ),
    },

    sectorId: requiredUuid(env, "WINTOUCH_SECTOR_ID"),
    workstationId: requiredUuid(env, "WINTOUCH_WORKSTATION_ID"),
    paymentMethods: {
      /*
       * Legacy WINTOUCH_PAYMENT_METHOD_ID remains a safe fallback
       * ONLY for bank transfer while environments are migrated.
       */
      bankTransfer:
        optionalUuid(
          env,
          "WINTOUCH_PAYMENT_METHOD_BANK_TRANSFER_ID",
        ) ??
        optionalUuid(
          env,
          "WINTOUCH_PAYMENT_METHOD_ID",
        ),

      multibanco:
        optionalUuid(
          env,
          "WINTOUCH_PAYMENT_METHOD_MULTIBANCO_ID",
        ),

      mbway:
        optionalUuid(
          env,
          "WINTOUCH_PAYMENT_METHOD_MBWAY_ID",
        ),

      card:
        optionalUuid(
          env,
          "WINTOUCH_PAYMENT_METHOD_CARD_ID",
        ),
    },

    enterpriseId: requiredUuid(env, "WINTOUCH_ENTERPRISE_ID"),
    currencyId: requiredUuid(env, "WINTOUCH_CURRENCY_ID"),
    countryId: requiredUuid(env, "WINTOUCH_COUNTRY_ID"),
    vatId: requiredUuid(env, "WINTOUCH_VAT_ID"),
    vatRate,
    productId,
    warehouseId,

    saveMode,
  };
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
