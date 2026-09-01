/**
 * B.3.2 — Eupago refund execution (management API).
 *
 *   POST /api/management/v1.02/refund/{trid}   (OAuth Bearer)
 *   body: { amount, [bic], [iban], [reason] }
 *
 * ACCEPTANCE IS NOT SETTLEMENT. An HTTP 201 means Eupago accepted/submitted
 * the refund request. The refund is only COMPLETED when a verified refund
 * webhook (its own distinct trid, carrying originalTrid) or a reconciliation
 * result proves the money moved.
 *
 * MB WAY / Credit Card refunds may require IBAN/BIC when a direct refund
 * cannot be executed. This module NEVER invents bank details and never
 * auto-retries: it surfaces an explicit operator-intervention outcome.
 */

import { formatCentsToDecimal } from "../money-boundary";
import { eupagoRequest, getEupagoAccessToken, type AmbiguityReason } from "./client";
import { isValidTrid, type EupagoConfig } from "./config";
import { ProviderError } from "../errors";
import { EUPAGO_PROVIDER_ID } from "./config";

export type EupagoRefundResult =
  /** Provider accepted/submitted the request — NOT proof of settlement. */
  | { readonly kind: "submitted"; readonly refundTransactionId: string | null }
  /** Provider needs bank details we must not fabricate. */
  | { readonly kind: "operator_required"; readonly code: "IBAN_BIC_REQUIRED" }
  | { readonly kind: "rejected"; readonly code: string }
  | { readonly kind: "ambiguous"; readonly reason: AmbiguityReason };

export interface EupagoRefundInput {
  readonly config: EupagoConfig;
  /** trid of the ORIGINAL payment movement. */
  readonly originalTransactionId: string;
  readonly amountCents: number;
  readonly reason?: string | null;
  /** Supplied ONLY by an explicit operator action — never fabricated. */
  readonly iban?: string | null;
  readonly bic?: string | null;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

/** Executes exactly ONE refund request. No internal retry, ever. */
export async function submitEupagoRefund(input: EupagoRefundInput): Promise<EupagoRefundResult> {
  if (!isValidTrid(input.originalTransactionId)) {
    throw new ProviderError("INVALID_PROVIDER_RESPONSE", {
      provider: EUPAGO_PROVIDER_ID,
      internalDetail: "invalid original trid",
    });
  }
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
    throw new ProviderError("INVALID_PROVIDER_RESPONSE", {
      provider: EUPAGO_PROVIDER_ID,
      internalDetail: "invalid refund amount",
    });
  }

  const token = await getEupagoAccessToken({
    environment: input.config.environment,
    clientId: input.config.oauthClientId,
    clientSecret: input.config.oauthClientSecret,
    fetchImpl: input.fetchImpl,
    timeoutMs: input.timeoutMs,
    now: input.now,
  });
  if (token.kind === "ambiguous") return { kind: "ambiguous", reason: token.reason };

  const response = await eupagoRequest({
    environment: input.config.environment,
    endpoint: "refund",
    trid: input.originalTransactionId,
    method: "POST",
    headers: { Authorization: `Bearer ${token.accessToken}` },
    body: {
      amount: formatCentsToDecimal(input.amountCents),
      ...(input.iban ? { iban: input.iban } : {}),
      ...(input.bic ? { bic: input.bic } : {}),
      ...(input.reason ? { reason: input.reason.slice(0, 200) } : {}),
    },
    timeoutMs: input.timeoutMs,
    fetchImpl: input.fetchImpl,
  });

  if (response.kind === "ambiguous") return { kind: "ambiguous", reason: response.reason };

  if (response.status >= 400) {
    const code = classifyRefundFailure(response.body);
    if (code === "IBAN_BIC_REQUIRED") return { kind: "operator_required", code };
    return { kind: "rejected", code };
  }

  const body = response.body;
  const status = typeof body.transactionStatus === "string" ? body.transactionStatus : null;
  if (status !== null && status !== "Success") {
    const code = classifyRefundFailure(body);
    if (code === "IBAN_BIC_REQUIRED") return { kind: "operator_required", code };
    return { kind: "rejected", code };
  }

  const refundTrid = ["trid", "transactionID", "transactionId", "refundTrid"]
    .map((k) => body[k])
    .find((v) => isValidTrid(v));

  return { kind: "submitted", refundTransactionId: (refundTrid as string | undefined) ?? null };
}

/**
 * Map a provider failure body to a normalized code. Any indication that bank
 * coordinates are needed becomes an explicit operator-required outcome.
 */
function classifyRefundFailure(body: Record<string, unknown>): string {
  const text = [body.message, body.error, body.transactionStatus, body.reason]
    .filter((v): v is string => typeof v === "string")
    .join(" ")
    .toUpperCase();

  if (/\bIBAN\b|\bBIC\b|BANK DETAILS|COORDENADAS/.test(text)) return "IBAN_BIC_REQUIRED";
  const cleaned = text.replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.slice(0, 60) || "REFUND_REJECTED";
}
