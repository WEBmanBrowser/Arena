import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/db";
import { products, orders, orderItems, orderItemStockAllocations, stockMovements, coupons, payments, auditLogs, emailNotifications, orderStatusHistory, invoiceDocuments, shipments, rmaRequests, reconciliationObservations, refundAttempts, productSuppliers, productImages, suppliers } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { confirmOrderPayment, cancelOrder, releaseExpiredReservations, transitionOrderStatus } from "./orders";

// ── Test helpers ──────────────────────────────────────────

async function resetTestData() {
  await db.delete(emailNotifications);
  await db.delete(auditLogs);
  await db.delete(stockMovements);
  await db.delete(orderStatusHistory);
  await db.delete(orderItems);
  // Tables referencing payments/orders must be cleared before the broad wipe
  // (B.3.1 invoice documents / shipments / RMA + B.3.5 refunds / reconciliation).
  await db.delete(reconciliationObservations);
  await db.delete(refundAttempts);
  await db.delete(invoiceDocuments);
  await db.delete(shipments);
  await db.delete(rmaRequests);
  await db.delete(payments);
  await db.delete(orders);
  // The tests assume a seed product exists with id=1, price="10.00", stock=5.
  // Wipe and reseed it idempotently so every test starts from the same fixture.
  await db.delete(productSuppliers).where(eq(productSuppliers.productId, 1));
  await db.delete(productImages).where(eq(productImages.productId, 1));
  await db.delete(products).where(eq(products.id, 1));
  await db.insert(products).values({
    id: 1,
    sku: "ORD-TEST-1",
    name: "Order test product",
    slug: "order-test-product",
    price: "10.00",
    stock: 5,
    reservedStock: 0,
    soldCount: 0,
  });
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

async function createSupplierTestOrder(opts: { qty?: number; expired?: boolean } = {}) {
  const qty = opts.qty ?? 2;
  const prod = await getProduct1();

  await db.update(products).set({
    stock: 0,
    reservedStock: 0,
    soldCount: 0,
  }).where(eq(products.id, 1));

  const [supplier] = await db.insert(suppliers).values({
    name: `Order lifecycle supplier ${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    isActive: true,
  }).returning();

  const [link] = await db.insert(productSuppliers).values({
    productId: 1,
    supplierId: supplier.id,
    supplierSku: `ORD-SUP-${Date.now()}`,
    supplierStock: 10,
    supplierReservedStock: qty,
    isPreferred: false,
  }).returning();

  const [order] = await db.insert(orders).values({
    orderNumber: `SUPTEST${Date.now()}${Math.floor(Math.random() * 10000)}`,
    status: "pending_payment",
    paymentStatus: "pending",
    subtotal: (parseFloat(prod.price) * qty).toFixed(2),
    shipping: "0.00",
    discount: "0.00",
    vat: "0.00",
    total: (parseFloat(prod.price) * qty).toFixed(2),
    deliveryType: "shipping",
    paymentMethod: "bank_transfer",
    reservationExpiresAt: opts.expired
      ? new Date(Date.now() - 60 * 1000)
      : new Date(Date.now() + 60 * 60 * 1000),
  }).returning();

  const [item] = await db.insert(orderItems).values({
    orderId: order.id,
    productId: 1,
    productName: prod.name,
    quantity: qty,
    unitPriceGross: prod.price,
    unitPriceNet: prod.price,
    vatRate: "23.00",
    vatAmount: "0.00",
    discountAmount: "0.00",
    lineTotalGross: (parseFloat(prod.price) * qty).toFixed(2),
  }).returning();

  await db.insert(orderItemStockAllocations).values({
    orderItemId: item.id,
    allocationType: "supplier",
    productSupplierId: link.id,
    quantity: qty,
    status: "reserved",
  });

  await db.insert(payments).values({
    orderId: order.id,
    provider: "manual",
    method: "bank_transfer",
    amount: (parseFloat(prod.price) * qty).toFixed(2),
    currency: "EUR",
    status: "pending",
  });

  return { order, item, supplier, link };
}



// ── Tests ─────────────────────────────────────────────────

describe("supplier stock allocation lifecycle", () => {
  beforeEach(resetTestData);

  it("payment commits supplier allocation without decrementing supplier physical stock", async () => {
    const { order, item, link } = await createSupplierTestOrder({ qty: 2 });

    const result = await confirmOrderPayment(order.id, null);
    expect(result.success).toBe(true);
    expect(result.changed).toBe(true);

    const product = await getProduct1();
    expect(product.stock).toBe(0);
    expect(product.reservedStock).toBe(0);
    expect(product.soldCount).toBe(2);

    const [supplierAfter] = await db.select().from(productSuppliers)
      .where(eq(productSuppliers.id, link.id));
    expect(supplierAfter.supplierStock).toBe(10);
    expect(supplierAfter.supplierReservedStock).toBe(2);

    const [allocation] = await db.select().from(orderItemStockAllocations)
      .where(eq(orderItemStockAllocations.orderItemId, item.id));
    expect(allocation.status).toBe("committed");

    const [orderAfter] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(orderAfter.status).toBe("paid");
    expect(orderAfter.paymentStatus).toBe("paid");
  });

  it("pending cancellation releases supplier reservation", async () => {
    const { order, item, link } = await createSupplierTestOrder({ qty: 2 });

    const result = await cancelOrder(order.id, null, "supplier lifecycle test");
    expect(result.success).toBe(true);

    const [supplierAfter] = await db.select().from(productSuppliers)
      .where(eq(productSuppliers.id, link.id));
    expect(supplierAfter.supplierStock).toBe(10);
    expect(supplierAfter.supplierReservedStock).toBe(0);

    const [allocation] = await db.select().from(orderItemStockAllocations)
      .where(eq(orderItemStockAllocations.orderItemId, item.id));
    expect(allocation.status).toBe("released");

    const product = await getProduct1();
    expect(product.stock).toBe(0);
    expect(product.reservedStock).toBe(0);
  });

  it("expired pending order releases supplier reservation", async () => {
    const { order, item, link } = await createSupplierTestOrder({ qty: 2, expired: true });

    await releaseExpiredReservations();

    const [supplierAfter] = await db.select().from(productSuppliers)
      .where(eq(productSuppliers.id, link.id));
    expect(supplierAfter.supplierReservedStock).toBe(0);

    const [allocation] = await db.select().from(orderItemStockAllocations)
      .where(eq(orderItemStockAllocations.orderItemId, item.id));
    expect(allocation.status).toBe("released");

    const [orderAfter] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(orderAfter.status).toBe("expired");
  });

  it("delivery fulfills committed supplier allocation and releases supplier reservation", async () => {
    const { order, item, link } = await createSupplierTestOrder({ qty: 2 });

    const paid = await confirmOrderPayment(order.id, null);
    expect(paid.success).toBe(true);

    const [supplierCommitted] = await db.select().from(productSuppliers)
      .where(eq(productSuppliers.id, link.id));
    expect(supplierCommitted.supplierReservedStock).toBe(2);

    const [allocationCommitted] = await db.select().from(orderItemStockAllocations)
      .where(eq(orderItemStockAllocations.orderItemId, item.id));
    expect(allocationCommitted.status).toBe("committed");

    const processing = await transitionOrderStatus(order.id, "processing", null);
    expect(processing.success).toBe(true);

    const shipped = await transitionOrderStatus(order.id, "shipped", null);
    expect(shipped.success).toBe(true);

    const [supplierBeforeDelivery] = await db.select().from(productSuppliers)
      .where(eq(productSuppliers.id, link.id));
    expect(supplierBeforeDelivery.supplierReservedStock).toBe(2);

    const delivered = await transitionOrderStatus(order.id, "delivered", null);
    expect(delivered.success).toBe(true);

    const [supplierAfter] = await db.select().from(productSuppliers)
      .where(eq(productSuppliers.id, link.id));
    expect(supplierAfter.supplierStock).toBe(10);
    expect(supplierAfter.supplierReservedStock).toBe(0);

    const [allocationAfter] = await db.select().from(orderItemStockAllocations)
      .where(eq(orderItemStockAllocations.orderItemId, item.id));
    expect(allocationAfter.status).toBe("fulfilled");

    const product = await getProduct1();
    expect(product.stock).toBe(0);
    expect(product.reservedStock).toBe(0);
    expect(product.soldCount).toBe(2);

    const [orderAfter] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(orderAfter.status).toBe("delivered");
  });

  it("cancellation after payment releases committed supplier reservation", async () => {
    const { order, item, link } = await createSupplierTestOrder({ qty: 2 });

    const paid = await confirmOrderPayment(order.id, null);
    expect(paid.success).toBe(true);

    const [committed] = await db.select().from(orderItemStockAllocations)
      .where(eq(orderItemStockAllocations.orderItemId, item.id));
    expect(committed.status).toBe("committed");

    const [supplierCommitted] = await db.select().from(productSuppliers)
      .where(eq(productSuppliers.id, link.id));
    expect(supplierCommitted.supplierReservedStock).toBe(2);

    const cancelled = await cancelOrder(order.id, null, "supplier paid cancellation test");
    expect(cancelled.success).toBe(true);

    const [supplierAfter] = await db.select().from(productSuppliers)
      .where(eq(productSuppliers.id, link.id));
    expect(supplierAfter.supplierStock).toBe(10);
    expect(supplierAfter.supplierReservedStock).toBe(0);

    const [allocationAfter] = await db.select().from(orderItemStockAllocations)
      .where(eq(orderItemStockAllocations.orderItemId, item.id));
    expect(allocationAfter.status).toBe("released");

    const product = await getProduct1();
    expect(product.stock).toBe(0);
    expect(product.reservedStock).toBe(0);
    expect(product.soldCount).toBe(2);
  });
});

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
