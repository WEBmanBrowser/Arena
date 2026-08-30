import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/db";
import { products, brands, productSuppliers, suppliers } from "@/db/schema";
import { eq, sql, and } from "drizzle-orm";
import { slugify } from "@/lib/utils";
import { isValidGTIN, wouldCreateCategoryCycle, validate, createProductSchema, updateProductSchema, createSupplierSchema, updateSupplierSchema, createProductSupplierSchema } from "@/lib/validation";
import { parseCSV, autoMapHeaders } from "@/lib/csv";
import { publicProductSelect, publicProductListSelect, sanitizeForPublic } from "@/lib/public-products";

async function reset() {
  await db.execute(sql`DELETE FROM product_images WHERE product_id IN (SELECT id FROM products WHERE sku LIKE 'TEST-%')`);
  await db.execute(sql`DELETE FROM stock_movements WHERE product_id IN (SELECT id FROM products WHERE sku LIKE 'TEST-%')`);
  await db.execute(sql`DELETE FROM product_suppliers WHERE product_id IN (SELECT id FROM products WHERE sku LIKE 'TEST-%')`);
  await db.execute(sql`DELETE FROM products WHERE sku LIKE 'TEST-%'`);
  await db.execute(sql`DELETE FROM brands WHERE slug LIKE 'test-%'`);
  await db.execute(sql`DELETE FROM suppliers WHERE name LIKE 'Test Sup%'`);
}

// ─── DB CONSTRAINTS ──────────────────────
describe("DB constraints", () => {
  beforeEach(reset);
  it("SKU unique", async () => { await db.insert(products).values({ name: "A", slug: "a-" + Date.now(), sku: "TEST-U1", price: "10.00" }); let t = false; try { await db.insert(products).values({ name: "B", slug: "b-" + Date.now(), sku: "TEST-U1", price: "20.00" }); } catch { t = true; } expect(t).toBe(true); });
  it("Slug unique", async () => { const s = "ts-" + Date.now(); await db.insert(products).values({ name: "A", slug: s, sku: "TEST-SL1-" + Date.now(), price: "10.00" }); let t = false; try { await db.insert(products).values({ name: "B", slug: s, sku: "TEST-SL2-" + Date.now(), price: "10.00" }); } catch { t = true; } expect(t).toBe(true); });
  it("EAN unique non-null", async () => { await db.insert(products).values({ name: "E1", slug: "e1-" + Date.now(), sku: "TEST-EA1", price: "10.00", ean: "5601234567892" }); let t = false; try { await db.insert(products).values({ name: "E2", slug: "e2-" + Date.now(), sku: "TEST-EA2", price: "10.00", ean: "5601234567892" }); } catch { t = true; } expect(t).toBe(true); });
  it("EAN allows NULL", async () => { await db.insert(products).values({ name: "N1", slug: "n1-" + Date.now(), sku: "TEST-EN1", price: "10.00" }); await db.insert(products).values({ name: "N2", slug: "n2-" + Date.now(), sku: "TEST-EN2", price: "10.00" }); });
  it("PS unique pair", async () => { const [p] = await db.insert(products).values({ name: "P", slug: "p-" + Date.now(), sku: "TEST-PS1", price: "10.00" }).returning(); const [s] = await db.insert(suppliers).values({ name: "Test Sup A" }).returning(); await db.insert(productSuppliers).values({ productId: p.id, supplierId: s.id }); let t = false; try { await db.insert(productSuppliers).values({ productId: p.id, supplierId: s.id }); } catch { t = true; } expect(t).toBe(true); });
  it("Preferred unique/product", async () => { const [p] = await db.insert(products).values({ name: "P", slug: "pf-" + Date.now(), sku: "TEST-PF1", price: "10.00" }).returning(); const [s1] = await db.insert(suppliers).values({ name: "Test Sup B" }).returning(); const [s2] = await db.insert(suppliers).values({ name: "Test Sup C" }).returning(); await db.insert(productSuppliers).values({ productId: p.id, supplierId: s1.id, isPreferred: true }); let t = false; try { await db.insert(productSuppliers).values({ productId: p.id, supplierId: s2.id, isPreferred: true }); } catch { t = true; } expect(t).toBe(true); });
  it("Brand FK", async () => { const [b] = await db.insert(brands).values({ name: "TB", slug: "test-b-" + Date.now() }).returning(); await db.insert(products).values({ name: "P", slug: "p-" + Date.now(), sku: "TEST-BP", price: "10.00", brandId: b.id }); let t = false; try { await db.delete(brands).where(eq(brands.id, b.id)); } catch { t = true; } expect(t).toBe(true); });
});

// ─── STOCK ────────────────────────────────
describe("Stock", () => {
  beforeEach(reset);
  it("+10", async () => { const [p] = await db.insert(products).values({ name: "S", slug: "s-" + Date.now(), sku: "TEST-ST1", price: "10.00", stock: 5 }).returning(); await db.update(products).set({ stock: sql`${products.stock} + 10` }).where(eq(products.id, p.id)); const [u] = await db.select().from(products).where(eq(products.id, p.id)); expect(u.stock).toBe(15); });
  it("guard negative", async () => { const [p] = await db.insert(products).values({ name: "N", slug: "n-" + Date.now(), sku: "TEST-NEG", price: "10.00", stock: 3 }).returning(); const r = await db.update(products).set({ stock: sql`${products.stock} - 5` }).where(sql`${products.id} = ${p.id} AND ${products.stock} - 5 >= 0`).returning(); expect(r.length).toBe(0); });
  it("reserved untouched", async () => { const [p] = await db.insert(products).values({ name: "R", slug: "r-" + Date.now(), sku: "TEST-RSV", price: "10.00", stock: 10, reservedStock: 3 }).returning(); await db.update(products).set({ stock: sql`${products.stock} + 5` }).where(eq(products.id, p.id)); const [u] = await db.select().from(products).where(eq(products.id, p.id)); expect(u.reservedStock).toBe(3); });
});

// ─── GTIN ─────────────────────────────────
describe("GTIN", () => {
  it("EAN-13", () => expect(isValidGTIN("5601234567892")).toBe(true));
  it("EAN-8", () => expect(isValidGTIN("96385074")).toBe(true));
  it("GTIN-14", () => expect(isValidGTIN("00012345678905")).toBe(true));
  it("bad checksum", () => expect(isValidGTIN("5601234567891")).toBe(false));
  it("letters", () => expect(isValidGTIN("560123456789A")).toBe(false));
  it("short", () => expect(isValidGTIN("123")).toBe(false));
  it("empty", () => expect(isValidGTIN("")).toBe(false));
});

// ─── CATEGORY CYCLES ─────────────────────
describe("Category cycles", () => {
  it("self", () => expect(wouldCreateCategoryCycle(1, 1, [{ id: 1, parentId: null }])).toBe(true));
  it("indirect", () => expect(wouldCreateCategoryCycle(1, 3, [{ id: 1, parentId: null }, { id: 2, parentId: 1 }, { id: 3, parentId: 2 }])).toBe(true));
  it("valid", () => expect(wouldCreateCategoryCycle(3, 1, [{ id: 1, parentId: null }, { id: 2, parentId: null }, { id: 3, parentId: 2 }])).toBe(false));
});

// ─── COST TRACKING ───────────────────────
describe("Cost", () => {
  beforeEach(reset);
  it("lastCostPrice", async () => { const [p] = await db.insert(products).values({ name: "LC", slug: "lc-" + Date.now(), sku: "TEST-LC1", price: "10.00" }).returning(); const [s] = await db.insert(suppliers).values({ name: "Test Sup D" }).returning(); const [ps] = await db.insert(productSuppliers).values({ productId: p.id, supplierId: s.id, costPrice: "100.00" }).returning(); await db.update(productSuppliers).set({ costPrice: "95.00", lastCostPrice: "100.00" }).where(eq(productSuppliers.id, ps.id)); const [u] = await db.select().from(productSuppliers).where(eq(productSuppliers.id, ps.id)); expect(u.costPrice).toBe("95.00"); expect(u.lastCostPrice).toBe("100.00"); });
  it("cost zero valid", async () => { const [p] = await db.insert(products).values({ name: "CZ", slug: "cz-" + Date.now(), sku: "TEST-CZ1", price: "10.00" }).returning(); const [s] = await db.insert(suppliers).values({ name: "Test Sup F" }).returning(); await db.insert(productSuppliers).values({ productId: p.id, supplierId: s.id, costPrice: "0.00", isPreferred: true }); const [ps] = await db.select().from(productSuppliers).where(and(eq(productSuppliers.productId, p.id), eq(productSuppliers.supplierId, s.id))); expect(ps.costPrice).toBe("0.00"); });
});

// ─── STRICT MONEY VALIDATION ─────────────
describe("Strict money validation", () => {
  const v = (p: string) => validate(createProductSchema, { name: "T", sku: "T1", price: p });
  it("'0' valid", () => expect(v("0").success).toBe(true));
  it("'0.00' valid", () => expect(v("0.00").success).toBe(true));
  it("'10' valid", () => expect(v("10").success).toBe(true));
  it("'10.50' valid", () => expect(v("10.50").success).toBe(true));
  it("'1000.99' valid", () => expect(v("1000.99").success).toBe(true));
  it("'abc' rejected", () => expect(v("abc").success).toBe(false));
  it("'10abc' rejected", () => expect(v("10abc").success).toBe(false));
  it("'12.34abc' rejected", () => expect(v("12.34abc").success).toBe(false));
  it("'abc10' rejected", () => expect(v("abc10").success).toBe(false));
  it("'-1' rejected", () => expect(v("-1").success).toBe(false));
  it("'NaN' rejected", () => expect(v("NaN").success).toBe(false));
  it("'Infinity' rejected", () => expect(v("Infinity").success).toBe(false));
  it("'1e999' rejected", () => expect(v("1e999").success).toBe(false));
  it("'10.999' rejected (3 decimals)", () => expect(v("10.999").success).toBe(false));
});

// ─── ZOD PRODUCTS ─────────────────────────
describe("Zod products", () => {
  it("rejects stock=-1", () => expect(validate(createProductSchema, { name: "T", sku: "T", price: "10", stock: -1 }).success).toBe(false));
  it("rejects stock=1.5", () => expect(validate(createProductSchema, { name: "T", sku: "T", price: "10", stock: 1.5 }).success).toBe(false));
  it("rejects minStock=-1", () => expect(validate(createProductSchema, { name: "T", sku: "T", price: "10", minStock: -1 }).success).toBe(false));
  it("rejects vatRate=abc", () => expect(validate(createProductSchema, { name: "T", sku: "T", price: "10", vatRate: "abc" }).success).toBe(false));
  it("rejects empty name", () => expect(validate(createProductSchema, { name: "", sku: "T", price: "10" }).success).toBe(false));
  it("update rejects price=abc", () => expect(validate(updateProductSchema, { id: 1, price: "abc" }).success).toBe(false));
  it("update accepts valid", () => expect(validate(updateProductSchema, { id: 1, price: "50.00" }).success).toBe(true));
});

// ─── ZOD SUPPLIERS ────────────────────────
describe("Zod supplier create", () => {
  it("rejects empty name", () => expect(validate(createSupplierSchema, { name: "" }).success).toBe(false));
  it("accepts valid", () => expect(validate(createSupplierSchema, { name: "Sup" }).success).toBe(true));
  it("accepts valid email", () => expect(validate(createSupplierSchema, { name: "S", email: "a@b.com" }).success).toBe(true));
  it("rejects invalid email", () => expect(validate(createSupplierSchema, { name: "S", email: "bad" }).success).toBe(false));
  it("accepts valid URL", () => expect(validate(createSupplierSchema, { name: "S", website: "https://x.com" }).success).toBe(true));
  it("rejects invalid URL", () => expect(validate(createSupplierSchema, { name: "S", website: "not url" }).success).toBe(false));
  it("accepts empty email", () => expect(validate(createSupplierSchema, { name: "S", email: "" }).success).toBe(true));
  it("accepts null website", () => expect(validate(createSupplierSchema, { name: "S", website: null }).success).toBe(true));
});

describe("Zod supplier update", () => {
  it("partial phone only", () => expect(validate(updateSupplierSchema, { phone: "253123456" }).success).toBe(true));
  it("partial email only", () => expect(validate(updateSupplierSchema, { email: "a@b.com" }).success).toBe(true));
  it("partial isActive only", () => expect(validate(updateSupplierSchema, { isActive: false }).success).toBe(true));
  it("empty update rejected", () => expect(validate(updateSupplierSchema, {}).success).toBe(false));
  it("name not required", () => expect(validate(updateSupplierSchema, { phone: "123" }).success).toBe(true));
});

// ─── ZOD PS ───────────────────────────────
describe("Zod product supplier", () => {
  it("rejects supplierId=0", () => expect(validate(createProductSupplierSchema, { supplierId: 0 }).success).toBe(false));
  it("rejects costPrice=-1", () => expect(validate(createProductSupplierSchema, { supplierId: 1, costPrice: -1 }).success).toBe(false));
  it("accepts costPrice=0", () => expect(validate(createProductSupplierSchema, { supplierId: 1, costPrice: 0 }).success).toBe(true));
  it("accepts costPrice=null", () => expect(validate(createProductSupplierSchema, { supplierId: 1, costPrice: null }).success).toBe(true));
  it("rejects costPrice='10abc'", () => expect(validate(createProductSupplierSchema, { supplierId: 1, costPrice: "10abc" }).success).toBe(false));
  it("accepts costPrice='95.50'", () => expect(validate(createProductSupplierSchema, { supplierId: 1, costPrice: "95.50" }).success).toBe(true));
  it("rejects leadTimeDays=-1", () => expect(validate(createProductSupplierSchema, { supplierId: 1, leadTimeDays: -1 }).success).toBe(false));
  it("accepts leadTimeDays=0", () => expect(validate(createProductSupplierSchema, { supplierId: 1, leadTimeDays: 0 }).success).toBe(true));
});

// ─── PUBLIC API COST PROTECTION ───────────
describe("Public product projection", () => {
  beforeEach(reset);
  it("excludes costPrice from shared projection used by API", async () => {
    const [p] = await db.insert(products).values({ name: "CostTest", slug: "ct-" + Date.now(), sku: "TEST-COST", price: "50.00", costPrice: "30.00", isActive: true }).returning();
    const [s] = await db.insert(suppliers).values({ name: "Test Sup G" }).returning();
    await db.insert(productSuppliers).values({ productId: p.id, supplierId: s.id, costPrice: "25.00", supplierSku: "SUP-123", isPreferred: true });

    // Test BOTH list and detail projections
    const [listRow] = await db.select(publicProductListSelect).from(products).where(eq(products.id, p.id)).limit(1);
    const [detailRow] = await db.select(publicProductSelect).from(products).where(eq(products.id, p.id)).limit(1);

    // Verify sanitizeForPublic removes reservedStock and adds availableStock
    const sanitizedList = sanitizeForPublic(listRow);
    const sanitizedDetail = sanitizeForPublic(detailRow);

    for (const row of [sanitizedList, sanitizedDetail]) {
      const keys = Object.keys(row);
      expect(keys).not.toContain("costPrice");
      expect(keys).not.toContain("lastCostPrice");
      expect(keys).not.toContain("reservedStock");
      expect(keys).toContain("availableStock");
      expect(keys).toContain("id");
      expect(keys).toContain("name");
      expect(keys).toContain("price");
    }
    expect(sanitizedDetail.name).toBe("CostTest");
    expect(sanitizedDetail.price).toBe("50.00");
    expect(sanitizedDetail.availableStock).toBe(0); // no stock set
  });
});

// ─── CSV ──────────────────────────────────
describe("CSV", () => {
  it("comma", () => { const r = parseCSV('SKU,Nome\nABC001,"Portátil 15,6"""\n'); expect(r.rows[0]["Nome"]).toBe('Portátil 15,6"'); });
  it("semicolon", () => { expect(parseCSV('SKU;Nome\nA;"T"\n').delimiter).toBe(";"); });
  it("quoted comma", () => { expect(parseCSV('SKU,N,D\nA,"P","Intel, 16GB"\n').rows[0]["D"]).toBe("Intel, 16GB"); });
  it("BOM", () => { expect(parseCSV('\uFEFFSKU,N\nA,T\n').headers[0]).toBe("SKU"); });
  it("mapping", () => { const m = autoMapHeaders(["Ref.", "PVP", "Qtd"]); expect(m["Ref."]).toBe("sku"); });
});

// ─── SLUGIFY ──────────────────────────────
describe("slugify", () => {
  it("URL-safe", () => expect(slugify("AMD Ryzen 7")).toBe("amd-ryzen-7"));
  it("accents", () => expect(slugify("Ração")).toBe("racao"));
});
