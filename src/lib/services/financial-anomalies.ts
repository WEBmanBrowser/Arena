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
 *   • Deduplicated by (provider, providerReference = trid): a redelivery of the
 *     same movement never creates a second anomaly row.
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
export const SETTLEMENT_ANOMALY_CODES = ["DOUBLE_CHARGE", "LATE_PAID", "PAYMENT_NOT_COHERENT"] as const;
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

/**
 * Write ONE durable anomaly for an authenticated money movement.
 *
 * Idempotent by (provider, trid): if the anomaly already exists the existing row
 * is returned instead of creating a duplicate (the DB also enforces this with a
 * unique index, so concurrent deliveries cannot double-record either).
 */
export async function recordSettlementAnomalyTx(
  tx: DbOrTx,
  input: RecordAnomalyInput
): Promise<typeof reconciliationObservations.$inferSelect | null> {
  const internal = await internalFinancialState(tx, input.orderId);
  const reference = input.movementId.trim();
  if (reference.length === 0 || reference.length > 255) return null;

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

  // Already recorded (redelivery / concurrent delivery) — never duplicate.
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
  return existing ?? null;
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
