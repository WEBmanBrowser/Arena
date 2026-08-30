/**
 * V30 Behavioral tests — PRODUCTION LOGIC = TESTED LOGIC.
 * Services AND operation handlers used by routes are the same ones tested here.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/db";
import { products, productImages, productSuppliers, suppliers, orders, orderItems, categories, auditLogs, users } from "@/db/schema";
import { eq, sql, and, inArray, desc } from "drizzle-orm";

import { bulkTargetSchema } from "@/lib/bulk-schemas";
import { resolveTargetIds, BULK_LIMIT, previewBulkPricing } from "@/lib/services/bulk-pricing-service";
import { reorderImages } from "@/lib/services/product-image-service";
import { executeBulkPriceApply, executeImageAltUpdate, executeImageDelete, executeProductSupplierDelete } from "@/lib/services/admin-operations";
import { sanitizeForPublic, getPublicProductImages, getPrimaryImageUrls } from "@/lib/public-products";
import { buildAdminProductConditions } from "@/lib/product-filters";
import { getCategoryAndDescendantIds } from "@/lib/category-descendants";
import { createPreviewToken, verifyPreviewToken, PREVIEW_EXPIRY_MS } from "@/lib/bulk-pricing";
import { createHmac } from "crypto";

// Real test actor — created in DB with valid FK for audit_logs
let ACTOR_ID: number;

async function ensureTestActor() {
  const email = "v30-test-actor@mdtech.test";
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing) { ACTOR_ID = existing.id; return; }
  const [actor] = await db.insert(users).values({
    email, name: "V30 Test Actor", password: "$2a$12$test-hash-not-real-but-valid-length-placeholder", role: "admin",
  }).returning();
  ACTOR_ID = actor.id;
}

async function reset() {
  await ensureTestActor();
  await db.execute(sql`DELETE FROM order_status_history WHERE order_id IN (SELECT id FROM orders WHERE order_number LIKE 'V30-%')`);
  await db.execute(sql`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE order_number LIKE 'V30-%')`);
  await db.execute(sql`DELETE FROM payments WHERE order_id IN (SELECT id FROM orders WHERE order_number LIKE 'V30-%')`);
  await db.execute(sql`DELETE FROM orders WHERE order_number LIKE 'V30-%'`);
  await db.execute(sql`DELETE FROM product_images WHERE product_id IN (SELECT id FROM products WHERE sku LIKE 'V30-%')`);
  await db.execute(sql`DELETE FROM stock_movements WHERE product_id IN (SELECT id FROM products WHERE sku LIKE 'V30-%')`);
  await db.execute(sql`DELETE FROM product_suppliers WHERE product_id IN (SELECT id FROM products WHERE sku LIKE 'V30-%')`);
  await db.execute(sql`DELETE FROM products WHERE sku LIKE 'V30-%'`);
  await db.execute(sql`DELETE FROM suppliers WHERE name LIKE 'V30 %'`);
  await db.execute(sql`DELETE FROM categories WHERE slug LIKE 'v30-%'`);
  // Audit cleanup for this test suite's actions
  await db.execute(sql`DELETE FROM audit_logs WHERE user_id = ${ACTOR_ID}`);
}

// ═══ BULK SCHEMAS ═════════════════════════════════════════
describe("Bulk schemas (shared, strict)", () => {
  it("selection valid", () => expect(bulkTargetSchema.safeParse({ type: "selection", productIds: [1] }).success).toBe(true));
  it("filters valid", () => expect(bulkTargetSchema.safeParse({ type: "filters" }).success).toBe(true));
  it("selection+filters strict", () => expect(bulkTargetSchema.safeParse({ type: "selection", productIds: [1], filters: {} }).success).toBe(false));
  it("filters+productIds strict", () => expect(bulkTargetSchema.safeParse({ type: "filters", productIds: [1] }).success).toBe(false));
  it("type banana", () => expect(bulkTargetSchema.safeParse({ type: "banana" }).success).toBe(false));
  it("duplicate IDs", () => expect(bulkTargetSchema.safeParse({ type: "selection", productIds: [1, 1] }).success).toBe(false));
});

// ═══ BULK 5000/5001 ═══════════════════════════════════════
describe("Bulk 5001 via REAL resolveTargetIds", () => {
  it("5000 → allowed", async () => {
    const ids = await resolveTargetIds({ type: "filters" }, async () => Array.from({ length: 5000 }, (_, i) => ({ id: i + 1 })));
    expect(ids.length).toBe(5000);
  });
  it("5001 → BULK_TOO_MANY_PRODUCTS", async () => {
    await expect(resolveTargetIds({ type: "filters" }, async () => Array.from({ length: 5001 }, (_, i) => ({ id: i + 1 })))).rejects.toThrow("BULK_TOO_MANY_PRODUCTS");
  });
});

// ═══ BULK SERVICE ═════════════════════════════════════════
describe("Bulk pricing", () => {
  beforeEach(reset);

  it("preview no-write", async () => {
    const [p] = await db.insert(products).values({ name: "V30-PV", slug: "v29-pv-" + Date.now(), sku: "V30-PV1", price: "100.00", isActive: true }).returning();
    const result = await previewBulkPricing({ type: "selection", productIds: [p.id] }, "percent_increase", 10);
    expect(result.results[0].newPrice).toBe("110.00");
    expect((await db.select().from(products).where(eq(products.id, p.id)))[0].price).toBe("100.00");
  });

  it("preview → apply via operation handler + audit", async () => {
    const [p] = await db.insert(products).values({ name: "V30-AP", slug: "v29-ap-" + Date.now(), sku: "V30-AP1", price: "100.00", isActive: true }).returning();
    const preview = await previewBulkPricing({ type: "selection", productIds: [p.id] }, "percent_increase", 10);
    // Apply via OPERATION HANDLER (same as route)
    const result = await executeBulkPriceApply(ACTOR_ID, preview.previewToken);
    expect(result.updated).toBe(1);
    expect((await db.select().from(products).where(eq(products.id, p.id)))[0].price).toBe("110.00");
    // Verify AUDIT was created by the handler
    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.action, "bulk.price_update")).orderBy(desc(auditLogs.createdAt)).limit(1);
    expect(audit).toBeDefined();
    expect(audit.userId).toBe(ACTOR_ID);
  });

  it("tampered token", async () => {
    const token = createPreviewToken("percent_increase", 5, [{ id: 999, price: "100.00" }]);
    await expect(executeBulkPriceApply(ACTOR_ID, token.substring(0, 10) + "CORRUPT" + token.substring(17))).rejects.toThrow("BULK_PREVIEW_INVALID");
  });

  it("expired token", async () => {
    const secret = process.env.BULK_PREVIEW_SECRET!;
    const payload = { v: 1, op: "percent_increase", val: 5, products: [{ id: 1, price: "100.00" }], iat: Date.now() - PREVIEW_EXPIRY_MS - 60000, exp: Date.now() - 60000 };
    const json = JSON.stringify(payload);
    const sig = createHmac("sha256", secret).update(json).digest("hex");
    await expect(executeBulkPriceApply(ACTOR_ID, Buffer.from(json + "." + sig).toString("base64url"))).rejects.toThrow("BULK_PREVIEW_EXPIRED");
  });

  it("stale → price preserved", async () => {
    const [p] = await db.insert(products).values({ name: "V30-ST", slug: "v29-st-" + Date.now(), sku: "V30-ST1", price: "100.00", isActive: true }).returning();
    const preview = await previewBulkPricing({ type: "selection", productIds: [p.id] }, "percent_increase", 10);
    await db.update(products).set({ price: "105.00" }).where(eq(products.id, p.id));
    await expect(executeBulkPriceApply(ACTOR_ID, preview.previewToken)).rejects.toThrow("BULK_PREVIEW_STALE");
    expect((await db.select().from(products).where(eq(products.id, p.id)))[0].price).toBe("105.00");
  });

  it("rollback", async () => {
    const [p1] = await db.insert(products).values({ name: "V30-R1", slug: "v29-r1-" + Date.now(), sku: "V30-R1", price: "100.00", isActive: true }).returning();
    const [p2] = await db.insert(products).values({ name: "V30-R2", slug: "v29-r2-" + Date.now(), sku: "V30-R2", price: "50.00", isActive: true }).returning();
    const preview = await previewBulkPricing({ type: "selection", productIds: [p1.id, p2.id] }, "percent_increase", 10);
    await db.update(products).set({ price: "55.00" }).where(eq(products.id, p2.id));
    await expect(executeBulkPriceApply(ACTOR_ID, preview.previewToken)).rejects.toThrow();
    expect((await db.select().from(products).where(eq(products.id, p1.id)))[0].price).toBe("100.00");
  });

  it("order snapshot preserved", async () => {
    const [p] = await db.insert(products).values({ name: "V30-OS", slug: "v29-os-" + Date.now(), sku: "V30-OS1", price: "100.00", isActive: true }).returning();
    const [o] = await db.insert(orders).values({ orderNumber: "V30-ORD-" + Date.now(), status: "delivered", subtotal: "100.00", vat: "0", total: "100.00", deliveryType: "pickup" }).returning();
    await db.insert(orderItems).values({ orderId: o.id, productId: p.id, productName: p.name, quantity: 1, unitPriceGross: "100.00", unitPriceNet: "81.30", vatRate: "23.00", vatAmount: "18.70", lineTotalGross: "100.00" });
    const preview = await previewBulkPricing({ type: "selection", productIds: [p.id] }, "percent_increase", 20);
    await executeBulkPriceApply(ACTOR_ID, preview.previewToken);
    expect((await db.select().from(orderItems).where(eq(orderItems.orderId, o.id)))[0].unitPriceGross).toBe("100.00");
  });

  it("supplier cost preserved", async () => {
    const [p] = await db.insert(products).values({ name: "V30-SC", slug: "v29-sc-" + Date.now(), sku: "V30-SC1", price: "100.00", costPrice: "60.00", isActive: true }).returning();
    const [s] = await db.insert(suppliers).values({ name: "V30 SupC" }).returning();
    await db.insert(productSuppliers).values({ productId: p.id, supplierId: s.id, costPrice: "55.00", isPreferred: true });
    const preview = await previewBulkPricing({ type: "selection", productIds: [p.id] }, "fixed_increase", 20);
    await executeBulkPriceApply(ACTOR_ID, preview.previewToken);
    expect((await db.select().from(products).where(eq(products.id, p.id)))[0].costPrice).toBe("60.00");
    expect((await db.select().from(productSuppliers).where(eq(productSuppliers.productId, p.id)))[0].costPrice).toBe("55.00");
  });
});

// ═══ IMAGE ALT AUDIT (via operation handler) ══════════════
describe("Image alt audit (operation handler)", () => {
  beforeEach(reset);

  it("change → audit created", async () => {
    const [p] = await db.insert(products).values({ name: "V30-AL", slug: "v29-al-" + Date.now(), sku: "V30-AL1", price: "10.00" }).returning();
    const [img] = await db.insert(productImages).values({ productId: p.id, storageKey: "k", altText: "Old", sortOrder: 0 }).returning();
    const result = await executeImageAltUpdate(ACTOR_ID, p.id, img.id, "New");
    expect(result.changed).toBe(true);
    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.action, "image.alt_updated")).orderBy(desc(auditLogs.createdAt)).limit(1);
    expect(audit).toBeDefined();
    expect(audit.userId).toBe(ACTOR_ID);
  });

  it("no-op → NO audit", async () => {
    const [p] = await db.insert(products).values({ name: "V30-NP", slug: "v29-np-" + Date.now(), sku: "V30-NP1", price: "10.00" }).returning();
    const [img] = await db.insert(productImages).values({ productId: p.id, storageKey: "k", altText: "Same", sortOrder: 0 }).returning();
    const auditsBefore = await db.select().from(auditLogs).where(eq(auditLogs.action, "image.alt_updated"));
    await executeImageAltUpdate(ACTOR_ID, p.id, img.id, "Same");
    const auditsAfter = await db.select().from(auditLogs).where(eq(auditLogs.action, "image.alt_updated"));
    expect(auditsAfter.length).toBe(auditsBefore.length); // no new audit
  });
});

// ═══ IMAGE DELETE AUDIT (via operation handler) ═══════════
describe("Image delete audit (operation handler)", () => {
  beforeEach(reset);

  it("success → audit", async () => {
    const [p] = await db.insert(products).values({ name: "V30-DL", slug: "v29-dl-" + Date.now(), sku: "V30-DL1", price: "10.00" }).returning();
    const [img] = await db.insert(productImages).values({ productId: p.id, storageKey: "k", sortOrder: 0 }).returning();
    const okStorage = { upload: async () => {}, delete: async () => {}, getPublicUrl: () => null };
    await executeImageDelete(ACTOR_ID, p.id, img.id, okStorage);
    expect((await db.select().from(productImages).where(eq(productImages.id, img.id))).length).toBe(0);
    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.action, "image.deleted")).orderBy(desc(auditLogs.createdAt)).limit(1);
    expect(audit).toBeDefined();
    expect(audit.userId).toBe(ACTOR_ID);
  });

  it("storage failure → no delete, no audit", async () => {
    const [p] = await db.insert(products).values({ name: "V30-DF", slug: "v29-df-" + Date.now(), sku: "V30-DF1", price: "10.00" }).returning();
    const [img] = await db.insert(productImages).values({ productId: p.id, storageKey: "k", sortOrder: 0 }).returning();
    const failStorage = { upload: async () => {}, delete: async () => { throw new Error(); }, getPublicUrl: () => null };
    await expect(executeImageDelete(ACTOR_ID, p.id, img.id, failStorage)).rejects.toThrow();
    expect((await db.select().from(productImages).where(eq(productImages.id, img.id))).length).toBe(1);
  });
});

// ═══ SUPPLIER DELETE AUDIT (via operation handler) ════════
describe("Supplier delete audit (operation handler)", () => {
  beforeEach(reset);

  it("valid → audit", async () => {
    const [p] = await db.insert(products).values({ name: "V30-SD", slug: "v29-sd-" + Date.now(), sku: "V30-SD1", price: "10.00" }).returning();
    const [s] = await db.insert(suppliers).values({ name: "V30 SupD" }).returning();
    const [ps] = await db.insert(productSuppliers).values({ productId: p.id, supplierId: s.id }).returning();
    await executeProductSupplierDelete(ACTOR_ID, p.id, ps.id);
    expect((await db.select().from(productSuppliers).where(eq(productSuppliers.id, ps.id))).length).toBe(0);
    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.action, "product_supplier.deleted")).orderBy(desc(auditLogs.createdAt)).limit(1);
    expect(audit).toBeDefined();
    expect(audit.userId).toBe(ACTOR_ID);
  });

  it("wrong ownership → NOT_FOUND, no audit", async () => {
    const [pA] = await db.insert(products).values({ name: "V30-WO-A", slug: "v29-woa-" + Date.now(), sku: "V30-WOA", price: "10.00" }).returning();
    const [pB] = await db.insert(products).values({ name: "V30-WO-B", slug: "v29-wob-" + Date.now(), sku: "V30-WOB", price: "10.00" }).returning();
    const [s] = await db.insert(suppliers).values({ name: "V30 SupW" }).returning();
    const [ps] = await db.insert(productSuppliers).values({ productId: pB.id, supplierId: s.id }).returning();
    const auditsBefore = await db.select().from(auditLogs).where(eq(auditLogs.action, "product_supplier.deleted"));
    await expect(executeProductSupplierDelete(ACTOR_ID, pA.id, ps.id)).rejects.toThrow("NOT_FOUND");
    expect((await db.select().from(productSuppliers).where(eq(productSuppliers.id, ps.id))).length).toBe(1);
    const auditsAfter = await db.select().from(auditLogs).where(eq(auditLogs.action, "product_supplier.deleted"));
    expect(auditsAfter.length).toBe(auditsBefore.length); // no new audit
  });
});

// ═══ CATEGORY CYCLE SAFETY ═══════════════════════════════
describe("Category cycle safety (UNION, production helper)", () => {
  beforeEach(reset);

  it("depth 4 works", async () => {
    const [a] = await db.insert(categories).values({ name: "V30-A", slug: "v29-a-" + Date.now(), isActive: true }).returning();
    const [b] = await db.insert(categories).values({ name: "V30-B", slug: "v29-b-" + Date.now(), parentId: a.id, isActive: true }).returning();
    const [c] = await db.insert(categories).values({ name: "V30-C", slug: "v29-c-" + Date.now(), parentId: b.id, isActive: true }).returning();
    const [d] = await db.insert(categories).values({ name: "V30-D", slug: "v29-d-" + Date.now(), parentId: c.id, isActive: true }).returning();
    await db.insert(products).values({ name: "V30-Deep", slug: "v29-dp-" + Date.now(), sku: "V30-DEEP", price: "10.00", categoryId: d.id, isActive: true });
    for (const cat of [a, b, c, d]) {
      const ids = await getCategoryAndDescendantIds(cat.id);
      expect(ids).toContain(d.id);
    }
  });

  it("cycle safety: UNION prevents infinite loop", async () => {
    // Create categories and then force a cycle via direct DB update (bypassing app validation)
    const [x] = await db.insert(categories).values({ name: "V30-X", slug: "v29-x-" + Date.now(), isActive: true }).returning();
    const [y] = await db.insert(categories).values({ name: "V30-Y", slug: "v29-y-" + Date.now(), parentId: x.id, isActive: true }).returning();
    // Force cycle: x → y → x (bypass app validation)
    await db.update(categories).set({ parentId: y.id }).where(eq(categories.id, x.id));
    // getCategoryAndDescendantIds MUST terminate (UNION deduplicates)
    const ids = await getCategoryAndDescendantIds(x.id);
    expect(ids.length).toBeGreaterThanOrEqual(1);
    expect(ids.length).toBeLessThanOrEqual(2); // x and y, no infinite expansion
    // Cleanup: break cycle
    await db.update(categories).set({ parentId: null }).where(eq(categories.id, x.id));
  });
});

// ═══ isActive=false via REAL resolver ═════════════════════
describe("isActive=false via REAL resolveTargetIds", () => {
  beforeEach(reset);
  it("resolves only inactive", async () => {
    await db.insert(products).values({ name: "V30-ACT", slug: "v29-act-" + Date.now(), sku: "V30-ACT1", price: "10.00", isActive: true });
    const [inact] = await db.insert(products).values({ name: "V30-INA", slug: "v29-ina-" + Date.now(), sku: "V30-INA1", price: "10.00", isActive: false }).returning();
    const ids = await resolveTargetIds({ type: "filters", filters: { isActive: false } });
    expect(ids).toContain(inact.id);
  });
});

// ═══ PUBLIC ═══════════════════════════════════════════════
describe("Public products", () => {
  beforeEach(reset);
  it("sanitize strips costPrice + reservedStock", async () => {
    const [p] = await db.insert(products).values({ name: "V30-PB", slug: "v29-pb-" + Date.now(), sku: "V30-PB1", price: "10.00", costPrice: "5.00", stock: 10, reservedStock: 3 }).returning();
    const s = sanitizeForPublic(p);
    expect(s.availableStock).toBe(7);
    expect("reservedStock" in s).toBe(false);
    expect("costPrice" in s).toBe(false);
  });
});

// ═══ DB CONSTRAINTS ═══════════════════════════════════════
describe("DB constraints", () => {
  beforeEach(reset);
  it("EAN unique", async () => { await db.insert(products).values({ name: "V30-EU1", slug: "v29-eu1-" + Date.now(), sku: "V30-EU1", price: "10.00", ean: "5601234567892" }); let t = false; try { await db.insert(products).values({ name: "V30-EU2", slug: "v29-eu2-" + Date.now(), sku: "V30-EU2", price: "10.00", ean: "5601234567892" }); } catch { t = true; } expect(t).toBe(true); });
  it("PS unique", async () => { const [p] = await db.insert(products).values({ name: "V30-PU", slug: "v29-pu-" + Date.now(), sku: "V30-PU1", price: "10.00" }).returning(); const [s] = await db.insert(suppliers).values({ name: "V30 SupU" }).returning(); await db.insert(productSuppliers).values({ productId: p.id, supplierId: s.id }); let t = false; try { await db.insert(productSuppliers).values({ productId: p.id, supplierId: s.id }); } catch { t = true; } expect(t).toBe(true); });
  it("preferred unique", async () => { const [p] = await db.insert(products).values({ name: "V30-PR", slug: "v29-pr-" + Date.now(), sku: "V30-PR1", price: "10.00" }).returning(); const [s1] = await db.insert(suppliers).values({ name: "V30 SupP1" }).returning(); const [s2] = await db.insert(suppliers).values({ name: "V30 SupP2" }).returning(); await db.insert(productSuppliers).values({ productId: p.id, supplierId: s1.id, isPreferred: true }); let t = false; try { await db.insert(productSuppliers).values({ productId: p.id, supplierId: s2.id, isPreferred: true }); } catch { t = true; } expect(t).toBe(true); });
  it("primary image unique", async () => { const [p] = await db.insert(products).values({ name: "V30-IM", slug: "v29-im-" + Date.now(), sku: "V30-IM1", price: "10.00" }).returning(); await db.insert(productImages).values({ productId: p.id, storageKey: "k1", isPrimary: true, sortOrder: 0 }); let t = false; try { await db.insert(productImages).values({ productId: p.id, storageKey: "k2", isPrimary: true, sortOrder: 1 }); } catch { t = true; } expect(t).toBe(true); });
});
