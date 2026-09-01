/**
 * B.3.5 — Provider refund execution contract (fail-closed).
 *
 * NO provider adapter is live: every allowlisted payment provider returns
 * a normalized OPERATION_NOT_SUPPORTED result. This module contains no
 * URLs, HTTP methods, request bodies, headers, signature schemes, OAuth
 * behaviour or provider-specific refund identifiers — those belong to the
 * future provider integration phases (currently FROZEN).
 *
 * When a real provider integration is unfrozen, an adapter implementing
 * this contract is registered in getRefundProvider() and the refund
 * orchestration in src/lib/refunds.ts can begin executing attempts.
 */

import { PAYMENT_PROVIDERS } from "./registry";
import { ProviderError } from "./errors";

/** Allowlisted refund execution providers (payment providers only). */
export const REFUND_EXECUTION_PROVIDERS = PAYMENT_PROVIDERS;

export type RefundExecutionProvider = (typeof PAYMENT_PROVIDERS)[number];

export interface RefundExecutionRequest {
  readonly refundAttemptId: number;
  readonly providerPaymentReference: string | null;
  readonly amountCents: number;
  readonly currency: string;
}

/**
 * Normalized execution result. `executed: false` with a code is the ONLY
 * result any provider can produce in B.3.5 — external execution is
 * unavailable and fail-closed by design.
 */
export interface RefundExecutionResult {
  readonly executed: false;
  readonly code: "OPERATION_NOT_SUPPORTED";
  readonly message: string;
}

export interface RefundProviderAdapter {
  readonly provider: string;
  /** Attempt to execute a refund externally. Fail-closed in B.3.5. */
  createRefund(request: RefundExecutionRequest): Promise<RefundExecutionResult>;
  /** Query external refund status. Fail-closed in B.3.5. */
  getRefundStatus(providerRefundId: string): Promise<RefundExecutionResult>;
}

function failClosedAdapter(provider: string): RefundProviderAdapter {
  return {
    provider,
    async createRefund(): Promise<RefundExecutionResult> {
      throw new ProviderError("OPERATION_NOT_SUPPORTED", {
        provider,
        internalDetail: "No live refund execution adapter exists in B.3.5.",
      });
    },
    async getRefundStatus(): Promise<RefundExecutionResult> {
      throw new ProviderError("OPERATION_NOT_SUPPORTED", {
        provider,
        internalDetail: "No live refund execution adapter exists in B.3.5.",
      });
    },
  };
}

/**
 * Returns the refund execution adapter for an allowlisted payment
 * provider. The adapter ALWAYS throws ProviderError(OPERATION_NOT_SUPPORTED)
 * in B.3.5 — recording refund INTENT is allowed, executing it externally
 * is not. Unknown providers return null (never a fabricated adapter).
 */
export function getRefundProvider(provider: string): RefundProviderAdapter | null {
  return (REFUND_EXECUTION_PROVIDERS as readonly string[]).includes(provider)
    ? failClosedAdapter(provider)
    : null;
}
