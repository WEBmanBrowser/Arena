import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import {
  auditLogs,
  orderItems,
  orderStatusHistory,
  orders,
  payments,
  reconciliationObservations,
  refundAttempts,
  users,
} from "@/db/schema";
import { eq, inArray, like } from "drizzle-orm";
import {
  ReconciliationError,
  ingestReconciliationObservation,
  listOpenAnomalies,
  resolveReconciliationAnomaly,
} from "@/lib/reconciliation";
import { requestRefund } from "@/lib/refunds";

async function cleanupB35R() {
  const rows = await db.select({ id: orders.id }).from(orders).where(like(orders.orderNumber, "B35REC-%"));
  const orderIds = rows.map((o) => o.id);
  if (orderIds.length) {
    await db.delete(refundAttempts).where(inArray(refundAttempts.orderId, orderIds));
    await db.delete(reconciliationObservations).where(inArray(reconciliationObservations.orderId, orderIds));
    await db.delete(payments).where(inArray(payments.orderId, orderIds));
    await db.delete(orderStatusHistory).where(inArray(orderStatusHistory.orderId, orderIds));
    await db.delete(orderItems).where(inArray(orderItems.orderId, orderIds));
    await db.delete(orders).where(inArray(orders.id, orderIds));
  }
  await db.delete(auditLogs).where(like(auditLogs.action, "reconciliation.%"));
  await db.delete(auditLogs).where(like(auditLogs.action, "refund.%"));
  await db.delete(users).where(like(users.email, "b35rec-%@test.local"));
}

let seq = 0;

async function createUser(role = "admin") {
  seq += 1;
  const [u] = await db
    .insert(users)
    .values({
      email: `b35rec-${role}-${Date.now()}-${seq}@test.local`,
      password: "x",
      name: `B35REC ${role}`,
      role,
    })
    .returning();
  return u;
}

async function createPaidOrder(total = "100.00", refundedCents = 0) {
  const [order] = await db
    .insert(orders)
    .values({
      orderNumber: `B35REC-ORD-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
      status: "paid",
      paymentStatus: "paid",
      subtotal: total,
      shipping: "0.00",
      total,
      deliveryType: "shipping",
      paymentMethod: "bank_transfer",
    })
    .returning();
  await db.insert(payments).values({ orderId: order.id, provider: "manual", method: "bank_transfer", amount: total, currency: "EUR", status: "paid", paidAt: new Date() });
  if (refundedCents > 0) {
    const user = await createUser();
    await requestRefund({
      orderId: order.id,
      amountCents: refundedCents,
      idempotencyKey: `b35rec-refund-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
      requestedBy: user.id,
      manualCompletion: { externalReference: `TRF-REC-${order.id}`, completedAt: new Date() },
    });
  }
  return order;
}

beforeEach(async () => {
  await cleanupB35R();
});
afterEach(async () => {
  await cleanupB35R();
});

describe("B.3.5 reconciliation observations", () => {
  it("exact match produces no anomaly and is auto-resolved", async () => {
    const user = await createUser();
    const order = await createPaidOrder("100.00");
    const result = await ingestReconciliationObservation({
      orderId: order.id,
      provider: "manual",
      providerReference: "REC-EXACT-1",
      observedPaidCents: 10000,
      observedRefundedCents: 0,
      currency: "EUR",
      observedAt: new Date(),
      recordedBy: user.id,
    });
    expect(result.created).toBe(true);
    expect(result.observation.anomalyCode).toBeNull();
    expect(result.observation.status).toBe("resolved");
    expect(result.observation.expectedPaidCents).toBe(10000);
    expect(result.observation.internalRefundedCents).toBe(0);
  });

  it("paid amount mismatch is flagged as an open anomaly", async () => {
    const user = await createUser();
    const order = await createPaidOrder("100.00");
    const result = await ingestReconciliationObservation({
      orderId: order.id,
      provider: "manual",
      providerReference: "REC-PAID-DIFF",
      observedPaidCents: 9000, // internal says 10000
      observedRefundedCents: 0,
      currency: "EUR",
      observedAt: new Date(),
      recordedBy: user.id,
    });
    expect(result.observation.anomalyCode).toBe("PAID_AMOUNT_MISMATCH");
    expect(result.observation.status).toBe("open");
    expect((await listOpenAnomalies()).some((a) => a.id === result.observation.id)).toBe(true);
  });

  it("internal paid but externally unpaid is flagged", async () => {
    const user = await createUser();
    const order = await createPaidOrder("100.00");
    const result = await ingestReconciliationObservation({
      orderId: order.id,
      provider: "manual",
      providerReference: "REC-UNPAID-EXT",
      observedPaidCents: 0,
      observedRefundedCents: 0,
      currency: "EUR",
      observedAt: new Date(),
      recordedBy: user.id,
    });
    expect(result.observation.anomalyCode).toBe("PAID_AMOUNT_MISMATCH");
  });

  it("refund mismatch is flagged (refund succeeded internally but not observed; and external refund exceeding internal)", async () => {
    const user = await createUser();
    const order = await createPaidOrder("100.00", 2500); // 25€ refunded internally

    const notObserved = await ingestReconciliationObservation({
      orderId: order.id,
      provider: "manual",
      providerReference: "REC-REF-NOT-OBS",
      observedPaidCents: 10000,
      observedRefundedCents: 0, // external does not reflect the refund
      currency: "EUR",
      observedAt: new Date(),
      recordedBy: user.id,
    });
    expect(notObserved.observation.anomalyCode).toBe("REFUND_AMOUNT_MISMATCH");

    const exceeds = await ingestReconciliationObservation({
      orderId: order.id,
      provider: "manual",
      providerReference: "REC-REF-EXCEEDS",
      observedPaidCents: 10000,
      observedRefundedCents: 5000, // external refund exceeds internal 2500
      currency: "EUR",
      observedAt: new Date(),
      recordedBy: user.id,
    });
    expect(exceeds.observation.anomalyCode).toBe("REFUND_AMOUNT_MISMATCH");
  });

  it("currency mismatch is flagged and takes precedence", async () => {
    const user = await createUser();
    const order = await createPaidOrder("100.00");
    const result = await ingestReconciliationObservation({
      orderId: order.id,
      provider: "manual",
      providerReference: "REC-CCY",
      observedPaidCents: 10000,
      observedRefundedCents: 0,
      currency: "USD",
      observedAt: new Date(),
      recordedBy: user.id,
    });
    expect(result.observation.anomalyCode).toBe("CURRENCY_MISMATCH");
    expect(result.observation.status).toBe("open");
  });

  it("duplicate normalized observation is idempotent and safe", async () => {
    const user = await createUser();
    const order = await createPaidOrder("100.00");
    const input = {
      orderId: order.id,
      provider: "manual",
      providerReference: "REC-DUP-REF",
      observedPaidCents: 10000,
      observedRefundedCents: 0,
      currency: "EUR",
      observedAt: new Date(),
      recordedBy: user.id,
    };
    const first = await ingestReconciliationObservation(input);
    const second = await ingestReconciliationObservation(input);
    expect(second.created).toBe(false);
    expect(second.observation.id).toBe(first.observation.id);
    const rows = await db.select().from(reconciliationObservations).where(eq(reconciliationObservations.orderId, order.id));
    expect(rows.length).toBe(1);
  });

  it("rejects invalid providers, currencies and amounts", async () => {
    const user = await createUser();
    const order = await createPaidOrder();
    await expect(
      ingestReconciliationObservation({ orderId: order.id, provider: "not-a-provider", providerReference: null, observedPaidCents: 0, observedRefundedCents: 0, currency: "EUR", observedAt: new Date(), recordedBy: user.id })
    ).rejects.toMatchObject({ code: "PROVIDER_NOT_ALLOWED" });
    await expect(
      ingestReconciliationObservation({ orderId: order.id, provider: "manual", providerReference: null, observedPaidCents: -1, observedRefundedCents: 0, currency: "EUR", observedAt: new Date(), recordedBy: user.id })
    ).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
    await expect(
      ingestReconciliationObservation({ orderId: order.id, provider: "manual", providerReference: null, observedPaidCents: 0, observedRefundedCents: 0, currency: "eur", observedAt: new Date(), recordedBy: user.id })
    ).rejects.toMatchObject({ code: "INVALID_CURRENCY" });
  });
});

describe("B.3.5 anomaly resolution", () => {
  it("resolution is explicit, audited and requires a note; non-open observations rejected", async () => {
    const admin = await createUser();
    const resolver = await createUser("manager");
    const order = await createPaidOrder("100.00");
    const { observation } = await ingestReconciliationObservation({
      orderId: order.id,
      provider: "manual",
      providerReference: "REC-RESOLVE-1",
      observedPaidCents: 9000,
      observedRefundedCents: 0,
      currency: "EUR",
      observedAt: new Date(),
      recordedBy: admin.id,
    });

    // note is mandatory
    await expect(resolveReconciliationAnomaly(observation.id, resolver.id, "")).rejects.toMatchObject({ code: "INVALID_NOTE" });

    const resolved = await resolveReconciliationAnomaly(observation.id, resolver.id, "Confirmado com extrato bancário — diferença de taxas.");
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolvedBy).toBe(resolver.id);
    expect(resolved.resolutionNote).toContain("extrato");

    const audit = await db.select().from(auditLogs).where(like(auditLogs.action, "reconciliation.anomaly_resolved"));
    expect(audit.length).toBe(1);
    expect(audit[0].userId).toBe(resolver.id);

    // resolving twice rejected
    await expect(resolveReconciliationAnomaly(observation.id, resolver.id, "segunda vez — já resolvido")).rejects.toBeInstanceOf(ReconciliationError);
    await expect(resolveReconciliationAnomaly(observation.id, resolver.id, "nova tentativa válida")).rejects.toMatchObject({ code: "OBSERVATION_NOT_OPEN" });

    // anomalies are never auto-fixed: internal state untouched by resolution
    const [payment] = await db.select().from(payments).where(eq(payments.orderId, order.id)).limit(1);
    expect(payment.amount).toBe("100.00");
    expect(payment.status).toBe("paid");
  });

  it("observation ingest is audited", async () => {
    const user = await createUser();
    const order = await createPaidOrder("100.00");
    await ingestReconciliationObservation({
      orderId: order.id,
      provider: "manual",
      providerReference: "REC-AUDIT-1",
      observedPaidCents: 10000,
      observedRefundedCents: 0,
      currency: "EUR",
      observedAt: new Date(),
      recordedBy: user.id,
    });
    const audit = await db.select().from(auditLogs).where(like(auditLogs.action, "reconciliation.observation_ingested"));
    expect(audit.length).toBe(1);
    expect(audit[0].userId).toBe(user.id);
  });
});
