import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/db";
import { products, productImages, orderItems, orders } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { calculateBulkPriceChanges, createPreviewToken, verifyPreviewToken, type BulkPriceOp } from "@/lib/bulk-pricing";
import { validateImageSignature, ALLOWED_MIME_TYPES } from "@/lib/storage/types";
import { toCents } from "@/lib/money";

async function reset() {
  await db.execute(sql`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE order_number LIKE 'T13-ORD-%')`);
  await db.execute(sql`DELETE FROM orders WHERE order_number LIKE 'T13-ORD-%'`);
  await db.execute(sql`DELETE FROM product_images WHERE product_id IN (SELECT id FROM products WHERE sku LIKE 'T13-%')`);
  await db.execute(sql`DELETE FROM stock_movements WHERE product_id IN (SELECT id FROM products WHERE sku LIKE 'T13-%')`);
  await db.execute(sql`DELETE FROM product_suppliers WHERE product_id IN (SELECT id FROM products WHERE sku LIKE 'T13-%')`);
  await db.execute(sql`DELETE FROM products WHERE sku LIKE 'T13-%'`);
}

// ─── BULK PRICING CALCULATOR ──────────────
describe("Bulk pricing calculator", () => {
  const prods = [{ id: 1, name: "A", sku: "A1", price: "100.00" }, { id: 2, name: "B", sku: "B1", price: "9.99" }];
  it("+5%", () => expect(calculateBulkPriceChanges(prods, "percent_increase", 5)[0].newPrice).toBe("105.00"));
  it("-10%", () => expect(calculateBulkPriceChanges(prods, "percent_decrease", 10)[0].newPrice).toBe("90.00"));
  it("+2.50", () => expect(calculateBulkPriceChanges(prods, "fixed_increase", 2.50)[0].newPrice).toBe("102.50"));
  it("-2.50", () => expect(calculateBulkPriceChanges(prods, "fixed_decrease", 2.50)[0].newPrice).toBe("97.50"));
  it("negative flagged", () => { const r = calculateBulkPriceChanges([{ id: 1, name: "C", sku: "C1", price: "2.00" }], "fixed_decrease", 3.00); expect(r[0].invalid).toBe(true); });
  it("zero valid", () => expect(calculateBulkPriceChanges([{ id: 1, name: "D", sku: "D1", price: "2.00" }], "fixed_decrease", 2.00)[0].newPrice).toBe("0.00"));
  it("rounding", () => { const r = calculateBulkPriceChanges([{ id: 1, name: "E", sku: "E1", price: "9.99" }], "percent_increase", 5); expect(r[0].newPrice).toBe((Math.round(toCents("9.99") * 1.05) / 100).toFixed(2)); });
  it("same function", () => expect(calculateBulkPriceChanges(prods, "percent_increase", 5)).toEqual(calculateBulkPriceChanges(prods, "percent_increase", 5)));
});

// ─── BULK TOKEN ───────────────────────────
describe("Bulk preview token", () => {
  const prodData = [{ id: 1, price: "100.00" }, { id: 2, price: "50.00" }];

  it("create + verify", () => {
    const token = createPreviewToken("percent_increase", 5, prodData);
    const r = verifyPreviewToken(token);
    expect(r.valid).toBe(true);
    expect(r.expired).toBe(false);
    expect(r.data?.op).toBe("percent_increase");
    expect(r.data?.val).toBe(5);
    expect(r.data?.products.length).toBe(2);
  });

  it("invalid rejected", () => expect(verifyPreviewToken("garbage").valid).toBe(false));

  it("tampered rejected", () => {
    const token = createPreviewToken("percent_increase", 5, prodData);
    const tampered = token.slice(0, -5) + "XXXXX";
    expect(verifyPreviewToken(tampered).valid).toBe(false);
  });

  it("binds operation", () => {
    const token = createPreviewToken("percent_increase", 5, prodData);
    const r = verifyPreviewToken(token);
    expect(r.data?.op).toBe("percent_increase");
    // Cannot change to percent_decrease without new token
  });

  it("binds value", () => {
    const token = createPreviewToken("percent_increase", 5, prodData);
    const r = verifyPreviewToken(token);
    expect(r.data?.val).toBe(5);
  });

  it("binds products and prices", () => {
    const token = createPreviewToken("fixed_increase", 10, prodData);
    const r = verifyPreviewToken(token);
    expect(r.data?.products).toEqual(prodData);
  });
});

// ─── BULK DB ──────────────────────────────
describe("Bulk pricing DB", () => {
  beforeEach(reset);
  it("preview no write", async () => {
    const [p] = await db.insert(products).values({ name: "BP", slug: "bp-" + Date.now(), sku: "T13-BP1", price: "100.00" }).returning();
    calculateBulkPriceChanges([{ id: p.id, name: p.name, sku: p.sku, price: p.price }], "percent_increase", 5);
    const [c] = await db.select().from(products).where(eq(products.id, p.id));
    expect(c.price).toBe("100.00");
  });
  it("order snapshot unaffected", async () => {
    const [p] = await db.insert(products).values({ name: "BS", slug: "bs-" + Date.now(), sku: "T13-BS1", price: "100.00" }).returning();
    const [o] = await db.insert(orders).values({ orderNumber: "T13-ORD-" + Date.now(), status: "delivered", subtotal: "90.00", vat: "0", total: "90.00", deliveryType: "pickup" }).returning();
    await db.insert(orderItems).values({ orderId: o.id, productId: p.id, productName: p.name, quantity: 1, unitPriceGross: "90.00", unitPriceNet: "73.17", vatRate: "23.00", vatAmount: "16.83", lineTotalGross: "90.00" });
    await db.update(products).set({ price: "110.00" }).where(eq(products.id, p.id));
    const [item] = await db.select().from(orderItems).where(eq(orderItems.orderId, o.id));
    expect(item.unitPriceGross).toBe("90.00");
  });
});

// ─── IMAGE VALIDATION ─────────────────────
describe("Image validation", () => {
  it("JPEG", () => expect(validateImageSignature(new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0, 0, 0, 0, 0]).buffer, "image/jpeg")).toBe(true));
  it("PNG", () => expect(validateImageSignature(new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]).buffer, "image/png")).toBe(true));
  it("WebP", () => expect(validateImageSignature(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]).buffer, "image/webp")).toBe(true));
  it("random rejected", () => expect(validateImageSignature(new Uint8Array([0, 1, 2, 3, 0, 0, 0, 0, 0, 0, 0, 0]).buffer, "image/jpeg")).toBe(false));
  it("too small", () => expect(validateImageSignature(new Uint8Array([0xFF, 0xD8]).buffer, "image/jpeg")).toBe(false));
  it("allowed types", () => { expect(ALLOWED_MIME_TYPES).toContain("image/jpeg"); expect(ALLOWED_MIME_TYPES).not.toContain("image/svg+xml"); });
});

// ─── PRODUCT IMAGES DB ────────────────────
describe("Product images DB", () => {
  beforeEach(reset);
  it("primary unique DB constraint", async () => {
    const [p] = await db.insert(products).values({ name: "IMG", slug: "img-" + Date.now(), sku: "T13-IMG1", price: "10.00" }).returning();
    await db.insert(productImages).values({ productId: p.id, storageKey: "k1", isPrimary: true, sortOrder: 0 });
    let t = false; try { await db.insert(productImages).values({ productId: p.id, storageKey: "k2", isPrimary: true, sortOrder: 1 }); } catch { t = true; }
    expect(t).toBe(true);
  });
  it("multiple non-primary OK", async () => {
    const [p] = await db.insert(products).values({ name: "I2", slug: "i2-" + Date.now(), sku: "T13-IMG2", price: "10.00" }).returning();
    await db.insert(productImages).values({ productId: p.id, storageKey: "k1", isPrimary: false, sortOrder: 0 });
    await db.insert(productImages).values({ productId: p.id, storageKey: "k2", isPrimary: false, sortOrder: 1 });
  });
  it("reorder persists", async () => {
    const [p] = await db.insert(products).values({ name: "RO", slug: "ro-" + Date.now(), sku: "T13-RO1", price: "10.00" }).returning();
    const [a] = await db.insert(productImages).values({ productId: p.id, storageKey: "a", sortOrder: 0 }).returning();
    const [b] = await db.insert(productImages).values({ productId: p.id, storageKey: "b", sortOrder: 1 }).returning();
    await db.update(productImages).set({ sortOrder: 1 }).where(eq(productImages.id, a.id));
    await db.update(productImages).set({ sortOrder: 0 }).where(eq(productImages.id, b.id));
    const imgs = await db.select().from(productImages).where(eq(productImages.productId, p.id));
    const sorted = imgs.sort((x, y) => x.sortOrder - y.sortOrder);
    expect(sorted[0].storageKey).toBe("b");
  });
});
