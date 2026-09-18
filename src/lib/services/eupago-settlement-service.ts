/**
 * PAYMENT P0 — Eupago webhook settlement (trusted provider events).
 *
 * ATOMICITY (item 10)
 *  ONE PostgreSQL transaction contains the ENTIRE settlement:
 *    webhook claim → attempt → payment → order → stock → history → financial
 *    audit → email outbox row → webhook `processed`.
 *  Either the money movement and every one of its consequences commit, or
 *  nothing does. A redelivery after a rollback therefore starts from a clean,
 *  consistent state instead of a half-settled one.
 *
 * NO EXTERNAL HTTP INSIDE THE TRANSACTION (item 11)
 *  No Eupago call, no Resend call and no Wintouch call happens inside the
 *  transaction. The notification is written as an outbox row INSIDE the
 *  transaction and dispatched only AFTER the commit succeeded.
 *
 * AUTHORITY
 *  The order transition is performed exclusively through the canonical
 *  centralized confirmation (`confirmOrderPaymentInTx`). This module never
 *  writes `orders.status`, never rewrites a settled `payments` row, never
 *  touches RMA, and never bypasses the B.3.5 over-refund trigger.
 *
 * IDEMPOTENCY
 *  Dedupe key = `trid` (the fund movement id) in the existing B.3.1 ledger.
 *  A duplicate delivery produces NO second transition, NO second email, NO
 *  second audit entry and NO second stock movement.
 */

import { db } from "@/db";
import { paymentAttempts, refundAttempts } from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { confirmOrderPaymentInTx } from "@/lib/orders";
import { createAuditLogTx } from "@/lib/audit";
import { ProviderError } from "@/lib/providers/errors";
import { EUPAGO_PROVIDER_ID } from "@/lib/providers/eupago/config";
import { resolveEupagoWebhookKey } from "@/lib/services/eupago-config-service";
import { verifyEupagoWebhook } from "@/lib/providers/eupago/webhook-crypto";
import { normalizeEupagoEvent, type NormalizedEupagoEvent } from "@/lib/providers/eupago/events";
import {
  claimWebhookEvent,
  deferWebhookEvent,
  markWebhookEventIgnored,
  markWebhookEventProcessed,
  recordWebhookDeliveryFailure,
  recoveryGrants,
  registerWebhookEvent,
} from "@/lib/providers/webhook-events";
import { dispatchEmailNotification } from "@/lib/email-outbox";
import type { DbOrTx } from "@/lib/stock-locks";

export type SettlementOutcome =
  | "payment_confirmed"
  | "payment_attempt_updated"
  | "refund_settled"
  | "duplicate"
  | "ignored"
  | "mismatch"
  /**
   * The delivery was authenticated but could not be correlated YET. It is parked
   * in the re-evaluable `pending` state (H2) instead of being terminally
   * ignored, and the provider's redelivery of the SAME trid re-evaluates it.
   */
  | "deferred";

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

interface SettlementStepResult {
  readonly outcome: SettlementOutcome;
  readonly code?: string;
  /** Outbox row to dispatch AFTER the transaction commits. */
  readonly notificationId?: number | null;
}

/**
 * B.3.5.2 — MINIMUM trusted metadata required for future refund recovery.
 * Every value comes from a field that already passed signature verification,
 * structural normalization and amount decoding — the provider's own statement,
 * never anything reconstructed from the application.
 *
 * PERSISTED:  kind, status, originalTrid, amountCents, currency, method.
 * NOT persisted: identifier / reference / entity (local-correlation fields are
 * not safe to expose in a provider-event row surfaced by the anomaly view) and
 * never the trid (it lives in `provider_webhook_events.provider_event_id`),
 * the raw body, headers, signature or any secret.
 */
function buildTrustedMetadata(event: NormalizedEupagoEvent): Record<string, string | number | boolean> {
  const meta: Record<string, string | number | boolean> = {
    kind: event.kind,
    status: event.status,
  };
  if (event.originalTrid) meta.originalTrid = event.originalTrid;
  if (typeof event.amountCents === "number" && Number.isSafeInteger(event.amountCents) && event.amountCents > 0) {
    meta.amountCents = event.amountCents;
  }
  if (event.currency) meta.currency = event.currency;
  if (event.method) meta.method = event.method;
  return meta;
}

/**
 * Full inbound webhook pipeline: verify → normalize → (one tx) claim → settle →
 * processed → (post-commit) notify.
 */
export async function processEupagoWebhook(
  input: ProcessWebhookInput
): Promise<ProcessWebhookResult> {
  const key = input.webhookKey ?? await resolveEupagoWebhookKey();

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

  // 3. Register the delivery (INSERT … ON CONFLICT → trid is the identity).
  const registration = await registerWebhookEvent({
    provider: EUPAGO_PROVIDER_ID,
    providerEventId: event.trid,
    rawBody: input.rawBody,
    eventType: `${event.kind}.${event.status.toLowerCase()}`,
    metadata: buildTrustedMetadata(event),
  });

  if (registration.duplicate && registration.event.status === "processed") {
    return { outcome: "duplicate", trid: event.trid };
  }

  try {
    // ── ONE transaction for claim + settlement + processed ──
    const committed = await db.transaction(async (tx) => {
      const claimed = await claimWebhookEvent(registration.event.id, {
        executor: tx,
        extraGrantedAttempts: recoveryGrants(registration.event),
      });
      if (!claimed) {
        return {
          outcome: registration.event.status === "processed" ? "duplicate" : "deferred",
          code: "CLAIM_BUDGET_EXHAUSTED",
          notificationId: null,
        } satisfies SettlementStepResult;
      }

      const settled =
        event.kind === "refund"
          ? await settleRefundEvent(tx, event)
          : await settlePaymentEvent(tx, event);

      if (settled.outcome === "ignored" || settled.outcome === "mismatch") {
        await markWebhookEventIgnored(claimed.id, settled.code, tx);
      } else if (settled.outcome === "deferred") {
        await deferWebhookEvent(claimed.id, settled.code ?? "DEFERRED", tx);
      } else {
        await markWebhookEventProcessed(claimed.id, tx);
      }
      return settled;
    });

    // ── POST-COMMIT ONLY (no HTTP inside the transaction) ──
    if (committed.notificationId != null) {
      await dispatchEmailNotification(committed.notificationId);
    }

    return { outcome: committed.outcome, code: committed.code, trid: event.trid };
  } catch (e) {
    // The transaction rolled back — including its claim. The delivery is
    // accounted for OUTSIDE the transaction so the capped retry budget reflects
    // reality (H3: an event whose budget ran out needs an explicit grant).
    await recordWebhookDeliveryFailure(registration.event.id, e).catch(() => undefined);
    throw e;
  }
}

// ─── Payment movements ────────────────────────────────────

async function settlePaymentEvent(tx: DbOrTx, event: NormalizedEupagoEvent): Promise<SettlementStepResult> {
  const correlated = await correlateAttempt(tx, event);
  if (!correlated) {
    // H2 — DECIDE BETWEEN "TERMINALLY IGNORED" AND "RE-EVALUABLE".
    //
    // An identifier is generated locally and COMMITTED before the create call is
    // issued, so an authenticated delivery carrying an identifier that matches
    // no local attempt is a definitive divergence (not ours) → ignored.
    //
    // A delivery that carries ONLY a Multibanco reference can legitimately
    // arrive BEFORE the create response has persisted that reference (the
    // attempt exists, its `provider_reference` is still NULL). That absence of
    // correlation is TRANSIENT, so the event is deferred rather than ignored;
    // the provider's redelivery of the same trid re-evaluates it against the
    // local state as it exists then. Nothing is created, nothing is called.
    if (event.identifier) return { outcome: "mismatch", code: "ATTEMPT_NOT_FOUND" };
    if (event.reference) return { outcome: "deferred", code: "DEFERRED_REFERENCE_NOT_YET_PERSISTED" };
    return { outcome: "mismatch", code: "ATTEMPT_NOT_FOUND" };
  }

  // Lock the correlated attempt: settlement serializes on it, and the revision
  // read below is the fencing value for the write.
  const [attempt] = await tx
    .select()
    .from(paymentAttempts)
    .where(eq(paymentAttempts.id, correlated.id))
    .limit(1)
    .for("update");
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
  if (attempt.method !== event.method) return { outcome: "mismatch", code: "METHOD_MISMATCH" };
  if (!event.currency || event.currency !== attempt.currency) {
    return { outcome: "mismatch", code: "CURRENCY_MISMATCH" };
  }

  if (event.status !== "Paid") {
    // Error / Cancel / Expired: record PROVIDER state only. No order transition
    // is invented — the order state machine stays authoritative.
    const providerStatus =
      event.status === "Expired" ? "expired" : event.status === "Cancel" ? "cancelled" : "failed";
    const [updated] = await tx
      .update(paymentAttempts)
      .set({
        status: providerStatus,
        providerTransactionId: attempt.providerTransactionId ?? event.trid,
        failureReason: `PROVIDER_${event.status.toUpperCase()}`,
        completedAt: new Date(),
        recoveryState: null,
        operationRevision: sql`${paymentAttempts.operationRevision} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(paymentAttempts.id, attempt.id),
          eq(paymentAttempts.status, "pending"),
          eq(paymentAttempts.operationRevision, attempt.operationRevision)
        )
      )
      .returning();

    if (!updated) {
      // Already settled by an earlier delivery / provider state already known.
      return { outcome: "duplicate" };
    }

    await createAuditLogTx(tx, {
      userId: null,
      action: "payment.provider_state_recorded",
      entity: "payment_attempt",
      entityId: updated.id,
      details: {
        orderId: updated.orderId,
        paymentId: updated.paymentId,
        provider: EUPAGO_PROVIDER_ID,
        providerStatus,
        trid: event.trid,
      },
    });
    return { outcome: "payment_attempt_updated", code: providerStatus };
  }

  // Paid: the amount must match EXACTLY, in integer cents.
  if (event.amountCents === null || event.amountCents !== attempt.amountCents) {
    return { outcome: "mismatch", code: "AMOUNT_MISMATCH" };
  }

  if (attempt.status === "paid") {
    // Same fund movement re-delivered after settlement → idempotent no-op.
    // A DIFFERENT trid on an already paid attempt cannot happen (unique
    // (provider, provider_transaction_id)) and is reported as a divergence.
    if (attempt.providerTransactionId === event.trid) return { outcome: "duplicate" };
    return { outcome: "mismatch", code: "PROVIDER_TRANSACTION_CONFLICT" };
  }

  // Fenced compare-and-swap: the attempt must still be `pending` AND still be at
  // the revision this delivery correlated against (item 16).
  const [claimedAttempt] = await tx
    .update(paymentAttempts)
    .set({
      status: "paid",
      providerTransactionId: event.trid,
      providerReference: attempt.providerReference ?? event.reference,
      completedAt: new Date(),
      recoveryState: null,
      operatorActionCode: null,
      operationRevision: sql`${paymentAttempts.operationRevision} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(paymentAttempts.id, attempt.id),
        eq(paymentAttempts.status, "pending"),
        eq(paymentAttempts.operationRevision, attempt.operationRevision)
      )
    )
    .returning();

  if (!claimedAttempt) {
    // Another delivery already settled this attempt — idempotent no-op.
    return { outcome: "duplicate" };
  }

  // Canonical, centralized confirmation — same transaction. It settles EXACTLY
  // the canonical payment of this attempt (never every pending payment row) and
  // writes its audit + outbox row here as well.
  const confirmation = await confirmOrderPaymentInTx(tx, {
    orderId: attempt.orderId,
    actorId: null,
    paymentId: attempt.paymentId,
    source: "provider_webhook",
  });

  // Financial audit INSIDE the transaction (item 21).
  await createAuditLogTx(tx, {
    userId: null,
    action: "payment.provider_settled",
    entity: "payment_attempt",
    entityId: claimedAttempt.id,
    details: {
      orderId: claimedAttempt.orderId,
      paymentId: attempt.paymentId,
      provider: EUPAGO_PROVIDER_ID,
      amountCents: claimedAttempt.amountCents,
      currency: claimedAttempt.currency,
      trid: event.trid,
      changed: confirmation.changed,
    },
  });

  return { outcome: "payment_confirmed", notificationId: confirmation.notificationId };
}

/**
 * Correlate a provider event to a local attempt.
 *
 * An identifier supplied by the provider is only trusted because it is matched
 * against a locally generated value; a reference is matched the same way.
 */
async function correlateAttempt(tx: DbOrTx, event: NormalizedEupagoEvent) {
  if (event.identifier) {
    const [row] = await tx
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
    const [row] = await tx
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
 * Correlation goes: originalTrid → payment_attempt → canonical payment →
 * matching refund_attempt of THAT payment. No payments row is rewritten, no
 * order transition is performed, no stock or RMA record is touched, and the
 * over-refund protection remains with the B.3.5 database trigger.
 */
async function settleRefundEvent(tx: DbOrTx, event: NormalizedEupagoEvent): Promise<SettlementStepResult> {
  const originalTrid = event.originalTrid!;

  const [paymentAttempt] = await tx
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
  const [alreadySettled] = await tx
    .select({ id: refundAttempts.id })
    .from(refundAttempts)
    .where(
      and(eq(refundAttempts.provider, EUPAGO_PROVIDER_ID), eq(refundAttempts.providerRefundId, event.trid))
    )
    .limit(1);
  if (alreadySettled) return { outcome: "duplicate" };

  // Serialize refund movement correlation per original payment. Without this
  // lock, two distinct equal movements can both choose the same oldest
  // candidate; the conditional-update loser would then be misclassified as a
  // duplicate instead of advancing to the next legitimate attempt.
  await tx
    .select({ id: paymentAttempts.id })
    .from(paymentAttempts)
    .where(eq(paymentAttempts.id, paymentAttempt.id))
    .for("update");

  // Re-read candidates AFTER acquiring the payment lock, restricted to the
  // CANONICAL payment of the settled attempt (item 23).
  const candidates = await tx
    .select()
    .from(refundAttempts)
    .where(
      and(
        eq(refundAttempts.orderId, paymentAttempt.orderId),
        eq(refundAttempts.provider, EUPAGO_PROVIDER_ID),
        eq(refundAttempts.providerOriginalTransactionId, originalTrid),
        paymentAttempt.paymentId != null
          ? eq(refundAttempts.paymentId, paymentAttempt.paymentId)
          : eq(refundAttempts.orderId, paymentAttempt.orderId)
      )
    )
    .orderBy(refundAttempts.id);

  const target = candidates.find(
    (r) =>
      (r.status === "pending" || r.status === "processing") &&
      r.amountCents === event.amountCents &&
      r.currency === event.currency
  );
  if (!target) return { outcome: "ignored", code: "REFUND_ATTEMPT_NOT_FOUND" };

  // The B.3.5 balance trigger re-verifies the over-refund invariant on this
  // UPDATE. The predicate also fences against unrelated state transitions.
  const [updated] = await tx
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

  if (!updated) return { outcome: "duplicate" };

  await createAuditLogTx(tx, {
    userId: null,
    action: "refund.provider_settled",
    entity: "refund",
    entityId: updated.id,
    details: {
      orderId: updated.orderId,
      paymentId: updated.paymentId,
      provider: EUPAGO_PROVIDER_ID,
      amountCents: updated.amountCents,
      currency: updated.currency,
      trid: event.trid,
      originalTrid,
    },
  });

  return { outcome: "refund_settled" };
}
