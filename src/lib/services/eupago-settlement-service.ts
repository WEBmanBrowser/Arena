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
  escalateWebhookEventConflict,
  getWebhookEvent,
  isAnomalyWebhookEvent,
  markWebhookEventAnomaly,
  markWebhookEventIgnored,
  markWebhookEventProcessed,
  recordWebhookDeliveryFailure,
  recoveryGrants,
  registerWebhookEvent,
} from "@/lib/providers/webhook-events";
import type { ConfirmPaymentIncoherenceCode } from "@/lib/orders";
import {
  recordSettlementAnomalyTx,
  type SettlementAnomalyCode,
} from "@/lib/services/financial-anomalies";
import { dispatchEmailNotification } from "@/lib/email-outbox";
import { assertEupagoLedgerReady } from "@/lib/services/eupago-ledger-service";
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
  | "deferred"
  /**
   * HIGH-1/HIGH-2 — the movement is REAL and was recorded (attempt paid + durable
   * anomaly), but it could not be settled coherently: a second charge for an
   * already settled order, money arriving after expiry/cancellation, or a
   * canonical payment that is missing/cancelled/incoherent. The event is NOT
   * `processed`, nothing is auto-fixed and an operator must reconcile or refund.
   */
  | "payment_anomaly";

/**
 * HIGH-1/HIGH-2 — how a refused (incoherent) settlement is classified for the
 * operator. The classification is DERIVED from the authoritative gate in
 * `confirmOrderPaymentInTx`; it never decides by itself.
 */
const INCOHERENCE_ANOMALY_CODE: Record<ConfirmPaymentIncoherenceCode, SettlementAnomalyCode> = {
  /** Money exists for an order with no payment row able to receive it. */
  PAYMENT_NOT_FOUND: "PAYMENT_NOT_COHERENT",
  /** The canonical payment is already paid: a second movement → double charge. */
  PAYMENT_ALREADY_SETTLED: "DOUBLE_CHARGE",
  /** Payment cancelled internally: the movement must be refunded/reconciled. */
  PAYMENT_CANCELLED: "LATE_PAID",
  /** Any other non-settleable payment state (failed/refunded/unknown). */
  PAYMENT_NOT_SETTLED: "PAYMENT_NOT_COHERENT",
  /** The ORDER was settled by a different payment/movement → double charge. */
  ORDER_ALREADY_SETTLED_BY_OTHER_MOVEMENT: "DOUBLE_CHARGE",
  /** Order expired/cancelled/refunded when the money arrived → late payment. */
  ORDER_NOT_SETTLEABLE: "LATE_PAID",
};

export interface ProcessWebhookResult {
  readonly outcome: SettlementOutcome;
  readonly code?: string;
  readonly trid?: string;
}

/**
 * C2 — fields of an authenticated payload that were PROVABLY different from the
 * payload of the same `trid` already on record. Only fields that are persisted
 * for the previous delivery are compared, so a conflict is only reported when it
 * is determinable from stored evidence.
 */
interface PayloadConflict {
  readonly fields: string[];
  readonly persistedEventType: string | null;
  readonly receivedEventType: string;
  readonly persistedAmountCents: number | null;
  readonly receivedAmountCents: number | null;
  readonly persistedCurrency: string | null;
  readonly receivedCurrency: string | null;
  readonly persistedMethod: string | null;
  readonly receivedMethod: string | null;
  readonly persistedOriginalTrid: string | null;
  readonly receivedOriginalTrid: string | null;
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

/** Anomaly code persisted on an event that already ended in an anomaly. */
function anomalyCodeOf(event: { metadata?: Record<string, string | number | boolean> | null; lastError?: string | null }): string {
  const stored = event.metadata?.anomalyCode;
  if (typeof stored === "string" && stored.length > 0) return stored;
  return event.lastError && event.lastError.length > 0 ? event.lastError : "PAYMENT_ANOMALY";
}

/**
 * C2 — compare an authenticated redelivery against the payload ALREADY ON RECORD
 * for the same `trid`.
 *
 * Only persisted, signature-verified fields are compared, and only when BOTH
 * sides carry a value: the comparison therefore never invents a divergence that
 * the stored evidence cannot prove. A byte-identical redelivery yields `null`.
 */
function describePayloadConflict(
  persisted: { eventType: string | null; metadata: Record<string, string | number | boolean> | null },
  event: NormalizedEupagoEvent
): PayloadConflict | null {
  const meta = persisted.metadata ?? {};
  const fields: string[] = [];

  const receivedEventType = `${event.kind}.${event.status.toLowerCase()}`;
  if (persisted.eventType && persisted.eventType !== receivedEventType) fields.push("event_type");

  const persistedAmountCents = typeof meta.amountCents === "number" ? meta.amountCents : null;
  if (persistedAmountCents !== null && event.amountCents !== null && persistedAmountCents !== event.amountCents) {
    fields.push("amount");
  }

  const persistedCurrency = typeof meta.currency === "string" ? meta.currency : null;
  if (persistedCurrency && event.currency && persistedCurrency !== event.currency) fields.push("currency");

  const persistedMethod = typeof meta.method === "string" ? meta.method : null;
  if (persistedMethod && event.method && persistedMethod !== event.method) fields.push("method");

  const persistedOriginalTrid = typeof meta.originalTrid === "string" ? meta.originalTrid : null;
  if (persistedOriginalTrid && event.originalTrid && persistedOriginalTrid !== event.originalTrid) {
    fields.push("original_trid");
  }

  if (fields.length === 0) return null;

  return {
    fields,
    persistedEventType: persisted.eventType ?? null,
    receivedEventType,
    persistedAmountCents,
    receivedAmountCents: event.amountCents,
    persistedCurrency,
    receivedCurrency: event.currency,
    persistedMethod,
    receivedMethod: event.method,
    persistedOriginalTrid,
    receivedOriginalTrid: event.originalTrid,
  };
}

/**
 * Deterministic fingerprint of ONE divergence between a concluded delivery and
 * its redelivery. Stored on the event row so a redelivery of the SAME divergent
 * payload is idempotent, while a DIFFERENT divergence is still recorded.
 */
function conflictFingerprint(conflict: PayloadConflict): string {
  return JSON.stringify([
    [...conflict.fields].sort(),
    conflict.receivedEventType,
    conflict.receivedAmountCents,
    conflict.receivedCurrency,
    conflict.receivedMethod,
    conflict.receivedOriginalTrid,
  ]).slice(0, 200);
}

/**
 * Best local candidate for a movement, used to keep a conflict ATTRIBUTED when
 * that is provable: first the attempt that already owns the `trid` (the settled
 * money record), then the ordinary identifier/reference correlation.
 */
async function findCandidateAttemptTx(tx: DbOrTx, event: NormalizedEupagoEvent) {
  const [byMovement] = await tx
    .select()
    .from(paymentAttempts)
    .where(
      and(
        eq(paymentAttempts.provider, EUPAGO_PROVIDER_ID),
        eq(paymentAttempts.providerTransactionId, event.trid)
      )
    )
    .limit(1);
  if (byMovement) return byMovement;
  return correlateAttempt(tx, event);
}

/**
 * Full inbound webhook pipeline: verify → normalize → (one tx) claim → settle →
 * processed → (post-commit) notify.
 */export async function processEupagoWebhook(
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

  // ── C2 — a CONCLUDED delivery must not silently change meaning. ──────────
  //
  // The `trid` is the delivery identity. When it is already on record AND the
  // previous delivery concluded financially (`processed` or `anomaly`), a
  // redelivery whose authenticated payload differs in a field we PERSISTED
  // (status/kind, amount, currency, method, original trid) is NOT the same
  // statement and can never be answered as a plain duplicate: that would hide a
  // divergence between what was concluded and what the provider now says.
  //
  // `ignored` deliveries are deliberately EXCLUDED: they concluded nothing about
  // money, and their re-evaluation paths (bounded budget grant / the audited
  // B.3.5.2 refund recovery) must keep working unchanged.
  if (
    registration.duplicate &&
    (registration.event.status === "processed" || isAnomalyWebhookEvent(registration.event))
  ) {
    const conflict = describePayloadConflict(registration.event, event);
    if (conflict) {
      const fingerprint = conflictFingerprint(conflict);
      const recorded =
        typeof registration.event.metadata?.eventConflict === "string"
          ? registration.event.metadata.eventConflict
          : null;
      if (recorded !== fingerprint) {
        return escalateConcludedConflict(registration.event, event, conflict, fingerprint);
      }
      // This exact divergence is already recorded: answer with the anomaly that
      // exists (never a plain duplicate, never a second anomaly row).
      return { outcome: "payment_anomaly", code: anomalyCodeOf(registration.event), trid: event.trid };
    }
  }

  if (registration.duplicate && registration.event.status === "processed") {
    return { outcome: "duplicate", trid: event.trid };
  }

  // A movement already recorded as a FINANCIAL ANOMALY is idempotent: the same
  // trid redelivered returns the same anomaly (never `processed`, never a second
  // anomaly row, never a second settlement attempt).
  if (registration.duplicate && isAnomalyWebhookEvent(registration.event)) {
    return {
      outcome: "payment_anomaly",
      code: typeof registration.event.metadata?.anomalyCode === "string" ? registration.event.metadata.anomalyCode : "PAYMENT_ANOMALY",
      trid: event.trid,
    };
  }

  try {
    // ── ONE transaction for claim + settlement + processed ──
    const committed = await db.transaction(async (tx) => {
      // L5 — the ledger rules of 0017 are enforced HERE too, not only on the
      // payment-creation path: without this gate a deployment whose migration is
      // missing would fail with a raw SQL error (unknown column/trigger) instead
      // of the explicit operational fail-closed error. Cached per isolate.
      await assertEupagoLedgerReady(tx);

      const claimed = await claimWebhookEvent(registration.event.id, {
        executor: tx,
        extraGrantedAttempts: recoveryGrants(registration.event),
      });
      if (!claimed) {
        // C8 — NEVER answer from the pre-claim snapshot: the delivery that won
        // the claim may have concluded the event while this one was waiting for
        // the row lock (or the budget may simply be exhausted). Re-read the row
        // that REALLY exists and answer coherently with it.
        const current = (await getWebhookEvent(registration.event.id, tx)) ?? registration.event;
        if (current.status === "processed") {
          return { outcome: "duplicate", code: "CONSUMED_BY_CONCURRENT_DELIVERY", notificationId: null } satisfies SettlementStepResult;
        }
        if (isAnomalyWebhookEvent(current)) {
          // Terminal for the retry machinery: the money evidence is already
          // recorded and only a human can resolve it.
          return {
            outcome: "payment_anomaly",
            code: anomalyCodeOf(current),
            notificationId: null,
          } satisfies SettlementStepResult;
        }
        if (current.status === "ignored") {
          // Already reasoned about and dismissed: answering `deferred` here would
          // make the provider retry a delivery we have concluded on.
          return { outcome: "mismatch", code: current.lastError ?? "IGNORED", notificationId: null } satisfies SettlementStepResult;
        }
        return { outcome: "deferred", code: "CLAIM_BUDGET_EXHAUSTED", notificationId: null } satisfies SettlementStepResult;
      }

      const settled =
        event.kind === "refund"
          ? await settleRefundEvent(tx, event)
          : await settlePaymentEvent(tx, event);

      if (settled.outcome === "ignored" || settled.outcome === "mismatch") {
        await markWebhookEventIgnored(claimed.id, settled.code, tx);
      } else if (settled.outcome === "deferred") {
        await deferWebhookEvent(claimed.id, settled.code ?? "DEFERRED", tx);
      } else if (settled.outcome === "payment_anomaly") {
        // HIGH-1/HIGH-2 — NEVER `processed` when money could not be settled
        // coherently: the event carries the anomaly code and stays outstanding
        // for the operator (the anomaly row itself is written in-tx above).
        await markWebhookEventAnomaly(claimed.id, settled.code ?? "PAYMENT_ANOMALY", tx);
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

/**
 * C2 — record a CONFLICT between a concluded delivery and its authenticated
 * redelivery, in ONE transaction: durable anomaly (when the movement can be
 * attributed to a local attempt/payment) + audit + event escalation.
 *
 * Nothing financial is settled, no stock moves, no order state changes, no
 * refund is issued and no provider is called. The original webhook evidence
 * (payload hash, event type, metadata, processed_at) is preserved — this is an
 * escalation, not a replay.
 */
async function escalateConcludedConflict(
  persisted: { id: number; eventType: string | null; metadata: Record<string, string | number | boolean> | null },
  event: NormalizedEupagoEvent,
  conflict: PayloadConflict,
  fingerprint: string
): Promise<ProcessWebhookResult> {
  const code = "PROVIDER_EVENT_CONFLICT" satisfies SettlementAnomalyCode;

  await db.transaction(async (tx) => {
    await assertEupagoLedgerReady(tx);

    // The conditional escalation is the arbitration point: only the delivery that
    // MOVES the event to `anomaly` for this fingerprint writes the evidence, so a
    // redelivery (or a concurrent twin) can never duplicate the anomaly/audit.
    const escalated = await escalateWebhookEventConflict(persisted.id, code, fingerprint, tx);
    if (!escalated) return;

    const candidate = await findCandidateAttemptTx(tx, event);
    const details = {
      provider: EUPAGO_PROVIDER_ID,
      trid: event.trid,
      code,
      anomalyCode: code,
      conflictFields: conflict.fields,
      persistedEventType: conflict.persistedEventType,
      receivedEventType: conflict.receivedEventType,
      persistedAmountCents: conflict.persistedAmountCents,
      receivedAmountCents: conflict.receivedAmountCents,
      persistedCurrency: conflict.persistedCurrency,
      receivedCurrency: conflict.receivedCurrency,
      persistedMethod: conflict.persistedMethod,
      receivedMethod: conflict.receivedMethod,
      persistedOriginalTrid: conflict.persistedOriginalTrid,
      receivedOriginalTrid: conflict.receivedOriginalTrid,
      settled: false,
    };

    if (candidate) {
      const anomaly = await recordSettlementAnomalyTx(tx, {
        orderId: candidate.orderId,
        paymentId: candidate.paymentId ?? null,
        code,
        amountCents: event.amountCents,
        currency: event.currency ?? candidate.currency,
        movementId: event.trid,
      });
      await createAuditLogTx(tx, {
        userId: null,
        action: "payment.provider_anomaly_recorded",
        entity: "payment_attempt",
        entityId: candidate.id,
        details: {
          ...details,
          orderId: candidate.orderId,
          paymentId: candidate.paymentId ?? null,
          attemptId: candidate.id,
          attemptState: candidate.status,
          anomalyId: anomaly?.id ?? null,
        },
      });
    } else {
      // No local candidate can be proven: the conflict is still recorded durably
      // (event + audit) instead of being acknowledged as a duplicate.
      await createAuditLogTx(tx, {
        userId: null,
        action: "payment.provider_event_conflict",
        entity: "provider_webhook_event",
        entityId: persisted.id,
        details: { ...details, attributed: false },
      });
    }

  });

  return { outcome: "payment_anomaly", code, trid: event.trid };
}

// ─── Payment movements ────────────────────────────────────

type PaymentAttemptRow = typeof paymentAttempts.$inferSelect;

/**
 * HIGH-1(c) — an authenticated movement that correlates to an attempt ALREADY
 * settled with a DIFFERENT trid is evidence of a second charge. It is recorded
 * durably (its own trid is kept outside the unique (provider, transaction)
 * constraint of the attempt row) and an operator must reconcile/refund it.
 */
async function recordSecondMovementTx(
  tx: DbOrTx,
  attempt: PaymentAttemptRow,
  event: NormalizedEupagoEvent
): Promise<SettlementStepResult> {
  const anomalyCode: SettlementAnomalyCode = "PAYMENT_NOT_COHERENT";
  const anomaly = await recordSettlementAnomalyTx(tx, {
    orderId: attempt.orderId,
    paymentId: attempt.paymentId ?? null,
    code: anomalyCode,
    amountCents: event.amountCents,
    currency: event.currency ?? attempt.currency,
    movementId: event.trid,
  });
  await createAuditLogTx(tx, {
    userId: null,
    action: "payment.provider_anomaly_recorded",
    entity: "payment_attempt",
    entityId: attempt.id,
    details: {
      orderId: attempt.orderId,
      paymentId: attempt.paymentId ?? null,
      provider: EUPAGO_PROVIDER_ID,
      amountCents: event.amountCents,
      currency: event.currency ?? attempt.currency,
      trid: event.trid,
      code: "PROVIDER_TRANSACTION_CONFLICT",
      anomalyCode,
      anomalyId: anomaly?.id ?? null,
      settledTrid: attempt.providerTransactionId,
      previousState: attempt.status,
      settled: true,
    },
  });
  return {
    outcome: "payment_anomaly",
    code: `${anomalyCode}:PROVIDER_TRANSACTION_CONFLICT`,
    notificationId: null,
  };
}

/**
 * C1 — classify an authenticated, amount-matched `Paid` movement against the
 * attempt state that REALLY exists, after the conditional write lost.
 *
 *   (A) settled with the SAME trid      → legitimate idempotent duplicate;
 *   (B) settled with a DIFFERENT trid   → second movement → financial anomaly;
 *   (C) terminal non-paid (expired / cancelled / failed) + authenticated `Paid`
 *       → money arrived for a movement the provider already closed → LATE_PAID
 *       anomaly, NEVER a silent duplicate (no reactivation, no stock, no refund);
 *   (D) anything else (still pending / unknown) → fail closed and let the
 *       provider's bounded retry re-evaluate; nothing is invented.
 *
 * The terminal case is also the deterministic CAS-loss case: `FOR UPDATE` means
 * a pending row cannot change underneath us, so a lost CAS can only mean the row
 * was NOT pending. The caller re-reads the row before calling this, so the
 * classification never relies on a stale snapshot.
 */
async function classifyPaidAgainstAttempt(
  tx: DbOrTx,
  attempt: PaymentAttemptRow,
  event: NormalizedEupagoEvent
): Promise<SettlementStepResult> {
  if (attempt.status === "paid") {
    if (attempt.providerTransactionId === event.trid) return { outcome: "duplicate" };
    return recordSecondMovementTx(tx, attempt, event);
  }

  if (attempt.status === "expired" || attempt.status === "cancelled" || attempt.status === "failed") {
    const reason = `LATE_PAID:ATTEMPT_${attempt.status.toUpperCase()}`;
    const anomaly = await recordSettlementAnomalyTx(tx, {
      orderId: attempt.orderId,
      paymentId: attempt.paymentId ?? null,
      code: "LATE_PAID",
      amountCents: event.amountCents,
      currency: event.currency ?? attempt.currency,
      movementId: event.trid,
    });
    await createAuditLogTx(tx, {
      userId: null,
      action: "payment.provider_anomaly_recorded",
      entity: "payment_attempt",
      entityId: attempt.id,
      details: {
        orderId: attempt.orderId,
        paymentId: attempt.paymentId ?? null,
        provider: EUPAGO_PROVIDER_ID,
        amountCents: event.amountCents,
        currency: event.currency ?? attempt.currency,
        trid: event.trid,
        code: reason,
        anomalyCode: "LATE_PAID",
        anomalyId: anomaly?.id ?? null,
        previousState: attempt.status,
        previouslyRecordedTrid: attempt.providerTransactionId,
        settled: false,
      },
    });
    return { outcome: "payment_anomaly", code: reason, notificationId: null };
  }

  return { outcome: "deferred", code: "ATTEMPT_STATE_UNSETTLED", notificationId: null };
}

/**
 * C3 — an AUTHENTICATED movement that claims money (a `Paid` payment or a refund
 * callback) but CONTRADICTS the local record. It is never settled, never
 * confirmed, never discounted and never refunded automatically; instead the
 * specific contradiction becomes a durable, auditable anomaly bound to the local
 * candidate so an operator can act on it.
 */
async function recordClaimedMovementConflictTx(
  tx: DbOrTx,
  attempt: PaymentAttemptRow,
  event: NormalizedEupagoEvent,
  reasonCode: SettlementAnomalyCode,
  candidateSource: string
): Promise<void> {
  const anomaly = await recordSettlementAnomalyTx(tx, {
    orderId: attempt.orderId,
    paymentId: attempt.paymentId ?? null,
    code: reasonCode,
    amountCents: event.amountCents,
    currency: event.currency ?? attempt.currency,
    movementId: event.trid,
  });
  await createAuditLogTx(tx, {
    userId: null,
    action: "payment.provider_anomaly_recorded",
    entity: "payment_attempt",
    entityId: attempt.id,
    details: {
      orderId: attempt.orderId,
      paymentId: attempt.paymentId ?? null,
      provider: EUPAGO_PROVIDER_ID,
      amountCents: event.amountCents,
      currency: event.currency ?? attempt.currency,
      trid: event.trid,
      code: reasonCode,
      anomalyCode: reasonCode,
      anomalyId: anomaly?.id ?? null,
      previousState: attempt.status,
      candidateSource,
      settled: false,
    },
  });
}

async function settlePaymentEvent(tx: DbOrTx, event: NormalizedEupagoEvent): Promise<SettlementStepResult> {
  // C3 — only a movement that CLAIMS MONEY can raise a financial anomaly. A
  // contradictory Expired/Cancel/Error carries no money and keeps its existing
  // (ignored/deferred) semantics.
  const claimsMoney = event.status === "Paid";

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
    // C3 — DEFINITIVE non-correlation of a money-claiming movement. There is no
    // local candidate to attribute a reconciliation row to (the observation table
    // requires an order), so the delivery is recorded durably in the AUDIT TRAIL
    // and stays visible through the existing operational surfaces (dashboard
    // `IGNORED_PAYMENT_WEBHOOK` + the admin webhook-anomaly list with the
    // `ignored_payment` filter). Nothing is created, nothing is called.
    const transientAbsence = !event.identifier && !!event.reference;
    if (claimsMoney && !transientAbsence) {
      await createAuditLogTx(tx, {
        userId: null,
        action: "payment.provider_unattributed_movement",
        entity: "provider_webhook_event",
        details: {
          provider: EUPAGO_PROVIDER_ID,
          trid: event.trid,
          amountCents: event.amountCents,
          currency: event.currency,
          method: event.method,
          identifier: event.identifier,
          reference: event.reference,
          reason: "ATTEMPT_NOT_FOUND",
          attributed: false,
          settled: false,
        },
      });
    }
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
  // C3 — every branch below refuses the settlement (no confirmation, no stock,
  // no refund, no `processed`). When the movement CLAIMS MONEY the refusal is
  // additionally made DURABLE as a reconciliation anomaly bound to this
  // candidate, so it cannot vanish as an `ignored` row with only a `lastError`.
  if (event.identifier && attempt.providerIdentifier !== event.identifier) {
    if (claimsMoney) await recordClaimedMovementConflictTx(tx, attempt, event, "IDENTIFIER_MISMATCH", "identifier");
    return { outcome: "mismatch", code: "IDENTIFIER_MISMATCH" };
  }
  if (event.reference && attempt.providerReference !== event.reference) {
    if (claimsMoney) await recordClaimedMovementConflictTx(tx, attempt, event, "REFERENCE_MISMATCH", "reference");
    return { outcome: "mismatch", code: "REFERENCE_MISMATCH" };
  }
  if (!event.method) {
    if (claimsMoney) await recordClaimedMovementConflictTx(tx, attempt, event, "METHOD_MISSING", "method");
    return { outcome: "mismatch", code: "METHOD_MISSING" };
  }
  if (attempt.method !== event.method) {
    if (claimsMoney) await recordClaimedMovementConflictTx(tx, attempt, event, "METHOD_MISMATCH", "method");
    return { outcome: "mismatch", code: "METHOD_MISMATCH" };
  }
  if (!event.currency || event.currency !== attempt.currency) {
    if (claimsMoney) await recordClaimedMovementConflictTx(tx, attempt, event, "CURRENCY_MISMATCH", "currency");
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
    if (claimsMoney) await recordClaimedMovementConflictTx(tx, attempt, event, "AMOUNT_MISMATCH", "amount");
    return { outcome: "mismatch", code: "AMOUNT_MISMATCH" };
  }

  // C1 — an attempt that is ALREADY settled (same trid → idempotent duplicate;
  // different trid → second movement) is classified before the CAS, and the CAS
  // loser is classified through the SAME function against the state it really
  // has. That is what makes "authenticated Paid for a terminal attempt" a
  // recorded anomaly instead of a silent duplicate.
  if (attempt.status !== "pending") {
    return classifyPaidAgainstAttempt(tx, attempt, event);
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
    // C1(D) — the CAS lost. NEVER assume another delivery settled this attempt:
    // re-read the row that really exists and classify the movement against THAT
    // state (same trid → duplicate; different trid → anomaly; terminal non-paid
    // + authenticated Paid → LATE_PAID anomaly; anything else → deferred).
    const [currentAttempt] = await tx
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.id, attempt.id))
      .limit(1);
    return classifyPaidAgainstAttempt(tx, currentAttempt ?? attempt, event);
  }

  // Canonical, centralized confirmation — same transaction. It settles EXACTLY
  // the canonical payment of this attempt (never every pending payment row) and
  // writes its audit + outbox row here as well.
  //
  // HIGH-1/HIGH-2 — FAIL-CLOSED: the confirmation refuses to write a partial
  // settlement. When it does, the movement is NOT discarded and this delivery is
  // NOT reported as processed: the attempt stays `paid` (evidence) and a durable
  // anomaly is opened for the operator, in the SAME transaction.
  const confirmation = await confirmOrderPaymentInTx(tx, {
    orderId: attempt.orderId,
    actorId: null,
    paymentId: attempt.paymentId,
    source: "provider_webhook",
    settlementMustBeCoherent: true,
  });

  if (confirmation.incoherence) {
    const anomalyCode = INCOHERENCE_ANOMALY_CODE[confirmation.incoherence.code];
    const anomaly = await recordSettlementAnomalyTx(tx, {
      orderId: claimedAttempt.orderId,
      paymentId: confirmation.incoherence.paymentId ?? attempt.paymentId ?? null,
      code: anomalyCode,
      amountCents: claimedAttempt.amountCents,
      currency: claimedAttempt.currency,
      movementId: event.trid,
    });

    // Auditable, in-tx: the money exists and needs reconciliation/refund.
    await createAuditLogTx(tx, {
      userId: null,
      action: "payment.provider_anomaly_recorded",
      entity: "payment_attempt",
      entityId: claimedAttempt.id,
      details: {
        orderId: claimedAttempt.orderId,
        paymentId: confirmation.incoherence.paymentId ?? attempt.paymentId ?? null,
        provider: EUPAGO_PROVIDER_ID,
        amountCents: claimedAttempt.amountCents,
        currency: claimedAttempt.currency,
        trid: event.trid,
        code: confirmation.incoherence.code,
        anomalyCode,
        anomalyId: anomaly?.id ?? null,
        detail: confirmation.incoherence.detail,
      },
    });

    return {
      outcome: "payment_anomaly",
      code: `${anomalyCode}:${confirmation.incoherence.code}`,
      notificationId: null,
    };
  }

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
  if (!paymentAttempt) {
    // C3 — a refund callback whose ORIGINAL movement is unknown cannot be
    // attributed to an order (the observation table requires one), so it is
    // recorded durably in the audit trail and stays visible through the existing
    // refund surfaces (dashboard refund mismatch counter + admin
    // `ignored_refund` webhook list). No money is moved.
    await createAuditLogTx(tx, {
      userId: null,
      action: "payment.provider_unattributed_movement",
      entity: "provider_webhook_event",
      details: {
        provider: EUPAGO_PROVIDER_ID,
        kind: "refund",
        trid: event.trid,
        originalTrid,
        amountCents: event.amountCents,
        currency: event.currency,
        reason: "ORIGINAL_PAYMENT_NOT_FOUND",
        attributed: false,
        settled: false,
      },
    });
    return { outcome: "mismatch", code: "ORIGINAL_PAYMENT_NOT_FOUND" };
  }

  if (event.amountCents === null || event.amountCents <= 0) {
    await recordClaimedMovementConflictTx(tx, paymentAttempt, event, "AMOUNT_MISSING", "original_trid");
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
  if (!target) {
    // C3 — an authenticated refund callback that correlates to a payment but to NO
    // matching refund attempt. Its durable anomaly keeps the refund VISIBLE for
    // the operator; the event itself stays `ignored / REFUND_ATTEMPT_NOT_FOUND`
    // because that state is exactly what the audited B.3.5.2 refund-recovery path
    // requires (no re-send, no auto-settlement).
    await recordClaimedMovementConflictTx(tx, paymentAttempt, event, "REFUND_ATTEMPT_NOT_FOUND", "original_trid");
    return { outcome: "ignored", code: "REFUND_ATTEMPT_NOT_FOUND" };
  }

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
