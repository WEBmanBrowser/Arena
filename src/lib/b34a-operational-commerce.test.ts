import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/db";
import { invoiceDocuments, orders, products, shippingClasses, settings, auditLogs } from "@/db/schema";
import { and, eq, like, sql } from "drizzle-orm";
import {
  calculateShippingForCart,
  ensureDefaultShippingConfiguration,
  updateFreeShippingSettings,
  ShippingRateError,
} from "@/lib/shipping-rates";
import { ManualInvoicingError, recordManualInvoice } from "@/lib/manual-invoicing";

async function classId(key: string) {
  const [row] = await db.select({ id: shippingClasses.id }).from(shippingClasses).where(eq(shippingClasses.key, key)).limit(1);
  if (!row) throw new Error(`missing class ${key}`);
  return row.id;
}

async function createProduct(suffix: string, shippingClassKey = "small") {
  const id = shippingClassKey ? await classId(shippingClassKey) : null;
  const [p] = await db.insert(products).values({
    name: `B34A Product ${suffix}`,
    slug: `b34a-product-${suffix}-${Date.now()}`,
    sku: `B34A-${suffix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    price: "20.00",
    vatRate: "23.00",
    stock: 20,
    reservedStock: 0,
    shippingClassId: id,
    isActive: true,
  }).returning();
  return p;
}

async function createOrder(total = "127.90") {
  const [order] = await db.insert(orders).values({
    orderNumber: `B34A-ORD-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    status: "paid",
    paymentStatus: "paid",
    subtotal: "120.00",
    shipping: "7.90",
    total,
    deliveryType: "shipping",
  }).returning();
  return order;
}

beforeEach(async () => {
  await ensureDefaultShippingConfiguration();
  await db.delete(invoiceDocuments).where(eq(invoiceDocuments.provider, "manual"));
  await db.delete(auditLogs).where(like(auditLogs.action, "manual_invoice%"));
  await db.delete(products).where(like(products.sku, "B34A-%"));
  await db.update(shippingClasses).set({ isActive: true, rateCents: sql`CASE WHEN key = 'small' THEN 490 WHEN key = 'large' THEN 790 ELSE rate_cents END`, priority: sql`CASE WHEN key = 'small' THEN 10 WHEN key = 'large' THEN 20 ELSE priority END` });
  await updateFreeShippingSettings({ enabled: true, thresholdCents: 10_000 });
  await db.update(settings).set({ value: "manual" }).where(eq(settings.key, "invoice_mode"));
});

describe("B.3.4A shipping calculation", () => {
  it("charges the highest applicable active priority once for mixed delivery carts", async () => {
    const small = await createProduct("SMALL", "small");
    const large = await createProduct("LARGE", "large");

    const quote = await calculateShippingForCart({
      items: [{ productId: small.id, quantity: 10 }, { productId: large.id, quantity: 3 }],
      deliveryType: "shipping",
      merchandiseAfterDiscountCents: 9_999,
    });

    expect(quote.shippingCents).toBe(790);
    expect(quote.winningClass?.key).toBe("large");
    expect(quote.freeShippingApplied).toBe(false);
  });

  it("applies the post-discount merchandise free-shipping boundary at 10000 cents", async () => {
    const product = await createProduct("FREE", "large");
    const below = await calculateShippingForCart({ items: [{ productId: product.id, quantity: 1 }], deliveryType: "shipping", merchandiseAfterDiscountCents: 9_999 });
    const at = await calculateShippingForCart({ items: [{ productId: product.id, quantity: 1 }], deliveryType: "shipping", merchandiseAfterDiscountCents: 10_000 });

    expect(below.shippingCents).toBe(790);
    expect(at.shippingCents).toBe(0);
    expect(at.freeShippingApplied).toBe(true);
  });

  it("preserves store pickup at zero without applying class pricing", async () => {
    const product = await createProduct("PICKUP", "large");
    const quote = await calculateShippingForCart({ items: [{ productId: product.id, quantity: 1 }], deliveryType: "pickup", merchandiseAfterDiscountCents: 1_000 });
    expect(quote.shippingCents).toBe(0);
    expect(quote.winningClass).toBeNull();
    expect(quote.freeShippingApplied).toBe(false);
  });

  it("fails closed for delivery when a physical product class is missing or inactive", async () => {
    const noClass = await createProduct("NOCLASS", "small");
    await db.update(products).set({ shippingClassId: null }).where(eq(products.id, noClass.id));
    await expect(calculateShippingForCart({ items: [{ productId: noClass.id, quantity: 1 }], deliveryType: "shipping", merchandiseAfterDiscountCents: 1_000 }))
      .rejects.toBeInstanceOf(ShippingRateError);

    const inactive = await createProduct("INACTIVE", "small");
    await db.update(shippingClasses).set({ isActive: false }).where(eq(shippingClasses.key, "small"));
    await expect(calculateShippingForCart({ items: [{ productId: inactive.id, quantity: 1 }], deliveryType: "shipping", merchandiseAfterDiscountCents: 1_000 }))
      .rejects.toMatchObject({ code: "SHIPPING_CLASS_INACTIVE" });
  });
});

describe("B.3.4A manual invoicing", () => {
  it("records an immutable manual invoice snapshot from the authoritative order total", async () => {
    const order = await createOrder("127.90");
    const doc = await recordManualInvoice({ orderId: order.id, actorUserId: 1, officialReference: "FT 2026/9001", issuedAt: new Date("2026-09-01T10:00:00.000Z") });

    expect(doc.provider).toBe("manual");
    expect(doc.source).toBe("manual");
    expect(doc.status).toBe("issued");
    expect(doc.amountCents).toBe(12_790);
    expect(doc.currency).toBe("EUR");
    expect(doc.documentNumber).toBe("FT 2026/9001");
  });

  it("prevents duplicate normal manual invoices with PostgreSQL uniqueness under concurrency", async () => {
    const order = await createOrder("20.00");
    const attempts = await Promise.allSettled([
      recordManualInvoice({ orderId: order.id, actorUserId: 1, officialReference: "FT 2026/CONC-A", issuedAt: new Date() }),
      recordManualInvoice({ orderId: order.id, actorUserId: 1, officialReference: "FT 2026/CONC-B", issuedAt: new Date() }),
    ]);
    expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((a) => a.status === "rejected" && (a.reason as ManualInvoicingError).code === "DUPLICATE_INVOICE")).toHaveLength(1);
  });

  it("fails closed when invoice mode is not manual", async () => {
    const order = await createOrder("20.00");
    await db.update(settings).set({ value: "automatic" }).where(eq(settings.key, "invoice_mode"));
    await expect(recordManualInvoice({ orderId: order.id, actorUserId: 1, officialReference: "FT 2026/AUTO", issuedAt: new Date() }))
      .rejects.toMatchObject({ code: "AUTOMATIC_INVOICING_UNAVAILABLE" });
  });
});
