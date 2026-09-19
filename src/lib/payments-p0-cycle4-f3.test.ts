/**
 * PAYMENT P0 (CYCLE 4) — F-3 · MEDIUM · insufficient financial evidence for a
 * `REFUNDED` resolution.
 *
 * THE FINDING
 *   `resolveReconciliationAnomaly` accepted `resolutionCode = "REFUNDED"` on the
 *   mere EXISTENCE of some `succeeded` refund attempt:
 *     • it selected only `{ id }` with `.limit(1)`, so `amountCents` was never
 *       looked at — a 1.00 refund "proved" a 50.00 divergence had been returned;
 *     • when the observation had `paymentId = NULL` the predicate became
 *       `undefined` and `and()` dropped it, silently degrading to an `orderId`
 *       fallback that accepts the refund of a DIFFERENT payment of the same order.
 *
 * THE FIX
 *   `REFUNDED` now requires `succeeded` refunds bound to the SAME `paymentId`,
 *   whose SUM covers `observedPaidCents` — the persisted amount of the money
 *   movement that raised the anomaly (`recordSettlementAnomalyTx` writes exactly
 *   that). Unattributable observations (`paymentId IS NULL`) and non-determinable
 *   amounts (`observedPaidCents <= 0`) FAIL CLOSED with `REFUND_EVIDENCE_REQUIRED`;
 *   there is no `orderId` fallback. The operator keeps `MANUALLY_RECONCILED` as
 *   the truthful escape hatch.
 *
 * WHY SUMMING SEVERAL REFUNDS IS SOUND (no double counting)
 *   `enforce_refund_balance()` (drizzle/0007) locks the payment row FOR UPDATE
 *   and bounds the COMMITTED refunds (`pending` + `processing` + `succeeded`) by
 *   the payment's paid amount, and `refund_attempts.idempotency_key` is UNIQUE —
 *   so every summed row is a distinct ledger entry and `SUM(succeeded)` can never
 *   exceed what was actually paid.
 *
 * NO MOCKS: every observation is written by the real production path
 * (`recordSettlementAnomalyTx` / `ingestReconciliationObservation`) and every
 * refund by the real ledger API (`requestRefund` with manual completion,
 * `markRefundFailed`, `cancelRefund`), so the database-level over-refund trigger
 * is exercised rather than bypassed. Concurrency (case 7) uses genuinely parallel
 * transactions on separate pool connections — the pattern already established by
 * `b35-refund-concurrency.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import {
  auditLogs,
  payments,
  reconciliationObservations,
  refundAttempts,
} from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { confirmOrderPayment } from "@/lib/orders";
import { ingestReconciliationObservation, resolveReconciliationAnomaly } from "@/lib/reconciliation";
import { cancelRefund, completeManualRefund, markRefundFailed, requestRefund } from "@/lib/refunds";
import { recordSettlementAnomalyTx } from "@/lib/services/financial-anomalies";
import { cleanupByPrefix, createPendingOrder, createUser, unique } from "@/test-support/fixtures";

const PREFIX = "P0C4F3";
/** The amount every fixture order is paid for, and the anomaly is about. */
const PAID_CENTS = 5000;

// ─── helpers ───────────────────────────────────────────────

/** `requestRefund` requires a stable operation identity: 8–128 chars, alnum start. */
const refundKey = () => `f3-${unique()}`;

/** Settle the fixture order so there is a canonical `paid` payment to refund. */
async function settleOrder(orderId: number) {
  const confirmed = await confirmOrderPayment(orderId, null, { source: "manual" });
  if (!confirmed.changed) throw new Error("test setup failed: order was not confirmed");
  const paid = (await db.select().from(payments).where(eq(payments.orderId, orderId))).filter(
    (row) => row.status === "paid"
  );
  if (paid.length === 0) throw new Error("test setup failed: no paid payment");
  // `loadPaidPayment` binds a manual refund to the paid payment with the LOWEST
  // id, which is the one `createPendingOrder` wrote.
  return paid.sort((a, b) => a.id - b.id)[0];
}

/** A CONCLUDED refund, through the real ledger API (never a raw insert). */
async function succeededRefund(orderId: number, amountCents: number, actorId: number) {
  const { refund } = await requestRefund({
    orderId,
    amountCents,
    idempotencyKey: refundKey(),
    requestedBy: actorId,
    provider: "manual",
    reason: "F-3 evidence fixture",
    manualCompletion: { externalReference: `EXT-${unique()}`, completedAt: new Date() },
  });
  if (refund.status !== "succeeded") throw new Error(`test setup failed: refund is ${refund.status}`);
  return refund;
}

/** A refund left in a NON-conclusive state, through the real ledger API. */
async function pendingRefund(orderId: number, amountCents: number, actorId: number) {
  const { refund } = await requestRefund({
    orderId,
    amountCents,
    idempotencyKey: refundKey(),
    requestedBy: actorId,
    provider: "manual",
    reason: "F-3 non-conclusive fixture",
  });
  if (refund.status !== "pending") throw new Error(`test setup failed: refund is ${refund.status}`);
  return refund;
}

/** An OPEN anomaly attributed to ONE payment, written by the settlement path. */
async function attributableAnomaly(orderId: number, paymentId: number, amountCents: number | null) {
  const observation = await recordSettlementAnomalyTx(db, {
    orderId,
    paymentId,
    code: amountCents == null ? "AMOUNT_MISSING" : "DOUBLE_CHARGE",
    amountCents,
    currency: "EUR",
    movementId: `T-F3-${unique()}`,
  });
  if (!observation) throw new Error("test setup failed: anomaly was not recorded");
  if (observation.status !== "open") throw new Error("test setup failed: anomaly is not open");
  return observation;
}

const observationRow = async (id: number) =>
  (await db.select().from(reconciliationObservations).where(eq(reconciliationObservations.id, id)).limit(1))[0];
const resolutionAuditsFor = async (observationId: number) =>
  db
    .select()
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.action, "reconciliation.anomaly_resolved"),
        eq(auditLogs.entityId, observationId)
      )
    );
const succeededCentsOn = async (paymentId: number) =>
  (
    await db
      .select()
      .from(refundAttempts)
      .where(and(eq(refundAttempts.paymentId, paymentId), eq(refundAttempts.status, "succeeded")))
  ).reduce((sum, row) => sum + row.amountCents, 0);

/** Run the factories in GENUINE parallel (separate pool connections). */
async function race<T>(factories: Array<() => Promise<T>>) {
  return Promise.all(
    factories.map(async (f) => {
      try {
        return { ok: true as const, value: await f() };
      } catch (e) {
        return { ok: false as const, error: e as { code?: string } };
      }
    })
  );
}

beforeEach(async () => {
  await cleanupByPrefix(PREFIX);
});
afterEach(async () => {
  await cleanupByPrefix(PREFIX);
});

// ─── F-3 ───────────────────────────────────────────────────

describe("F-3 — `REFUNDED` requires sufficient evidence on the right payment", () => {
  it("1. refuses a partial succeeded refund that does not cover the observed amount", async () => {
    const fixture = await createPendingOrder({ prefix: PREFIX, totalCents: PAID_CENTS });
    const resolver = await createUser(PREFIX, "manager");
    const paid = await settleOrder(fixture.orderId);
    const observation = await attributableAnomaly(fixture.orderId, paid.id, PAID_CENTS);

    // 1.00 concluded on the right payment — real money, but 49.00 short.
    await succeededRefund(fixture.orderId, 100, resolver.id);
    expect(await succeededCentsOn(paid.id)).toBe(100);

    await expect(
      resolveReconciliationAnomaly(observation.id, resolver.id, "Reembolso parcial confirmado.", "REFUNDED")
    ).rejects.toMatchObject({ code: "REFUND_EVIDENCE_REQUIRED" });

    // Nothing was concluded: the anomaly is still open and unresolved.
    const stillOpen = await observationRow(observation.id);
    expect(stillOpen.status).toBe("open");
    expect(stillOpen.resolutionCode).toBeNull();
    expect(stillOpen.resolvedBy).toBeNull();
    expect(await resolutionAuditsFor(observation.id)).toHaveLength(0);
  });

  it("2. accepts a single succeeded refund covering the whole observed amount", async () => {
    const fixture = await createPendingOrder({ prefix: PREFIX, totalCents: PAID_CENTS });
    const resolver = await createUser(PREFIX, "manager");
    const paid = await settleOrder(fixture.orderId);
    const observation = await attributableAnomaly(fixture.orderId, paid.id, PAID_CENTS);

    await succeededRefund(fixture.orderId, PAID_CENTS, resolver.id);
    expect(await succeededCentsOn(paid.id)).toBe(PAID_CENTS);

    const resolved = await resolveReconciliationAnomaly(
      observation.id,
      resolver.id,
      "Reembolso integral registado e concluído no ledger.",
      "REFUNDED"
    );

    expect(resolved.status).toBe("resolved");
    expect(resolved.resolutionCode).toBe("REFUNDED");
    expect(resolved.resolvedBy).toBe(resolver.id);
    expect(resolved.resolvedAt).toBeInstanceOf(Date);
    expect(await resolutionAuditsFor(observation.id)).toHaveLength(1);
  });

  it("3. accepts several partial succeeded refunds on the SAME payment whose sum covers it", async () => {
    const fixture = await createPendingOrder({ prefix: PREFIX, totalCents: PAID_CENTS });
    const resolver = await createUser(PREFIX, "manager");
    const paid = await settleOrder(fixture.orderId);
    const observation = await attributableAnomaly(fixture.orderId, paid.id, PAID_CENTS);

    // Two distinct ledger entries (unique idempotency keys), both concluded.
    await succeededRefund(fixture.orderId, 2000, resolver.id);
    await expect(
      resolveReconciliationAnomaly(observation.id, resolver.id, "Ainda só 20.00 devolvidos.", "REFUNDED")
    ).rejects.toMatchObject({ code: "REFUND_EVIDENCE_REQUIRED" });
    expect((await observationRow(observation.id)).status).toBe("open");

    await succeededRefund(fixture.orderId, 3000, resolver.id);
    expect(await succeededCentsOn(paid.id)).toBe(PAID_CENTS);

    const resolved = await resolveReconciliationAnomaly(
      observation.id,
      resolver.id,
      "Dois reembolsos parciais concluídos somam o valor integral.",
      "REFUNDED"
    );
    expect(resolved.resolutionCode).toBe("REFUNDED");
    expect(resolved.status).toBe("resolved");
  });

  it("4. refuses a sufficient refund that belongs to ANOTHER payment of the same order", async () => {
    const fixture = await createPendingOrder({ prefix: PREFIX, totalCents: PAID_CENTS });
    const resolver = await createUser(PREFIX, "manager");
    const firstPayment = await settleOrder(fixture.orderId);

    // A SECOND canonical paid payment on the same order (a second charge), with a
    // higher id — so `loadPaidPayment` keeps binding manual refunds to the first.
    const [secondPayment] = await db
      .insert(payments)
      .values({
        orderId: fixture.orderId,
        provider: "manual",
        method: "bank_transfer",
        amount: (PAID_CENTS / 100).toFixed(2),
        currency: "EUR",
        status: "paid",
      })
      .returning();
    expect(secondPayment.id).toBeGreaterThan(firstPayment.id);

    // The anomaly is about the SECOND payment…
    const observation = await attributableAnomaly(fixture.orderId, secondPayment.id, PAID_CENTS);
    // …but the concluded refund lands on the FIRST one.
    const refund = await succeededRefund(fixture.orderId, PAID_CENTS, resolver.id);
    expect(refund.paymentId).toBe(firstPayment.id);
    expect(await succeededCentsOn(firstPayment.id)).toBe(PAID_CENTS);
    expect(await succeededCentsOn(secondPayment.id)).toBe(0);

    // Enough money was returned on the order, yet NOT for this anomaly's payment:
    // the old `orderId` fallback would have accepted it.
    await expect(
      resolveReconciliationAnomaly(observation.id, resolver.id, "Reembolso feito noutro pagamento.", "REFUNDED")
    ).rejects.toMatchObject({ code: "REFUND_EVIDENCE_REQUIRED" });
    expect((await observationRow(observation.id)).status).toBe("open");

    // CONTROL — the gate discriminates by PAYMENT identity, not by amount: an
    // anomaly attributed to the payment that really holds the refund is accepted.
    const control = await attributableAnomaly(fixture.orderId, firstPayment.id, PAID_CENTS);
    const resolved = await resolveReconciliationAnomaly(
      control.id,
      resolver.id,
      "Reembolso integral confirmado no pagamento certo.",
      "REFUNDED"
    );
    expect(resolved.resolutionCode).toBe("REFUNDED");
  });

  it("5. never counts refunds that are not `succeeded`", async () => {
    const fixture = await createPendingOrder({ prefix: PREFIX, totalCents: PAID_CENTS });
    const resolver = await createUser(PREFIX, "manager");
    const paid = await settleOrder(fixture.orderId);
    const observation = await attributableAnomaly(fixture.orderId, paid.id, PAID_CENTS);

    // 90.00 of refund attempts exist on the right payment — none of them
    // CONCLUDED: 20.00 failed, 20.00 cancelled, 50.00 still pending.
    const failed = await pendingRefund(fixture.orderId, 2000, resolver.id);
    await markRefundFailed(failed.id, resolver.id, { code: "PROVIDER_REJECTED" });
    const cancelled = await pendingRefund(fixture.orderId, 2000, resolver.id);
    await cancelRefund(cancelled.id, resolver.id, "cliente desistiu");
    const stillPending = await pendingRefund(fixture.orderId, PAID_CENTS, resolver.id);

    const rows = await db
      .select()
      .from(refundAttempts)
      .where(eq(refundAttempts.paymentId, paid.id));
    expect(rows).toHaveLength(3);
    expect(rows.reduce((sum, row) => sum + row.amountCents, 0)).toBe(9000);
    expect(rows.map((row) => row.status).sort()).toEqual(["cancelled", "failed", "pending"]);
    expect(await succeededCentsOn(paid.id)).toBe(0);

    await expect(
      resolveReconciliationAnomaly(observation.id, resolver.id, "Há reembolsos em curso no ledger.", "REFUNDED")
    ).rejects.toMatchObject({ code: "REFUND_EVIDENCE_REQUIRED" });
    expect((await observationRow(observation.id)).status).toBe("open");

    // CONCLUDING the pending refund is the only thing that changes the answer:
    // same rows, same amounts — only the status moves to `succeeded`.
    await completeManualRefund({
      refundId: stillPending.id,
      externalReference: `EXT-${unique()}`,
      completedAt: new Date(),
      actorId: resolver.id,
    });
    expect(await succeededCentsOn(paid.id)).toBe(PAID_CENTS);

    const resolved = await resolveReconciliationAnomaly(
      observation.id,
      resolver.id,
      "Reembolso concluído no ledger: cobertura integral comprovada.",
      "REFUNDED"
    );
    expect(resolved.resolutionCode).toBe("REFUNDED");
    expect(resolved.status).toBe("resolved");
  });

  it("6. fails closed for an observation that cannot be attributed to a payment", async () => {
    const fixture = await createPendingOrder({ prefix: PREFIX, totalCents: PAID_CENTS });
    const resolver = await createUser(PREFIX, "manager");
    const paid = await settleOrder(fixture.orderId);

    // The ingest path NEVER writes a `paymentId`: this is the legacy/ambiguous row.
    const { observation } = await ingestReconciliationObservation({
      orderId: fixture.orderId,
      provider: "manual",
      providerReference: `REC-F3-${unique()}`,
      observedPaidCents: 0,
      observedRefundedCents: 0,
      currency: "EUR",
      observedAt: new Date(),
      recordedBy: resolver.id,
    });
    expect(observation.status).toBe("open");
    expect(observation.paymentId).toBeNull();

    // A fully concluded refund covering the order exists — and must NOT be
    // borrowed, because it cannot be proven to belong to this anomaly's money.
    await succeededRefund(fixture.orderId, PAID_CENTS, resolver.id);
    expect(await succeededCentsOn(paid.id)).toBe(PAID_CENTS);

    await expect(
      resolveReconciliationAnomaly(observation.id, resolver.id, "Reembolsado por fora, sem atribuição.", "REFUNDED")
    ).rejects.toMatchObject({ code: "REFUND_EVIDENCE_REQUIRED" });
    expect((await observationRow(observation.id)).status).toBe("open");

    // The operator's truthful escape hatch stays available.
    const resolved = await resolveReconciliationAnomaly(
      observation.id,
      resolver.id,
      "Confirmado com o extrato bancário; evidência automática não atribuível.",
      "MANUALLY_RECONCILED"
    );
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolutionCode).toBe("MANUALLY_RECONCILED");
  });

  it("6b. fails closed when the relevant amount is not determinable (observedPaidCents = 0)", async () => {
    const fixture = await createPendingOrder({ prefix: PREFIX, totalCents: PAID_CENTS });
    const resolver = await createUser(PREFIX, "manager");
    const paid = await settleOrder(fixture.orderId);

    // Attributable, but the movement carried NO amount → `observedPaidCents = 0`.
    const observation = await attributableAnomaly(fixture.orderId, paid.id, null);
    expect(observation.paymentId).toBe(paid.id);
    expect(observation.observedPaidCents).toBe(0);

    await succeededRefund(fixture.orderId, PAID_CENTS, resolver.id);

    // Coverage of "0 cents" would be vacuously true for ANY state, so the gate
    // refuses instead of inventing an amount.
    await expect(
      resolveReconciliationAnomaly(observation.id, resolver.id, "Montante do movimento desconhecido.", "REFUNDED")
    ).rejects.toMatchObject({ code: "REFUND_EVIDENCE_REQUIRED" });
    expect((await observationRow(observation.id)).status).toBe("open");
  });

  it("7. stays safe under genuinely concurrent resolution: one conclusion only", async () => {
    const fixture = await createPendingOrder({ prefix: PREFIX, totalCents: PAID_CENTS });
    const resolver = await createUser(PREFIX, "manager");
    const paid = await settleOrder(fixture.orderId);
    const observation = await attributableAnomaly(fixture.orderId, paid.id, PAID_CENTS);

    // The evidence is sufficient, so BOTH conclusions would be accepted on their
    // own: `REFUNDED` (money returned) and `FALSE_POSITIVE` (nothing to act on)
    // are incompatible statements about the same anomaly.
    await succeededRefund(fixture.orderId, PAID_CENTS, resolver.id);

    const results = await race([
      () => resolveReconciliationAnomaly(observation.id, resolver.id, "Reembolso integral no ledger.", "REFUNDED"),
      () => resolveReconciliationAnomaly(observation.id, resolver.id, "Observação duplicada, sem dinheiro.", "FALSE_POSITIVE"),
    ]);

    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    // The loser is refused by the state machine, never silently overwritten.
    expect(["OBSERVATION_NOT_OPEN", "OBSERVATION_STATE_CONFLICT"]).toContain(losers[0].error.code);

    // Exactly ONE conclusion persisted, and exactly one audit entry.
    const row = await observationRow(observation.id);
    expect(row.status).toBe("resolved");
    expect(["REFUNDED", "FALSE_POSITIVE"]).toContain(row.resolutionCode);
    expect(row.resolvedBy).toBe(resolver.id);
    const audits = await resolutionAuditsFor(observation.id);
    expect(audits).toHaveLength(1);
    expect(audits[0].details).toMatchObject({ resolutionCode: row.resolutionCode });
  });
});
