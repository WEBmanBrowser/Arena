/**
 * B.3.2 — Eupago payment creation (Multibanco / MB WAY / Credit Card).
 *
 * CONTRACT NOTES (from official Eupago documentation)
 *  • Multibanco uses the BODY-AUTH REST API: `chave` travels in the body.
 *    Fields used: chave, valor, id, per_dup. An ordinary MDTech order sets
 *    per_dup = 0 — a reference must not accept multiple payments.
 *  • MB WAY and Credit Card use the v1.02 API with `Authorization: ApiKey …`.
 *  • HTTP 200 != success. Eupago returns 200 for semantic failures, so the
 *    response fields (sucesso / estado / resposta) are validated explicitly.
 *  • CREATION IS NOT SETTLEMENT. MB WAY "Success"/201 only means the payment
 *    REQUEST was created; the card flow only yields a hosted redirect URL.
 *    Neither ever confirms an order — only a trusted webhook/reconciliation
 *    event does (see ./settlement.ts).
 *
 * PCI: this module never accepts, forwards, logs or stores a PAN, CVV,
 * expiry date, OTP or any 3DS credential. Card payments are completed on
 * Eupago's hosted page; MDTech only handles the redirect URL.
 *
 * Money crosses the boundary as integer cents formatted by the deterministic
 * money-boundary helper — never via floating-point arithmetic.
 */

import { ProviderError } from "../errors";
import { formatCentsToDecimal, PROVIDER_CURRENCY } from "../money-boundary";
import { EUPAGO_PROVIDER_ID, type EupagoConfig } from "./config";
import { eupagoRequest, type AmbiguityReason, type EupagoResponse } from "./client";

export type EupagoMethod = "multibanco" | "mbway" | "card";

/** Normalized creation outcome. */
export type EupagoCreateResult =
  | {
      readonly kind: "created";
      /** Provider fund/reference identifier used operationally. */
      readonly reference: string;
      readonly entity?: string | null;
      readonly transactionId?: string | null;
      /** Eupago-hosted redirect (Credit Card only). */
      readonly redirectUrl?: string | null;
      readonly expiresAt?: Date | null;
    }
  | { readonly kind: "rejected"; readonly code: string }
  | { readonly kind: "ambiguous"; readonly reason: AmbiguityReason };

export interface EupagoCreateInput {
  readonly config: EupagoConfig;
  /** Stable internal identifier, persisted BEFORE this call is made. */
  readonly identifier: string;
  readonly amountCents: number;
  readonly currency?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface MbwayCreateInput extends EupagoCreateInput {
  readonly customerPhone: string;
  readonly countryCode: string;
  readonly customerName?: string | null;
  readonly customerEmail?: string | null;
}

export interface CardCreateInput extends EupagoCreateInput {
  readonly successUrl: string;
  readonly failUrl: string;
  readonly backUrl: string;
  readonly customerEmail: string;
  readonly lang?: string;
}

const IDENTIFIER_RE = /^[A-Za-z0-9._-]{8,60}$/;

function assertIdentifier(identifier: string): string {
  if (typeof identifier !== "string" || !IDENTIFIER_RE.test(identifier)) {
    throw new ProviderError("INVALID_PROVIDER_RESPONSE", {
      provider: EUPAGO_PROVIDER_ID,
      internalDetail: "invalid stable identifier",
    });
  }
  return identifier;
}

function assertCurrency(currency: string | undefined): string {
  const value = currency ?? PROVIDER_CURRENCY;
  if (value !== PROVIDER_CURRENCY) {
    throw new ProviderError("INVALID_PROVIDER_RESPONSE", {
      provider: EUPAGO_PROVIDER_ID,
      internalDetail: "unsupported currency",
    });
  }
  return value;
}

function optionalString(value: unknown, maxLength = 255): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : null;
}

function parseProviderDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.length === 0) return null;
  // Eupago sends "YYYY-MM-DD" or "YYYY-MM-DD HH:MM:SS".
  const normalized = value.includes(" ") ? value.replace(" ", "T") : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

// ─── Multibanco (body auth) ───────────────────────────────

/**
 * `per_dup = 0`: the generated reference accepts exactly ONE payment.
 * Allowing duplicate payments on an order reference would create
 * unreconcilable overpayments.
 */
export const MULTIBANCO_PER_DUP_SINGLE_PAYMENT = 0 as const;

export async function createMultibancoReference(
  input: EupagoCreateInput
): Promise<EupagoCreateResult> {
  const identifier = assertIdentifier(input.identifier);
  assertCurrency(input.currency);

  const response = await eupagoRequest({
    environment: input.config.environment,
    endpoint: "multibancoCreate",
    method: "POST",
    body: {
      chave: input.config.apiKey,
      valor: formatCentsToDecimal(input.amountCents),
      id: identifier,
      per_dup: MULTIBANCO_PER_DUP_SINGLE_PAYMENT,
    },
    timeoutMs: input.timeoutMs,
    fetchImpl: input.fetchImpl,
  });

  return interpretMultibanco(response);
}

/**
 * HTTP 200 is NOT success. The body-auth API signals semantic outcome through
 * `sucesso` (boolean) plus `estado`/`resposta` codes.
 */
function interpretMultibanco(response: EupagoResponse): EupagoCreateResult {
  if (response.kind === "ambiguous") return { kind: "ambiguous", reason: response.reason };

  const body = response.body;
  const success = body.sucesso;
  const estado = body.estado;
  const resposta = optionalString(body.resposta, 120);

  // `estado === 0` is the documented success code; `sucesso` must be true.
  const semanticSuccess = success === true && (estado === 0 || estado === "0" || estado === undefined);

  if (!semanticSuccess) {
    return {
      kind: "rejected",
      code: normalizeRejectionCode(resposta ?? (typeof estado === "string" || typeof estado === "number" ? String(estado) : "PROVIDER_REJECTED")),
    };
  }

  const reference = optionalString(body.referencia, 64);
  const entity = optionalString(body.entidade, 20);
  if (!reference || !entity) {
    // Claimed success without the operationally required fields is malformed.
    return { kind: "ambiguous", reason: "malformed_response" };
  }

  return {
    kind: "created",
    reference,
    entity,
    transactionId: optionalString(body.transactionID ?? body.trid, 64),
    expiresAt: parseProviderDate(body.data_fim),
  };
}

// ─── MB WAY (ApiKey auth, v1.02) ──────────────────────────

const PHONE_RE = /^[0-9]{6,15}$/;
const COUNTRY_CODE_RE = /^[0-9]{1,4}$/;

export async function createMbwayRequest(input: MbwayCreateInput): Promise<EupagoCreateResult> {
  const identifier = assertIdentifier(input.identifier);
  const currency = assertCurrency(input.currency);

  const phone = String(input.customerPhone ?? "").replace(/\s+/g, "");
  const countryCode = String(input.countryCode ?? "").replace(/^\+/, "");
  if (!PHONE_RE.test(phone) || !COUNTRY_CODE_RE.test(countryCode)) {
    throw new ProviderError("INVALID_PROVIDER_RESPONSE", {
      provider: EUPAGO_PROVIDER_ID,
      internalDetail: "invalid MB WAY phone/country code",
    });
  }

  const response = await eupagoRequest({
    environment: input.config.environment,
    endpoint: "mbwayCreate",
    method: "POST",
    headers: { Authorization: `ApiKey ${input.config.apiKey}` },
    body: {
      payment: {
        identifier,
        amount: { value: formatCentsToDecimal(input.amountCents), currency },
        countryCode,
        customerPhone: phone,
      },
      customer: {
        notify: false,
        ...(input.customerName ? { name: input.customerName.slice(0, 100) } : {}),
        ...(input.customerEmail ? { email: input.customerEmail.slice(0, 150) } : {}),
        phone,
      },
    },
    timeoutMs: input.timeoutMs,
    fetchImpl: input.fetchImpl,
  });

  return interpretV102(response, { requireRedirect: false });
}

// ─── Credit Card (ApiKey auth, v1.02, hosted flow) ────────

export async function createCardRequest(input: CardCreateInput): Promise<EupagoCreateResult> {
  const identifier = assertIdentifier(input.identifier);
  const currency = assertCurrency(input.currency);

  const response = await eupagoRequest({
    environment: input.config.environment,
    endpoint: "creditCardCreate",
    method: "POST",
    headers: { Authorization: `ApiKey ${input.config.apiKey}` },
    body: {
      payment: {
        identifier,
        amount: { value: formatCentsToDecimal(input.amountCents), currency },
        successUrl: input.successUrl,
        failUrl: input.failUrl,
        backUrl: input.backUrl,
        ...(input.lang ? { lang: input.lang } : {}),
      },
      customer: {
        notify: false,
        email: input.customerEmail,
      },
    },
    timeoutMs: input.timeoutMs,
    fetchImpl: input.fetchImpl,
  });

  return interpretV102(response, { requireRedirect: true });
}

/**
 * v1.02 semantic interpretation. HTTP 201 alone is not trusted: the documented
 * `transactionStatus` must be "Success". A card creation additionally requires
 * an Eupago-HOSTED redirect URL — any other host is rejected outright, since
 * MDTech must never send a customer to a non-Eupago payment page.
 */
function interpretV102(
  response: EupagoResponse,
  options: { requireRedirect: boolean }
): EupagoCreateResult {
  if (response.kind === "ambiguous") return { kind: "ambiguous", reason: response.reason };

  const body = response.body;
  const status = optionalString(body.transactionStatus, 40);

  if (status !== "Success") {
    return {
      kind: "rejected",
      code: normalizeRejectionCode(status ?? optionalString(body.message, 120) ?? "PROVIDER_REJECTED"),
    };
  }

  const reference = optionalString(body.reference, 64);
  const transactionId = optionalString(body.transactionID ?? body.transactionId, 64);
  if (!reference && !transactionId) {
    return { kind: "ambiguous", reason: "malformed_response" };
  }

  let redirectUrl: string | null = null;
  if (options.requireRedirect) {
    redirectUrl = optionalString(body.redirectUrl, 1000);
    if (!redirectUrl || !isEupagoHostedUrl(redirectUrl)) {
      // A missing or foreign redirect target is never surfaced to a browser.
      return { kind: "rejected", code: "INVALID_REDIRECT_URL" };
    }
  }

  return {
    kind: "created",
    reference: reference ?? transactionId!,
    transactionId,
    redirectUrl,
    entity: null,
  };
}

/** The hosted payment page must live on an Eupago host over HTTPS. */
export function isEupagoHostedUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  return url.hostname === "eupago.pt" || url.hostname.endsWith(".eupago.pt");
}

function normalizeRejectionCode(raw: string): string {
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.slice(0, 60) || "PROVIDER_REJECTED";
}
