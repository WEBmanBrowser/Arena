/**
 * B.3.2 — Eupago refund execution orchestration.
 *
 * INTEGRATES WITH B.3.5 — it does NOT replace it.
 *  • The refund attempt is created by the existing `requestRefund()` service,
 *    which owns idempotency, currency validation, the application-level
 *    over-refund check and the audit trail. The database trigger
 *    `refund_attempts_balance_guard` remains the final authority.
 *  • This module only ARMS an existing attempt with provider correlation,
 *    issues EXACTLY ONE provider request, and records a sanitized
 *    acknowledgement.
 *  • It NEVER marks a refund `succeeded`: HTTP 201 means "accepted/submitted",
 *    not "settled". Only a verified refund webhook (own trid + originalTrid)
 *    or reconciliation can complete it — see eupago-settlement-service.ts.
 *  • No payments row rewrite, no orders.status write, no stock mutation, no
 *    RMA mutation.
 */

import { db } from "@/db";
import { paymentAttempts, refundAttempts } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { createAuditLog } from "@/lib/audit";
import { ProviderError } from "@/lib/providers/errors";
import { EUPAGO_PROVIDER_ID, getEupagoConfig, type EupagoConfig } from "@/lib/providers/eupago/config";
import { submitEupagoRefund } from "@/lib/providers/eupago/refunds";

export type RefundAttemptRow = typeof refundAttempts.$inferSelect;

export type ExecuteRefundResult =
  /** Provider accepted the request. The attempt stays pending/processing. */
  | { readonly outcome: "submitted"; readonly refund: RefundAttemptRow }
  /** Bank details required — explicit operator intervention, no auto-retry. */
  | { readonly outcome: "operator_required"; readonly refund: RefundAttemptRow; readonly code: string }
  | { readonly outcome: "rejected"; readonly refund: RefundAttemptRow; readonly code: string }
  /** Unknown provider state — never retried automatically. */
  | {
      readonly outcome: "reconciliation_required";
      readonly refund: RefundAttemptRow;
      readonly code: string;
    };

export interface ExecuteRefundInput {
  /** Id of an EXISTING B.3.5 refund attempt (provider = 'eupago'). */
  readonly refundId: number;
  readonly actorId: number;
  /** Supplied only by an explicit operator decision — never fabricated. */
  readonly iban?: string | null;
  readonly bic?: string | null;
  readonly config?: EupagoConfig;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Arm a B.3.5 refund attempt with provider correlation.
 *
 * Resolves the ORIGINAL payment movement (`originalTrid`) from the settled
 * Eupago payment attempt of the same order and commits it BEFORE any network
 * call, so a crash mid-flight leaves a recoverable, correlatable record.
 */
export async function armEupagoRefund(refundId: number): Promise<RefundAttemptRow> {
  const [refund] = await db.select().from(refundAttempts).where(eq(refundAttempts.id, refundId)).limit(1);
  if (!refund) {
    throw new ProviderError("PAYMENT_NOT_FOUND", {
      provider: EUPAGO_PROVIDER_ID,
      internalDetail: "refund attempt not found",
    });
  }
  if (refund.provider !== EUPAGO_PROVIDER_ID) {
    throw new ProviderError("OPERATION_NOT_SUPPORTED", {
      provider: refund.provider,
      internalDetail: "refund attempt does not belong to eupago",
    });
  }
  if (refund.providerOriginalTransactionId) return refund;

  const [paid] = await db
    .select()
    .from(paymentAttempts)
    .where(
      and(
        eq(paymentAttempts.orderId, refund.orderId),
        eq(paymentAttempts.provider, EUPAGO_PROVIDER_ID),
        eq(paymentAttempts.status, "paid")
      )
    )
    .limit(1);

  if (!paid?.providerTransactionId) {
    throw new ProviderError("PAYMENT_NOT_FOUND", {
      provider: EUPAGO_PROVIDER_ID,
      internalDetail: "no settled eupago payment movement for this order",
    });
  }

  const [armed] = await db
    .update(refundAttempts)
    .set({
      providerOriginalTransactionId: paid.providerTransactionId,
      recoveryState: "armed",
      updatedAt: new Date(),
    })
    .where(eq(refundAttempts.id, refund.id))
    .returning();
  return armed;
}

/**
 * Execute the single permitted provider refund request for an armed attempt.
 *
 * The 'armed' → 'requested' compare-and-swap guarantees at most one network
 * call per attempt even under concurrent operators.
 */
export async function executeEupagoRefund(input: ExecuteRefundInput): Promise<ExecuteRefundResult> {
  const config = input.config ?? getEupagoConfig();
  const armed = await armEupagoRefund(input.refundId);

  if (armed.status !== "pending" && armed.status !== "processing") {
    throw new ProviderError("OPERATION_NOT_SUPPORTED", {
      provider: EUPAGO_PROVIDER_ID,
      internalDetail: `refund not executable in state ${armed.status}`,
    });
  }

  const [claimed] = await db
    .update(refundAttempts)
    .set({ recoveryState: "requested", providerRequestedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(refundAttempts.id, armed.id), eq(refundAttempts.recoveryState, "armed")))
    .returning();

  if (!claimed) {
    return { outcome: "reconciliation_required", refund: armed, code: "REFUND_ALREADY_REQUESTED" };
  }

  const result = await submitEupagoRefund({
    config,
    originalTransactionId: claimed.providerOriginalTransactionId!,
    amountCents: claimed.amountCents,
    reason: claimed.reason,
    iban: input.iban ?? null,
    bic: input.bic ?? null,
    fetchImpl: input.fetchImpl,
  });

  if (result.kind === "ambiguous") {
    // FAIL CLOSED — the money may or may not be moving. Never re-submit.
    const row = await setRefundOperatorState(
      claimed.id,
      "reconciliation_required",
      `AMBIGUOUS_${result.reason.toUpperCase()}`
    );
    await createAuditLog({
      userId: input.actorId,
      action: "refund.provider_ambiguous",
      entity: "refund",
      entityId: row.id,
      details: { orderId: row.orderId, provider: EUPAGO_PROVIDER_ID, reason: result.reason },
    });
    return { outcome: "reconciliation_required", refund: row, code: row.operatorActionCode! };
  }

  if (result.kind === "operator_required") {
    const row = await setRefundOperatorState(claimed.id, "reconciliation_required", result.code);
    await createAuditLog({
      userId: input.actorId,
      action: "refund.operator_intervention_required",
      entity: "refund",
      entityId: row.id,
      details: { orderId: row.orderId, provider: EUPAGO_PROVIDER_ID, code: result.code },
    });
    return { outcome: "operator_required", refund: row, code: result.code };
  }

  if (result.kind === "rejected") {
    // The attempt stays committed (balance reserved) and is NOT auto-retried;
    // an operator decides through the existing B.3.5 transitions.
    const row = await setRefundOperatorState(claimed.id, "reconciliation_required", result.code);
    return { outcome: "rejected", refund: row, code: result.code };
  }

  // Submitted — acknowledged only. Status intentionally REMAINS pending.
  const [row] = await db
    .update(refundAttempts)
    .set({
      status: "processing",
      // The provider refund trid is authoritative only once the refund webhook
      // confirms it; an acknowledgement value is not treated as settlement.
      operatorActionCode: null,
      updatedAt: new Date(),
    })
    .where(and(eq(refundAttempts.id, claimed.id), eq(refundAttempts.status, claimed.status)))
    .returning();

  await createAuditLog({
    userId: input.actorId,
    action: "refund.provider_submitted",
    entity: "refund",
    entityId: claimed.id,
    details: {
      orderId: claimed.orderId,
      provider: EUPAGO_PROVIDER_ID,
      amountCents: claimed.amountCents,
      acknowledged: result.refundTransactionId !== null,
    },
  });

  return { outcome: "submitted", refund: row ?? claimed };
}

async function setRefundOperatorState(
  refundId: number,
  recoveryState: string,
  code: string
): Promise<RefundAttemptRow> {
  const [row] = await db
    .update(refundAttempts)
    .set({ recoveryState, operatorActionCode: code.slice(0, 60), updatedAt: new Date() })
    .where(eq(refundAttempts.id, refundId))
    .returning();
  return row;
}

/** Refunds awaiting operator/reconciliation attention (report only). */
export async function listRefundsRequiringOperator(limit = 100): Promise<RefundAttemptRow[]> {
  return db
    .select()
    .from(refundAttempts)
    .where(
      and(
        eq(refundAttempts.provider, EUPAGO_PROVIDER_ID),
        eq(refundAttempts.recoveryState, "reconciliation_required")
      )
    )
    .limit(limit);
}
