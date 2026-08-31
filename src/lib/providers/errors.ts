/**
 * B.3.1 — Normalized integration/provider errors.
 *
 * These are TypeScript/application-level errors. They are intentionally NOT
 * persisted in a dedicated database table: the existing audit log
 * (`audit_logs`) plus application logging already cover durable traceability,
 * and provider failures that must survive a restart are represented by the
 * `status`/`last_error` columns of the durable B.3.1 tables
 * (provider_webhook_events, payment_attempts, shipments, invoice_documents).
 *
 * Customer-safe serialization NEVER exposes stack traces, credentials,
 * secrets or raw provider payloads.
 */

export const PROVIDER_ERROR_CODES = [
  "PROVIDER_UNAVAILABLE",
  "INVALID_PROVIDER_RESPONSE",
  "WEBHOOK_INVALID",
  "WEBHOOK_DUPLICATE",
  "PAYMENT_NOT_FOUND",
  "SHIPMENT_NOT_FOUND",
  "INVOICE_NOT_FOUND",
  "OPERATION_NOT_SUPPORTED",
  "UNSUPPORTED_PROVIDER",
] as const;

export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

/** Customer-facing messages (pt-PT). Never include provider internals. */
const CUSTOMER_MESSAGES: Record<ProviderErrorCode, string> = {
  PROVIDER_UNAVAILABLE: "O serviço externo está temporariamente indisponível.",
  INVALID_PROVIDER_RESPONSE: "Resposta inválida do serviço externo.",
  WEBHOOK_INVALID: "Notificação externa inválida.",
  WEBHOOK_DUPLICATE: "Notificação externa já recebida.",
  PAYMENT_NOT_FOUND: "Pagamento não encontrado.",
  SHIPMENT_NOT_FOUND: "Envio não encontrado.",
  INVOICE_NOT_FOUND: "Documento não encontrado.",
  OPERATION_NOT_SUPPORTED: "Operação não suportada.",
  UNSUPPORTED_PROVIDER: "Fornecedor não suportado.",
};

/** Codes for which a controlled retry may make sense. */
const RETRYABLE_CODES: ReadonlySet<ProviderErrorCode> = new Set<ProviderErrorCode>([
  "PROVIDER_UNAVAILABLE",
]);

/** Shape returned to customers / HTTP clients. */
export interface CustomerSafeProviderError {
  error: ProviderErrorCode;
  message: string;
}

export interface ProviderErrorOptions {
  /** Provider id (allowlisted identifier only, never credentials). */
  provider?: string;
  /** Internal-only diagnostic detail. NEVER serialized to customers. */
  internalDetail?: string;
  cause?: unknown;
}

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly provider?: string;
  /** Internal-only. Excluded from every customer-facing serialization. */
  readonly internalDetail?: string;
  readonly retryable: boolean;

  constructor(code: ProviderErrorCode, options: ProviderErrorOptions = {}) {
    super(CUSTOMER_MESSAGES[code]);
    this.name = "ProviderError";
    this.code = code;
    this.provider = options.provider;
    this.internalDetail = options.internalDetail;
    this.retryable = RETRYABLE_CODES.has(code);
    if (options.cause !== undefined) {
      // Kept in-memory only for logging; never serialized to customers.
      (this as { cause?: unknown }).cause = options.cause;
    }
  }

  /**
   * Customer-safe representation.
   * Contains ONLY the normalized code and a generic localized message.
   */
  toCustomerSafeJSON(): CustomerSafeProviderError {
    return { error: this.code, message: CUSTOMER_MESSAGES[this.code] };
  }

  /** `JSON.stringify(providerError)` is customer-safe by construction. */
  toJSON(): CustomerSafeProviderError {
    return this.toCustomerSafeJSON();
  }
}

export function isProviderError(e: unknown): e is ProviderError {
  return e instanceof ProviderError;
}

/**
 * Convert any thrown value into a customer-safe payload.
 * Unknown errors are collapsed to PROVIDER_UNAVAILABLE — internal messages
 * and stacks are never propagated.
 */
export function toCustomerSafeError(e: unknown): CustomerSafeProviderError {
  if (isProviderError(e)) return e.toCustomerSafeJSON();
  return {
    error: "PROVIDER_UNAVAILABLE",
    message: CUSTOMER_MESSAGES.PROVIDER_UNAVAILABLE,
  };
}

/**
 * Sanitize a free-text error message before durable persistence
 * (e.g. provider_webhook_events.last_error).
 * Redacts common secret-bearing patterns and truncates.
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Bearer tokens first: otherwise "Authorization: Bearer <token>" would only
  // redact the literal word "Bearer" and leak the token itself.
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]"],
  [/(authorization|bearer|api[-_ ]?key|apikey|secret|token|password|passwd|pwd|signature|cvv|iban)\s*[:=]\s*\S+/gi, "$1=[REDACTED]"],
  [/\b(?:\d[ -]*?){13,19}\b/g, "[REDACTED_PAN]"],
];

export function sanitizeErrorMessage(input: unknown, maxLength = 500): string {
  let text: string;
  if (input instanceof ProviderError) text = `${input.code}`;
  else if (input instanceof Error) text = input.message;
  else if (typeof input === "string") text = input;
  else text = "UNKNOWN_ERROR";

  for (const [pattern, replacement] of SECRET_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text.slice(0, maxLength);
}
