import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import {
  auditLogs,
  invoiceDocuments,
  orderItems,
  orderStatusHistory,
  orders,
  payments,
  products,
  reconciliationObservations,
  refundAttempts,
  stockMovements,
  users,
} from "@/db/schema";
import { eq, inArray, like } from "drizzle-orm";
import { decimalToCents } from "@/lib/money";
import {
  RefundError,
  cancelRefund,
  completeManualRefund,
  findStaleRefundAttempts,
  getOrderRefundState,
  markRefundFailed,
  recordManualCreditNote,
  requestRefund,
  retryRefund,
} from "@/lib/refunds";
import { recordManualInvoice } from "@/lib/manual-invoicing";

// ─── B.3.5 test data helpers ──────────────────────────────

async function cleanupB35() {
  const b35Orders = await db.select({ id: orders.id }).from(orders).where(like(orders.orderNumber, "B35-%"));
  const orderIds = b35Orders.map((o) => o.id);
  if (orderIds.length) {
    await db.delete(refundAttempts).where(inArray(refundAttempts.orderId, orderIds));
    await db.delete(reconciliationObservations).where(inArray(reconciliationObservations.orderId, orderIds));
    await db.delete(invoiceDocuments).where(inArray(invoiceDocuments.orderId, orderIds));
    await db.delete(payments).where(inArray(payments.orderId, orderIds));
    await db.delete(orderStatusHistory).where(inArray(orderStatusHistory.orderId, orderIds));
    await db.delete(orderItems).where(inArray(orderItems.orderId, orderIds));
    await db.delete(stockMovements).where(inArray(stockMovements.referenceId, orderIds));
    await db.delete(orders).where(inArray(orders.id, orderIds));
  }
  await db.delete(auditLogs).where(like(auditLogs.action, "refund.%"));
  await db.delete(auditLogs).where(like(auditLogs.action, "reconciliation.%"));
  await db.delete(auditLogs).where(like(auditLogs.action, "credit_note.%"));
  await db.delete(auditLogs).where(like(auditLogs.action, "manual_invoice.%"));
  await db.delete(products).where(like(products.sku, "B35-%"));
  await db.delete(users).where(like(users.email, "b35-%@test.local"));
}

async function createB35User(role = "admin") {
  const [u] = await db
    .insert(users)
    .values({
      email: `b35-${role}-${Date.now()}-${Math.floor(Math.random() * 100000)}@test.local`,
      password: "x",
      name: `B35 ${role}`,
      role,
    })
    .returning();
  return u;
}

async function createPaidOrder(opts: {
  total?: string;
  orderStatus?: string;
  paymentStatus?: string;
  userId?: number | null;
  withStockProduct?: boolean;
}) {
  const total = opts.total ?? "100.00";
  const [order] = await db
    .insert(orders)
    .values({
      orderNumber: `B35-ORD-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
      userId: opts.userId ?? null,
      status: opts.orderStatus ?? "paid",
      paymentStatus: opts.paymentStatus ?? "paid",
      subtotal: total,
      shipping: "0.00",
      total,
      deliveryType: "shipping",
      paymentMethod: "bank_transfer",
    })
    .returning();
  await db.insert(payments).values({
    orderId: order.id,
    provider: "manual",
    method: "bank_transfer",
    amount: total,
    currency: "EUR",
    status: opts.paymentStatus ?? "paid",
    paidAt: (opts.paymentStatus ?? "paid") === "paid" ? new Date() : null,
  });

  if (opts.withStockProduct) {
    const [product] = await db
      .insert(products)
      .values({
        name: "B35 Product",
        slug: `b35-product-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
        sku: `B35-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
        price: "10.00",
        vatRate: "23.00",
        stock: 10,
        reservedStock: 3,
        isActive: true,
      })
      .returning();
    await db.insert(orderItems).values({
      orderId: order.id,
      productId: product.id,
      productName: "B35 Product",
      quantity: 1,
      unitPriceGross: "10.00",
      unitPriceNet: "8.13",
      lineTotalGross: "10.00",
    });
    return { order, product };
  }
  return { order, product: null };
}

function key() {
  return `b35-key-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

async function expectRefundError(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code });
}

// ─── Tests ────────────────────────────────────────────────

beforeEach(async () => {
  await cleanupB35();
});
afterEach(async () => {
  await cleanupB35();
});

describe("B.3.5 money helper", () => {
  it("decimalToCents is deterministic and rejects invalid amounts", () => {
    expect(decimalToCents("100.00")).toBe(10000);
    expect(decimalToCents("127.90")).toBe(12790);
    expect(decimalToCents("0.05")).toBe(5);
    expect(decimalToCents("100")).toBe(10000);
    expect(decimalToCents("100.005")).toBeNull();
    expect(decimalToCents("-5.00")).toBeNull();
    expect(decimalToCents("abc")).toBeNull();
    expect(decimalToCents("1,000.00")).toBeNull();
    expect(decimalToCents(null)).toBeNull();
  });
});

describe("B.3.5 refund request validation", () => {
  it("rejects zero, negative and non-integer amounts", async () => {
    const user = await createB35User();
    const { order } = await createPaidOrder({});
    await expectRefundError(requestRefund({ orderId: order.id, amountCents: 0, idempotencyKey: key(), requestedBy: user.id }), "INVALID_AMOUNT");
    await expectRefundError(requestRefund({ orderId: order.id, amountCents: -100, idempotencyKey: key(), requestedBy: user.id }), "INVALID_AMOUNT");
    await expectRefundError(requestRefund({ orderId: order.id, amountCents: 10.5, idempotencyKey: key(), requestedBy: user.id }), "INVALID_AMOUNT");
  });

  it("rejects refunds on unpaid orders/payments", async () => {
    const user = await createB35User();
    const { order } = await createPaidOrder({ orderStatus: "pending_payment", paymentStatus: "pending" });
    await expectRefundError(requestRefund({ orderId: order.id, amountCents: 100, idempotencyKey: key(), requestedBy: user.id }), "PAYMENT_NOT_FOUND");
    const state = await getOrderRefundState(order.id);
    expect(state.paidCents).toBe(0);
    expect(state.remainingRefundableCents).toBe(0);
  });

  it("rejects currency mismatch", async () => {
    const user = await createB35User();
    const { order } = await createPaidOrder({});
    await expectRefundError(
      requestRefund({ orderId: order.id, amountCents: 100, idempotencyKey: key(), requestedBy: user.id, currency: "USD" }),
      "CURRENCY_MISMATCH"
    );
  });

  it("rejects amounts above refundable paid amount", async () => {
    const user = await createB35User();
    const { order } = await createPaidOrder({ total: "100.00" });
    await expectRefundError(
      requestRefund({ orderId: order.id, amountCents: 10001, idempotencyKey: key(), requestedBy: user.id }),
      "REFUND_EXCEEDS_REFUNDABLE"
    );
  });

  it("rejects unknown providers and invalid idempotency keys", async () => {
    const user = await createB35User();
    const { order } = await createPaidOrder({});
    await expectRefundError(requestRefund({ orderId: order.id, amountCents: 100, idempotencyKey: key(), requestedBy: user.id, provider: "mrw" }), "PROVIDER_NOT_ALLOWED");
    await expectRefundError(requestRefund({ orderId: order.id, amountCents: 100, idempotencyKey: "short", requestedBy: user.id }), "INVALID_IDEMPOTENCY_KEY");
    await expectRefundError(requestRefund({ orderId: order.id, amountCents: 100, idempotencyKey: "bad key with spaces!", requestedBy: user.id }), "INVALID_IDEMPOTENCY_KEY");
  });

  it("rejects manual completion for non-manual providers and future completion dates", async () => {
    const user = await createB35User();
    const { order } = await createPaidOrder({});
    await expectRefundError(
      requestRefund({
        orderId: order.id,
        amountCents: 100,
        idempotencyKey: key(),
        requestedBy: user.id,
        provider: "eupago",
        manualCompletion: { externalReference: "X", completedAt: new Date() },
      }),
      "MANUAL_COMPLETION_REQUIRES_MANUAL_PROVIDER"
    );
    await expectRefundError(
      requestRefund({
        orderId: order.id,
        amountCents: 100,
        idempotencyKey: key(),
        requestedBy: user.id,
        manualCompletion: { externalReference: "X", completedAt: new Date(Date.now() + 86_400_000) },
      }),
      "INVALID_DATE"
    );
  });

  it("records a registry provider refund as pending intent with fail-closed execution", async () => {
    const user = await createB35User();
    const { order } = await createPaidOrder({});
    const result = await requestRefund({ orderId: order.id, amountCents: 1000, idempotencyKey: key(), requestedBy: user.id, provider: "eupago" });
    expect(result.created).toBe(true);
    expect(result.executionSupported).toBe(false);
    expect(result.refund.status).toBe("pending");
    expect(result.refund.provider).toBe("eupago");
  });
});

describe("B.3.5 refund lifecycle", () => {
  it("records a completed manual refund with external evidence", async () => {
    const user = await createB35User();
    const { order } = await createPaidOrder({});
    const completedAt = new Date(Date.now() - 3_600_000);
    const result = await requestRefund({
      orderId: order.id,
      amountCents: 2500,
      idempotencyKey: key(),
      requestedBy: user.id,
      manualCompletion: { externalReference: "TRF-2026-001", completedAt },
    });
    expect(result.refund.status).toBe("succeeded");
    expect(result.refund.providerRefundId).toBe("TRF-2026-001");
    expect(result.refund.completedAt).toEqual(completedAt);

    const state = await getOrderRefundState(order.id);
    expect(state.refundedCents).toBe(2500);
    expect(state.paidCents).toBe(10000);
    expect(state.remainingRefundableCents).toBe(7500);
  });

  it("partial refund keeps order lifecycle state untouched (no forced terminal refunded)", async () => {
    const user = await createB35User();
    const { order } = await createPaidOrder({});
    await requestRefund({ orderId: order.id, amountCents: 2500, idempotencyKey: key(), requestedBy: user.id, manualCompletion: { externalReference: "TRF-1", completedAt: new Date() } });
    const [fresh] = await db.select().from(orders).where(eq(orders.id, order.id)).limit(1);
    expect(fresh.status).toBe("paid"); // lifecycle untouched — financial state only
    expect(fresh.paymentStatus).toBe("paid"); // historical payment truth preserved
    const [payment] = await db.select().from(payments).where(eq(payments.orderId, order.id)).limit(1);
    expect(payment.status).toBe("paid"); // payment row never rewritten to refunded
  });

  it("supports multiple sequential partial refunds up to the paid amount", async () => {
    const user = await createB35User();
    const { order } = await createPaidOrder({ total: "100.00" });
    await requestRefund({ orderId: order.id, amountCents: 2500, idempotencyKey: key(), requestedBy: user.id, manualCompletion: { externalReference: "TRF-A", completedAt: new Date() } });
    await requestRefund({ orderId: order.id, amountCents: 2500, idempotencyKey: key(), requestedBy: user.id, manualCompletion: { externalReference: "TRF-B", completedAt: new Date() } });
    const state = await getOrderRefundState(order.id);
    expect(state.refundedCents).toBe(5000);
    expect(state.remainingRefundableCents).toBe(5000);
    // third refund above remaining rejected
    await expectRefundError(
      requestRefund({ orderId: order.id, amountCents: 5001, idempotencyKey: key(), requestedBy: user.id }),
      "REFUND_EXCEEDS_REFUNDABLE"
    );
  });

  it("full cumulative refund is reflected financially but never auto-transitions order status", async () => {
    const user = await createB35User();
    const { order } = await createPaidOrder({ total: "100.00" });
    await requestRefund({ orderId: order.id, amountCents: 6000, idempotencyKey: key(), requestedBy: user.id, manualCompletion: { externalReference: "TRF-F1", completedAt: new Date() } });
    await requestRefund({ orderId: order.id, amountCents: 4000, idempotencyKey: key(), requestedBy: user.id, manualCompletion: { externalReference: "TRF-F2", completedAt: new Date() } });
    const state = await getOrderRefundState(order.id);
    expect(state.refundedCents).toBe(10000);
    expect(state.fullyRefunded).toBe(true);
    expect(state.remainingRefundableCents).toBe(0);
    const [fresh] = await db.select().from(orders).where(eq(orders.id, order.id)).limit(1);
    expect(fresh.status).toBe("paid"); // explicit operational transition required (documented decision)
    // any further refund is rejected
    await expectRefundError(requestRefund({ orderId: order.id, amountCents: 1, idempotencyKey: key(), requestedBy: user.id }), "REFUND_EXCEEDS_REFUNDABLE");
  });

  it("pending manual refund completes with evidence; completion is required to count as refunded", async () => {
    const user = await createB35User();
    const { order } = await createPaidOrder({});
    const created = await requestRefund({ orderId: order.id, amountCents: 3000, idempotencyKey: key(), requestedBy: user.id });
    expect(created.refund.status).toBe("pending");

    let state = await getOrderRefundState(order.id);
    expect(state.refundedCents).toBe(0); // pending does not count as refunded
    expect(state.committedCents).toBe(3000); // but DOES commit balance
    expect(state.remainingRefundableCents).toBe(7000);

    const completed = await completeManualRefund({
      refundId: created.refund.id,
      externalReference: "TRF-COMPLETE-1",
      completedAt: new Date(),
      actorId: user.id,
    });
    expect(completed.status).toBe("succeeded");

    state = await getOrderRefundState(order.id);
    expect(state.refundedCents).toBe(3000);
    expect(state.committedCents).toBe(3000);
  });

  it("failed refunds release commitment and do not count as successful", async () => {
    const user = await createB35User();
    const { order } = await createPaidOrder({});
    const created = await requestRefund({ orderId: order.id, amountCents: 5000, idempotencyKey: key(), requestedBy: user.id });
    await markRefundFailed(created.refund.id, user.id, { code: "PROVIDER_UNAVAILABLE", message: "Externo indisponível" });

    const state = await getOrderRefundState(order.id);
    expect(state.refundedCents).toBe(0);
    expect(state.committedCents).toBe(0); // failed releases commitment
    expect(state.remainingRefundableCents).toBe(10000);
  });

  it("retry reuses the same row and identity, cannot duplicate liability", async () => {
    const user = await createB35User();
    const { order } = await createPaidOrder({ total: "100.00" });
    const created = await requestRefund({ orderId: order.id, amountCents: 10000, idempotencyKey: key(), requestedBy: user.id });
    await markRefundFailed(created.refund.id, user.id);
    const retried = await retryRefund(created.refund.id, user.id);
    expect(retried.id).toBe(created.refund.id); // same row — no new financial operation
    expect(retried.status).toBe("pending");
    expect(retried.idempotencyKey).toBe(created.refund.idempotencyKey);

    const count = await db.select().from(refundAttempts).where(eq(refundAttempts.orderId, order.id));
    expect(count.length).toBe(1);

    // retry of a second full refund while the first is re-committed → rejected
    await expectRefundError(requestRefund({ orderId: order.id, amountCents: 10000, idempotencyKey: key(), requestedBy: user.id }), "REFUND_EXCEEDS_REFUNDABLE");
  });

  it("retry blocked by the DB balance guard maps to a normalized error (not a raw 500)", async () => {
    const user = await createB35User();
    const { order } = await createPaidOrder({ total: "100.00" });
    const failedRefund = await requestRefund({ orderId: order.id, amountCents: 10000, idempotencyKey: key(), requestedBy: user.id });
    await markRefundFailed(failedRefund.refund.id, user.id);

    // Another refund consumes the balance while the first is failed…
    await requestRefund({
      orderId: order.id,
      amountCents: 10000,
      idempotencyKey: key(),
      requestedBy: user.id,
      manualCompletion: { externalReference: "TRF-RACE", completedAt: new Date() },
    });

    // …so re-arming the failed refund must fail cleanly with the guard code.
    await expectRefundError(retryRefund(failedRefund.refund.id, user.id), "REFUND_EXCEEDS_REFUNDABLE");
  });

  it("succeeded refunds are terminal and immutable — cannot be executed twice", async () => {
    const user = await createB35User();
    const { order } = await createPaidOrder({});
    const created = await requestRefund({
      orderId: order.id,
      amountCents: 2000,
      idempotencyKey: key(),
      requestedBy: user.id,
      manualCompletion: { externalReference: "TRF-IMM", completedAt: new Date() },
    });
    await expectRefundError(completeManualRefund({ refundId: created.refund.id, externalReference: "X2", completedAt: new Date(), actorId: user.id }), "REFUND_IMMUTABLE");
    await expectRefundError(retryRefund(created.refund.id, user.id), "REFUND_IMMUTABLE");
    await expectRefundError(cancelRefund(created.refund.id, user.id), "REFUND_IMMUTABLE");
    await expectRefundError(markRefundFailed(created.refund.id, user.id), "REFUND_IMMUTABLE");
  });

  it("idempotent replay returns the same operation without duplicating", async () => {
    const user = await createB35User();
    const { order } = await createPaidOrder({});
    const idem = key();
    const first = await requestRefund({ orderId: order.id, amountCents: 1500, idempotencyKey: idem, requestedBy: user.id });
    const second = await requestRefund({ orderId: order.id, amountCents: 1500, idempotencyKey: idem, requestedBy: user.id });
    expect(second.created).toBe(false);
    expect(second.refund.id).toBe(first.refund.id);
    const rows = await db.select().from(refundAttempts).where(eq(refundAttempts.orderId, order.id));
    expect(rows.length).toBe(1);

    // same key with different amount → conflict
    await expectRefundError(requestRefund({ orderId: order.id, amountCents: 999, idempotencyKey: idem, requestedBy: user.id }), "IDEMPOTENCY_KEY_CONFLICT");
  });

  it("cancel releases committed balance", async () => {
    const user = await createB35User();
    const { order } = await createPaidOrder({});
    const created = await requestRefund({ orderId: order.id, amountCents: 5000, idempotencyKey: key(), requestedBy: user.id });
    await cancelRefund(created.refund.id, user.id, "engano");
    const state = await getOrderRefundState(order.id);
    expect(state.committedCents).toBe(0);
    expect(state.remainingRefundableCents).toBe(10000);
  });
});

describe("B.3.5 refunds never touch inventory", () => {
  it("refund does not restock and does not release reservations", async () => {
    const user = await createB35User();
    const { order, product } = await createPaidOrder({ withStockProduct: true });
    const movementsBefore = await db.select().from(stockMovements).where(eq(stockMovements.referenceId, order.id));
    await requestRefund({
      orderId: order.id,
      amountCents: 10000,
      idempotencyKey: key(),
      requestedBy: user.id,
      manualCompletion: { externalReference: "TRF-NORESTOCK", completedAt: new Date() },
    });
    const [freshProduct] = await db.select().from(products).where(eq(products.id, product!.id)).limit(1);
    expect(freshProduct.stock).toBe(product!.stock); // no restock
    expect(freshProduct.reservedStock).toBe(product!.reservedStock); // no reservation change
    const movementsAfter = await db.select().from(stockMovements).where(eq(stockMovements.referenceId, order.id));
    expect(movementsAfter.length).toBe(movementsBefore.length); // no new stock movements
  });
});

describe("B.3.5 credit notes", () => {
  it("records a manual credit note linked to the original invoice with immutability guards", async () => {
    const user = await createB35User();
    const { order } = await createPaidOrder({ total: "100.00" });
    const invoice = await recordManualInvoice({
      orderId: order.id,
      actorUserId: user.id,
      officialReference: "FT B35/CN-1",
      issuedAt: new Date(),
    });
    await requestRefund({
      orderId: order.id,
      amountCents: 2500,
      idempotencyKey: key(),
      requestedBy: user.id,
      manualCompletion: { externalReference: "TRF-CN", completedAt: new Date() },
    });

    const state = await getOrderRefundState(order.id);
    expect(state.fiscalCreditNotePending).toBe(true);

    const note = await recordManualCreditNote({
      orderId: order.id,
      originalDocumentId: invoice.id,
      officialReference: "NC B35/CN-1",
      issuedAt: new Date(),
      amountCents: 2500,
      actorId: user.id,
    });
    expect(note.documentType).toBe("credit_note");
    expect(note.status).toBe("issued");
    expect(note.originalDocumentId).toBe(invoice.id);

    const stateAfter = await getOrderRefundState(order.id);
    expect(stateAfter.fiscalCreditNotePending).toBe(false);

    // duplicate official reference rejected
    await expectRefundError(
      recordManualCreditNote({ orderId: order.id, originalDocumentId: invoice.id, officialReference: "NC B35/CN-1", issuedAt: new Date(), amountCents: 1000, actorId: user.id }),
      "DUPLICATE_DOCUMENT"
    );
    // cumulative credit notes may not exceed the original invoice
    await expectRefundError(
      recordManualCreditNote({ orderId: order.id, originalDocumentId: invoice.id, officialReference: "NC B35/CN-2", issuedAt: new Date(), amountCents: 8000, actorId: user.id }),
      "CREDIT_NOTE_EXCEEDS_INVOICE"
    );
  });
});

describe("B.3.5 stale refund detection", () => {
  it("reports only old pending/processing attempts", async () => {
    const user = await createB35User();
    const { order } = await createPaidOrder({});
    const fresh = await requestRefund({ orderId: order.id, amountCents: 100, idempotencyKey: key(), requestedBy: user.id });
    expect((await findStaleRefundAttempts(60)).some((r) => r.id === fresh.refund.id)).toBe(false);

    await db.update(refundAttempts).set({ createdAt: new Date(Date.now() - 3_600_000 * 2) }).where(eq(refundAttempts.id, fresh.refund.id));
    const stale = await findStaleRefundAttempts(60);
    expect(stale.some((r) => r.id === fresh.refund.id)).toBe(true);
  });
});
