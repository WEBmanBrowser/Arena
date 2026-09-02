/**
 * B.3.5.2 — Safe recovery for future ignored Eupago refund webhooks.
 *
 * PROBLEM (audit-established)
 *  When a verified Eupago refund webhook is delivered BEFORE the local
 *  `refund_attempts` row exists, the existing B.3.5.1 settlement path cannot
 *  correlate it. The provider movement is recorded in
 *  `provider_webhook_events` and marked `ignored / REFUND_ATTEMPT_NOT_FOUND`,
 *  but the money has already moved on the provider side and the platform
 *  has no way to reflect that without operator intervention.
 *
 * NON-NEGOTIABLE HISTORICAL RULE
 *  Legacy events that do NOT contain the new trusted metadata fields
 *  (`originalTrid`, `amountCents`, `currency` written at verified ingestion)
 *  are operationally READ-ONLY. They MUST NOT become financially recoverable.
 *  This service refuses them with `LEGACY_EVENT_UNRECOVERABLE` /
 *  `MISSING_PERSISTED_METADATA` and the row remains visible in the B.4.2
 *  anomaly view.
 *
 * SCOPE
 *  This service:
 *   - correlates a TRUSTED persisted Eupago refund event to an EXISTING
 *     B.3.5 pending/processing `refund_attempt`;
 *   - performs the financial settlement (status → succeeded, providerRefundId
 *     bound) under the same B.3.5 atomic invariants used by the normal
 *     webhook path;
 *   - atomically marks the webhook event `processed` inside the SAME
 *     PostgreSQL transaction, so a crash mid-flight either commits BOTH the
 *     financial settlement and the webhook state, or commits neither.
 *
 *  This service NEVER:
 *   - creates a new `refund_attempt`;
 *   - infers missing `originalTrid` / `amountCents` / `currency` from
 *     anything other than the trusted persisted metadata;
 *   - rewrites `payments` rows;
 *   - mutates `orders.status`, stock, RMA or the payments ledger;
 *   - broadens the generic `claimWebhookEvent()` so arbitrary ignored
 *     events become recoverable.
 *
 * CONCURRENCY
 *  Two recovery requests for the same event: the second sees a status
 *  other than `ignored` (the event is now `processing` or `processed`),
 *  fails the claim, and returns the deterministic `already_processed` /
 *  `already_settled` / `conflict` outcome.
 *
 *  Recovery while a normal refund webhook for the SAME trid is redelivered:
 *  the unique index `(provider, provider_event_id)` blocks the second row;
 *  the existing settlement path's claim fails closed; the recovery settles
 *  at most once.
 */

import { db } from "@/db";
import {
  paymentAttempts,
  providerWebhookEvents,
  refundAttempts,
} from "@/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createAuditLog } from "@/lib/audit";
import { sanitizeErrorMessage } from "@/lib/providers/errors";
import { EUPAGO_PROVIDER_ID } from "@/lib/providers/eupago/config";
import type { WebhookEventRecord } from "@/lib/providers/webhook-events";

type RefundAttemptRow = typeof refundAttempts.$inferSelect;

/** Reasons a recovery is REJECTED before any state change. Sanitized and
 *  determinstic — these are the only codes the API may return. */
export type RecoveryRejectionCode =
  | "WEBHOOK_EVENT_NOT_FOUND"
  | "WRONG_PROVIDER"
  | "WRONG_STATUS"
  | "WRONG_LAST_ERROR"
  | "LEGACY_EVENT_UNRECOVERABLE"
  | "MISSING_PERSISTED_METADATA"
  | "MISSING_TRID"
  | "MISSING_ORIGINAL_TRID"
  | "MISSING_AMOUNT"
  | "MISSING_CURRENCY"
  | "INVALID_AMOUNT"
  | "INVALID_CURRENCY"
  | "ORIGINAL_PAYMENT_NOT_FOUND"
  | "REFUND_CANDIDATE_NOT_FOUND"
  | "ALREADY_PROCESSED"
  | "ALREADY_SETTLED"
  | "CONFLICT";

export type RecoveryOutcome =
  | { readonly outcome: "settled"; readonly refund: RefundAttemptRow; readonly webhookEvent: WebhookEventRecord }
  | { readonly outcome: "already_settled"; readonly refund: RefundAttemptRow; readonly webhookEvent: WebhookEventRecord }
  | { readonly outcome: "rejected"; readonly code: RecoveryRejectionCode; readonly message: string };

/** Metadata schema persisted at verified ingestion by eupago-settlement-service. */
interface PersistedTrustedMetadata {
  readonly kind?: unknown;
  readonly status?: unknown;
  readonly originalTrid?: unknown;
  readonly amountCents?: unknown;
  readonly currency?: unknown;
  readonly method?: unknown;
  readonly identifier?: unknown;
  readonly reference?: unknown;
  readonly entity?: unknown;
}

const REFUND_ATTEMPT_NOT_FOUND = "REFUND_ATTEMPT_NOT_FOUND";

function isSafePositiveIntegerCents(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

function isValidTridFormat(v: unknown): v is string {
  return typeof v === "string" && v.length >= 1 && v.length <= 64 && /^[A-Za-z0-9._:\-]+$/.test(v);
}

function isValidCurrency(v: unknown): v is string {
  return typeof v === "string" && /^[A-Z]{3}$/.test(v);
}

function fail(code: RecoveryRejectionCode, message: string): RecoveryOutcome {
  return { outcome: "rejected", code, message };
}

/**
 * Recover a single ignored Eupago refund event.
 *
 * This is the ONLY allowed path that turns an ignored
 * `REFUND_ATTEMPT_NOT_FOUND` event into a financial settlement. It refuses
 * any event that does not carry the new trusted metadata, and refuses any
 * event whose persisted values cannot pass the strictest fail-closed
 * correlation rules.
 *
 * The function returns a structured outcome — it never throws for an
 * eligible-but-rejected event. A thrown error means the call site is
 * broken (e.g. a non-positive webhook id).
 */
export async function recoverIgnoredEupagoRefund(input: {
  readonly webhookEventId: number;
  readonly actorId: number | null;
}): Promise<RecoveryOutcome> {
  if (!Number.isInteger(input.webhookEventId) || input.webhookEventId < 1) {
    throw new Error("INVALID_WEBHOOK_EVENT_ID");
  }

  // ─── 1. Fetch + read-only eligibility check ──────────────────
  const [event] = await db
    .select()
    .from(providerWebhookEvents)
    .where(eq(providerWebhookEvents.id, input.webhookEventId))
    .limit(1);
  if (!event) return fail("WEBHOOK_EVENT_NOT_FOUND", "Webhook event not found");
  if (event.provider !== EUPAGO_PROVIDER_ID) return fail("WRONG_PROVIDER", "Event is not from Eupago");
  if (event.status !== "ignored") {
    if (event.status === "processed") return fail("ALREADY_PROCESSED", "Event already processed");
    return fail("WRONG_STATUS", `Event status '${event.status}' is not eligible for recovery`);
  }
  if (event.lastError !== REFUND_ATTEMPT_NOT_FOUND) {
    return fail("WRONG_LAST_ERROR", `Event lastError '${event.lastError ?? ""}' is not eligible for recovery`);
  }
  if (!event.providerEventId || !isValidTridFormat(event.providerEventId)) {
    return fail("MISSING_TRID", "Event has no valid provider trid");
  }
  if (!event.metadata) {
    return fail("MISSING_PERSISTED_METADATA", "Event carries no persisted trusted metadata");
  }
  const meta = event.metadata as PersistedTrustedMetadata;
  if (meta.kind !== "refund") {
    return fail("LEGACY_EVENT_UNRECOVERABLE", "Event is not classified as refund");
  }
  if (typeof meta.status !== "string" || meta.status !== "Refund") {
    // Provider status is "Refund" (the movement type) — without it, we
    // cannot prove the trusted event was a refund movement.
    return fail("LEGACY_EVENT_UNRECOVERABLE", "Event status is not 'Refund'");
  }
  if (!isValidTridFormat(meta.originalTrid)) {
    return fail("MISSING_ORIGINAL_TRID", "Event metadata has no valid originalTrid");
  }
  if (!isSafePositiveIntegerCents(meta.amountCents)) {
    return fail("INVALID_AMOUNT", "Event metadata has no safe positive integer amountCents");
  }
  if (!isValidCurrency(meta.currency)) {
    return fail("INVALID_CURRENCY", "Event metadata has no canonical 3-letter currency");
  }

  const refundTrid = event.providerEventId;
  const originalTrid = meta.originalTrid;
  const amountCents = meta.amountCents;
  const currency = meta.currency;

  // ─── 2. Atomic claim + financial settlement + final state change ─
  //
  // A SINGLE PostgreSQL transaction performs:
  //   a) restricted claim of the ignored event → processing
  //      (the matching WHERE clause guarantees NO other event in the
  //      ignored/REFUND_ATTEMPT_NOT_FOUND/refund-shape set can be claimed
  //      by a concurrent recovery call);
  //   b) FOR UPDATE on the original payment attempt to serialize candidate
  //      correlation, exactly as B.3.5.1 requires;
  //   c) re-read of the matching refund candidates under that lock;
  //   d) conditional UPDATE of the chosen refund_attempt to `succeeded`
  //      (the B.3.5 balance trigger re-verifies the over-refund invariant);
  //   e) final transition of the webhook event to `processed` (or, when an
  //      already-settled financial record proves the same trid was settled
  //      previously, the same atomic transition to `processed`).
  //
  // If ANY step fails AFTER a successful claim, the entire transaction
  // ROLLS BACK — the event is left in its pre-recovery state and the
  // financial state is unchanged. To achieve that, every "rejection after
  // a successful claim" path throws a typed sentinel that the outer catch
  // maps to a deterministic code.
  type TxResult =
    | { kind: "settled"; row: RefundAttemptRow }
    | { kind: "already_settled"; row: RefundAttemptRow }
    | { kind: "rejected"; code: RecoveryRejectionCode };
  let txResult: TxResult | null = null;

  class RecoveryPreconditionError extends Error {
    constructor(public readonly code: RecoveryRejectionCode) {
      super(`recovery_precondition:${code}`);
      this.name = "RecoveryPreconditionError";
    }
  }

  try {
    txResult = await db.transaction<TxResult>(async (tx) => {
      // (a) Restricted, targeted claim. The WHERE clause is the explicit
      // B.3.5.2 contract: only ignored + REFUND_ATTEMPT_NOT_FOUND + refund
      // classification + provider=eupago are claimable. Generic inbound
      // claim semantics are unaffected.
      const [claimedEvent] = await tx
        .update(providerWebhookEvents)
        .set({
          status: "processing",
          attempts: sql`${providerWebhookEvents.attempts} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(providerWebhookEvents.id, input.webhookEventId),
            eq(providerWebhookEvents.provider, EUPAGO_PROVIDER_ID),
            eq(providerWebhookEvents.status, "ignored"),
            eq(providerWebhookEvents.lastError, REFUND_ATTEMPT_NOT_FOUND),
            eq(providerWebhookEvents.providerEventId, refundTrid)
          )
        )
        .returning();
      if (!claimedEvent) {
        // No rows matched → either another recovery already grabbed it, or
        // the event state changed since the read-only eligibility check.
        // The transaction has not mutated anything yet, so a normal return
        // commits a no-op.
        return { kind: "rejected", code: "ALREADY_PROCESSED" };
      }

      // From this point on, a rejection MUST roll back the claim we just
      // took. We surface it as a thrown sentinel that the outer catch maps
      // to a deterministic code.

      // ── (early) Already settled by an earlier delivery of the SAME trid ─
      // The unique index `refund_attempts_provider_refund_unique` makes
      // double-binding the same provider refund trid impossible, so this
      // SELECT is the deterministic proof. If found AND already succeeded,
      // we transition the event to `processed` in the SAME transaction
      // (the financial record already proves the provider movement was
      // settled — we just have to catch up the webhook state).
      const [existingSettled] = await tx
        .select()
        .from(refundAttempts)
        .where(
          and(
            eq(refundAttempts.provider, EUPAGO_PROVIDER_ID),
            eq(refundAttempts.providerRefundId, refundTrid)
          )
        )
        .limit(1);
      if (existingSettled) {
        if (existingSettled.status === "succeeded") {
          // Finalize the webhook state in the SAME transaction.
          await tx
            .update(providerWebhookEvents)
            .set({
              status: "processed",
              processedAt: new Date(),
              lastError: null,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(providerWebhookEvents.id, claimedEvent.id),
                eq(providerWebhookEvents.status, "processing")
              )
            );
          return { kind: "already_settled", row: existingSettled };
        }
        // Bound but not yet succeeded — never settle twice from this path.
        throw new RecoveryPreconditionError("CONFLICT");
      }

      // (b) Lock the original payment attempt.
      const [originalPayment] = await tx
        .select({ id: paymentAttempts.id, orderId: paymentAttempts.orderId })
        .from(paymentAttempts)
        .where(
          and(
            eq(paymentAttempts.provider, EUPAGO_PROVIDER_ID),
            eq(paymentAttempts.providerTransactionId, originalTrid)
          )
        )
        .limit(1);
      if (!originalPayment) {
        throw new RecoveryPreconditionError("ORIGINAL_PAYMENT_NOT_FOUND");
      }

      // (b.2) Acquire the row lock in a deterministic way.
      await tx
        .select({ id: paymentAttempts.id })
        .from(paymentAttempts)
        .where(eq(paymentAttempts.id, originalPayment.id))
        .for("update");

      // (c) Re-read candidates only after the payment lock is held.
      const candidates = await tx
        .select()
        .from(refundAttempts)
        .where(
          and(
            eq(refundAttempts.orderId, originalPayment.orderId),
            eq(refundAttempts.provider, EUPAGO_PROVIDER_ID),
            eq(refundAttempts.providerOriginalTransactionId, originalTrid),
            inArray(refundAttempts.status, ["pending", "processing"])
          )
        )
        .orderBy(refundAttempts.id);

      // FIFO with exact amount+currency match (same as B.3.5.1).
      const target = candidates.find(
        (r) => r.amountCents === amountCents && r.currency === currency
      );
      if (!target) {
        throw new RecoveryPreconditionError("REFUND_CANDIDATE_NOT_FOUND");
      }

      // (d) Conditional settlement. The B.3.5 balance trigger
      // `refund_attempts_balance_guard` re-verifies the over-refund invariant
      // on this UPDATE. The conditional WHERE additionally protects against
      // any state transition since the lock was acquired.
      const [updated] = await tx
        .update(refundAttempts)
        .set({
          status: "succeeded",
          providerRefundId: refundTrid,
          completedAt: new Date(),
          recoveryState: null,
          operatorActionCode: null,
          errorCode: null,
          errorMessage: null,
          updatedAt: new Date(),
        })
        .where(and(eq(refundAttempts.id, target.id), eq(refundAttempts.status, target.status)))
        .returning();

      if (!updated) {
        throw new RecoveryPreconditionError("CONFLICT");
      }

      // (e) Mark the webhook event processed in the SAME transaction.
      await tx
        .update(providerWebhookEvents)
        .set({
          status: "processed",
          processedAt: new Date(),
          lastError: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(providerWebhookEvents.id, claimedEvent.id),
            eq(providerWebhookEvents.status, "processing")
          )
        );

      return { kind: "settled", row: updated };
    });
  } catch (e) {
    if (e instanceof RecoveryPreconditionError) {
      // Post-claim preconditions failed — the claim was rolled back too.
      txResult = { kind: "rejected", code: e.code };
    } else {
      // Over-refund and any other DB-level guard fail-closed here — the
      // financial settlement and the webhook state transition roll back
      // TOGETHER. The event is left in its pre-recovery state.
      const sanitized = sanitizeErrorMessage(e);
      if (sanitized.includes("REFUND_EXCEEDS_REFUNDABLE_AMOUNT") || sanitized.includes("REFUND_CURRENCY_MISMATCH")) {
        txResult = { kind: "rejected", code: "REFUND_CANDIDATE_NOT_FOUND" };
      } else {
        // Unknown DB failure: do NOT mask it as success; bubble out as
        // the caller's responsibility. The transaction is already rolled
        // back; the event row is unchanged.
        throw e;
      }
    }
  }

  // Re-read the webhook row OUTSIDE the transaction so the response can
  // carry the current DB-visible state. This is non-authoritative for
  // atomicity — by construction, the success branch only returns when
  // BOTH the financial row and the webhook row were committed.
  if (txResult?.kind === "settled") {
    const settled = txResult.row;
    const [fresh] = await db
      .select()
      .from(providerWebhookEvents)
      .where(eq(providerWebhookEvents.id, input.webhookEventId))
      .limit(1);
    await createAuditLog({
      userId: input.actorId,
      action: "refund.recovery_settled",
      entity: "refund",
      entityId: settled.id,
      details: {
        orderId: settled.orderId,
        provider: EUPAGO_PROVIDER_ID,
        webhookEventId: input.webhookEventId,
        providerEventId: refundTrid,
        amountCents: settled.amountCents,
        currency: settled.currency,
      },
    });
    return {
      outcome: "settled",
      refund: settled,
      webhookEvent: fresh ?? event,
    };
  }

  if (txResult?.kind === "already_settled") {
    const alreadySettled = txResult.row;
    const [fresh] = await db
      .select()
      .from(providerWebhookEvents)
      .where(eq(providerWebhookEvents.id, input.webhookEventId))
      .limit(1);
    await createAuditLog({
      userId: input.actorId,
      action: "refund.recovery_already_settled",
      entity: "refund",
      entityId: alreadySettled.id,
      details: {
        orderId: alreadySettled.orderId,
        provider: EUPAGO_PROVIDER_ID,
        webhookEventId: input.webhookEventId,
        providerEventId: refundTrid,
        amountCents: alreadySettled.amountCents,
        currency: alreadySettled.currency,
      },
    });
    return {
      outcome: "already_settled",
      refund: alreadySettled,
      webhookEvent: fresh ?? event,
    };
  }

  // Transaction rolled back or a precondition was unmet — map the
  // diagnostic to a deterministic code and return.
  const code = (txResult && "code" in txResult ? txResult.code : null) ?? "CONFLICT";
  return fail(
    code,
    code === "ORIGINAL_PAYMENT_NOT_FOUND"
      ? "Original Eupago payment attempt is not present locally"
      : code === "REFUND_CANDIDATE_NOT_FOUND"
        ? "No matching local pending refund attempt — recovery refused"
        : code === "ALREADY_PROCESSED"
          ? "Event was already claimed by a concurrent recovery call"
          : code === "ALREADY_SETTLED"
            ? "Event was already settled"
            : code === "CONFLICT"
              ? "Recovery refused due to a concurrent state change"
              : "Recovery refused"
  );
}
