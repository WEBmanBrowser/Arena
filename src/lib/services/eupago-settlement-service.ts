/**
 * B.3.2 — Eupago webhook settlement (trusted provider events).
 *
 * This is the ONLY path that may settle a Eupago payment or refund, and it
 * does so exclusively through the EXISTING centralized services:
 *
 *   payment settled  → confirmOrderPayment()   (Phase A lifecycle)
 *   refund settled   → the B.3.5 refund_attempts ledger
 *
 * It NEVER writes orders.status directly, NEVER mutates stock, NEVER rewrites
 * historical payments rows, NEVER touches RMA, and NEVER bypasses the B.3.5
 * over-refund trigger.
 *
 * IDEMPOTENCY
 *  Dedupe key = `trid` (the fund movement id), recorded in the existing B.3.1
 *  provider_webhook_events ledger scoped by provider. A duplicate delivery is
 *  detected before any side effect and produces NO second transition, NO
 *  second email, NO second audit entry, NO second stock movement.
 *
 * CORRELATION
 *  Before confirming, the event must match the local attempt on provider,
 *  identifier/reference, method, currency and amount (integer cents).
 */

import { db } from "@/db";
import { paymentAttempts, refundAttempts } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { confirmOrderPayment } from "@/lib/orders";
import { createAuditLog } from "@/lib/audit";
import { ProviderError } from "@/lib/providers/errors";
import { EUPAGO_PROVIDER_ID, getEupagoWebhookKey } from "@/lib/providers/eupago/config";
import { verifyEupagoWebhook } from "@/lib/providers/eupago/webhook-crypto";
import { normalizeEupagoEvent, type NormalizedEupagoEvent } from "@/lib/providers/eupago/events";
import {
  claimWebhookEvent,
  markWebhookEventFailed,
  markWebhookEventIgnored,
  markWebhookEventProcessed,
  registerWebhookEvent,
} from "@/lib/providers/webhook-events";

export type SettlementOutcome =
  | "payment_confirmed"
  | "payment_attempt_updated"
  | "refund_settled"
  | "duplicate"
  | "ignored"
  | "mismatch";

export interface ProcessWebhookResult {
  readonly outcome: SettlementOutcome;
  readonly code?: string;
  readonly trid?: string;
}

export interface ProcessWebhookInput {
  /** Byte-exact raw body. MUST NOT be re-serialized before it reaches here. */
  readonly rawBody: string;
  /** Lower-cased header map. */
  readonly headers: Record<string, string>;
  readonly webhookKey?: string;
}

/**
 * Full inbound webhook pipeline: verify → normalize → dedupe → settle.
 *
 * Any verification failure throws ProviderError(WEBHOOK_INVALID) so the route
 * can answer 401/400 without leaking provider internals.
 */
export async function processEupagoWebhook(
  input: ProcessWebhookInput
): Promise<ProcessWebhookResult> {
  const key = input.webhookKey ?? getEupagoWebhookKey();

  // 1. Signature (and, only afterwards, decryption).
  const verified = await verifyEupagoWebhook(key, input.rawBody, input.headers);

  // 2. Structural/semantic normalization.
  const normalized = normalizeEupagoEvent(verified.payload);
  if (!normalized.ok) {
    throw new ProviderError("WEBHOOK_INVALID", {
      provider: EUPAGO_PROVIDER_ID,
      internalDetail: `normalization failed: ${normalized.code}`,
    });
  }
  const event = normalized.event;

  // 3. Dedupe on trid via the existing B.3.1 ledger (never a second ledger).
  //    The raw body is hashed, never stored.
  const registration = await registerWebhookEvent({
    provider: EUPAGO_PROVIDER_ID,
    providerEventId: event.trid,
    rawBody: input.rawBody,
    eventType: `${event.kind}.${event.status.toLowerCase()}`,
    metadata: { kind: event.kind, status: event.status },
  });

  if (registration.duplicate && registration.event.status === "processed") {
    return { outcome: "duplicate", trid: event.trid };
  }

  const claimed = await claimWebhookEvent(registration.event.id);
  if (!claimed) {
    // Already processing/processed elsewhere — a retry must not duplicate.
    return { outcome: "duplicate", trid: event.trid };
  }

  try {
    const result =
      event.kind === "refund" ? await settleRefundEvent(event) : await settlePaymentEvent(event);

    if (result.outcome === "ignored" || result.outcome === "mismatch") {
      await markWebhookEventIgnored(claimed.id, result.code);
    } else {
      await markWebhookEventProcessed(claimed.id);
    }
    return { ...result, trid: event.trid };
  } catch (e) {
    await markWebhookEventFailed(claimed.id, e);
    throw e;
  }
}

// ─── Payment movements ────────────────────────────────────

async function settlePaymentEvent(event: NormalizedEupagoEvent): Promise<ProcessWebhookResult> {
  const attempt = await correlateAttempt(event);
  if (!attempt) return { outcome: "mismatch", code: "ATTEMPT_NOT_FOUND" };

  // Strict correlation before ANY financial effect. When the provider supplies
  // both local correlation fields, they must both point to the SAME attempt;
  // never fall back from a mismatched identifier to a reference (or vice versa).
  if (event.identifier && attempt.providerIdentifier !== event.identifier) {
    return { outcome: "mismatch", code: "IDENTIFIER_MISMATCH" };
  }
  if (event.reference && attempt.providerReference !== event.reference) {
    return { outcome: "mismatch", code: "REFERENCE_MISMATCH" };
  }
  if (!event.method) return { outcome: "mismatch", code: "METHOD_MISSING" };
  if (attempt.method !== event.method) {
    return { outcome: "mismatch", code: "METHOD_MISMATCH" };
  }
  if (!event.currency || event.currency !== attempt.currency) {
    return { outcome: "mismatch", code: "CURRENCY_MISMATCH" };
  }

  if (event.status !== "Paid") {
    // Error / Cancel / Expired: record PROVIDER state only. No order
    // transition is invented — the order state machine stays authoritative.
    const providerStatus = event.status === "Expired" ? "expired" : event.status === "Cancel" ? "cancelled" : "failed";
    await db
      .update(paymentAttempts)
      .set({
        status: providerStatus,
        providerTransactionId: attempt.providerTransactionId ?? event.trid,
        failureReason: `PROVIDER_${event.status.toUpperCase()}`,
        completedAt: new Date(),
        recoveryState: null,
        updatedAt: new Date(),
      })
      .where(and(eq(paymentAttempts.id, attempt.id), eq(paymentAttempts.status, "pending")))
      .returning();
    return { outcome: "payment_attempt_updated", code: providerStatus };
  }

  // Paid: the amount must match EXACTLY, in integer cents.
  if (event.amountCents === null || event.amountCents !== attempt.amountCents) {
    return { outcome: "mismatch", code: "AMOUNT_MISMATCH" };
  }

  // Bind the settling fund movement to this attempt. The unique index on
  // (provider, provider_transaction_id) makes a cross-attempt reuse of the
  // same trid impossible.
  const [claimedAttempt] = await db
    .update(paymentAttempts)
    .set({
      status: "paid",
      providerTransactionId: event.trid,
      providerReference: attempt.providerReference ?? event.reference,
      completedAt: new Date(),
      recoveryState: null,
      operatorActionCode: null,
      updatedAt: new Date(),
    })
    .where(and(eq(paymentAttempts.id, attempt.id), eq(paymentAttempts.status, "pending")))
    .returning();

  if (!claimedAttempt) {
    // Another delivery already settled this attempt — idempotent no-op.
    return { outcome: "duplicate" };
  }

  // Centralized lifecycle — the ONLY way an order becomes paid. It handles
  // the transition, stock conversion, audit and deduplicated email itself.
  const confirmation = await confirmOrderPayment(attempt.orderId, null);
  if (!confirmation.success) {
    throw new ProviderError("PROVIDER_UNAVAILABLE", {
      provider: EUPAGO_PROVIDER_ID,
      internalDetail: `order confirmation failed: ${confirmation.error ?? "unknown"}`,
    });
  }

  return { outcome: "payment_confirmed" };
}

/**
 * Correlate a provider event to a local attempt.
 *
 * An identifier supplied by the provider is only trusted because it is matched
 * against a locally generated value; a reference is matched the same way.
 */
async function correlateAttempt(event: NormalizedEupagoEvent) {
  if (event.identifier) {
    const [row] = await db
      .select()
      .from(paymentAttempts)
      .where(
        and(
          eq(paymentAttempts.provider, EUPAGO_PROVIDER_ID),
          eq(paymentAttempts.providerIdentifier, event.identifier)
        )
      )
      .limit(1);
    if (row) return row;
  }
  if (event.reference) {
    const [row] = await db
      .select()
      .from(paymentAttempts)
      .where(
        and(
          eq(paymentAttempts.provider, EUPAGO_PROVIDER_ID),
          eq(paymentAttempts.providerReference, event.reference)
        )
      )
      .limit(1);
    if (row) return row;
  }
  return null;
}

// ─── Refund movements ─────────────────────────────────────

/**
 * Settle a refund movement against the EXISTING B.3.5 refund_attempts ledger.
 *
 * The refund event carries its OWN trid (dedupe key) plus originalTrid (the
 * payment movement). Correlation therefore goes:
 *   originalTrid → payment_attempt → order → pending refund_attempt.
 *
 * No payments row is rewritten, no order transition is performed, no stock or
 * RMA record is touched. Over-refund protection remains with the B.3.5
 * database trigger.
 */
async function settleRefundEvent(event: NormalizedEupagoEvent): Promise<ProcessWebhookResult> {
  const originalTrid = event.originalTrid!;

  const [paymentAttempt] = await db
    .select()
    .from(paymentAttempts)
    .where(
      and(
        eq(paymentAttempts.provider, EUPAGO_PROVIDER_ID),
        eq(paymentAttempts.providerTransactionId, originalTrid)
      )
    )
    .limit(1);
  if (!paymentAttempt) return { outcome: "mismatch", code: "ORIGINAL_PAYMENT_NOT_FOUND" };

  if (event.amountCents === null || event.amountCents <= 0) {
    return { outcome: "mismatch", code: "AMOUNT_MISSING" };
  }

  // Already settled by an earlier delivery of the SAME refund trid.
  const [alreadySettled] = await db
    .select({ id: refundAttempts.id })
    .from(refundAttempts)
    .where(
      and(eq(refundAttempts.provider, EUPAGO_PROVIDER_ID), eq(refundAttempts.providerRefundId, event.trid))
    )
    .limit(1);
  if (alreadySettled) return { outcome: "duplicate" };

  // Find the armed/submitted refund attempt this movement settles.
  const candidates = await db
    .select()
    .from(refundAttempts)
    .where(
      and(
        eq(refundAttempts.orderId, paymentAttempt.orderId),
        eq(refundAttempts.provider, EUPAGO_PROVIDER_ID),
        eq(refundAttempts.providerOriginalTransactionId, originalTrid)
      )
    )
    .orderBy(refundAttempts.id);

  const target = candidates.find(
    (r) =>
      (r.status === "pending" || r.status === "processing") &&
      r.amountCents === event.amountCents &&
      r.currency === event.currency
  );
  if (!target) return { outcome: "mismatch", code: "REFUND_ATTEMPT_NOT_FOUND" };

  // Conditional update = idempotent under concurrent deliveries. The B.3.5
  // balance trigger re-verifies the over-refund invariant on this UPDATE.
  const [settled] = await db
    .update(refundAttempts)
    .set({
      status: "succeeded",
      providerRefundId: event.trid,
      completedAt: new Date(),
      recoveryState: null,
      operatorActionCode: null,
      errorCode: null,
      errorMessage: null,
      updatedAt: new Date(),
    })
    .where(and(eq(refundAttempts.id, target.id), eq(refundAttempts.status, target.status)))
    .returning();

  if (!settled) return { outcome: "duplicate" };

  await createAuditLog({
    userId: null,
    action: "refund.provider_settled",
    entity: "refund",
    entityId: settled.id,
    details: {
      orderId: settled.orderId,
      provider: EUPAGO_PROVIDER_ID,
      amountCents: settled.amountCents,
      currency: settled.currency,
    },
  });

  return { outcome: "refund_settled" };
}
