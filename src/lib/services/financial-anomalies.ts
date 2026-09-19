/**
 * PAYMENT P0 (HIGH-1 / HIGH-2) — durable FINANCIAL ANOMALIES raised by settlement.
 *
 * Some authenticated `Paid` movements prove that money exists for an order that
 * the normal settlement path cannot liquidate coherently:
 *
 *   DOUBLE_CHARGE        a second movement was paid for an order that is ALREADY
 *                        settled (the customer was charged twice).
 *   LATE_PAID            money arrived after the reservation expired, after the
 *                        order was cancelled, or after the internal payment was
 *                        cancelled.
 *   PAYMENT_NOT_COHERENT the movement is real but its canonical `payments` row is
 *                        missing, cancelled or settled in a way that cannot be
 *                        reconciled with this attempt.
 *
 * DESIGN RULES (fail-closed, no silent loss of money)
 *   • The anomaly is written INSIDE the settlement transaction, so the evidence
 *     (movement id, amount, currency, canonical payment, order) commits together
 *     with the attempt update or not at all.
 *   • The event is NEVER marked `processed`: it is marked `anomaly`, which is
 *     terminal for the retry machinery (a redelivery of the same trid stays
 *     idempotent) but explicit for operators.
 *   • Nothing is auto-fixed here: the order is not revived, stock is not
 *     discounted, no refund is issued and no provider is called.
 *   • The anomaly keeps the CANONICAL PAYMENT visible, so a later refund stays
 *     bound to the right payment and therefore to the right `originalTrid`.
 *   • Deduplicated per OCCURRENCE, not per movement (C7): a redelivery of the
 *     SAME occurrence (same movement, same anomaly code, still open, written by
 *     the system) returns the existing row, while a NEW relevant anomaly for a
 *     movement whose previous observation is already RESOLVED — or was recorded
 *     by a human — is recorded as its own row instead of being swallowed by the
 *     (provider, provider_reference) unique index. See `recordSettlementAnomalyTx`.
 */

import { db } from "@/db";
import {
  orders,
  payments,
  reconciliationObservations,
  refundAttempts,
} from "@/db/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import type { DbOrTx } from "@/lib/stock-locks";
import { EUPAGO_PROVIDER_ID } from "@/lib/providers/eupago/config";

/** Anomaly codes produced by the settlement pipeline itself. */
export const SETTLEMENT_ANOMALY_CODES = [
  "DOUBLE_CHARGE",
  "LATE_PAID",
  "PAYMENT_NOT_COHERENT",
  /**
   * C2 — the same `trid` reappeared with a semantically different authenticated
   * payload: the previous conclusion is not interchangeable with this delivery.
   */
  "PROVIDER_EVENT_CONFLICT",
  /**
   * C3 — AUTHENTICATED movements that contradicted the local record and were
   * therefore never settled. The SPECIFIC contradiction is preserved (no generic
   * code) so the operator knows exactly what to verify, and the movement keeps
   * its `trid` as the observation reference.
   */
  "AMOUNT_MISMATCH",
  "CURRENCY_MISMATCH",
  "METHOD_MISMATCH",
  "METHOD_MISSING",
  "IDENTIFIER_MISMATCH",
  "REFERENCE_MISMATCH",
  "ATTEMPT_NOT_FOUND",
  "AMOUNT_MISSING",
  "REFUND_ATTEMPT_NOT_FOUND",
  "ORIGINAL_PAYMENT_NOT_FOUND",
] as const;
export type SettlementAnomalyCode = (typeof SETTLEMENT_ANOMALY_CODES)[number];

export interface RecordAnomalyInput {
  readonly orderId: number;
  /** Canonical payment the movement belongs to, when it is known. */
  readonly paymentId: number | null;
  readonly code: SettlementAnomalyCode;
  /** Amount the provider actually moved (integer cents); null when absent. */
  readonly amountCents: number | null;
  readonly currency: string | null;
  /** The fund movement id (`trid`) — never dropped, never truncated. */
  readonly movementId: string;
  readonly observedAt?: Date;
}

/** Internal authoritative snapshot at ingest time (operator context). */
async function internalFinancialState(
  tx: DbOrTx,
  orderId: number
): Promise<{ paidCents: number; refundedCents: number }> {
  const [paidRow] = await tx
    .select({ total: sql<number>`coalesce(sum((${payments.amount} * 100)::integer), 0)::int` })
    .from(payments)
    .where(and(eq(payments.orderId, orderId), eq(payments.status, "paid")));

  const [refundedRow] = await tx
    .select({ total: sql<number>`coalesce(sum(${refundAttempts.amountCents}), 0)::int` })
    .from(refundAttempts)
    .where(and(eq(refundAttempts.orderId, orderId), eq(refundAttempts.status, "succeeded")));

  return { paidCents: paidRow?.total ?? 0, refundedCents: refundedRow?.total ?? 0 };
}

/** Upper bound on occurrence suffixes tried for one movement (bounded work). */
const MAX_ANOMALY_OCCURRENCES = 5;

/**
 * Reference of the Nth occurrence of an anomaly for the same movement.
 *
 * Occurrence 1 keeps the movement id verbatim (the historical and documented
 * form: `provider_reference = trid`). A NEW occurrence of an anomaly for a
 * movement that already has a (resolved/human/other-code) observation is
 * recorded under `#2`, `#3`, … so the unique index can never silently swallow
 * it (C7).
 */
function occurrenceReference(base: string, occurrence: number): string {
  if (occurrence <= 1) return base;
  const suffix = `#${occurrence}`;
  return `${base.slice(0, Math.max(1, 255 - suffix.length))}${suffix}`;
}

/**
 * Is the persisted row the SAME anomaly occurrence as the one being recorded?
 *
 * Only an OPEN row written by the SYSTEM for the SAME order/payment with the
 * SAME code qualifies. A resolved row, a row with a different code and a row
 * ingested by a human (`recordedBy` set) are all DIFFERENT occurrences: the new
 * financial anomaly must be recorded instead of being absorbed by the old one.
 */
function isSameOccurrence(
  existing: typeof reconciliationObservations.$inferSelect,
  input: RecordAnomalyInput
): boolean {
  return (
    existing.status === "open" &&
    existing.recordedBy === null &&
    existing.anomalyCode === input.code &&
    existing.orderId === input.orderId &&
    existing.paymentId === (input.paymentId ?? null)
  );
}

/**
 * Write ONE durable anomaly for an authenticated money movement.
 *
 * Idempotent per OCCURRENCE (C7): a redelivery / concurrent delivery of the SAME
 * anomaly returns the existing row without writing a second one (the DB unique
 * index on (provider, provider_reference) arbitrates concurrent inserts, so the
 * insert is retried under the next occurrence suffix when needed). A NEW anomaly
 * for a movement whose previous observation is already resolved — or was written
 * by a human operator — is NOT swallowed: it is recorded as a distinct
 * occurrence (`#2`, `#3`, …) and therefore stays visible to the operator.
 *
 * Returns null only when the anomaly could not be recorded within the bounded
 * occurrence budget; the caller still marks the webhook event as anomalous, so
 * the delivery itself is never silently dropped.
 */
export async function recordSettlementAnomalyTx(
  tx: DbOrTx,
  input: RecordAnomalyInput
): Promise<typeof reconciliationObservations.$inferSelect | null> {
  const internal = await internalFinancialState(tx, input.orderId);
  const base = input.movementId.trim();
  if (base.length === 0 || base.length > 255) return null;

  for (let occurrence = 1; occurrence <= MAX_ANOMALY_OCCURRENCES; occurrence += 1) {
    const reference = occurrenceReference(base, occurrence);
    const inserted = await tx
      .insert(reconciliationObservations)
      .values({
        orderId: input.orderId,
        paymentId: input.paymentId,
        provider: EUPAGO_PROVIDER_ID,
        providerReference: reference,
        observedPaidCents: input.amountCents != null && input.amountCents > 0 ? input.amountCents : 0,
        observedRefundedCents: 0,
        currency: input.currency ?? "EUR",
        observedAt: input.observedAt ?? new Date(),
        expectedPaidCents: internal.paidCents,
        internalRefundedCents: internal.refundedCents,
        anomalyCode: input.code,
        status: "open",
        // System observation: there is no human operator behind a double charge.
        recordedBy: null,
      })
      .onConflictDoNothing({
        // The dedupe index is PARTIAL (`provider_reference IS NOT NULL`), so the
        // arbitration target has to carry the same predicate — inference without it
        // fails with 42P10 (which would surface as a 500 instead of an anomaly).
        target: [reconciliationObservations.provider, reconciliationObservations.providerReference],
        where: sql`provider_reference IS NOT NULL`,
      })
      .returning();

    if (inserted.length > 0) return inserted[0];

    // The reference is taken. Re-read it: same occurrence → idempotent return;
    // anything else → this movement needs its NEXT occurrence row.
    const [existing] = await tx
      .select()
      .from(reconciliationObservations)
      .where(
        and(
          eq(reconciliationObservations.provider, EUPAGO_PROVIDER_ID),
          eq(reconciliationObservations.providerReference, reference)
        )
      )
      .limit(1);
    if (existing && isSameOccurrence(existing, input)) return existing;
  }

  // Bounded budget exhausted (pathological same-movement churn): the caller
  // records the anomaly code on the webhook event and in the audit trail.
  return null;
}

export interface SettlementAnomalyView {
  readonly id: number;
  readonly code: string | null;
  readonly orderId: number;
  readonly orderNumber: string | null;
  readonly paymentId: number | null;
  readonly paymentProvider: string | null;
  readonly movementId: string | null;
  readonly observedPaidCents: number;
  readonly expectedPaidCents: number;
  readonly currency: string;
  readonly status: string;
  readonly createdAt: Date;
}

/**
 * Operational read model (manager+): every open anomaly raised by settlement,
 * with the canonical payment so an operator can refund/reconcile against the
 * RIGHT movement. No customer data, no recipients, no secrets.
 */
export async function listSettlementAnomalies(limit = 100): Promise<SettlementAnomalyView[]> {
  const rows = await db
    .select({
      id: reconciliationObservations.id,
      code: reconciliationObservations.anomalyCode,
      orderId: reconciliationObservations.orderId,
      orderNumber: orders.orderNumber,
      paymentId: reconciliationObservations.paymentId,
      paymentProvider: payments.provider,
      movementId: reconciliationObservations.providerReference,
      observedPaidCents: reconciliationObservations.observedPaidCents,
      expectedPaidCents: reconciliationObservations.expectedPaidCents,
      currency: reconciliationObservations.currency,
      status: reconciliationObservations.status,
      createdAt: reconciliationObservations.createdAt,
    })
    .from(reconciliationObservations)
    .leftJoin(orders, eq(orders.id, reconciliationObservations.orderId))
    .leftJoin(payments, eq(payments.id, reconciliationObservations.paymentId))
    .where(eq(reconciliationObservations.status, "open"))
    .orderBy(desc(reconciliationObservations.createdAt))
    .limit(Math.max(1, Math.min(limit, 200)));

  return rows;
}

/** Counters per anomaly code (operational dashboard). */
export async function settlementAnomalySummary(): Promise<Record<string, number>> {
  const rows = await db
    .select({
      code: reconciliationObservations.anomalyCode,
      count: sql<number>`count(*)::int`,
    })
    .from(reconciliationObservations)
    .where(eq(reconciliationObservations.status, "open"))
    .groupBy(reconciliationObservations.anomalyCode);

  const summary: Record<string, number> = {};
  for (const row of rows) {
    summary[row.code ?? "UNCLASSIFIED"] = row.count;
  }
  return summary;
}
