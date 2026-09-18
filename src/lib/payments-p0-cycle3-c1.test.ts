/**
 * PAYMENT P0 (CYCLE 3) — C1: an authenticated `Paid` for a TERMINAL attempt.
 *
 * The scenario this suite exists for: the attempt is already terminal
 * (`expired` / `cancelled` / `failed`) when a valid `Paid` movement arrives for
 * it (same identifier, same amount, same currency, same method) — the provider
 * says the customer paid a reference it had already closed, or the CAS lost a
 * race. Before C1 that delivery correlated, failed the conditional write and was
 * answered as a silent `duplicate` (HTTP 200), so REAL MONEY was recorded nowhere.
 *
 * What is PROVEN here (not mocked):
 *   • the delivery ends `payment_anomaly` — never `processed`, never `duplicate`;
 *   • a durable `reconciliation_observations` row is written, OPEN, bound to the
 *     canonical payment and carrying the movement's own `trid`;
 *   • a financial audit row preserves provider, trid, attempt, previous state,
 *     amount, currency and the anomaly code;
 *   • the webhook event ends `anomaly` (terminal for the retry machinery);
 *   • NO order reactivation, NO payment confirmation, NO stock change, NO email,
 *     NO refund;
 *   • redelivering the same `Paid`/trid stays idempotent (one anomaly, one audit);
 *   • the same classification holds for every order-state variant
 *     (pending_payment / expired / cancelled / already paid by another payment);
 *   • two CONCURRENT `Paid` movements for one pending attempt settle exactly once.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import {
  auditLogs,
  emailNotifications,
  orderStatusHistory,
  orders,
  paymentAttempts,
  payments,
  products,
  providerWebhookEvents,
  reconciliationObservations,
  refundAttempts,
  stockMovements,
} from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";
import type { EupagoConfig } from "@/lib/providers/eupago/config";
import { createEupagoPayment } from "@/lib/services/eupago-payment-service";
import { processEupagoWebhook } from "@/lib/services/eupago-settlement-service";
import {
  TEST_WEBHOOK_KEY,
  cleanupByPrefix,
  createPendingOrder,
  paidWebhookPayload,
  resetEupagoLedgerSlice,
  signedWebhook,
  stubFetch,
  unique,
} from "@/test-support/fixtures";

const PREFIX = "P0C3";

const CONFIG: EupagoConfig = {
  environment: "sandbox",
  apiKey: "dummy-api-key",
  oauthClientId: "dummy-client-id",
  oauthClientSecret: "dummy-client-secret",
  webhookKey: TEST_WEBHOOK_KEY,
};

async function createAttempt(orderId: number, method: "mbway" | "multibanco" = "mbway", amountCents = 5000) {
  const providerResponse =
    method === "multibanco"
      ? { sucesso: true, estado: 0, referencia: `9${unique()}`.slice(0, 15), entidade: "12345" }
      : { transactionStatus: "Success", transactionID: `TX-${unique()}`, reference: `REF-${unique()}` };
  return createEupagoPayment({
    orderId,
    method,
    amountCents,
    config: CONFIG,
    customerPhone: "912345678",
    countryCode: "351",
    fetchImpl: stubFetch(providerResponse),
  });
}

/** Authenticated delivery of the SAME amount/currency/method as the attempt. */
async function deliverPaid(trid: string, identifier: string, method = "mbway") {
  return processEupagoWebhook(
    await signedWebhook(paidWebhookPayload({ trid, identifier, method }))
  );
}

async function deliverProviderStatus(trid: string, status: string, identifier: string, method = "mbway") {
  return processEupagoWebhook(
    await signedWebhook({ trid, status, identifier, method, amount: "50.00", currency: "EUR" })
  );
}

const attemptRow = async (id: number) =>
  (await db.select().from(paymentAttempts).where(eq(paymentAttempts.id, id)).limit(1))[0];
const orderRow = async (id: number) =>
  (await db.select().from(orders).where(eq(orders.id, id)).limit(1))[0];
const productRow = async (id: number) =>
  (await db.select().from(products).where(eq(products.id, id)).limit(1))[0];
const observationsFor = async (orderId: number) =>
  db.select().from(reconciliationObservations).where(eq(reconciliationObservations.orderId, orderId));
const anomalyAuditsFor = async (attemptId: number) =>
  db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, "payment.provider_anomaly_recorded"), eq(auditLogs.entityId, attemptId)));
const eventRow = async (trid: string) =>
  (
    await db
      .select()
      .from(providerWebhookEvents)
      .where(eq(providerWebhookEvents.providerEventId, trid))
      .limit(1)
  )[0];

/** Every "no side effect of a settlement" assertion in one place. */
async function expectNoSettlementSideEffects(orderId: number, productId: number, snapshot: Awaited<ReturnType<typeof noSideEffectSnapshot>>) {
  const product = await productRow(productId);
  expect(product.stock).toBe(snapshot.product.stock);
  expect(product.soldCount).toBe(snapshot.product.soldCount);
  expect(product.reservedStock).toBe(snapshot.product.reservedStock);

  const order = await orderRow(orderId);
  expect(order.status).toBe(snapshot.order.status);
  expect(order.paymentStatus).toBe(snapshot.order.paymentStatus);

  const paidPayments = (await db.select().from(payments).where(eq(payments.orderId, orderId))).filter(
    (row) => row.status === "paid"
  );
  expect(paidPayments).toHaveLength(snapshot.paidPayments);

  expect(
    await db.select().from(refundAttempts).where(eq(refundAttempts.orderId, orderId))
  ).toHaveLength(0);
  expect(
    await db
      .select()
      .from(stockMovements)
      .where(and(eq(stockMovements.referenceId, orderId), eq(stockMovements.type, "sale")))
  ).toHaveLength(snapshot.saleMovements);
  expect(
    await db
      .select()
      .from(emailNotifications)
      .where(and(eq(emailNotifications.referenceType, "order"), eq(emailNotifications.referenceId, orderId)))
  ).toHaveLength(snapshot.orderEmails);
  expect(
    await db.select().from(orderStatusHistory).where(eq(orderStatusHistory.orderId, orderId))
  ).toHaveLength(snapshot.historyRows);
}

async function noSideEffectSnapshot(orderId: number, productId: number) {
  return {
    product: await productRow(productId),
    order: await orderRow(orderId),
    paidPayments: (await db.select().from(payments).where(eq(payments.orderId, orderId))).filter(
      (row) => row.status === "paid"
    ).length,
    saleMovements: (
      await db
        .select()
        .from(stockMovements)
        .where(and(eq(stockMovements.referenceId, orderId), eq(stockMovements.type, "sale")))
    ).length,
    orderEmails: (
      await db
        .select()
        .from(emailNotifications)
        .where(and(eq(emailNotifications.referenceType, "order"), eq(emailNotifications.referenceId, orderId)))
    ).length,
    historyRows: (
      await db.select().from(orderStatusHistory).where(eq(orderStatusHistory.orderId, orderId))
    ).length,
  };
}

beforeEach(async () => {
  await cleanupByPrefix(PREFIX);
  await resetEupagoLedgerSlice();
});

afterEach(async () => {
  await cleanupByPrefix(PREFIX);
});

describe("C1 — authenticated Paid for a TERMINAL attempt", () => {
  it("pending → Expired → Paid: durable LATE_PAID anomaly, never a silent duplicate", async () => {
    const fixture = await createPendingOrder({ prefix: PREFIX });
    const created = await createAttempt(fixture.orderId);
    if (created.outcome !== "created") throw new Error(`attempt not created: ${created.outcome}`);
    const attempt = created.attempt;
    const identifier = attempt.providerIdentifier!;

    // The provider closes the attempt (the customer did not pay the reference).
    const closed = await deliverProviderStatus(`T-EXP-${unique()}`, "Expired", identifier);
    expect(closed.outcome).toBe("payment_attempt_updated");
    expect((await attemptRow(attempt.id)).status).toBe("expired");

    const snapshot = await noSideEffectSnapshot(fixture.orderId, fixture.productId);
    const paidTrid = `T-PAID-${unique()}`;

    // THEN the money arrives for the reference it had already closed.
    const result = await deliverPaid(paidTrid, identifier);
    expect(result.outcome).toBe("payment_anomaly");
    expect(result.code).toBe("LATE_PAID:ATTEMPT_EXPIRED");

    // ── durable anomaly, bound to the canonical payment and the real movement ──
    const anomalies = await observationsFor(fixture.orderId);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({
      anomalyCode: "LATE_PAID",
      status: "open",
      provider: "eupago",
      providerReference: paidTrid,
      paymentId: attempt.paymentId,
      orderId: fixture.orderId,
      recordedBy: null,
      observedPaidCents: 5000,
      currency: "EUR",
    });

    // ── audit preserves provider/trid/attempt/previous state/amount/currency ──
    const audits = await anomalyAuditsFor(attempt.id);
    expect(audits).toHaveLength(1);
    expect(audits[0].details).toMatchObject({
      orderId: fixture.orderId,
      paymentId: attempt.paymentId,
      provider: "eupago",
      trid: paidTrid,
      previousState: "expired",
      code: "LATE_PAID:ATTEMPT_EXPIRED",
      anomalyCode: "LATE_PAID",
      amountCents: 5000,
      currency: "EUR",
      settled: false,
    });

    // ── the event is NOT processed: it needs an operator ──
    const event = await eventRow(paidTrid);
    expect(event.status).toBe("anomaly");
    expect(String(event.metadata?.anomalyCode)).toContain("LATE_PAID");

    // ── nothing was settled, reactivated, discounted or refunded ──
    await expectNoSettlementSideEffects(fixture.orderId, fixture.productId, snapshot);
    expect((await attemptRow(attempt.id)).status).toBe("expired");

    // ── redelivery of the SAME Paid/trid is idempotent ──
    const replay = await deliverPaid(paidTrid, identifier);
    expect(replay.outcome).toBe("payment_anomaly");
    expect(replay.code).toBe("LATE_PAID:ATTEMPT_EXPIRED");
    expect(await observationsFor(fixture.orderId)).toHaveLength(1);
    expect(await anomalyAuditsFor(attempt.id)).toHaveLength(1);
    await expectNoSettlementSideEffects(fixture.orderId, fixture.productId, snapshot);
  });

  it("pending → Cancel / Error → Paid: the same durable anomaly classification", async () => {
    for (const [providerStatus, expectedState] of [
      ["Cancel", "cancelled"],
      ["Error", "failed"],
    ] as const) {
      const fixture = await createPendingOrder({ prefix: PREFIX });
      const created = await createAttempt(fixture.orderId);
      if (created.outcome !== "created") throw new Error("attempt not created");
      const identifier = created.attempt.providerIdentifier!;

      const closed = await deliverProviderStatus(`T-${providerStatus}-${unique()}`, providerStatus, identifier);
      expect(closed.outcome).toBe("payment_attempt_updated");
      expect((await attemptRow(created.attempt.id)).status).toBe(expectedState);

      const snapshot = await noSideEffectSnapshot(fixture.orderId, fixture.productId);
      const paidTrid = `T-PAID-${unique()}`;
      const result = await deliverPaid(paidTrid, identifier);

      // NEVER a silent duplicate: the money is recorded as an anomaly.
      expect(result.outcome).toBe("payment_anomaly");
      expect(result.code).toBe(`LATE_PAID:ATTEMPT_${expectedState.toUpperCase()}`);

      const anomalies = await observationsFor(fixture.orderId);
      expect(anomalies).toHaveLength(1);
      expect(anomalies[0]).toMatchObject({
        anomalyCode: "LATE_PAID",
        providerReference: paidTrid,
        paymentId: created.attempt.paymentId,
        status: "open",
      });
      expect((await eventRow(paidTrid)).status).toBe("anomaly");
      await expectNoSettlementSideEffects(fixture.orderId, fixture.productId, snapshot);
    }
  });

  it("attempt made terminal INTERNALLY (no provider status event): the CAS loser is classified, not duplicated", async () => {
    const fixture = await createPendingOrder({ prefix: PREFIX });
    const created = await createAttempt(fixture.orderId);
    if (created.outcome !== "created") throw new Error("attempt not created");
    const identifier = created.attempt.providerIdentifier!;

    // Simulate the internal terminal transition (operator/cron expiry): the
    // attempt is closed WITHOUT any provider delivery, so the arriving `Paid`
    // finds a row the CAS predicate can never match.
    await db
      .update(paymentAttempts)
      .set({
        status: "expired",
        completedAt: new Date(),
        operationRevision: sql`${paymentAttempts.operationRevision} + 1`,
      })
      .where(eq(paymentAttempts.id, created.attempt.id));

    const snapshot = await noSideEffectSnapshot(fixture.orderId, fixture.productId);
    const paidTrid = `T-INTERNAL-${unique()}`;
    const result = await deliverPaid(paidTrid, identifier);

    expect(result.outcome).toBe("payment_anomaly");
    expect(result.code).toBe("LATE_PAID:ATTEMPT_EXPIRED");
    const anomalies = await observationsFor(fixture.orderId);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({
      anomalyCode: "LATE_PAID",
      providerReference: paidTrid,
      paymentId: created.attempt.paymentId,
    });
    expect((await anomalyAuditsFor(created.attempt.id))[0].details).toMatchObject({
      previousState: "expired",
      trid: paidTrid,
      settled: false,
    });
    await expectNoSettlementSideEffects(fixture.orderId, fixture.productId, snapshot);
  });

  it("order expired / cancelled variants: LATE_PAID anomaly, order state untouched", async () => {
    for (const [status, paymentStatus] of [
      ["expired", "cancelled"],
      ["cancelled", "cancelled"],
    ] as const) {
      const fixture = await createPendingOrder({ prefix: PREFIX });
      const created = await createAttempt(fixture.orderId);
      if (created.outcome !== "created") throw new Error("attempt not created");
      const identifier = created.attempt.providerIdentifier!;

      await db.update(orders).set({ status, paymentStatus }).where(eq(orders.id, fixture.orderId));

      const snapshot = await noSideEffectSnapshot(fixture.orderId, fixture.productId);
      const paidTrid = `T-ORDER-${status}-${unique()}`;
      const result = await deliverPaid(paidTrid, identifier);

      expect(result.outcome).toBe("payment_anomaly");
      expect(result.code).toBe("LATE_PAID:ORDER_NOT_SETTLEABLE");

      const anomalies = await observationsFor(fixture.orderId);
      expect(anomalies).toHaveLength(1);
      expect(anomalies[0]).toMatchObject({
        anomalyCode: "LATE_PAID",
        providerReference: paidTrid,
        paymentId: created.attempt.paymentId,
        status: "open",
      });

      // The movement is preserved on the attempt, the order is NOT revived.
      const attemptAfter = await attemptRow(created.attempt.id);
      expect(attemptAfter.status).toBe("paid");
      expect(attemptAfter.providerTransactionId).toBe(paidTrid);
      expect((await orderRow(fixture.orderId))).toMatchObject({ status, paymentStatus });
      await expectNoSettlementSideEffects(fixture.orderId, fixture.productId, snapshot);
    }
  });

  it("order already paid by ANOTHER payment: DOUBLE_CHARGE anomaly, order not rewritten", async () => {
    const fixture = await createPendingOrder({ prefix: PREFIX });

    // Movement A settles the order through the real pipeline.
    const attemptA = await createAttempt(fixture.orderId, "mbway");
    if (attemptA.outcome !== "created") throw new Error("attempt A not created");
    const tridA = `T-A-${unique()}`;
    const settled = await deliverPaid(tridA, attemptA.attempt.providerIdentifier!);
    expect(settled.outcome).toBe("payment_confirmed");
    expect((await orderRow(fixture.orderId)).status).toBe("paid");

    // Movement B is a REAL second charge on a different canonical payment.
    const attemptB = await createAttempt(fixture.orderId, "multibanco");
    if (attemptB.outcome !== "created") throw new Error("attempt B not created");
    expect(attemptB.attempt.paymentId).not.toBe(attemptA.attempt.paymentId);

    const snapshot = await noSideEffectSnapshot(fixture.orderId, fixture.productId);
    const tridB = `T-B-${unique()}`;
    const second = await deliverPaid(tridB, attemptB.attempt.providerIdentifier!, "multibanco");

    expect(second.outcome).toBe("payment_anomaly");
    expect(second.code).toBe("DOUBLE_CHARGE:ORDER_ALREADY_SETTLED_BY_OTHER_MOVEMENT");

    const anomalies = await observationsFor(fixture.orderId);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({
      anomalyCode: "DOUBLE_CHARGE",
      providerReference: tridB,
      paymentId: attemptB.attempt.paymentId,
      status: "open",
    });

    // Exactly one canonical payment is paid, and it is A's.
    const paidPayments = (await db.select().from(payments).where(eq(payments.orderId, fixture.orderId))).filter(
      (row) => row.status === "paid"
    );
    expect(paidPayments).toHaveLength(1);
    expect(paidPayments[0].id).toBe(attemptA.attempt.paymentId);

    // B's movement is preserved as evidence (money is not lost).
    const attemptBAfter = await attemptRow(attemptB.attempt.id);
    expect(attemptBAfter.status).toBe("paid");
    expect(attemptBAfter.providerTransactionId).toBe(tridB);

    await expectNoSettlementSideEffects(fixture.orderId, fixture.productId, snapshot);
  });

  it("settled attempt: same trid → idempotent duplicate; different trid → anomaly", async () => {
    const fixture = await createPendingOrder({ prefix: PREFIX });
    const created = await createAttempt(fixture.orderId);
    if (created.outcome !== "created") throw new Error("attempt not created");
    const identifier = created.attempt.providerIdentifier!;
    const trid = `T-SETTLED-${unique()}`;

    const settled = await deliverPaid(trid, identifier);
    expect(settled.outcome).toBe("payment_confirmed");

    // (A) the SAME movement redelivered → legitimate idempotent duplicate.
    const replay = await deliverPaid(trid, identifier);
    expect(replay.outcome).toBe("duplicate");
    expect(await observationsFor(fixture.orderId)).toHaveLength(0);

    // (B) a DIFFERENT authenticated movement on the settled attempt → anomaly.
    const secondTrid = `T-SETTLED-2-${unique()}`;
    const snapshot = await noSideEffectSnapshot(fixture.orderId, fixture.productId);
    const second = await deliverPaid(secondTrid, identifier);
    expect(second.outcome).toBe("payment_anomaly");
    expect(second.code).toBe("PAYMENT_NOT_COHERENT:PROVIDER_TRANSACTION_CONFLICT");

    const anomalies = await observationsFor(fixture.orderId);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({
      anomalyCode: "PAYMENT_NOT_COHERENT",
      providerReference: secondTrid,
      paymentId: created.attempt.paymentId,
      status: "open",
    });
    await expectNoSettlementSideEffects(fixture.orderId, fixture.productId, snapshot);
  });

  it("two CONCURRENT Paid movements for one pending attempt: exactly one settles", async () => {
    const fixture = await createPendingOrder({ prefix: PREFIX });
    const created = await createAttempt(fixture.orderId);
    if (created.outcome !== "created") throw new Error("attempt not created");
    const identifier = created.attempt.providerIdentifier!;

    const tridFirst = `T-RACE-1-${unique()}`;
    const tridSecond = `T-RACE-2-${unique()}`;

    const [a, b] = await Promise.all([deliverPaid(tridFirst, identifier), deliverPaid(tridSecond, identifier)]);

    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(["payment_anomaly", "payment_confirmed"]);

    // Exactly one settlement: one paid canonical payment, one stock effect.
    const paidPayments = (await db.select().from(payments).where(eq(payments.orderId, fixture.orderId))).filter(
      (row) => row.status === "paid"
    );
    expect(paidPayments).toHaveLength(1);
    expect((await orderRow(fixture.orderId)).status).toBe("paid");

    // The loser's movement is preserved as an anomaly, never silently dropped.
    const anomalies = await observationsFor(fixture.orderId);
    expect(anomalies).toHaveLength(1);
    const loserTrid = a.outcome === "payment_anomaly" ? tridFirst : tridSecond;
    expect(anomalies[0]).toMatchObject({
      providerReference: loserTrid,
      status: "open",
    });
    expect(["PAYMENT_NOT_COHERENT", "LATE_PAID", "DOUBLE_CHARGE"]).toContain(anomalies[0].anomalyCode);

    const loserEvent = await eventRow(loserTrid);
    expect(loserEvent.status).toBe("anomaly");
  });
});
