/**
 * PAYMENT P0 — financial anomalies raised by SETTLEMENT (HIGH-1 / HIGH-2), the
 * retryable deferred acknowledgement (HIGH-3) and the LOW hardening items that
 * make both safe (L1 grant atomicity, L2 unambiguous refund binding).
 *
 * The invariant under test everywhere: a REAL, authenticated money movement is
 * NEVER reported as `processed` when it could not be settled coherently. The
 * movement is preserved (attempt + trid + canonical payment) and a durable,
 * operator-visible anomaly is opened. Nothing is auto-fixed: no order revival, no
 * stock movement, no email, no refund.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/db";
import {
  auditLogs,
  emailNotifications,
  orders,
  orderItems,
  paymentAttempts,
  payments,
  products,
  providerWebhookEvents,
  reconciliationObservations,
  refundAttempts,
  stockMovements,
  users,
} from "@/db/schema";
import { and, eq, like } from "drizzle-orm";
import type { EupagoConfig } from "@/lib/providers/eupago/config";
import {
  DEFAULT_MAX_WEBHOOK_ATTEMPTS,
  getWebhookEvent,
  grantWebhookRecoveryBudget,
  recoveryGrants,
  MAX_RECOVERY_GRANTS,
} from "@/lib/providers/webhook-events";
import { providerWebhookEvents as pwe } from "@/db/schema";
import { createEupagoPayment, armPaymentAttempt } from "@/lib/services/eupago-payment-service";
import { processEupagoWebhook } from "@/lib/services/eupago-settlement-service";
import { armEupagoRefund } from "@/lib/services/eupago-refund-service";
import { listSettlementAnomalies, settlementAnomalySummary } from "@/lib/services/financial-anomalies";
import { POST as webhookPOST } from "@/app/api/webhooks/eupago/route";
import {
  cleanupByPrefix,
  createPendingOrder,
  resetEupagoLedgerSlice,
  signedWebhook,
  stubFetch,
  TEST_WEBHOOK_KEY,
  unique,
} from "@/test-support/fixtures";

const PREFIX = "P0ANOM";
const CONFIG: EupagoConfig = {
  environment: "sandbox",
  apiKey: "dummy-api-key",
  oauthClientId: "dummy-client-id",
  oauthClientSecret: "dummy-client-secret",
  webhookKey: TEST_WEBHOOK_KEY,
};

function paidPayload(overrides: Record<string, unknown> = {}) {
  return { status: "Paid", method: "mbway", amount: "50.00", currency: "EUR", ...overrides };
}

async function orderRow(orderId: number) {
  const [row] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  return row;
}

async function anomaliesFor(orderId: number) {
  return db
    .select()
    .from(reconciliationObservations)
    .where(eq(reconciliationObservations.orderId, orderId));
}

async function webhookEvent(trid: string) {
  const [row] = await db
    .select()
    .from(providerWebhookEvents)
    .where(eq(providerWebhookEvents.providerEventId, trid))
    .limit(1);
  return row;
}

async function productRow(productId: number) {
  const [row] = await db.select().from(products).where(eq(products.id, productId)).limit(1);
  return row;
}

async function soldMovements(orderId: number) {
  return db.select().from(stockMovements).where(eq(stockMovements.referenceId, orderId));
}

/** Create a paid Eupago attempt for the fixture order, through the real pipeline. */
async function createAttempt(orderId: number, method: "mbway" | "multibanco" = "mbway") {
  const providerResponse =
    method === "multibanco"
      ? { sucesso: true, estado: 0, referencia: `9${unique()}`.slice(0, 15), entidade: "12345" }
      : { transactionStatus: "Success", transactionID: `TX-${unique()}`, reference: `REF-${unique()}` };
  return createEupagoPayment({
    orderId,
    method,
    amountCents: 5000,
    config: CONFIG,
    customerPhone: "912345678",
    countryCode: "351",
    fetchImpl: stubFetch(providerResponse),
  });
}

beforeEach(async () => {
  await cleanupByPrefix(PREFIX);
  await resetEupagoLedgerSlice();
});
afterEach(async () => {
  await cleanupByPrefix(PREFIX);
  // Hygiene: this suite creates operator users for the refund/grant paths. They
  // are deleted AFTER the financial rows that reference them (cleanupByPrefix),
  // so a later file can never inherit a stale fixed user.
  await db.delete(users).where(like(users.email, `${PREFIX}-%`));
});

// ─── HIGH-1: second authenticated Paid for an already settled order ────────

describe("HIGH-1 — a second Paid movement never finishes as `processed`", () => {
  it("records DOUBLE_CHARGE when another movement already settled the order", async () => {
    const fixture = await createPendingOrder({ prefix: PREFIX });

    // Movement A settles the order.
    const attemptA = await createAttempt(fixture.orderId, "mbway");
    const tridA = `T-${unique()}`;
    const settled = await processEupagoWebhook(
      await signedWebhook(paidPayload({ trid: tridA, identifier: attemptA.attempt.providerIdentifier }))
    );
    expect(settled.outcome).toBe("payment_confirmed");
    expect((await orderRow(fixture.orderId)).status).toBe("paid");

    const stockAfterA = await productRow(fixture.productId);
    const movementsAfterA = await soldMovements(fixture.orderId);
    const emailsAfterA = await db
      .select()
      .from(emailNotifications)
      .where(and(eq(emailNotifications.referenceType, "order"), eq(emailNotifications.referenceId, fixture.orderId)));
    expect(emailsAfterA).toHaveLength(1);

    // Movement B is REAL and authenticated, on a DIFFERENT attempt of the same
    // order (a second charge the customer actually paid).
    const attemptB = await createAttempt(fixture.orderId, "multibanco");
    expect(attemptB.attempt.paymentId).not.toBe(attemptA.attempt.paymentId);

    const tridB = `T-${unique()}`;
    const second = await processEupagoWebhook(
      await signedWebhook(paidPayload({ trid: tridB, identifier: attemptB.attempt.providerIdentifier, method: "multibanco" }))
    );
    expect(second.outcome).toBe("payment_anomaly");
    expect(second.code).toBe("DOUBLE_CHARGE:ORDER_ALREADY_SETTLED_BY_OTHER_MOVEMENT");

    // The movement itself is preserved (money is not lost).
    const [attemptBRow] = await db.select().from(paymentAttempts).where(eq(paymentAttempts.id, attemptB.attempt.id)).limit(1);
    expect(attemptBRow.status).toBe("paid");
    expect(attemptBRow.providerTransactionId).toBe(tridB);

    // The order is NOT rewritten and the second canonical payment is NOT paid.
    expect((await orderRow(fixture.orderId)).status).toBe("paid");
    const paidPayments = (await db.select().from(payments).where(eq(payments.orderId, fixture.orderId))).filter(
      (row) => row.status === "paid"
    );
    expect(paidPayments).toHaveLength(1);
    expect(paidPayments[0].id).toBe(attemptA.attempt.paymentId);

    // Durable, linked anomaly: the operator sees the money and WHICH payment.
    const anomalies = await anomaliesFor(fixture.orderId);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({
      anomalyCode: "DOUBLE_CHARGE",
      status: "open",
      provider: "eupago",
      providerReference: tridB,
      paymentId: attemptB.attempt.paymentId,
      recordedBy: null,
    });

    // The webhook event is NOT `processed`.
    const event = await webhookEvent(tridB);
    expect(event.status).toBe("anomaly");
    expect(String(event.metadata?.anomalyCode)).toContain("DOUBLE_CHARGE");

    // The financial audit exists and carries the second trid.
    const audit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "payment.provider_anomaly_recorded"), eq(auditLogs.entityId, attemptB.attempt.id)));
    expect(audit).toHaveLength(1);
    expect(audit[0].details).toMatchObject({ trid: tridB, anomalyCode: "DOUBLE_CHARGE" });

    // No extra stock effect, no second email.
    const stockAfterB = await productRow(fixture.productId);
    expect(stockAfterB.stock).toBe(stockAfterA.stock);
    expect(stockAfterB.soldCount).toBe(stockAfterA.soldCount);
    expect(await soldMovements(fixture.orderId)).toHaveLength(movementsAfterA.length);
    const emailsAfterB = await db
      .select()
      .from(emailNotifications)
      .where(and(eq(emailNotifications.referenceType, "order"), eq(emailNotifications.referenceId, fixture.orderId)));
    expect(emailsAfterB).toHaveLength(1);

    // Redelivery of the SAME trid is idempotent: same outcome, same code, ONE
    // anomaly row, no second settlement attempt.
    const replay = await processEupagoWebhook(
      await signedWebhook(paidPayload({ trid: tridB, identifier: attemptB.attempt.providerIdentifier, method: "multibanco" }))
    );
    expect(replay.outcome).toBe("payment_anomaly");
    expect(replay.code).toBe("DOUBLE_CHARGE:ORDER_ALREADY_SETTLED_BY_OTHER_MOVEMENT");
    expect(await anomaliesFor(fixture.orderId)).toHaveLength(1);
    expect((await webhookEvent(tridB)).status).toBe("anomaly");
    expect(await soldMovements(fixture.orderId)).toHaveLength(movementsAfterA.length);

    // Operational read model: the potentially received money is visible with the
    // canonical payment it belongs to.
    const open = await listSettlementAnomalies(50);
    const visible = open.find((row) => row.orderId === fixture.orderId);
    expect(visible).toMatchObject({
      code: "DOUBLE_CHARGE",
      movementId: tridB,
      paymentId: attemptB.attempt.paymentId,
      orderId: fixture.orderId,
    });
    expect((await settlementAnomalySummary()).DOUBLE_CHARGE).toBeGreaterThanOrEqual(1);
  });

  it("records DOUBLE_CHARGE when two attempts share the SAME already-paid canonical payment", async () => {
    const fixture = await createPendingOrder({ prefix: PREFIX });

    // Two ATTEMPTS of the same logical payment can exist (a retried/duplicated
    // create that was persisted separately) while sharing ONE canonical payment.
    const attemptA = await createAttempt(fixture.orderId, "mbway");
    const [attemptB] = await db
      .insert(paymentAttempts)
      .values({
        orderId: fixture.orderId,
        paymentId: attemptA.attempt.paymentId,
        provider: "eupago",
        method: "mbway",
        status: "pending",
        amountCents: 5000,
        currency: "EUR",
        providerIdentifier: `MDT-${fixture.orderId}-${unique()}`,
        recoveryState: "requested",
      })
      .returning();
    expect(attemptB.paymentId).toBe(attemptA.attempt.paymentId);

    const tridA = `T-${unique()}`;
    expect(
      (await processEupagoWebhook(await signedWebhook(paidPayload({ trid: tridA, identifier: attemptA.attempt.providerIdentifier }))))
        .outcome
    ).toBe("payment_confirmed");

    const tridB = `T-${unique()}`;
    const second = await processEupagoWebhook(
      await signedWebhook(paidPayload({ trid: tridB, identifier: attemptB.providerIdentifier }))
    );
    expect(second).toMatchObject({ outcome: "payment_anomaly", code: "DOUBLE_CHARGE:ORDER_ALREADY_SETTLED_BY_OTHER_MOVEMENT" });

    const anomalies = await anomaliesFor(fixture.orderId);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({
      anomalyCode: "DOUBLE_CHARGE",
      providerReference: tridB,
      paymentId: attemptA.attempt.paymentId,
    });

    // Exactly ONE payment row is paid, and both movements keep their own trid.
    const movements = await db.select().from(paymentAttempts).where(eq(paymentAttempts.orderId, fixture.orderId));
    const paidTrids = movements.filter((row) => row.status === "paid").map((row) => row.providerTransactionId).sort();
    expect(paidTrids).toEqual([tridA, tridB].sort());
    expect((await webhookEvent(tridB)).status).toBe("anomaly");
  });
});

// ─── HIGH-2: LATE_PAID after reservation expiry / cancellation ─────────────

describe("HIGH-2 — a valid Paid that can no longer be settled is preserved", () => {
  it("records LATE_PAID for an expired order without touching stock", async () => {
    const fixture = await createPendingOrder({ prefix: PREFIX });
    const attempt = await createAttempt(fixture.orderId, "mbway");

    // The reservation expired while the attempt was still pending: the canonical
    // payment is cancelled and the order leaves the settleable states.
    await db
      .update(orders)
      .set({ status: "expired", paymentStatus: "cancelled", updatedAt: new Date() })
      .where(eq(orders.id, fixture.orderId));
    await db
      .update(payments)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(eq(payments.id, attempt.attempt.paymentId!));

    const before = await productRow(fixture.productId);
    const trid = `T-${unique()}`;
    const result = await processEupagoWebhook(
      await signedWebhook(paidPayload({ trid, identifier: attempt.attempt.providerIdentifier }))
    );

    // Never a technical error, never a silent success.
    expect(result.outcome).toBe("payment_anomaly");
    expect(result.code).toBe("LATE_PAID:ORDER_NOT_SETTLEABLE");

    // Durable evidence: the movement keeps its trid and its canonical payment.
    const [movement] = await db.select().from(paymentAttempts).where(eq(paymentAttempts.id, attempt.attempt.id)).limit(1);
    expect(movement.status).toBe("paid");
    expect(movement.providerTransactionId).toBe(trid);
    expect(movement.paymentId).toBe(attempt.attempt.paymentId);

    const anomalies = await anomaliesFor(fixture.orderId);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({
      anomalyCode: "LATE_PAID",
      providerReference: trid,
      paymentId: attempt.attempt.paymentId,
      status: "open",
    });

    // No order revival, no stock change, no email, no refund.
    expect(await orderRow(fixture.orderId)).toMatchObject({ status: "expired", paymentStatus: "cancelled" });
    const after = await productRow(fixture.productId);
    expect(after.stock).toBe(before.stock);
    expect(after.soldCount).toBe(before.soldCount);
    expect(after.reservedStock).toBe(before.reservedStock);
    expect((await db.select().from(refundAttempts).where(eq(refundAttempts.orderId, fixture.orderId)))).toHaveLength(0);
    expect(
      await db
        .select()
        .from(emailNotifications)
        .where(and(eq(emailNotifications.referenceType, "order"), eq(emailNotifications.referenceId, fixture.orderId)))
    ).toHaveLength(0);

    // The delivery is not `processed` and a redelivery stays idempotent.
    expect((await webhookEvent(trid)).status).toBe("anomaly");
    const replay = await processEupagoWebhook(
      await signedWebhook(paidPayload({ trid, identifier: attempt.attempt.providerIdentifier }))
    );
    expect(replay.outcome).toBe("payment_anomaly");
    expect(replay.code).toBe("LATE_PAID:ORDER_NOT_SETTLEABLE");
    expect(await anomaliesFor(fixture.orderId)).toHaveLength(1);

    // The SAFE LATER PATH keeps its evidence: the operator read model exposes the
    // canonical payment AND the movement id, so a refund/reconciliation can be
    // performed against the RIGHT payment without guessing…
    const visible = (await listSettlementAnomalies(50)).find((row) => row.orderId === fixture.orderId);
    expect(visible).toMatchObject({
      code: "LATE_PAID",
      paymentId: attempt.attempt.paymentId,
      movementId: trid,
    });
    expect(visible?.paymentProvider).toBe("eupago");

    // …and nothing refunds the money on its own: a provider refund is REFUSED
    // while the canonical payment is not settled (fail-closed), so no automatic
    // or blind refund can ever be issued from a LATE_PAID anomaly.
    const [admin] = await db
      .insert(users)
      .values({ email: `${PREFIX}-${unique()}@test.local`, password: "x", name: PREFIX, role: "admin" })
      .returning();
    const [refund] = await db
      .insert(refundAttempts)
      .values({
        orderId: fixture.orderId,
        paymentId: attempt.attempt.paymentId!,
        provider: "eupago",
        idempotencyKey: `LATE-${unique()}`,
        amountCents: 5000,
        currency: "EUR",
        status: "pending",
        reason: "LATE_PAID reconciliation",
        requestedBy: admin.id,
      })
      .returning();
    await expect(armEupagoRefund(refund.id)).rejects.toMatchObject({ code: "OPERATION_NOT_SUPPORTED" });
    const [storedRefund] = await db.select().from(refundAttempts).where(eq(refundAttempts.id, refund.id)).limit(1);
    expect(storedRefund.providerOriginalTransactionId).toBeNull();
  });

  it("records LATE_PAID when the internal payment was cancelled", async () => {
    const fixture = await createPendingOrder({ prefix: PREFIX });
    const attempt = await createAttempt(fixture.orderId, "mbway");

    await db
      .update(payments)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(eq(payments.id, attempt.attempt.paymentId!));

    const trid = `T-${unique()}`;
    const result = await processEupagoWebhook(
      await signedWebhook(paidPayload({ trid, identifier: attempt.attempt.providerIdentifier }))
    );
    expect(result.outcome).toBe("payment_anomaly");
    expect(result.code).toBe("LATE_PAID:PAYMENT_CANCELLED");

    const anomalies = await anomaliesFor(fixture.orderId);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({ anomalyCode: "LATE_PAID", paymentId: attempt.attempt.paymentId });

    // The order never became paid and the payment stayed cancelled.
    expect((await orderRow(fixture.orderId)).status).toBe("pending_payment");
    const [payment] = await db.select().from(payments).where(eq(payments.id, attempt.attempt.paymentId!)).limit(1);
    expect(payment.status).toBe("cancelled");
  });

  it("refuses to write anything when the settlement cannot be coherent", async () => {
    // Direct gate test: the confirmation entry point itself must leave NO partial
    // settlement behind — no order transition, no stock effect, no audit, no email
    // — and must say WHY (instead of throwing a technical error).
    const { confirmOrderPaymentInTx } = await import("@/lib/orders");
    const { db: database } = await import("@/db");

    // (a) An order with NO canonical payment row at all.
    const orphan = await createPendingOrder({ prefix: PREFIX, paymentMethod: "bank_transfer" });
    await database.delete(payments).where(eq(payments.orderId, orphan.orderId));
    const stockBefore = await productRow(orphan.productId);

    const refused = await database.transaction(async (tx) =>
      confirmOrderPaymentInTx(tx, {
        orderId: orphan.orderId,
        actorId: null,
        paymentId: null,
        source: "provider_webhook",
        settlementMustBeCoherent: true,
      })
    );
    expect(refused.changed).toBe(false);
    expect(refused.incoherence?.code).toBe("PAYMENT_NOT_FOUND");
    expect((await orderRow(orphan.orderId)).status).toBe("pending_payment");
    const stockAfter = await productRow(orphan.productId);
    expect(stockAfter.stock).toBe(stockBefore.stock);
    expect(stockAfter.soldCount).toBe(stockBefore.soldCount);
    expect(await soldMovements(orphan.orderId)).toHaveLength(0);
    expect(
      await db
        .select()
        .from(emailNotifications)
        .where(and(eq(emailNotifications.referenceType, "order"), eq(emailNotifications.referenceId, orphan.orderId)))
    ).toHaveLength(0);

    // (b) The canonical payment is already paid while the order is not: the
    // movement cannot be attached to it any more.
    const alreadyPaid = await createPendingOrder({ prefix: PREFIX });
    const [paidPayment] = await database
      .insert(payments)
      .values({
        orderId: alreadyPaid.orderId,
        provider: "eupago",
        method: "mbway",
        amount: "50.00",
        currency: "EUR",
        status: "paid",
        paidAt: new Date(),
      })
      .returning();
    const paidRefusal = await database.transaction(async (tx) =>
      confirmOrderPaymentInTx(tx, {
        orderId: alreadyPaid.orderId,
        actorId: null,
        paymentId: paidPayment.id,
        source: "provider_webhook",
        settlementMustBeCoherent: true,
      })
    );
    expect(paidRefusal.incoherence?.code).toBe("PAYMENT_ALREADY_SETTLED");
    expect((await orderRow(alreadyPaid.orderId)).status).toBe("pending_payment");

    // (c) An order that is not settleable at all (cancelled).
    const cancelled = await createPendingOrder({ prefix: PREFIX });
    await database
      .update(orders)
      .set({ status: "cancelled", paymentStatus: "cancelled", updatedAt: new Date() })
      .where(eq(orders.id, cancelled.orderId));
    const cancelledRefusal = await database.transaction(async (tx) =>
      confirmOrderPaymentInTx(tx, {
        orderId: cancelled.orderId,
        actorId: null,
        paymentId: null,
        source: "provider_webhook",
        settlementMustBeCoherent: true,
      })
    );
    expect(cancelledRefusal.incoherence?.code).toBe("ORDER_NOT_SETTLEABLE");
    const cancelledStock = await productRow(cancelled.productId);
    expect(cancelledStock.soldCount).toBe(stockBefore.soldCount);
    expect(await soldMovements(cancelled.orderId)).toHaveLength(0);

    // (c) Positive control: a first, coherent settlement succeeds. A NEW movement
    // addressing the settled order is then refused here, because at this layer the
    // movement can no longer be attributed. A REDELIVERY of the same movement
    // never reaches this point — the webhook pipeline answers it as `duplicate`
    // BEFORE the confirmation (proved at route level in the HIGH-3 suite), which
    // is what keeps the same-trid path idempotent.
    const control = await createPendingOrder({ prefix: PREFIX });
    const confirmation = await database.transaction(async (tx) =>
      confirmOrderPaymentInTx(tx, {
        orderId: control.orderId,
        actorId: null,
        paymentId: null,
        source: "provider_webhook",
        settlementMustBeCoherent: true,
      })
    );
    expect(confirmation.changed).toBe(true);
    expect(confirmation.incoherence).toBeNull();

    const repeat = await database.transaction(async (tx) =>
      confirmOrderPaymentInTx(tx, {
        orderId: control.orderId,
        actorId: null,
        paymentId: confirmation.paymentId,
        source: "provider_webhook",
        settlementMustBeCoherent: true,
      })
    );
    expect(repeat.changed).toBe(false);
    expect(repeat.incoherence?.code).toBe("ORDER_ALREADY_SETTLED_BY_OTHER_MOVEMENT");
    expect(repeat.paymentId).toBe(confirmation.paymentId);
  });

});
// ─── HIGH-3: the deferred answer must be RETRYABLE at the HTTP boundary ─────

describe("HIGH-3 — route-level: deferred is answered with a retryable status", () => {
  // The route resolves the webhook key from the (test) environment; every other
  // key in this suite is a dummy. Restored afterwards.
  const previousKey = process.env.EUPAGO_WEBHOOK_KEY;
  beforeEach(() => {
    process.env.EUPAGO_WEBHOOK_KEY = TEST_WEBHOOK_KEY;
  });
  afterEach(() => {
    if (previousKey === undefined) delete process.env.EUPAGO_WEBHOOK_KEY;
    else process.env.EUPAGO_WEBHOOK_KEY = previousKey;
  });

  async function postWebhook(payload: Record<string, unknown>) {
    const signed = await signedWebhook(payload);
    const request = new NextRequest("https://arena.test/api/webhooks/eupago", {
      method: "POST",
      headers: signed.headers,
      body: signed.rawBody,
    });
    return webhookPOST(request);
  }

  it("answers 503 + Retry-After for a deferred delivery and 200 once it settles", async () => {
    const fixture = await createPendingOrder({ prefix: PREFIX });
    const trid = `T-${unique()}`;
    const reference = `REF-${unique()}`;

    // 1. Early delivery: no reference persisted yet → DEFERRED → RETRYABLE.
    const early = await postWebhook(paidPayload({ trid, reference }));
    expect(early.status).toBe(503);
    expect(early.headers.get("retry-after")).toBe("60");
    expect(await early.json()).toMatchObject({ received: false, retry: true, outcome: "deferred" });

    const [pendingEvent] = await db
      .select()
      .from(pwe)
      .where(eq(pwe.providerEventId, trid))
      .limit(1);
    expect(pendingEvent.status).toBe("pending"); // re-evaluable, NOT `ignored`

    // 2. The local reference is persisted by the create response.
    await armPaymentAttempt({ orderId: fixture.orderId, method: "mbway", amountCents: 5000 });
    await db
      .update(paymentAttempts)
      .set({ providerReference: reference })
      .where(and(eq(paymentAttempts.orderId, fixture.orderId), eq(paymentAttempts.provider, "eupago")));

    // 3. The provider redelivers the SAME trid → settles exactly once, 200.
    const settled = await postWebhook(paidPayload({ trid, reference }));
    expect(settled.status).toBe(200);
    expect(await settled.json()).toMatchObject({ received: true, outcome: "payment_confirmed" });
    expect((await orderRow(fixture.orderId)).status).toBe("paid");

    // 4. A further redelivery is an acknowledged duplicate — never a second effect.
    const replay = await postWebhook(paidPayload({ trid, reference }));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ outcome: "duplicate" });

    const paidPayments = (await db.select().from(payments).where(eq(payments.orderId, fixture.orderId))).filter(
      (row) => row.status === "paid"
    );
    expect(paidPayments).toHaveLength(1);
  });

  it("keeps an unmatched IDENTIFIER terminal (no pointless retry storm)", async () => {
    await createPendingOrder({ prefix: PREFIX });
    const response = await postWebhook(paidPayload({ trid: `T-${unique()}`, identifier: `ID-${unique()}` }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ received: true, outcome: "mismatch" });
  });

  it("still rejects an unsigned delivery with 401", async () => {
    const request = new NextRequest("https://arena.test/api/webhooks/eupago", {
      method: "POST",
      headers: { "x-signature": "deadbeef" },
      body: JSON.stringify(paidPayload({ trid: `T-${unique()}` })),
    });
    const response = await webhookPOST(request);
    expect(response.status).toBe(401);
  });
});

// ─── L1: atomic, bounded recovery grants ──────────────────────────────────

describe("L1 — recovery grants stay bounded under concurrency", () => {
  async function exhaustedEvent(): Promise<{ eventId: number; trid: string }> {
    const fixture = await createPendingOrder({ prefix: PREFIX });
    const trid = `T-${unique()}`;
    void fixture;
    for (let index = 0; index < DEFAULT_MAX_WEBHOOK_ATTEMPTS; index += 1) {
      const result = await processEupagoWebhook(await signedWebhook(paidPayload({ trid, reference: `REF-${unique()}` })));
      expect(result.outcome).toBe("deferred");
    }
    const event = await webhookEvent(trid);
    return { eventId: event.id, trid };
  }

  it("never exceeds MAX_RECOVERY_GRANTS when grants race", async () => {
    const { eventId } = await exhaustedEvent();

    const results = await Promise.all([
      grantWebhookRecoveryBudget({ eventId }),
      grantWebhookRecoveryBudget({ eventId }),
      grantWebhookRecoveryBudget({ eventId }),
    ]);
    const granted = results.filter((result) => result.outcome === "granted").length;
    expect(granted).toBeLessThanOrEqual(MAX_RECOVERY_GRANTS);

    const stored = await getWebhookEvent(eventId);
    expect(recoveryGrants(stored!)).toBe(granted);
    expect(recoveryGrants(stored!)).toBeLessThanOrEqual(MAX_RECOVERY_GRANTS);

    // A subsequent grant can never push the counter past the ceiling.
    const after = await grantWebhookRecoveryBudget({ eventId });
    const final = await getWebhookEvent(eventId);
    expect(recoveryGrants(final!)).toBeLessThanOrEqual(MAX_RECOVERY_GRANTS);
    if (after.outcome === "rejected") expect(after.code).toBe("GRANT_LIMIT_REACHED");
  });

  it("refuses to grant a financially anomalous event", async () => {
    const fixture = await createPendingOrder({ prefix: PREFIX });
    const first = await createAttempt(fixture.orderId, "mbway");
    const tridA = `T-${unique()}`;
    await processEupagoWebhook(await signedWebhook(paidPayload({ trid: tridA, identifier: first.attempt.providerIdentifier })));

    const second = await createAttempt(fixture.orderId, "multibanco");
    const tridB = `T-${unique()}`;
    const anomalous = await processEupagoWebhook(
      await signedWebhook(paidPayload({ trid: tridB, identifier: second.attempt.providerIdentifier, method: "multibanco" }))
    );
    expect(anomalous.outcome).toBe("payment_anomaly");

    const event = await webhookEvent(tridB);
    // Even after the (unnecessary) budget is exhausted, a grant is refused: the
    // money needs an operator, not another replay.
    await db
      .update(providerWebhookEvents)
      .set({ attempts: DEFAULT_MAX_WEBHOOK_ATTEMPTS })
      .where(eq(providerWebhookEvents.id, event.id));
    const refused = await grantWebhookRecoveryBudget({ eventId: event.id });
    expect(refused.outcome).toBe("rejected");
    if (refused.outcome !== "rejected") return;
    expect(refused.code).toBe("EVENT_FINANCIAL_ANOMALY");

    // And it is never listed as retryable either (L6).
    const { isRetryable, listRetryableWebhookEvents } = await import("@/lib/providers/webhook-events");
    const [row] = await db.select().from(providerWebhookEvents).where(eq(providerWebhookEvents.id, event.id)).limit(1);
    expect(isRetryable(row)).toBe(false);
    expect((await listRetryableWebhookEvents("eupago")).some((candidate) => candidate.id === event.id)).toBe(false);
  });
});

// ─── L2: unambiguous refund binding ───────────────────────────────────────

describe("L2 — refund binding refuses to guess between two settled movements", () => {
  async function refundFixture() {
    const fixture = await createPendingOrder({ prefix: PREFIX });
    const attempt = await createAttempt(fixture.orderId, "mbway");
    const trid = `T-${unique()}`;
    const settled = await processEupagoWebhook(
      await signedWebhook(paidPayload({ trid, identifier: attempt.attempt.providerIdentifier }))
    );
    expect(settled.outcome).toBe("payment_confirmed");

    const [admin] = await db
      .insert((await import("@/db/schema")).users)
      .values({ email: `${PREFIX}-${unique()}@test.local`, password: "x", name: PREFIX, role: "admin" })
      .returning();

    const [refund] = await db
      .insert(refundAttempts)
      .values({
        orderId: fixture.orderId,
        paymentId: attempt.attempt.paymentId!,
        provider: "eupago",
        idempotencyKey: `L2-${unique()}`,
        amountCents: 5000,
        currency: "EUR",
        status: "pending",
        requestedBy: admin.id,
      })
      .returning();
    return { fixture, attempt, trid, refund };
  }

  it("arms the single settled movement deterministically", async () => {
    const { attempt, trid, refund } = await refundFixture();
    // A SECOND attempt of the same payment that never settled must not make the
    // binding ambiguous.
    await armPaymentAttempt({ orderId: refund.orderId, method: "mbway", amountCents: 5000 });

    const armed = await armEupagoRefund(refund.id);
    expect(armed.providerOriginalTransactionId).toBe(trid);
    expect(armed.recoveryState).toBe("armed");
    expect(attempt.attempt.paymentId).toBe(refund.paymentId);
  });

  it("refuses AMBIGUOUS_PROVIDER_MOVEMENT when two movements settled the same payment", async () => {
    const { attempt, refund } = await refundFixture();

    // A second, equally real movement settled the SAME canonical payment (the
    // double-charge shape): there is no correct answer to "which movement are we
    // refunding?", so the binding must be refused instead of guessed.
    const [second] = await db
      .insert(paymentAttempts)
      .values({
        orderId: refund.orderId,
        paymentId: attempt.attempt.paymentId,
        provider: "eupago",
        method: "mbway",
        status: "paid",
        amountCents: 5000,
        currency: "EUR",
        providerIdentifier: `MDT-${refund.orderId}-${unique()}`,
        providerTransactionId: `T-${unique()}`,
        completedAt: new Date(),
      })
      .returning();
    expect(second.paymentId).toBe(attempt.attempt.paymentId);

    await expect(armEupagoRefund(refund.id)).rejects.toMatchObject({ code: "AMBIGUOUS_PROVIDER_MOVEMENT" });

    const [stored] = await db.select().from(refundAttempts).where(eq(refundAttempts.id, refund.id)).limit(1);
    expect(stored.providerOriginalTransactionId).toBeNull();
    expect(stored.recoveryState).toBeNull();
  });
});

// ─── Order line integrity for the anomaly suite ───────────────────────────

describe("HIGH-1/HIGH-2 — the anomaly never rewrites order lines", () => {
  it("keeps order items and totals untouched", async () => {
    const fixture = await createPendingOrder({ prefix: PREFIX });
    const itemsBefore = await db.select().from(orderItems).where(eq(orderItems.orderId, fixture.orderId));

    const attempt = await createAttempt(fixture.orderId, "mbway");
    await db
      .update(orders)
      .set({ status: "cancelled", paymentStatus: "cancelled", updatedAt: new Date() })
      .where(eq(orders.id, fixture.orderId));

    const result = await processEupagoWebhook(
      await signedWebhook(paidPayload({ trid: `T-${unique()}`, identifier: attempt.attempt.providerIdentifier }))
    );
    expect(result.outcome).toBe("payment_anomaly");

    const itemsAfter = await db.select().from(orderItems).where(eq(orderItems.orderId, fixture.orderId));
    expect(itemsAfter).toEqual(itemsBefore);
    expect((await orderRow(fixture.orderId)).total).toBe(fixture.total);
  });
});

// ─── HIGH-1(c): a second movement on an already settled ATTEMPT ────────────

describe("HIGH-1(c) — a second Paid movement is never dismissed as a divergence", () => {
  it("records the second trid durably instead of ignoring it", async () => {
    const fixture = await createPendingOrder({ prefix: PREFIX });
    const attempt = await createAttempt(fixture.orderId, "mbway");

    const tridA = `T-${unique()}`;
    expect(
      (
        await processEupagoWebhook(
          await signedWebhook(paidPayload({ trid: tridA, identifier: attempt.attempt.providerIdentifier }))
        )
      ).outcome
    ).toBe("payment_confirmed");

    // The SAME attempt (same local identifier) reports a SECOND, different
    // authenticated movement: evidence the customer was charged twice.
    const tridB = `T-${unique()}`;
    const second = await processEupagoWebhook(
      await signedWebhook(paidPayload({ trid: tridB, identifier: attempt.attempt.providerIdentifier }))
    );
    expect(second).toMatchObject({
      outcome: "payment_anomaly",
      code: "PAYMENT_NOT_COHERENT:PROVIDER_TRANSACTION_CONFLICT",
    });

    // Both movements survive: the attempt keeps its settled trid and the anomaly
    // keeps the second one.
    const [stored] = await db.select().from(paymentAttempts).where(eq(paymentAttempts.id, attempt.attempt.id)).limit(1);
    expect(stored.providerTransactionId).toBe(tridA);
    const anomalies = await anomaliesFor(fixture.orderId);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({
      anomalyCode: "PAYMENT_NOT_COHERENT",
      providerReference: tridB,
      paymentId: attempt.attempt.paymentId,
    });

    const event = await webhookEvent(tridB);
    expect(event.status).toBe("anomaly");
    const audit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "payment.provider_anomaly_recorded"), eq(auditLogs.entityId, attempt.attempt.id)));
    expect(audit).toHaveLength(1);
    expect(audit[0].details).toMatchObject({ trid: tridB, settledTrid: tridA });

    // Redelivery of the second trid stays idempotent (one anomaly row).
    const replay = await processEupagoWebhook(
      await signedWebhook(paidPayload({ trid: tridB, identifier: attempt.attempt.providerIdentifier }))
    );
    expect(replay.outcome).toBe("payment_anomaly");
    expect(await anomaliesFor(fixture.orderId)).toHaveLength(1);

    // The order is unchanged and the invoice/email path never ran twice.
    expect((await orderRow(fixture.orderId)).status).toBe("paid");
    expect(
      await db
        .select()
        .from(emailNotifications)
        .where(and(eq(emailNotifications.referenceType, "order"), eq(emailNotifications.referenceId, fixture.orderId)))
    ).toHaveLength(1);
  });
});
