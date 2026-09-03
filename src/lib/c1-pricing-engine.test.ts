/**
 * C.1 — Pricing engine against a real database.
 *
 * Covers what pure tests cannot: the cost→price trigger on the real supplier
 * routes, the absolute protection of manual prices, atomicity of cost+price,
 * the schema constraints on pricing_rules, and the audit trail.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { products, pricingRules, suppliers, productSuppliers, brands, categories, users, auditLogs, settings } from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";

const getCurrentUserMock = vi.fn();
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getCurrentUser: () => getCurrentUserMock() };
});

import {
  recalculateProductPrice,
  computeAutomaticPrice,
  setPriceMode,
  loadPricingContext,
} from "@/lib/services/pricing-engine-service";
import { getRoundingPolicy, saveRoundingPolicy, ROUNDING_POLICY_KEY } from "@/lib/rounding-policy";
import { DEFAULT_ROUNDING_POLICY } from "@/lib/pricing-calculator";
import { POST as supplierPOST, PUT as supplierPUT } from "@/app/api/admin/products/[id]/suppliers/route";
import { PUT as productsPUT } from "@/app/api/admin/products/route";

const MANAGER = { id: 9801, email: "c1@test.local", name: "C1", role: "manager", phone: null, nif: null, company: null };
const TAG = "C1ENG";

let supplierId = 0;
let otherSupplierId = 0;
let brandId = 0;
let rootCatId = 0;
let childCatId = 0;

async function cleanup() {
  await db.execute(sql`DELETE FROM pricing_rules WHERE notes LIKE ${TAG + "%"} OR product_id IN (SELECT id FROM products WHERE sku LIKE ${TAG + "%"})`);
  await db.execute(sql`DELETE FROM product_suppliers WHERE product_id IN (SELECT id FROM products WHERE sku LIKE ${TAG + "%"})`);
  await db.execute(sql`DELETE FROM stock_movements WHERE product_id IN (SELECT id FROM products WHERE sku LIKE ${TAG + "%"})`);
  await db.execute(sql`DELETE FROM products WHERE sku LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM pricing_rules WHERE category_id IN (SELECT id FROM categories WHERE slug LIKE ${"c1eng%"})`);
  await db.execute(sql`DELETE FROM pricing_rules WHERE brand_id IN (SELECT id FROM brands WHERE slug LIKE ${"c1eng%"})`);
  await db.execute(sql`DELETE FROM pricing_rules WHERE supplier_id IN (SELECT id FROM suppliers WHERE name LIKE ${TAG + "%"})`);
  await db.execute(sql`DELETE FROM pricing_rules WHERE scope = 'global'`);
}

beforeAll(async () => {
  await db.insert(users).values({ id: MANAGER.id, email: MANAGER.email, password: "x", name: MANAGER.name, role: "manager" }).onConflictDoNothing();
  const [sup] = await db.insert(suppliers).values({ name: `${TAG} Fornecedor A` }).returning();
  const [sup2] = await db.insert(suppliers).values({ name: `${TAG} Fornecedor B` }).returning();
  const [br] = await db.insert(brands).values({ name: `${TAG} TP-Link`, slug: `c1eng-tplink-${Date.now()}` }).returning();
  const [root] = await db.insert(categories).values({ name: `${TAG} Informática`, slug: `c1eng-root-${Date.now()}` }).returning();
  const [child] = await db.insert(categories).values({ name: `${TAG} Portáteis`, slug: `c1eng-child-${Date.now()}`, parentId: root.id }).returning();
  supplierId = sup.id; otherSupplierId = sup2.id; brandId = br.id; rootCatId = root.id; childCatId = child.id;
});

beforeEach(async () => {
  getCurrentUserMock.mockReset();
  getCurrentUserMock.mockResolvedValue(MANAGER);
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await db.execute(sql`DELETE FROM suppliers WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM brands WHERE slug LIKE 'c1eng%'`);
  await db.execute(sql`DELETE FROM categories WHERE slug LIKE 'c1eng%'`);
  await db.execute(sql`DELETE FROM audit_logs WHERE user_id = ${MANAGER.id}`);
  await db.execute(sql`DELETE FROM users WHERE id = ${MANAGER.id}`);
  await db.execute(sql`DELETE FROM settings WHERE key = ${ROUNDING_POLICY_KEY}`);
});

let seq = 0;
async function makeProduct(extra: Record<string, unknown> = {}) {
  seq += 1;
  const sku = `${TAG}-${Date.now()}-${seq}`;
  const [p] = await db.insert(products).values({
    name: sku, slug: sku.toLowerCase(), sku,
    price: "100.00", vatRate: "23.00", priceMode: "auto",
    ...extra,
  }).returning();
  return p;
}

async function globalRule(rate: number, extra: Record<string, unknown> = {}) {
  const [r] = await db.insert(pricingRules).values({
    scope: "global", method: "markup_on_cost", ratePercent: String(rate),
    roundingPolicy: "auto", notes: `${TAG} global`, ...extra,
  }).returning();
  return r;
}

describe("C.1 — cost change triggers an automatic recalculation", () => {
  it("prices the brief's example: cost 10 + markup 20% + VAT 23% = 14,99", async () => {
    await globalRule(20);
    const p = await makeProduct({ costPrice: "10.00" });

    const result = await recalculateProductPrice(p.id, { userId: MANAGER.id });
    expect(result.priced).toBe(true);
    expect(result.newPrice).toBe("14.99");
    expect(result.breakdown!.grossBeforeRoundingCents).toBe(1476);

    const [row] = await db.select().from(products).where(eq(products.id, p.id));
    expect(row.price).toBe("14.99");
    expect(row.priceRuleId).not.toBeNull();
    expect(row.priceCalculatedAt).not.toBeNull();
  });

  it("reprices when the preferred supplier cost changes through the real route", async () => {
    await globalRule(20);
    const p = await makeProduct();

    const req = new NextRequest(`http://localhost/api/admin/products/${p.id}/suppliers`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ supplierId, costPrice: 10, isPreferred: true }),
    });
    const res = await supplierPOST(req, { params: Promise.resolve({ id: String(p.id) }) });
    expect(res.status).toBe(201);

    const [row] = await db.select().from(products).where(eq(products.id, p.id));
    expect(row.costPrice).toBe("10.00");
    expect(row.price).toBe("14.99"); // cost and price updated together
  });

  it("reprices again when the supplier cost is updated (PUT)", async () => {
    await globalRule(20);
    const p = await makeProduct();
    await supplierPOST(
      new NextRequest("http://localhost/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ supplierId, costPrice: 10, isPreferred: true }) }),
      { params: Promise.resolve({ id: String(p.id) }) }
    );
    const [ps] = await db.select().from(productSuppliers).where(eq(productSuppliers.productId, p.id));

    await supplierPUT(
      new NextRequest("http://localhost/x", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ psId: ps.id, costPrice: 20 }) }),
      { params: Promise.resolve({ id: String(p.id) }) }
    );

    const [row] = await db.select().from(products).where(eq(products.id, p.id));
    expect(row.costPrice).toBe("20.00");
    // 20 * 1.20 = 24 net → 29,52 gross → band < 200 € → ,99
    expect(row.price).toBe("29.99");
  });

  it("cost and price move atomically — never a new cost with a stale price", async () => {
    await globalRule(50);
    const p = await makeProduct({ costPrice: "10.00" });
    await recalculateProductPrice(p.id);
    const [before] = await db.select().from(products).where(eq(products.id, p.id));

    await supplierPOST(
      new NextRequest("http://localhost/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ supplierId, costPrice: 40, isPreferred: true }) }),
      { params: Promise.resolve({ id: String(p.id) }) }
    );

    const [after] = await db.select().from(products).where(eq(products.id, p.id));
    expect(after.costPrice).toBe("40.00");
    expect(after.price).not.toBe(before.price);
    expect(Number(after.price)).toBeGreaterThan(Number(before.price));
  });

  it("editing the cost through the products PUT reprices the product", async () => {
    await globalRule(20);
    const p = await makeProduct({ costPrice: "10.00" });
    await recalculateProductPrice(p.id);

    const res = await productsPUT(new NextRequest("http://localhost/api/admin/products", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: p.id, costPrice: "50.00" }),
    }) as never);
    expect(res.status).toBe(200);

    const [row] = await db.select().from(products).where(eq(products.id, p.id));
    expect(row.costPrice).toBe("50.00");
    expect(row.price).toBe("73.99"); // 50*1.2=60 net → 73,80 → ,99
  });

  it("records the recalculation in the audit log", async () => {
    await globalRule(20);
    const p = await makeProduct({ costPrice: "10.00" });
    await recalculateProductPrice(p.id, { userId: MANAGER.id });
    const { auditRecalculation } = await import("@/lib/services/pricing-engine-service");
    const again = await recalculateProductPrice(p.id, { userId: MANAGER.id });
    await auditRecalculation({ ...again, changed: true, currentPrice: "1.00", newPrice: "14.99" }, MANAGER.id, "test");

    const logs = await db.select().from(auditLogs)
      .where(and(eq(auditLogs.action, "product.price_recalculated"), eq(auditLogs.entityId, p.id)));
    expect(logs.length).toBeGreaterThan(0);
  });
});

describe("C.1 — manual price protection is absolute", () => {
  it("never recalculates a manual product", async () => {
    await globalRule(20);
    const p = await makeProduct({ costPrice: "10.00", price: "99.99", priceMode: "manual" });

    const result = await recalculateProductPrice(p.id);
    expect(result.priced).toBe(false);
    expect(result.skipReason).toBe("manual_price");

    const [row] = await db.select().from(products).where(eq(products.id, p.id));
    expect(row.price).toBe("99.99");
  });

  it("a supplier cost change updates the cost but NOT a manual price", async () => {
    await globalRule(20);
    const p = await makeProduct({ price: "99.99", priceMode: "manual" });

    await supplierPOST(
      new NextRequest("http://localhost/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ supplierId, costPrice: 10, isPreferred: true }) }),
      { params: Promise.resolve({ id: String(p.id) }) }
    );

    const [row] = await db.select().from(products).where(eq(products.id, p.id));
    expect(row.costPrice).toBe("10.00"); // cost synced (imports must still work)
    expect(row.price).toBe("99.99");     // price untouched
  });

  it("editing the price by hand switches the product to manual", async () => {
    await globalRule(20);
    const p = await makeProduct({ costPrice: "10.00" });
    await recalculateProductPrice(p.id);

    await productsPUT(new NextRequest("http://localhost/x", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: p.id, price: "42.00" }),
    }) as never);

    const [row] = await db.select().from(products).where(eq(products.id, p.id));
    expect(row.priceMode).toBe("manual");
    expect(row.price).toBe("42.00");
  });

  it("switching back to automatic recalculates immediately", async () => {
    await globalRule(20);
    const p = await makeProduct({ costPrice: "10.00", price: "99.99", priceMode: "manual" });

    const result = await setPriceMode(p.id, "auto", MANAGER.id);
    expect(result?.priced).toBe(true);

    const [row] = await db.select().from(products).where(eq(products.id, p.id));
    expect(row.priceMode).toBe("auto");
    expect(row.price).toBe("14.99");
  });

  it("switching to manual freezes the current price", async () => {
    await globalRule(20);
    const p = await makeProduct({ costPrice: "10.00" });
    await recalculateProductPrice(p.id);

    await setPriceMode(p.id, "manual", MANAGER.id);
    await recalculateProductPrice(p.id);

    const [row] = await db.select().from(products).where(eq(products.id, p.id));
    expect(row.price).toBe("14.99");
    expect(row.priceMode).toBe("manual");
  });
});

describe("C.1 — safe refusals: the engine never invents a price", () => {
  it("skips a product with no cost", async () => {
    await globalRule(20);
    const p = await makeProduct({ costPrice: null, price: "55.00" });
    const result = await recalculateProductPrice(p.id);
    expect(result.skipReason).toBe("no_cost");
    const [row] = await db.select().from(products).where(eq(products.id, p.id));
    expect(row.price).toBe("55.00");
  });

  it("skips a zero cost rather than pricing at zero", async () => {
    await globalRule(20);
    const p = await makeProduct({ costPrice: "0.00", price: "55.00" });
    expect((await recalculateProductPrice(p.id)).skipReason).toBe("no_cost");
  });

  it("skips when no rule applies", async () => {
    const p = await makeProduct({ costPrice: "10.00", price: "55.00" });
    const result = await recalculateProductPrice(p.id);
    expect(result.skipReason).toBe("no_rule");
    const [row] = await db.select().from(products).where(eq(products.id, p.id));
    expect(row.price).toBe("55.00");
  });

  it("refuses to price below the rule's minimum margin", async () => {
    await globalRule(5, { minMarginPercent: "30" });
    const p = await makeProduct({ costPrice: "10.00", price: "55.00" });
    const result = await recalculateProductPrice(p.id);
    expect(result.skipReason).toBe("below_min_margin");
    const [row] = await db.select().from(products).where(eq(products.id, p.id));
    expect(row.price).toBe("55.00");
  });

  it("removing the preferred supplier clears the cost and stops pricing", async () => {
    await globalRule(20);
    const p = await makeProduct();
    await supplierPOST(
      new NextRequest("http://localhost/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ supplierId, costPrice: 10, isPreferred: true }) }),
      { params: Promise.resolve({ id: String(p.id) }) }
    );
    const { deleteProductSupplier } = await import("@/lib/services/product-supplier-service");
    const [ps] = await db.select().from(productSuppliers).where(eq(productSuppliers.productId, p.id));
    const out = await deleteProductSupplier(p.id, ps.id);

    expect(out.priceResult?.skipReason).toBe("no_cost");
    const [row] = await db.select().from(products).where(eq(products.id, p.id));
    expect(row.costPrice).toBeNull();
    expect(row.price).toBe("14.99"); // last good price kept, not zeroed
  });
});

describe("C.1 — rule scoping against real rows", () => {
  it("uses the PREFERRED supplier's rule, not another linked supplier", async () => {
    await db.insert(pricingRules).values({ scope: "supplier", supplierId, method: "markup_on_cost", ratePercent: "20", notes: `${TAG} pref` });
    await db.insert(pricingRules).values({ scope: "supplier", supplierId: otherSupplierId, method: "markup_on_cost", ratePercent: "200", notes: `${TAG} other` });

    const p = await makeProduct();
    await db.insert(productSuppliers).values({ productId: p.id, supplierId: otherSupplierId, costPrice: "10.00", isPreferred: false });
    await db.insert(productSuppliers).values({ productId: p.id, supplierId, costPrice: "10.00", isPreferred: true });
    await db.update(products).set({ costPrice: "10.00" }).where(eq(products.id, p.id));

    const result = await recalculateProductPrice(p.id);
    expect(result.newPrice).toBe("14.99"); // 20%, not 200%
  });

  it("a brand rule beats the supplier rule (natural order)", async () => {
    await db.insert(pricingRules).values({ scope: "supplier", supplierId, method: "markup_on_cost", ratePercent: "20", notes: `${TAG} s` });
    await db.insert(pricingRules).values({ scope: "brand", brandId, method: "markup_on_cost", ratePercent: "50", notes: `${TAG} b` });

    const p = await makeProduct({ costPrice: "10.00", brandId });
    await db.insert(productSuppliers).values({ productId: p.id, supplierId, costPrice: "10.00", isPreferred: true });

    const result = await recalculateProductPrice(p.id);
    expect(result.newPrice).toBe("18.99"); // 10*1.5=15 net → 18,45 → ,99
  });

  it("a child category rule beats its parent", async () => {
    await db.insert(pricingRules).values({ scope: "category", categoryId: rootCatId, method: "markup_on_cost", ratePercent: "10", notes: `${TAG} root` });
    await db.insert(pricingRules).values({ scope: "category", categoryId: childCatId, method: "markup_on_cost", ratePercent: "20", notes: `${TAG} child` });

    const p = await makeProduct({ costPrice: "10.00", categoryId: childCatId });
    expect((await recalculateProductPrice(p.id)).newPrice).toBe("14.99"); // 20%
  });

  it("an explicit priority promotes the supplier rule over the brand rule", async () => {
    await db.insert(pricingRules).values({ scope: "brand", brandId, method: "markup_on_cost", ratePercent: "50", priority: 0, notes: `${TAG} b` });
    await db.insert(pricingRules).values({ scope: "supplier", supplierId, method: "markup_on_cost", ratePercent: "20", priority: 10, notes: `${TAG} s` });

    const p = await makeProduct({ costPrice: "10.00", brandId });
    await db.insert(productSuppliers).values({ productId: p.id, supplierId, costPrice: "10.00", isPreferred: true });

    expect((await recalculateProductPrice(p.id)).newPrice).toBe("14.99"); // supplier 20% won
  });

  it("margin_on_sale and markup_on_cost stay distinct end to end", async () => {
    await globalRule(50, { method: "margin_on_sale" });
    const p = await makeProduct({ costPrice: "50.00" });
    // margin 50% → net 100 → gross 123,00 € → still under the 200 € band → ,99
    expect((await recalculateProductPrice(p.id)).newPrice).toBe("123.99");
  });

  it("respects a per-rule fixed rounding instead of the band policy", async () => {
    await globalRule(20, { roundingPolicy: "none" });
    const p = await makeProduct({ costPrice: "10.00" });
    expect((await recalculateProductPrice(p.id)).newPrice).toBe("14.76");
  });

  it("uses the product's own VAT rate", async () => {
    await globalRule(20);
    const p = await makeProduct({ costPrice: "10.00", vatRate: "6.00" });
    // 12 net → 12,72 → ,99
    expect((await recalculateProductPrice(p.id)).newPrice).toBe("12.99");
  });
});

describe("C.1 — schema constraints protect the rules table", () => {
  it("rejects a scope/target mismatch", async () => {
    await expect(
      db.insert(pricingRules).values({ scope: "brand", productId: 1, method: "markup_on_cost", ratePercent: "10", notes: `${TAG} bad` })
    ).rejects.toThrow();
  });

  it("rejects a global rule carrying a target", async () => {
    await expect(
      db.insert(pricingRules).values({ scope: "global", brandId, method: "markup_on_cost", ratePercent: "10", notes: `${TAG} bad` })
    ).rejects.toThrow();
  });

  it("rejects margin_on_sale at or above 100%", async () => {
    await expect(
      db.insert(pricingRules).values({ scope: "global", method: "margin_on_sale", ratePercent: "100", notes: `${TAG} bad` })
    ).rejects.toThrow();
  });

  it("rejects a negative rate and an invalid method", async () => {
    await expect(db.insert(pricingRules).values({ scope: "global", method: "markup_on_cost", ratePercent: "-1", notes: `${TAG} bad` })).rejects.toThrow();
    await expect(db.insert(pricingRules).values({ scope: "global", method: "nonsense", ratePercent: "10", notes: `${TAG} bad` })).rejects.toThrow();
  });

  it("allows only one ACTIVE rule per target but many inactive ones", async () => {
    await db.insert(pricingRules).values({ scope: "brand", brandId, method: "markup_on_cost", ratePercent: "10", notes: `${TAG} b1` });
    await expect(
      db.insert(pricingRules).values({ scope: "brand", brandId, method: "markup_on_cost", ratePercent: "20", notes: `${TAG} b2` })
    ).rejects.toThrow();
    await expect(
      db.insert(pricingRules).values({ scope: "brand", brandId, method: "markup_on_cost", ratePercent: "20", isActive: false, notes: `${TAG} b3` })
    ).resolves.toBeDefined();
  });

  it("rejects an invalid price_mode on products", async () => {
    const p = await makeProduct();
    await expect(
      db.execute(sql`UPDATE products SET price_mode = 'whatever' WHERE id = ${p.id}`)
    ).rejects.toThrow();
    // and the valid values are accepted
    await expect(db.execute(sql`UPDATE products SET price_mode = 'manual' WHERE id = ${p.id}`)).resolves.toBeDefined();
  });
});

describe("C.1 — configurable rounding policy persistence", () => {
  it("falls back to the default when nothing is configured", async () => {
    await db.execute(sql`DELETE FROM settings WHERE key = ${ROUNDING_POLICY_KEY}`);
    expect(await getRoundingPolicy()).toEqual(DEFAULT_ROUNDING_POLICY);
  });

  it("round-trips a custom policy and the engine honours it", async () => {
    await saveRoundingPolicy({ enabled: true, bands: [{ fromCents: 0, mode: "end_90" }] });
    expect((await getRoundingPolicy()).bands[0].mode).toBe("end_90");

    await globalRule(20);
    const p = await makeProduct({ costPrice: "10.00" });
    expect((await recalculateProductPrice(p.id)).newPrice).toBe("14.90"); // ,90 not ,99

    await db.execute(sql`DELETE FROM settings WHERE key = ${ROUNDING_POLICY_KEY}`);
  });

  it("ignores a corrupt stored policy instead of breaking pricing", async () => {
    await db.insert(settings).values({ key: ROUNDING_POLICY_KEY, value: "{not json", group: "pricing" }).onConflictDoUpdate({ target: settings.key, set: { value: "{not json" } });
    expect(await getRoundingPolicy()).toEqual(DEFAULT_ROUNDING_POLICY);
    await db.execute(sql`DELETE FROM settings WHERE key = ${ROUNDING_POLICY_KEY}`);
  });

  it("rejects saving an invalid policy", async () => {
    await expect(saveRoundingPolicy({ enabled: true, bands: [{ fromCents: 500, mode: "end_90" }] })).rejects.toThrow();
  });
});

describe("C.1 — preview matches apply", () => {
  it("computeAutomaticPrice returns exactly what recalculate persists", async () => {
    await globalRule(20);
    const p = await makeProduct({ costPrice: "37.41" });
    const ctx = await loadPricingContext();
    const preview = computeAutomaticPrice(
      { id: p.id, price: p.price, costPrice: p.costPrice, vatRate: p.vatRate, categoryId: p.categoryId, brandId: p.brandId, priceMode: p.priceMode },
      null, ctx.rules, ctx.categoryTree, ctx.policy
    );
    const applied = await recalculateProductPrice(p.id);
    expect(preview.newPrice).toBe(applied.newPrice);

    const [row] = await db.select().from(products).where(eq(products.id, p.id));
    expect(row.price).toBe(preview.newPrice);
  });

  it("is idempotent — running twice does not drift the price", async () => {
    await globalRule(20);
    const p = await makeProduct({ costPrice: "10.00" });
    const first = await recalculateProductPrice(p.id);
    const second = await recalculateProductPrice(p.id);
    expect(second.newPrice).toBe(first.newPrice);
    expect(second.changed).toBe(false);
  });
});
