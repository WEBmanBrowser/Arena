import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { auditLogs, coupons, invoiceDocuments, orderItems, orderStatusHistory, orders, payments, products, settings, shippingClasses, stockMovements, users } from "@/db/schema";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { calculateShippingForCart, ensureDefaultShippingConfiguration, updateFreeShippingSettings, ShippingRateError } from "@/lib/shipping-rates";
import { ManualInvoicingError, recordManualInvoice } from "@/lib/manual-invoicing";
import { getAccountOrderDetail } from "@/lib/services/admin-customers-service";
import { POST as quotePOST } from "@/app/api/cart/quote/route";
import { POST as orderPOST } from "@/app/api/orders/route";
import { markInvoiceDocumentIssued } from "@/lib/providers/invoice-provider";

async function cleanupB34A() {
  const productRows = await db.select({ id: products.id }).from(products).where(like(products.sku, "B34A-%"));
  const productIds = productRows.map((p) => p.id);
  const b34aOrders = productIds.length
    ? await db.selectDistinct({ id: orderItems.orderId }).from(orderItems).where(inArray(orderItems.productId, productIds))
    : [];
  const explicitB34AOrders = await db.select({ id: orders.id }).from(orders).where(like(orders.orderNumber, "B34A%"));
  const orderIds = [...new Set([...b34aOrders, ...explicitB34AOrders].map((o) => o.id))];
  if (orderIds.length) {
    await db.delete(invoiceDocuments).where(inArray(invoiceDocuments.orderId, orderIds));
    await db.delete(payments).where(inArray(payments.orderId, orderIds));
    await db.delete(orderStatusHistory).where(inArray(orderStatusHistory.orderId, orderIds));
    await db.delete(orderItems).where(inArray(orderItems.orderId, orderIds));
    await db.delete(stockMovements).where(and(eq(stockMovements.referenceType, "order"), inArray(stockMovements.referenceId, orderIds)));
    await db.delete(orders).where(inArray(orders.id, orderIds));
  }
  await db.delete(invoiceDocuments).where(eq(invoiceDocuments.provider, "manual"));
  await db.delete(auditLogs).where(like(auditLogs.action, "%invoice%"));
  await db.delete(products).where(like(products.sku, "B34A-%"));
  await db.delete(coupons).where(like(coupons.code, "B34A_%"));
  await db.delete(users).where(like(users.email, "b34a-%@test.local"));
}

async function classId(key: string) {
  const [row] = await db.select({ id: shippingClasses.id }).from(shippingClasses).where(eq(shippingClasses.key, key)).limit(1);
  if (!row) throw new Error(`missing class ${key}`);
  return row.id;
}

async function createProduct(suffix: string, shippingClassKey = "small", price = "20.00") {
  const id = shippingClassKey ? await classId(shippingClassKey) : null;
  const [p] = await db.insert(products).values({
    name: `B34A Product ${suffix}`,
    slug: `b34a-product-${suffix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    sku: `B34A-${suffix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    price,
    vatRate: "23.00",
    stock: 20,
    reservedStock: 0,
    shippingClassId: id,
    isActive: true,
  }).returning();
  return p;
}

async function createOrder(total = "127.90", status = "pending_payment", paymentStatus = "pending") {
  const [order] = await db.insert(orders).values({
    orderNumber: `B34A-ORD-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    status,
    paymentStatus,
    subtotal: "120.00",
    shipping: "7.90",
    total,
    deliveryType: "shipping",
    paymentMethod: "bank_transfer",
  }).returning();
  await db.insert(payments).values({ orderId: order.id, provider: "manual", method: "bank_transfer", amount: total, currency: "EUR", status: paymentStatus });
  return order;
}

function req(url: string, body: unknown) {
  return new NextRequest(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

async function createOrderViaRoute(productId: number, body: Record<string, unknown> = {}) {
  const res = await orderPOST(req("http://localhost/api/orders", {
    items: [{ productId, quantity: 1, price: "0.01", shippingClass: "client-fake" }],
    deliveryType: "shipping",
    paymentMethod: "bank_transfer",
    guestEmail: `b34a-guest-${Date.now()}@test.local`,
    guestName: "B34A Guest",
    shippingPrice: 1,
    shippingCents: 1,
    freeShipping: true,
    freeShippingThreshold: 0,
    shippingClass: "client-fake",
    ...body,
  }));
  const data = await res.json();
  expect(res.status).toBe(200);
  await db.update(orders).set({ orderNumber: `B34A-ROUTEORDER-${data.order.id}` }).where(eq(orders.id, data.order.id));
  const [order] = await db.select().from(orders).where(eq(orders.id, data.order.id)).limit(1);
  return order;
}

beforeEach(async () => {
  await cleanupB34A();
  await ensureDefaultShippingConfiguration();
  await db.update(shippingClasses).set({
    isActive: true,
    rateCents: sql`CASE WHEN key = 'small' THEN 490 WHEN key = 'large' THEN 790 ELSE rate_cents END`,
    priority: sql`CASE WHEN key = 'small' THEN 10 WHEN key = 'large' THEN 20 ELSE priority END`,
  });
  await updateFreeShippingSettings({ enabled: true, thresholdCents: 10_000 });
  await db.update(settings).set({ value: "manual" }).where(eq(settings.key, "invoice_mode"));
});

describe("B.3.4A shipping calculation", () => {
  it("covers small, multiple-small, large, mixed and multiple-large cart semantics", async () => {
    const small1 = await createProduct("SMALL1", "small");
    const small2 = await createProduct("SMALL2", "small");
    const large1 = await createProduct("LARGE1", "large");
    const large2 = await createProduct("LARGE2", "large");

    expect((await calculateShippingForCart({ items: [{ productId: small1.id, quantity: 1 }], deliveryType: "shipping", merchandiseAfterDiscountCents: 1_000 })).shippingCents).toBe(490);
    expect((await calculateShippingForCart({ items: [{ productId: small1.id, quantity: 3 }, { productId: small2.id, quantity: 2 }], deliveryType: "shipping", merchandiseAfterDiscountCents: 1_000 })).shippingCents).toBe(490);
    expect((await calculateShippingForCart({ items: [{ productId: large1.id, quantity: 1 }], deliveryType: "shipping", merchandiseAfterDiscountCents: 1_000 })).shippingCents).toBe(790);
    expect((await calculateShippingForCart({ items: [{ productId: small1.id, quantity: 1 }, { productId: large1.id, quantity: 1 }], deliveryType: "shipping", merchandiseAfterDiscountCents: 1_000 })).shippingCents).toBe(790);
    expect((await calculateShippingForCart({ items: [{ productId: large1.id, quantity: 1 }, { productId: large2.id, quantity: 2 }], deliveryType: "shipping", merchandiseAfterDiscountCents: 1_000 })).shippingCents).toBe(790);
  });

  it("proves priority beats price", async () => {
    await db.update(shippingClasses).set({ rateCents: 500, priority: 30 }).where(eq(shippingClasses.key, "small"));
    await db.update(shippingClasses).set({ rateCents: 900, priority: 20 }).where(eq(shippingClasses.key, "large"));
    const highPriorityLowPrice = await createProduct("PRIORITY", "small");
    const lowPriorityHighPrice = await createProduct("PRICE", "large");

    const quote = await calculateShippingForCart({ items: [{ productId: highPriorityLowPrice.id, quantity: 1 }, { productId: lowPriorityHighPrice.id, quantity: 1 }], deliveryType: "shipping", merchandiseAfterDiscountCents: 1_000 });
    expect(quote.winningClass?.key).toBe("small");
    expect(quote.shippingCents).toBe(500);
  });

  it("applies exact free-shipping boundary on post-discount merchandise only", async () => {
    const product = await createProduct("FREE", "large");
    expect((await calculateShippingForCart({ items: [{ productId: product.id, quantity: 1 }], deliveryType: "shipping", merchandiseAfterDiscountCents: 9_999 })).shippingCents).toBe(790);
    expect((await calculateShippingForCart({ items: [{ productId: product.id, quantity: 1 }], deliveryType: "shipping", merchandiseAfterDiscountCents: 10_000 })).shippingCents).toBe(0);
    expect((await calculateShippingForCart({ items: [{ productId: product.id, quantity: 1 }], deliveryType: "shipping", merchandiseAfterDiscountCents: 10_001 })).shippingCents).toBe(0);
  });

  it("coupon interactions use after-discount merchandise before shipping, including percentage coupons", async () => {
    const p9500 = await createProduct("COUPON9500", "small", "105.00");
    const p10000 = await createProduct("COUPON10000", "small", "110.00");
    const pPercent = await createProduct("COUPONPCT", "small", "125.00");
    await db.insert(coupons).values([
      { code: "B34A_FIXED_10A", type: "fixed", value: "10.00", isActive: true },
      { code: "B34A_FIXED_10B", type: "fixed", value: "10.00", isActive: true },
      { code: "B34A_PCT_20", type: "percentage", value: "20.00", isActive: true },
    ]);

    const paid = await quotePOST(req("http://localhost/api/cart/quote", { items: [{ productId: p9500.id, quantity: 1 }], couponCode: "B34A_FIXED_10A", deliveryType: "shipping", freeShipping: true }));
    expect((await paid.json()).shipping).toBe("4.90");
    const free = await quotePOST(req("http://localhost/api/cart/quote", { items: [{ productId: p10000.id, quantity: 1 }], couponCode: "B34A_FIXED_10B", deliveryType: "shipping" }));
    expect((await free.json()).shipping).toBe("0.00");
    const pct = await quotePOST(req("http://localhost/api/cart/quote", { items: [{ productId: pPercent.id, quantity: 1 }], couponCode: "B34A_PCT_20", deliveryType: "shipping" }));
    expect((await pct.json()).shipping).toBe("0.00");
  });

  it("pickup remains zero and ignores class state/rate/threshold", async () => {
    const product = await createProduct("PICKUP", "large");
    await db.update(shippingClasses).set({ isActive: false, rateCents: 9999 }).where(eq(shippingClasses.key, "large"));
    await updateFreeShippingSettings({ enabled: false, thresholdCents: 1 });
    const quote = await calculateShippingForCart({ items: [{ productId: product.id, quantity: 1 }], deliveryType: "pickup", merchandiseAfterDiscountCents: 1_000 });
    expect(quote.shippingCents).toBe(0);
    expect(quote.winningClass).toBeNull();
  });

  it("fails closed for inactive, missing and corrupted delivery classes", async () => {
    const noClass = await createProduct("NOCLASS", "small");
    await db.update(products).set({ shippingClassId: null }).where(eq(products.id, noClass.id));
    await expect(calculateShippingForCart({ items: [{ productId: noClass.id, quantity: 1 }], deliveryType: "shipping", merchandiseAfterDiscountCents: 1_000 })).rejects.toMatchObject({ code: "SHIPPING_CLASS_MISSING" });

    const inactive = await createProduct("INACTIVE", "small");
    await db.update(shippingClasses).set({ isActive: false }).where(eq(shippingClasses.key, "small"));
    await expect(calculateShippingForCart({ items: [{ productId: inactive.id, quantity: 1 }], deliveryType: "shipping", merchandiseAfterDiscountCents: 1_000 })).rejects.toMatchObject({ code: "SHIPPING_CLASS_INACTIVE" });

    await db.update(shippingClasses).set({ isActive: true }).where(eq(shippingClasses.key, "small"));
    await expect(calculateShippingForCart({ items: [{ productId: 999_999_999, quantity: 1 }], deliveryType: "shipping", merchandiseAfterDiscountCents: 1_000 })).rejects.toBeInstanceOf(ShippingRateError);
  });

  it("invalid threshold data falls back safely instead of becoming free shipping", async () => {
    const product = await createProduct("BADSETTING", "small");
    await db.update(settings).set({ value: "hello" }).where(eq(settings.key, "shipping_free_threshold_cents"));
    const quote = await calculateShippingForCart({ items: [{ productId: product.id, quantity: 1 }], deliveryType: "shipping", merchandiseAfterDiscountCents: 9_999 });
    expect(quote.freeShippingThresholdCents).toBe(10_000);
    expect(quote.shippingCents).toBe(490);
  });
});

describe("B.3.4A quote/order authority and snapshots", () => {
  it("ignores client-tampered shipping price/class/free flags and includes gross shipping VAT", async () => {
    const product = await createProduct("TAMPER", "small", "20.00");
    const quote = await quotePOST(req("http://localhost/api/cart/quote", { items: [{ productId: product.id, quantity: 1, price: "0.01", shippingClass: "large" }], deliveryType: "shipping", shippingPrice: 0, shippingCents: 0, freeShipping: true, freeShippingThreshold: 0 }));
    const quoteBody = await quote.json();
    expect(quoteBody.shipping).toBe("4.90");
    expect(quoteBody.shippingClass.key).toBe("small");
    expect(quoteBody.vat).toBe("4.66"); // 20.00 gross @23% + 4.90 gross shipping @23%

    const order = await createOrderViaRoute(product.id);
    expect(order.shipping).toBe("4.90");
    expect(order.shippingMethod).toBe("small");
    expect(order.vat).toBe("4.66");
  });

  it("recalculates order shipping after a stale quote and preserves historical snapshots", async () => {
    const product = await createProduct("SNAPSHOT", "small", "20.00");
    await updateFreeShippingSettings({ enabled: false, thresholdCents: 0 });
    await db.update(shippingClasses).set({ rateCents: 490 }).where(eq(shippingClasses.key, "small"));
    const oldOrder = await createOrderViaRoute(product.id);
    expect(oldOrder.shipping).toBe("4.90");

    await db.update(shippingClasses).set({ rateCents: 590 }).where(eq(shippingClasses.key, "small"));
    const [oldAfterChange] = await db.select().from(orders).where(eq(orders.id, oldOrder.id)).limit(1);
    const newOrder = await createOrderViaRoute(product.id);
    expect(oldAfterChange.shipping).toBe("4.90");
    expect(newOrder.shipping).toBe("5.90");
  });

  it("pickup orders create no shipment rows", async () => {
    const product = await createProduct("PICKUPORDER", "small", "20.00");
    const order = await createOrderViaRoute(product.id, { deliveryType: "pickup" });
    expect(order.shipping).toBe("0.00");
    expect(order.deliveryType).toBe("pickup");
    const shipments = await db.execute(sql`SELECT count(*)::int AS count FROM shipments WHERE order_id = ${order.id}`);
    expect(Number(shipments.rows[0].count)).toBe(0);
  });
});

describe("B.3.4A manual invoicing", () => {
  it("records amount/currency from authoritative order and has no payment/order/stock side effects", async () => {
    const order = await createOrder("127.90", "pending_payment", "pending");
    const paymentsBefore = await db.select().from(payments).where(eq(payments.orderId, order.id));
    const stockBefore = await db.select().from(stockMovements).where(eq(stockMovements.referenceId, order.id));

    const doc = await recordManualInvoice({ orderId: order.id, actorUserId: 1, officialReference: "FT 2026/9001", issuedAt: new Date("2026-09-01T10:00:00.000Z") });
    const [orderAfter] = await db.select().from(orders).where(eq(orders.id, order.id));
    const paymentsAfter = await db.select().from(payments).where(eq(payments.orderId, order.id));
    const stockAfter = await db.select().from(stockMovements).where(eq(stockMovements.referenceId, order.id));

    expect(doc.provider).toBe("manual");
    expect(doc.source).toBe("manual");
    expect(doc.status).toBe("issued");
    expect(doc.amountCents).toBe(12_790);
    expect(doc.currency).toBe("EUR");
    expect(orderAfter.status).toBe("pending_payment");
    expect(orderAfter.paymentStatus).toBe("pending");
    expect(paymentsAfter).toEqual(paymentsBefore);
    expect(stockAfter).toEqual(stockBefore);
  });

  it("prevents sequential and concurrent duplicate normal manual invoices with PostgreSQL uniqueness", async () => {
    const order = await createOrder("20.00");
    await recordManualInvoice({ orderId: order.id, actorUserId: 1, officialReference: "FT 2026/SEQ", issuedAt: new Date() });
    await expect(recordManualInvoice({ orderId: order.id, actorUserId: 1, officialReference: "FT 2026/SEQ2", issuedAt: new Date() })).rejects.toMatchObject({ code: "DUPLICATE_INVOICE" });

    const concurrentOrder = await createOrder("20.00");
    const attempts = await Promise.allSettled([
      recordManualInvoice({ orderId: concurrentOrder.id, actorUserId: 1, officialReference: "FT 2026/CONC-A", issuedAt: new Date() }),
      recordManualInvoice({ orderId: concurrentOrder.id, actorUserId: 1, officialReference: "FT 2026/CONC-B", issuedAt: new Date() }),
    ]);
    expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((a) => a.status === "rejected" && (a.reason as ManualInvoicingError).code === "DUPLICATE_INVOICE")).toHaveLength(1);
    const rows = await db.select().from(invoiceDocuments).where(eq(invoiceDocuments.orderId, concurrentOrder.id));
    expect(rows).toHaveLength(1);
    const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.action, "manual_invoice.recorded"), eq(auditLogs.entity, "invoice_document")));
    expect(audits.length).toBeGreaterThanOrEqual(2);
  });

  it("issued records are not rewritten by existing provider transition helpers", async () => {
    const order = await createOrder("20.00");
    const doc = await recordManualInvoice({ orderId: order.id, actorUserId: 1, officialReference: "FT 2026/IMM", issuedAt: new Date("2026-09-01T10:00:00Z") });
    await expect(markInvoiceDocumentIssued(doc.id, { providerDocumentId: "OTHER", documentNumber: "OTHER", issuedAt: new Date("2026-09-02T10:00:00Z") })).rejects.toBeTruthy();
    const [after] = await db.select().from(invoiceDocuments).where(eq(invoiceDocuments.id, doc.id));
    expect(after.amountCents).toBe(doc.amountCents);
    expect(after.currency).toBe("EUR");
    expect(after.source).toBe("manual");
    expect(after.providerDocumentId).toBe("FT 2026/IMM");
    expect(after.issuedAt?.toISOString()).toBe("2026-09-01T10:00:00.000Z");
    expect(after.documentType).toBe("invoice");
  });

  it("fails closed when invoice mode is not manual and validates references", async () => {
    const order = await createOrder("20.00");
    await expect(recordManualInvoice({ orderId: order.id, actorUserId: 1, officialReference: "   ", issuedAt: new Date() })).rejects.toMatchObject({ code: "INVALID_REFERENCE" });
    await db.update(settings).set({ value: "automatic" }).where(eq(settings.key, "invoice_mode"));
    await expect(recordManualInvoice({ orderId: order.id, actorUserId: 1, officialReference: "FT 2026/AUTO", issuedAt: new Date() })).rejects.toMatchObject({ code: "AUTOMATIC_INVOICING_UNAVAILABLE" });
  });

  it("customer account order detail is IDOR-safe for invoice metadata", async () => {
    const [owner] = await db.insert(users).values({ email: `b34a-owner-${Date.now()}@test.local`, password: "hash", name: "Owner", role: "customer" }).returning();
    const [other] = await db.insert(users).values({ email: `b34a-other-${Date.now()}@test.local`, password: "hash", name: "Other", role: "customer" }).returning();
    const order = await createOrder("20.00");
    await db.update(orders).set({ userId: owner.id }).where(eq(orders.id, order.id));
    await recordManualInvoice({ orderId: order.id, actorUserId: 1, officialReference: "FT 2026/IDOR", issuedAt: new Date() });

    const own = await getAccountOrderDetail(order.id, owner.id);
    const foreign = await getAccountOrderDetail(order.id, other.id);
    const unauth = await getAccountOrderDetail(order.id, -1);
    expect(own?.invoiceDocuments).toHaveLength(1);
    expect(foreign).toBeNull();
    expect(unauth).toBeNull();
  });
});
