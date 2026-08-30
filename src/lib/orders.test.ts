import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/db";
import { products, orders, orderItems, stockMovements, coupons, payments, auditLogs, emailNotifications, orderStatusHistory } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { confirmOrderPayment, cancelOrder, releaseExpiredReservations } from "./orders";

// ── Test helpers ──────────────────────────────────────────

async function resetTestData() {
  await db.delete(emailNotifications);
  await db.delete(auditLogs);
  await db.delete(stockMovements);
  await db.delete(orderStatusHistory);
  await db.delete(orderItems);
  await db.delete(payments);
  await db.delete(orders);
  await db.update(products).set({ stock: 5, reservedStock: 0, soldCount: 0 }).where(eq(products.id, 1));
  await db.delete(coupons);
  await db.execute(sql`INSERT INTO coupons (code,type,value,is_active,used_count,max_uses) VALUES ('TEST10','percentage','10.00',true,0,2) ON CONFLICT DO NOTHING`);
}

async function createTestOrder(opts: { qty?: number; coupon?: string; reservedOverride?: number } = {}) {
  const qty = opts.qty ?? 2;
  const prod = await db.select().from(products).where(eq(products.id, 1)).limit(1).then(r => r[0]);

  // Create order directly in DB (simulating the POST /api/orders result)
  const [order] = await db.insert(orders).values({
    orderNumber: `TEST${Date.now()}`, status: "pending_payment", paymentStatus: "pending",
    subtotal: (parseFloat(prod.price) * qty).toFixed(2), shipping: "0.00", discount: "0.00",
    vat: "0.00", total: (parseFloat(prod.price) * qty).toFixed(2),
    deliveryType: "pickup", couponCode: opts.coupon || null,
    reservationExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
  }).returning();

  await db.insert(orderItems).values({
    orderId: order.id, productId: 1, productName: prod.name, quantity: qty,
    unitPriceGross: prod.price, unitPriceNet: prod.price, vatRate: "23.00",
    vatAmount: "0.00", discountAmount: "0.00", lineTotalGross: (parseFloat(prod.price) * qty).toFixed(2),
  });

  await db.insert(payments).values({
    orderId: order.id, provider: "manual", method: "bank_transfer",
    amount: (parseFloat(prod.price) * qty).toFixed(2), currency: "EUR", status: "pending",
  });

  // Set stock reservation
  const reserved = opts.reservedOverride ?? qty;
  await db.update(products).set({ reservedStock: reserved }).where(eq(products.id, 1));

  if (opts.coupon) {
    await db.update(coupons).set({ usedCount: sql`${coupons.usedCount} + 1` }).where(eq(coupons.code, opts.coupon));
  }

  return order;
}

async function getProduct1() {
  return db.select().from(products).where(eq(products.id, 1)).limit(1).then(r => r[0]);
}

// ── Tests ─────────────────────────────────────────────────

describe("confirmOrderPayment", () => {
  beforeEach(resetTestData);

  it("converts reservation to sale — stock=3, reserved=0, sold=2", async () => {
    const order = await createTestOrder({ qty: 2 });
    const result = await confirmOrderPayment(order.id, null);
    expect(result.success).toBe(true);
    expect(result.changed).toBe(true);

    const p = await getProduct1();
    expect(p.stock).toBe(3);
    expect(p.reservedStock).toBe(0);
    expect(p.soldCount).toBe(2);

    const [o] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(o.status).toBe("paid");

    const [pay] = await db.select().from(payments).where(eq(payments.orderId, order.id));
    expect(pay.status).toBe("paid");
  });

  it("fails on inconsistent reservation (reserved=1, qty=2)", async () => {
    const order = await createTestOrder({ qty: 2, reservedOverride: 1 });
    const result = await confirmOrderPayment(order.id, null);
    expect(result.success).toBe(false);
    expect(result.error).toContain("INVENTORY_INCONSISTENCY");

    const p = await getProduct1();
    expect(p.stock).toBe(5); // unchanged
    expect(p.reservedStock).toBe(1); // unchanged
  });

  it("is idempotent — second call does nothing", async () => {
    const order = await createTestOrder({ qty: 2 });
    await confirmOrderPayment(order.id, null);
    const result2 = await confirmOrderPayment(order.id, null);
    expect(result2.success).toBe(true);
    expect(result2.changed).toBe(false);

    const p = await getProduct1();
    expect(p.stock).toBe(3);
    expect(p.soldCount).toBe(2);

    const sales = await db.select().from(stockMovements).where(eq(stockMovements.type, "sale"));
    expect(sales.length).toBe(1);

    const audits = await db.select().from(auditLogs);
    expect(audits.filter(a => a.action === "order.payment_confirmed").length).toBe(1);
  });
});

describe("cancelOrder", () => {
  beforeEach(resetTestData);

  it("releases reservation and coupon", async () => {
    const order = await createTestOrder({ qty: 2, coupon: "TEST10" });
    const couponBefore = await db.select().from(coupons).where(eq(coupons.code, "TEST10")).then(r => r[0]);
    expect(couponBefore.usedCount).toBe(1);

    const result = await cancelOrder(order.id, null, "Test cancel");
    expect(result.success).toBe(true);
    expect(result.changed).toBe(true);

    const p = await getProduct1();
    expect(p.stock).toBe(5);
    expect(p.reservedStock).toBe(0);

    const couponAfter = await db.select().from(coupons).where(eq(coupons.code, "TEST10")).then(r => r[0]);
    expect(couponAfter.usedCount).toBe(0);
  });

  it("is idempotent — second call does nothing", async () => {
    const order = await createTestOrder({ qty: 2 });
    await cancelOrder(order.id, null);
    const result2 = await cancelOrder(order.id, null);
    expect(result2.success).toBe(true);
    expect(result2.changed).toBe(false);

    const releases = await db.select().from(stockMovements).where(eq(stockMovements.type, "reservation_released"));
    expect(releases.length).toBe(1);

    const audits = await db.select().from(auditLogs).where(eq(auditLogs.action, "order.cancelled"));
    expect(audits.length).toBe(1);
  });
});

describe("releaseExpiredReservations", () => {
  beforeEach(resetTestData);

  it("expires order with past reservationExpiresAt", async () => {
    const order = await createTestOrder({ qty: 2 });
    // Set expiry to past
    await db.update(orders).set({ reservationExpiresAt: new Date(Date.now() - 1000) }).where(eq(orders.id, order.id));

    const result = await releaseExpiredReservations();
    expect(result.expired).toBe(1);

    const [o] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(o.status).toBe("expired");

    const p = await getProduct1();
    expect(p.reservedStock).toBe(0);
  });

  it("is idempotent — second call does nothing", async () => {
    const order = await createTestOrder({ qty: 2 });
    await db.update(orders).set({ reservationExpiresAt: new Date(Date.now() - 1000) }).where(eq(orders.id, order.id));

    await releaseExpiredReservations();
    const result2 = await releaseExpiredReservations();
    expect(result2.expired).toBe(0);

    const p = await getProduct1();
    expect(p.reservedStock).toBe(0);
  });

  it("does NOT expire order with future reservationExpiresAt", async () => {
    await createTestOrder({ qty: 2 });
    // reservationExpiresAt is already in future (default)

    const result = await releaseExpiredReservations();
    expect(result.expired).toBe(0);

    const p = await getProduct1();
    expect(p.reservedStock).toBe(2); // unchanged
  });
});

describe("email eventKey deduplication", () => {
  beforeEach(resetTestData);

  it("confirm payment twice produces at most 1 email notification", async () => {
    const order = await createTestOrder({ qty: 2 });
    await confirmOrderPayment(order.id, null);
    await confirmOrderPayment(order.id, null);

    const emails = await db.select().from(emailNotifications)
      .where(eq(emailNotifications.type, "payment_confirmed"));
    // At most 1 — eventKey UNIQUE prevents duplicates
    expect(emails.length).toBeLessThanOrEqual(1);
  });

  it("cancel order twice produces at most 1 email notification", async () => {
    const order = await createTestOrder({ qty: 2 });
    await cancelOrder(order.id, null);
    await cancelOrder(order.id, null);

    const emails = await db.select().from(emailNotifications)
      .where(eq(emailNotifications.type, "order_cancelled"));
    expect(emails.length).toBeLessThanOrEqual(1);
  });
});
