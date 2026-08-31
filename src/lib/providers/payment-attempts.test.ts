// B.3.1 — Payment attempt tests (real PostgreSQL, real production service)
//
// Mandatory scenario: ONE order with THREE external payment attempts
//   1. eupago / mbway / expired
//   2. eupago / mbway / failed
//   3. eupago / card  / paid
// All three must remain persisted — history is never overwritten.

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { db } from "@/db";
import { orders, orderItems, payments, paymentAttempts, products } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  createPaymentAttempt,
  updatePaymentAttemptStatus,
  listPaymentAttempts,
  getLatestPaymentAttempt,
  getPaymentAttempt,
  findPaymentAttemptByReference,
  hasSuccessfulPaymentAttempt,
  getPaymentAdapter,
  isPaymentAttemptStatus,
  isPaymentAttemptMethod,
} from "@/lib/providers/payment-attempts";
import {
  parseDecimalToCents,
  formatCentsToDecimal,
  MAX_PROVIDER_AMOUNT_CENTS,
} from "@/lib/providers/money-boundary";
import { ProviderError } from "@/lib/providers/errors";

async function createTestOrder(total = "123.45") {
  const [order] = await db
    .insert(orders)
    .values({
      orderNumber: `B31-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
      status: "pending_payment",
      paymentStatus: "pending",
      subtotal: total,
      total,
      deliveryType: "shipping",
    })
    .returning();
  return order;
}

beforeEach(async () => {
  await db.delete(paymentAttempts);
});

describe("B.3.1 — payment attempts: multi-attempt history", () => {
  it("persists three attempts for one order without overwriting history", async () => {
    const order = await createTestOrder("199.90");
    const amountCents = parseDecimalToCents("199.90");

    const a1 = await createPaymentAttempt({
      orderId: order.id, provider: "eupago", method: "mbway", amountCents, providerReference: "EUP-MBWAY-1",
    });
    await updatePaymentAttemptStatus(a1.id, { status: "expired" });

    const a2 = await createPaymentAttempt({
      orderId: order.id, provider: "eupago", method: "mbway", amountCents, providerReference: "EUP-MBWAY-2",
    });
    await updatePaymentAttemptStatus(a2.id, { status: "failed", failureReason: "customer rejected" });

    const a3 = await createPaymentAttempt({
      orderId: order.id, provider: "eupago", method: "card", amountCents, providerReference: "EUP-CARD-1",
    });
    await updatePaymentAttemptStatus(a3.id, { status: "paid" });

    const history = await listPaymentAttempts(order.id);
    expect(history).toHaveLength(3);
    expect(history.map((h) => [h.provider, h.method, h.status])).toEqual([
      ["eupago", "mbway", "expired"],
      ["eupago", "mbway", "failed"],
      ["eupago", "card", "paid"],
    ]);

    // Amounts and currency are canonical for every attempt
    for (const attempt of history) {
      expect(attempt.amountCents).toBe(19990);
      expect(formatCentsToDecimal(attempt.amountCents)).toBe("199.90");
      expect(attempt.currency).toBe("EUR");
      expect(attempt.orderId).toBe(order.id);
      expect(attempt.createdAt).toBeInstanceOf(Date);
      expect(attempt.updatedAt).toBeInstanceOf(Date);
      expect(attempt.completedAt).toBeInstanceOf(Date);
    }

    expect(history.map((h) => h.providerReference)).toEqual(["EUP-MBWAY-1", "EUP-MBWAY-2", "EUP-CARD-1"]);
    expect((await getLatestPaymentAttempt(order.id))!.id).toBe(a3.id);
    expect(await hasSuccessfulPaymentAttempt(order.id)).toBe(true);
  });

  it("keeps the order status untouched — payment status is not order status", async () => {
    const order = await createTestOrder();
    const attempt = await createPaymentAttempt({
      orderId: order.id, provider: "eupago", method: "card", amountCents: 12345,
    });
    await updatePaymentAttemptStatus(attempt.id, { status: "paid" });

    const [reloaded] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(reloaded.status).toBe("pending_payment");
    expect(reloaded.paymentStatus).toBe("pending");
  });

  it("records timestamps only when an attempt settles", async () => {
    const order = await createTestOrder();
    const attempt = await createPaymentAttempt({
      orderId: order.id, provider: "eupago", method: "multibanco", amountCents: 500,
    });
    expect(attempt.status).toBe("pending");
    expect(attempt.completedAt).toBeNull();

    const paid = await updatePaymentAttemptStatus(attempt.id, { status: "paid" });
    expect(paid.completedAt).toBeInstanceOf(Date);
  });

  it("supports every normalized payment state", async () => {
    const order = await createTestOrder();
    for (const status of ["pending", "paid", "failed", "expired", "cancelled", "refunded"] as const) {
      const attempt = await createPaymentAttempt({
        orderId: order.id, provider: "eupago", method: "card", amountCents: 100, status,
      });
      expect(attempt.status).toBe(status);
      expect(isPaymentAttemptStatus(status)).toBe(true);
    }
    expect(await listPaymentAttempts(order.id)).toHaveLength(6);
    expect(isPaymentAttemptStatus("shipped")).toBe(false);
    expect(isPaymentAttemptMethod("mbway")).toBe(true);
    expect(isPaymentAttemptMethod("bank_transfer")).toBe(false);
  });

  it("does not reopen a terminal attempt", async () => {
    const order = await createTestOrder();
    const attempt = await createPaymentAttempt({
      orderId: order.id, provider: "eupago", method: "mbway", amountCents: 100,
    });
    await updatePaymentAttemptStatus(attempt.id, { status: "expired" });
    await expect(updatePaymentAttemptStatus(attempt.id, { status: "paid" })).rejects.toThrow(ProviderError);

    const stored = await getPaymentAttempt(attempt.id);
    expect(stored!.status).toBe("expired");
  });
});

describe("B.3.1 — payment attempts: constraints and lookups", () => {
  it("enforces the order foreign key", async () => {
    await expect(
      createPaymentAttempt({ orderId: 999_999_999, provider: "eupago", method: "card", amountCents: 100 })
    ).rejects.toThrow();
  });

  it("enforces unique provider references per provider", async () => {
    const order = await createTestOrder();
    await createPaymentAttempt({
      orderId: order.id, provider: "eupago", method: "card", amountCents: 100, providerReference: "DUP-REF",
    });
    await expect(
      createPaymentAttempt({
        orderId: order.id, provider: "eupago", method: "card", amountCents: 100, providerReference: "DUP-REF",
      })
    ).rejects.toThrow();

    // NULL references stay distinct (partial unique index)
    await createPaymentAttempt({ orderId: order.id, provider: "eupago", method: "card", amountCents: 100 });
    await createPaymentAttempt({ orderId: order.id, provider: "eupago", method: "card", amountCents: 100 });
    expect(await listPaymentAttempts(order.id)).toHaveLength(3);
  });

  it("finds an attempt by provider reference", async () => {
    const order = await createTestOrder();
    const created = await createPaymentAttempt({
      orderId: order.id, provider: "eupago", method: "mbway", amountCents: 250, providerReference: "LOOKUP-1",
    });
    const found = await findPaymentAttemptByReference("eupago", "LOOKUP-1");
    expect(found!.id).toBe(created.id);
    expect(await findPaymentAttemptByReference("eupago", "MISSING")).toBeNull();
  });

  it("sanitizes failure reasons before persisting them", async () => {
    const order = await createTestOrder();
    const attempt = await createPaymentAttempt({
      orderId: order.id, provider: "eupago", method: "card", amountCents: 100,
    });
    const failed = await updatePaymentAttemptStatus(attempt.id, {
      status: "failed",
      failureReason: "declined api_key=sk_live_SECRET card 4111 1111 1111 1111",
    });
    expect(failed.failureReason).not.toContain("sk_live_SECRET");
    expect(failed.failureReason).not.toContain("4111 1111 1111 1111");
  });

  it("reports PAYMENT_NOT_FOUND for unknown attempts", async () => {
    await expect(updatePaymentAttemptStatus(999_999_999, { status: "paid" })).rejects.toMatchObject({
      code: "PAYMENT_NOT_FOUND",
    });
  });
});

describe("B.3.1 — payment attempts: provider validation", () => {
  it("rejects non-allowlisted providers", async () => {
    const order = await createTestOrder();
    await expect(
      createPaymentAttempt({ orderId: order.id, provider: "stripe", method: "card", amountCents: 100 })
    ).rejects.toMatchObject({ code: "UNSUPPORTED_PROVIDER" });
  });

  it("does not accept bank_transfer as an external provider attempt", async () => {
    const order = await createTestOrder();
    await expect(
      createPaymentAttempt({ orderId: order.id, provider: "bank_transfer", method: "card", amountCents: 100 })
    ).rejects.toMatchObject({ code: "UNSUPPORTED_PROVIDER" });
    await expect(
      createPaymentAttempt({ orderId: order.id, provider: "eupago", method: "bank_transfer", amountCents: 100 })
    ).rejects.toMatchObject({ code: "OPERATION_NOT_SUPPORTED" });
  });

  it("rejects invalid amounts and currencies at the money boundary", async () => {
    const order = await createTestOrder();
    for (const amountCents of [0, -100, 1.5, Number.MAX_SAFE_INTEGER]) {
      await expect(
        createPaymentAttempt({ orderId: order.id, provider: "eupago", method: "card", amountCents })
      ).rejects.toMatchObject({ code: "INVALID_PROVIDER_RESPONSE" });
    }
    await expect(
      createPaymentAttempt({ orderId: order.id, provider: "eupago", method: "card", amountCents: 100, currency: "USD" })
    ).rejects.toMatchObject({ code: "INVALID_PROVIDER_RESPONSE" });
  });

  it("makes no live provider calls in this phase", () => {
    // No adapter is registered in B.3.1 → normalized error instead of network I/O
    expect(() => getPaymentAdapter("eupago")).toThrow(ProviderError);
    try {
      getPaymentAdapter("eupago");
    } catch (e) {
      expect((e as ProviderError).code).toBe("PROVIDER_UNAVAILABLE");
    }
    expect(() => getPaymentAdapter("stripe")).toThrow(ProviderError);
  });
});

describe("B.3.1 — bank transfer regression (existing flow untouched)", () => {
  it("keeps the legacy payments table usable and independent from payment_attempts", async () => {
    const order = await createTestOrder("50.00");
    const [legacy] = await db
      .insert(payments)
      .values({
        orderId: order.id, provider: "bank_transfer", method: "bank_transfer",
        amount: "50.00", currency: "EUR", status: "pending",
      })
      .returning();

    expect(legacy.provider).toBe("bank_transfer");
    expect(legacy.status).toBe("pending");
    // No provider attempt rows are implied by a bank transfer order
    expect(await listPaymentAttempts(order.id)).toHaveLength(0);

    await db.delete(payments).where(eq(payments.id, legacy.id));
  });

  it("does not touch orders/order_items/products schemas used by the existing flow", async () => {
    const [product] = await db.select().from(products).limit(1);
    expect(product).toBeDefined();
    const order = await createTestOrder("10.00");
    const [item] = await db
      .insert(orderItems)
      .values({
        orderId: order.id, productId: product.id, productName: product.name, quantity: 1,
        unitPriceGross: "10.00", unitPriceNet: "8.13", vatRate: "23.00",
        vatAmount: "1.87", discountAmount: "0.00", lineTotalGross: "10.00",
      })
      .returning();
    expect(item.orderId).toBe(order.id);
    await db.delete(orderItems).where(eq(orderItems.id, item.id));
  });
});

describe("B.3.1 — payment attempts: amount_cents int4 domain (LOW-1)", () => {
  it("persists exactly the maximum storable amount", async () => {
    const order = await createTestOrder("21474836.47");
    const attempt = await createPaymentAttempt({
      orderId: order.id, provider: "eupago", method: "card",
      amountCents: MAX_PROVIDER_AMOUNT_CENTS,
    });
    const stored = await getPaymentAttempt(attempt.id);
    expect(stored!.amountCents).toBe(MAX_PROVIDER_AMOUNT_CENTS);
    expect(formatCentsToDecimal(stored!.amountCents)).toBe("21474836.47");
  });

  it("rejects maximum + 1 in application validation, never as a raw PostgreSQL 22003", async () => {
    const order = await createTestOrder();
    for (const oversized of [MAX_PROVIDER_AMOUNT_CENTS + 1, 3_000_000_000, 99_999_999_999]) {
      let caught: unknown;
      try {
        await createPaymentAttempt({
          orderId: order.id, provider: "eupago", method: "card", amountCents: oversized,
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ProviderError);
      expect((caught as ProviderError).code).toBe("INVALID_PROVIDER_RESPONSE");
      const serialized = JSON.stringify((caught as ProviderError).toCustomerSafeJSON());
      expect(serialized).not.toContain("22003");
      expect(serialized).not.toContain("numeric field overflow");
    }
    // Nothing was written by the rejected calls.
    expect(await listPaymentAttempts(order.id)).toHaveLength(0);
  });
});

// Leave no order-referencing provider rows behind: other suites truncate
// `orders`, which fails while child rows still reference it.
afterAll(async () => {
  await db.delete(paymentAttempts);
});
