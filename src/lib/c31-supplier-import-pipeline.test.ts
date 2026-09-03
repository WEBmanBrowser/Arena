/**
 * C.3.1 — Supplier import pipeline against a real PostgreSQL.
 *
 * Covers what only a database can prove:
 *  - preview writes NOTHING but supplier_imports/supplier_import_rows;
 *  - the persisted snapshot (not the browser) is what apply consumes;
 *  - the signed token gates the first apply, and only the first;
 *  - cost syncs through the PREFERRED supplier and the price comes from the
 *    C.1/C.2 engine (10 € → 14,99 €), while manual prices are untouchable;
 *  - non-preferred suppliers change their own link and nothing else;
 *  - batches, idempotency, resume without re-sending the CSV, real progress;
 *  - disappeared products are detected and reported — and never acted on.
 *
 * Fixtures are semicolon-delimited with comma decimals on purpose: that is a
 * real pt-PT export, and it proves the parser (not a hand-rolled split) owns
 * the delimiter and the "10,00" → 10.00 conversion. Every product a test may
 * create is keyed on a `${TAG}-` internal SKU, so the cleanup below catches it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/db";
import {
  pricingRules,
  productSuppliers,
  products,
  stockMovements,
  suppliers,
  supplierImportRows,
  supplierImports,
  users,
} from "@/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";

const getCurrentUserMock = vi.fn();
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getCurrentUser: () => getCurrentUserMock() };
});

import { POST as previewPOST, GET as historyGET } from "@/app/api/admin/supplier-import/route";
import { POST as applyPOST } from "@/app/api/admin/supplier-import/apply/route";
import { GET as progressGET } from "@/app/api/admin/supplier-import/[id]/progress/route";
import { GET as linesGET } from "@/app/api/admin/supplier-import/[id]/lines/route";

const TAG = "C31PIPE";
const MANAGER = { id: 9741, email: "c31-pipe@test.local", name: "C31 Pipe", role: "manager", phone: null, nif: null, company: null };
const STAFF = { id: 9742, email: "c31-pipe-staff@test.local", name: "C31 Pipe Staff", role: "staff", phone: null, nif: null, company: null };

let supplierId = 0;
let otherSupplierId = 0;
let seq = 0;

/** Valid GTIN-13 from a 12-digit base, so fixtures never trip the checksum rule. */
function eanFor(base12: string): string {
  const digits = base12.padStart(12, "0").slice(0, 12).split("").map(Number);
  const sum = digits.reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 1 : 3), 0);
  return `${base12}${(10 - (sum % 10)) % 10}`;
}

async function makeProduct(extra: Record<string, unknown> = {}) {
  seq += 1;
  const sku = `${TAG}-${seq}`;
  const [p] = await db.insert(products).values({
    name: `Produto ${sku}`, slug: `${sku.toLowerCase()}-${seq}-${Date.now()}`, sku,
    price: "100.00", vatRate: "23.00", priceMode: "auto", stock: 0,
    ...extra,
  }).returning();
  return p;
}

async function link(productId: number, supId: number, cost: string | null, isPreferred: boolean, supplierSku?: string) {
  await db.insert(productSuppliers).values({ productId, supplierId: supId, costPrice: cost, isPreferred, supplierSku: supplierSku ?? null });
}

async function globalRule(ratePercent = 20) {
  await db.insert(pricingRules).values({
    scope: "global", method: "markup_on_cost", ratePercent: String(ratePercent),
    roundingPolicy: "auto", notes: `${TAG} global`,
  });
}

function post(path: string, body: unknown, withOrigin = true) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (withOrigin) headers.origin = "http://localhost";
  return new NextRequest(`http://localhost${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

const HEADER = "skuFornecedor;nome;custo;stock;ean;internalSku";
const line = (
  opts: { sku?: string; name?: string; cost?: string; stock?: string; ean?: string; internalSku?: string } = {}
) => [opts.sku ?? "", opts.name ?? "", opts.cost ?? "", opts.stock ?? "", opts.ean ?? "", opts.internalSku ?? ""].join(";");
const csvFile = (...rows: string[]) => [HEADER, ...rows].join("\n");

async function preview(csvText: string, body: Record<string, unknown> = {}) {
  const res = await previewPOST(post("/api/admin/supplier-import", { supplierId, fileName: `${TAG}.csv`, data: csvText, ...body }));
  return { status: res.status, json: await res.json() as any };
}

async function apply(importId: number, previewToken?: string) {
  const res = await applyPOST(post("/api/admin/supplier-import/apply", { importId, ...(previewToken ? { previewToken } : {}) }));
  return { status: res.status, json: await res.json() as any };
}

async function progress(importId: number) {
  const res = await progressGET(new NextRequest(`http://localhost/api/admin/supplier-import/${importId}/progress`), {
    params: Promise.resolve({ id: String(importId) }),
  });
  return { status: res.status, json: await res.json() as any };
}

/**
 * Products an import of THIS suite created are numbered by the catalogue itself
 * (MD-…), so they carry no fixture TAG: the snapshot rows that point at them are
 * the only way to find them again.
 */
async function importedProductIds(): Promise<number[]> {
  const rows = await db
    .select({ productId: supplierImportRows.productId })
    .from(supplierImportRows)
    .innerJoin(supplierImports, eq(supplierImports.id, supplierImportRows.importId))
    .where(and(inArray(supplierImports.userId, [MANAGER.id, STAFF.id]), sql`${supplierImportRows.productId} IS NOT NULL`));
  return [...new Set(rows.map((r) => r.productId).filter((v): v is number => typeof v === "number"))];
}

async function cleanup() {
  const ids = await importedProductIds();
  const list = ids.length ? sql.join(ids.map((id) => sql`${id}`), sql`,`) : null;
  if (list) {
    await db.execute(sql`DELETE FROM stock_movements WHERE product_id IN (${list})`);
    await db.execute(sql`DELETE FROM product_suppliers WHERE product_id IN (${list})`);
  }
  await db.execute(sql`DELETE FROM supplier_import_rows WHERE import_id IN (SELECT id FROM supplier_imports WHERE user_id IN (${MANAGER.id}, ${STAFF.id}))`);
  await db.execute(sql`DELETE FROM supplier_imports WHERE user_id IN (${MANAGER.id}, ${STAFF.id})`);
  await db.execute(sql`DELETE FROM pricing_rules WHERE notes LIKE ${`${TAG}%`}`);
  // One predicate for links, movements and products: a test may plant a row whose
  // SKU was minted (MD-…) while its slug still carries the TAG.
  const tagged = sql`SELECT id FROM products WHERE sku LIKE ${`${TAG}-%`} OR lower(slug) LIKE ${`${TAG.toLowerCase()}%`}`;
  await db.execute(sql`DELETE FROM stock_movements WHERE product_id IN (${tagged})`);
  await db.execute(sql`DELETE FROM product_suppliers WHERE product_id IN (${tagged})`);
  await db.execute(sql`DELETE FROM products WHERE id IN (${tagged})`);
  if (list) await db.execute(sql`DELETE FROM products WHERE id IN (${list})`);
}

beforeAll(async () => {
  await db.insert(users).values([
    { id: MANAGER.id, email: MANAGER.email, password: "x", name: MANAGER.name, role: MANAGER.role },
    { id: STAFF.id, email: STAFF.email, password: "x", name: STAFF.name, role: STAFF.role },
  ]).onConflictDoNothing();
  const [a] = await db.insert(suppliers).values({ name: `${TAG} Fornecedor A` }).returning();
  const [b] = await db.insert(suppliers).values({ name: `${TAG} Fornecedor B` }).returning();
  supplierId = a.id;
  otherSupplierId = b.id;
});

beforeEach(async () => {
  getCurrentUserMock.mockReset();
  getCurrentUserMock.mockResolvedValue(MANAGER);
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await db.execute(sql`DELETE FROM audit_logs WHERE user_id IN (${MANAGER.id}, ${STAFF.id})`);
  await db.execute(sql`DELETE FROM suppliers WHERE name LIKE ${`${TAG}%`}`);
  await db.execute(sql`DELETE FROM users WHERE id IN (${MANAGER.id}, ${STAFF.id})`);
});

describe("C.3.1 — preview is a read-only snapshot", () => {
  it("persists the import and its rows, and touches no product", async () => {
    await globalRule(20);
    const p = await makeProduct();
    await link(p.id, supplierId, "50.00", true, "SUP-1");
    const before = (await db.select().from(products).where(eq(products.id, p.id)))[0];
    const movementsBefore = (await db.select().from(stockMovements).where(eq(stockMovements.productId, p.id))).length;

    const csvText = csvFile(line({ sku: "SUP-1", name: "Cabo novo", cost: "10,00", stock: "8" }));
    const { status, json } = await preview(csvText);
    expect(status).toBe(200);

    const [stored] = await db.select().from(supplierImports).where(eq(supplierImports.id, json.importId));
    expect(stored.status).toBe("preview");
    expect(stored.fileName).toBe(`${TAG}.csv`);
    expect(stored.fileHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.fileSizeBytes).toBe(Buffer.byteLength(csvText, "utf8"));
    expect(stored.rowCount).toBe(1);
    expect(stored.batchesTotal).toBe(1);
    expect(stored.batchesDone).toBe(0);
    expect(stored.startedAt).toBeNull();
    expect(stored.heartbeatAt).toBeNull();
    expect(stored.mapping).toMatchObject({ skuFornecedor: "supplierSku", custo: "costPrice", stock: "stock" });

    const rows = await db.select().from(supplierImportRows).where(eq(supplierImportRows.importId, json.importId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      rowNumber: 2, status: "ready", matchType: "supplier_sku", productId: p.id,
      costPrice: "10.00", stock: 8, applied: false, name: "Cabo novo",
    });

    // Nothing in the catalogue moved.
    const after = (await db.select().from(products).where(eq(products.id, p.id)))[0];
    expect(after.price).toBe(before.price);
    expect(after.costPrice).toBe(before.costPrice);
    expect(after.stock).toBe(before.stock);
    expect((await db.select().from(stockMovements).where(eq(stockMovements.productId, p.id))).length).toBe(movementsBefore);
  });

  it("shows matching, conflicts, cost, stock, current and computed price, preferred state", async () => {
    await globalRule(20);
    const p = await makeProduct({ price: "99.00" });
    await link(p.id, supplierId, "50.00", true, "SUP-1");
    const ambiguousA = await makeProduct();
    const ambiguousB = await makeProduct();
    await link(ambiguousA.id, supplierId, null, false, "DUP");
    await link(ambiguousB.id, supplierId, null, false, "DUP");

    const { json } = await preview(csvFile(
      line({ sku: "SUP-1", name: "Cabo", cost: "10,00", stock: "8" }),
      line({ sku: "DUP", name: "Ambíguo", cost: "5,00" }),
      line({ sku: "SUP-NOVA", name: "Novo", cost: "20,00", internalSku: `${TAG}-NEW` }),
    ));

    const bySku = new Map<string, any>(json.lines.map((l: any) => [l.supplierSku ?? l.internalSku, l]));
    expect(bySku.get("SUP-1")).toMatchObject({
      rowNumber: 2, status: "ready", matchType: "supplier_sku", productId: p.id,
      costPrice: "10.00", costBefore: "50.00", stock: 8, stockBefore: 0,
      currentPrice: "99.00", computedPrice: "14.99", priceMode: "auto", isPreferredSupplier: true,
    });
    expect(bySku.get("DUP").status).toBe("conflict");
    expect(bySku.get("DUP").codes).toContain("AMBIGUOUS_SUPPLIER_SKU");
    // A line that will create a product has no product yet, and its price is a
    // prediction of the engine — never the file's number.
    expect(bySku.get("SUP-NOVA")).toMatchObject({ status: "new_product", productId: null, computedPrice: "29.99" });
    expect(json.summary).toMatchObject({ total: 3, ready: 1, conflicts: 1, newProducts: 1, actionable: 2 });
    expect(json.previewToken).toBeTypeOf("string");
  });

  it("reports a supplier file's price column as ignored, never as a price", async () => {
    const p = await makeProduct();
    await link(p.id, supplierId, null, true, "SUP-1");
    const { json } = await preview(["skuFornecedor;nome;custo;Preço", "SUP-1;Cabo;10,00;250,00"].join("\n"));
    expect(json.ignoredColumns).toContain("Preço");
    expect(json.lines[0].costPrice).toBe("10.00");
    expect(json.lines[0].issues.some((i: any) => i.code === "PRICE_COLUMN_IGNORED")).toBe(true);
    const [row] = await db.select().from(products).where(eq(products.id, p.id));
    expect(row.price).toBe("100.00");
  });

  it("rejects a 10 001 line file and an empty file", async () => {
    const big = csvFile(...Array.from({ length: 10001 }, (_, i) => line({ sku: `SUP-${i}`, name: "linha", cost: "1,00" })));
    const tooBig = await preview(big);
    expect(tooBig.status).toBe(400);
    expect(tooBig.json.error).toBe("CSV_TOO_MANY_ROWS");

    const empty = await preview("");
    expect(empty.status).toBe(400);
    expect(empty.json.error).toBe("CSV_EMPTY");
  });

  it("requires a real supplier", async () => {
    const res = await previewPOST(post("/api/admin/supplier-import", { supplierId: 999999, data: csvFile(line({ sku: "X", name: "n" })) }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("SUPPLIER_NOT_FOUND");
  });

  it("keeps RBAC: staff may read history but may not preview", async () => {
    getCurrentUserMock.mockResolvedValue(STAFF);
    expect((await preview(csvFile(line({ sku: "SUP-1", name: "n", cost: "1,00" })))).status).toBe(403);
    const history = await historyGET(new NextRequest("http://localhost/api/admin/supplier-import"));
    expect(history.status).toBe(200);
  });

  it("refuses a cross-origin POST (CSRF guard reused)", async () => {
    const res = await previewPOST(post("/api/admin/supplier-import", { supplierId, data: csvFile(line({ sku: "X", name: "n" })) }, false));
    expect(res.status).toBe(403);
  });
});

describe("C.3.1 — apply consumes the snapshot, never the browser", () => {
  it("refuses the first apply without a valid signed token", async () => {
    await globalRule(20);
    const p = await makeProduct();
    await link(p.id, supplierId, "50.00", true, "SUP-1");
    const { json } = await preview(csvFile(line({ sku: "SUP-1", name: "Cabo", cost: "10,00" })));

    const noToken = await apply(json.importId);
    expect(noToken.status).toBe(403);
    expect(noToken.json.error).toBe("PREVIEW_TOKEN_REQUIRED");

    const forged = await apply(json.importId, "eyJhbGciOi.test.deadbeef");
    expect(forged.status).toBe(403);
    expect(forged.json.error).toBe("PREVIEW_TOKEN_INVALID");
    expect((await db.select().from(products).where(eq(products.id, p.id)))[0].price).toBe("100.00");
  });

  it("refuses a valid token belonging to another import (supplier, hash and rows are bound)", async () => {
    await globalRule(20);
    const p = await makeProduct();
    await link(p.id, supplierId, "50.00", true, "SUP-1");
    const first = await preview(csvFile(line({ sku: "SUP-1", name: "Cabo", cost: "10,00" })));
    const second = await preview(csvFile(line({ sku: "SUP-1", name: "Cabo", cost: "11,00" })));

    const crossed = await apply(second.json.importId, first.json.previewToken);
    expect(crossed.status).toBe(403);
    expect(crossed.json.error).toBe("PREVIEW_TOKEN_MISMATCH");
    // Refusing the token must not have started anything.
    expect((await db.select().from(supplierImports).where(eq(supplierImports.id, second.json.importId)))[0].status).toBe("preview");

    // The matching token still works, so it is the binding that failed.
    const ok = await apply(second.json.importId, second.json.previewToken);
    expect(ok.status).toBe(200);
    expect((await db.select().from(products).where(eq(products.id, p.id)))[0].costPrice).toBe("11.00");
  });

  it("applies cost through the preferred supplier and lets the engine set the price", async () => {
    await globalRule(20);
    const p = await makeProduct({ price: "99.00" });
    await link(p.id, supplierId, "50.00", true, "SUP-1");

    const { json } = await preview(csvFile(line({ sku: "SUP-1", name: "Cabo HDMI", cost: "10,00", stock: "8" })));
    expect(json.lines[0]).toMatchObject({ status: "ready", matchType: "supplier_sku", productId: p.id });

    const applied = await apply(json.importId, json.previewToken);
    expect(applied.status).toBe(200);
    expect(applied.json).toMatchObject({
      ok: true, status: "completed", appliedNow: 1, applied: 1, created: 0, repriced: 1, pending: 0,
    });

    const [row] = await db.select().from(products).where(eq(products.id, p.id));
    expect(row.costPrice).toBe("10.00");
    expect(row.price).toBe("14.99"); // engine: 10 → 12 net → 14,76 → 14,99
    expect(row.priceMode).toBe("auto");

    const [linkRow] = await db.select().from(productSuppliers)
      .where(and(eq(productSuppliers.productId, p.id), eq(productSuppliers.supplierId, supplierId)));
    expect(linkRow).toMatchObject({ supplierSku: "SUP-1", costPrice: "10.00", lastCostPrice: "50.00" });

    const movements = await db.select().from(stockMovements).where(eq(stockMovements.productId, p.id));
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ type: "import", quantity: 8, stockBefore: 0, stockAfter: 8, referenceType: "supplier_import" });
  });

  it("protects a manual price absolutely while still syncing cost and stock", async () => {
    await globalRule(20);
    const p = await makeProduct({ priceMode: "manual", price: "77.77" });
    await link(p.id, supplierId, "50.00", true, "SUP-1");

    const { json } = await preview(csvFile(line({ sku: "SUP-1", name: "Cabo", cost: "10,00", stock: "5" })));
    expect(json.lines[0].status).toBe("ready");
    expect(json.lines[0].computedPrice).toBeNull();
    expect(json.lines[0].message).toContain("manual");

    const applied = await apply(json.importId, json.previewToken);
    expect(applied.json).toMatchObject({ status: "completed", appliedNow: 1, repriced: 0 });

    const [row] = await db.select().from(products).where(eq(products.id, p.id));
    expect(row.price).toBe("77.77");     // never touched
    expect(row.costPrice).toBe("10.00"); // cost and stock may follow the file
    expect(row.stock).toBe(5);
  });

  it("a non-preferred supplier updates its own link and nothing else", async () => {
    await globalRule(20);
    const p = await makeProduct({ price: "14.99", costPrice: "10.00" });
    await link(p.id, supplierId, "10.00", true);
    await link(p.id, otherSupplierId, "99.00", false, "SUP-B1");

    const res = await previewPOST(post("/api/admin/supplier-import", {
      supplierId: otherSupplierId, fileName: "b.csv", data: csvFile(line({ sku: "SUP-B1", name: "Cabo", cost: "8,00", stock: "4" })),
    }));
    const json = await res.json() as any;
    expect(json.lines[0]).toMatchObject({ status: "ready", isPreferredSupplier: false });

    const applied = await apply(json.importId, json.previewToken);
    expect(applied.json).toMatchObject({ status: "completed", repriced: 0, updated: 1 });

    const [row] = await db.select().from(products).where(eq(products.id, p.id));
    expect(row.costPrice).toBe("10.00"); // NOT 8.00
    expect(row.price).toBe("14.99");     // no repricing through a non-preferred cost
    expect(row.stock).toBe(4);            // stock is catalogue-level

    const [bLink] = await db.select().from(productSuppliers)
      .where(and(eq(productSuppliers.productId, p.id), eq(productSuppliers.supplierId, otherSupplierId)));
    expect(bLink.costPrice).toBe("8.00");      // its own link did change
    expect(bLink.lastCostPrice).toBe("99.00");
    expect(bLink.isPreferred).toBe(false);     // and it never took the throne
    const [aLink] = await db.select().from(productSuppliers)
      .where(and(eq(productSuppliers.productId, p.id), eq(productSuppliers.supplierId, supplierId)));
    expect(aLink.costPrice).toBe("10.00");      // the preferred link is untouched
    expect(await db.select().from(stockMovements).where(eq(stockMovements.productId, p.id))).toHaveLength(1);
  });

  it("creates a missing product once, priced by the engine, with one entry movement", async () => {
    await globalRule(20);
    const newSku = `${TAG}-NEW1`;
    const { json } = await preview(csvFile(line({ sku: "SUP-NEW", name: "Cabo Novo", cost: "20,00", stock: "6", internalSku: newSku })));
    const applied = await apply(json.importId, json.previewToken);
    expect(applied.json).toMatchObject({ status: "completed", appliedNow: 1, created: 1, updated: 0 });

    const [created] = await db.select().from(products).where(eq(products.sku, newSku));
    expect(created).toBeTruthy();
    expect(created.price).toBe("29.99");
    expect(created.priceMode).toBe("auto");
    expect(created.costPrice).toBe("20.00");
    expect(created.stock).toBe(6);
    expect(created.name).toBe("Cabo Novo"); // the snapshot designation
    expect(created.ean).toBeNull();

    const [createdLink] = await db.select().from(productSuppliers).where(eq(productSuppliers.productId, created.id));
    expect(createdLink).toMatchObject({ supplierId, supplierSku: "SUP-NEW", isPreferred: true });

    const movements = await db.select().from(stockMovements).where(eq(stockMovements.productId, created.id));
    expect(movements).toHaveLength(1);
    expect(movements[0].type).toBe("entry");

    const [storedRow] = await db.select().from(supplierImportRows).where(eq(supplierImportRows.importId, json.importId));
    expect(storedRow).toMatchObject({ status: "ready", productId: created.id, applied: true });

    // The same file again: the SKU now exists, so nothing is created twice.
    const again = await preview(csvFile(line({ sku: "SUP-NEW", name: "Cabo Novo", cost: "20,00", stock: "6", internalSku: newSku })));
    expect(again.json.lines[0]).toMatchObject({ status: "ready", productId: created.id, matchType: "supplier_sku" });
  });

  it("never applies a conflicted or invalid line", async () => {
    await globalRule(20);
    const p1 = await makeProduct();
    const p2 = await makeProduct();
    await link(p1.id, supplierId, null, false, "DUP");
    await link(p2.id, supplierId, null, false, "DUP");

    const { json } = await preview(csvFile(
      line({ sku: "DUP", name: "ambíguo", cost: "5,00" }),
      line({ name: "o nome nunca é chave", cost: "10,00", stock: "2" }),
      line({ name: "ean inválido", cost: "1,00", stock: "1", ean: "123456789012" }),
    ));
    expect(json.summary.conflicts).toBe(1);
    expect(json.summary.errors).toBe(2);
    expect(json.lines.map((l: any) => l.status)).toEqual(["conflict", "error", "error"]);

    const applied = await apply(json.importId, json.previewToken);
    expect(applied.json).toMatchObject({ status: "completed", appliedNow: 0, applied: 0, conflicts: 1, errors: 2 });

    for (const row of await db.select().from(products).where(inArray(products.id, [p1.id, p2.id]))) {
      expect(row.costPrice).toBeNull();
      expect(row.stock).toBe(0);
    }
    expect(await db.select().from(stockMovements).where(inArray(stockMovements.productId, [p1.id, p2.id]))).toHaveLength(0);
  });

  it("applies 1200 lines in 3 batches of 500", async () => {
    await globalRule(20);
    const count = 1200;
    const created = await db.insert(products).values(Array.from({ length: count }, (_, i) => ({
      name: `${TAG} bulk ${i}`, slug: `${TAG.toLowerCase()}-bulk-${i}`, sku: `${TAG}-BULK-${i}`,
      price: "100.00", vatRate: "23.00", priceMode: "auto", stock: 0,
    }))).returning({ id: products.id });
    await db.insert(productSuppliers).values(created.map((p, i) => ({
      productId: p.id, supplierId, costPrice: "50.00", isPreferred: true, supplierSku: `${TAG}-BULK-${i}`,
    })));

    const csvText = csvFile(...created.map((p, i) => line({ sku: `${TAG}-BULK-${i}`, name: `linha ${i}`, cost: "10,00", stock: String(i % 7) })));
    const { json } = await preview(csvText);
    expect(json.summary).toMatchObject({ total: count, ready: count, actionable: count });
    expect(json.batchesTotal).toBe(3);
    expect(json.lines).toHaveLength(200); // the response is paginated…
    expect(json.truncated).toBe(true);
    // …while the snapshot is complete.
    expect(await db.select({ id: supplierImportRows.id }).from(supplierImportRows)
      .where(eq(supplierImportRows.importId, json.importId))).toHaveLength(count);

    const applied = await apply(json.importId, json.previewToken);
    expect(applied.json).toMatchObject({
      status: "completed", appliedNow: count, applied: count, batchesDone: 3, batchesTotal: 3, pending: 0, repriced: count,
    });

    const ids = created.map((c) => c.id);
    const priced = await db.select({ id: products.id, price: products.price, costPrice: products.costPrice, stock: products.stock })
      .from(products).where(inArray(products.id, ids));
    expect(priced).toHaveLength(count);
    expect(priced.every((p) => p.price === "14.99" && p.costPrice === "10.00")).toBe(true);

    const movements = await db.select({ id: stockMovements.id, product: stockMovements.productId })
      .from(stockMovements).where(inArray(stockMovements.productId, ids));
    // exactly one movement per line that changed stock, never two for a product
    expect(movements).toHaveLength(created.filter((_, i) => i % 7 !== 0).length);
    expect(new Set(movements.map((m) => m.product)).size).toBe(movements.length);
  }, 180000);

  it("is idempotent: re-applying a completed import re-applies nothing", async () => {
    await globalRule(20);
    const p = await makeProduct({ price: "99.00" });
    await link(p.id, supplierId, "50.00", true, "SUP-1");
    const { json } = await preview(csvFile(line({ sku: "SUP-1", name: "Cabo", cost: "10,00", stock: "8" })));

    const first = await apply(json.importId, json.previewToken);
    expect(first.json.appliedNow).toBe(1);
    const afterFirst = (await db.select().from(products).where(eq(products.id, p.id)))[0];

    // Same call again, with and without the token: same answer, no second effect.
    const again = await apply(json.importId, json.previewToken);
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ status: "completed", appliedNow: 0, applied: 1, idempotent: true });
    expect((await apply(json.importId)).json.idempotent).toBe(true);

    const afterSecond = (await db.select().from(products).where(eq(products.id, p.id)))[0];
    expect(afterSecond.price).toBe(afterFirst.price);
    expect(afterSecond.stock).toBe(afterFirst.stock);
    expect(await db.select().from(stockMovements).where(eq(stockMovements.productId, p.id))).toHaveLength(1);
    const [linkRow] = await db.select().from(productSuppliers)
      .where(and(eq(productSuppliers.productId, p.id), eq(productSuppliers.supplierId, supplierId)));
    expect(linkRow.lastCostPrice).toBe("50.00"); // one cost transition, not two
  });

  it("resumes a partial import with no CSV and no token, applying only pending lines", async () => {
    await globalRule(20);
    const a = await makeProduct();
    const b = await makeProduct();
    await link(a.id, supplierId, "50.00", true, "SUP-A");
    await link(b.id, supplierId, "50.00", true, "SUP-B");

    const { json } = await preview(csvFile(
      line({ sku: "SUP-A", name: "A", cost: "10,00", stock: "3" }),
      line({ sku: "SUP-B", name: "B", cost: "30,00", stock: "4" }),
    ));

    // Simulate an interrupted run: the FIRST line is committed, the worker died
    // before the second, and the import was left in 'partial'.
    await db.execute(sql`UPDATE supplier_import_rows SET applied = true, applied_at = now() WHERE import_id = ${json.importId} AND row_number = 2`);
    await db.execute(sql`UPDATE supplier_imports SET status = 'partial', started_at = now(), heartbeat_at = now() - interval '10 minutes' WHERE id = ${json.importId}`);

    const resumed = await apply(json.importId); // no token, no CSV
    expect(resumed.status).toBe(200);
    expect(resumed.json).toMatchObject({ status: "completed", appliedNow: 1, applied: 2, resumed: true });

    // Only the never-applied line produced an effect.
    const [rowB] = await db.select().from(products).where(eq(products.id, b.id));
    expect(rowB.costPrice).toBe("30.00");
    expect(rowB.price).toBe("44.99"); // 30 → 36 net → 44,28 → ,99
    expect(await db.select().from(stockMovements).where(eq(stockMovements.productId, b.id))).toHaveLength(1);
    const [rowA] = await db.select().from(products).where(eq(products.id, a.id));
    expect(rowA.costPrice).toBeNull();
    expect(await db.select().from(stockMovements).where(eq(stockMovements.productId, a.id))).toHaveLength(0);
  });
});

describe("C.3.1 — progress endpoint", () => {
  it("reports real counters and server-side canResume", async () => {
    await globalRule(20);
    const p = await makeProduct();
    await link(p.id, supplierId, "50.00", true, "SUP-1");
    const { json } = await preview(csvFile(
      line({ sku: "SUP-1", name: "Cabo", cost: "10,00", stock: "2" }),
      line({ sku: `${TAG}-NEW2`, name: "Novo", cost: "12,00", stock: "1" }),
      line({ name: "sem chave", cost: "1,00" }),
    ));

    const idle = await progress(json.importId);
    expect(idle.status).toBe(200);
    expect(idle.json).toMatchObject({
      importId: json.importId, status: "preview", supplierId, total: 3, applied: 0, pending: 2,
      errors: 1, conflicts: 0, batchesDone: 0, batchesTotal: 1, canResume: false, stale: false,
    });
    expect(idle.json.startedAt).toBeNull();
    expect(idle.json.completedAt).toBeNull();
    expect(idle.json.heartbeatAt).toBeNull();
    expect(idle.json.heartbeatTtlMs).toBe(5 * 60 * 1000);

    await apply(json.importId, json.previewToken);
    const done = await progress(json.importId);
    expect(done.json).toMatchObject({ status: "completed", applied: 2, pending: 0, canResume: false, batchesDone: 1 });
    expect(done.json.completedAt).toBeTruthy();
    expect(done.json.startedAt).toBeTruthy();
    expect(done.json.heartbeatAt).toBeTruthy();

    // partial → resumable; a fresh 'applying' is not; a stale one is.
    await db.execute(sql`UPDATE supplier_imports SET status = 'partial' WHERE id = ${json.importId}`);
    expect((await progress(json.importId)).json.canResume).toBe(true);
    await db.execute(sql`UPDATE supplier_imports SET status = 'applying', heartbeat_at = now() WHERE id = ${json.importId}`);
    expect((await progress(json.importId)).json).toMatchObject({ status: "applying", canResume: false, stale: false });
    await db.execute(sql`UPDATE supplier_imports SET heartbeat_at = now() - interval '6 minutes' WHERE id = ${json.importId}`);
    expect((await progress(json.importId)).json).toMatchObject({ canResume: true, stale: true });
    void p;
  });

  it("returns 404 for an unknown import and 403 for anonymous callers", async () => {
    expect((await progress(999999)).status).toBe(404);
    getCurrentUserMock.mockResolvedValue(null);
    expect((await progress(1)).status).toBe(403);
  });

  it("serves the persisted snapshot lines so a reload can re-show the preview", async () => {
    await globalRule(20);
    const p = await makeProduct();
    await link(p.id, supplierId, "50.00", true, "SUP-1");
    const { json } = await preview(csvFile(line({ sku: "SUP-1", name: "Cabo", cost: "10,00" })));

    const res = await linesGET(new NextRequest("http://localhost/x"), { params: Promise.resolve({ id: String(json.importId) }) });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({
      rowNumber: 2, supplierSku: "SUP-1", status: "ready", costPrice: "10.00", currentPrice: "100.00",
    });
  });

  it("lists import history for a supplier", async () => {
    await globalRule(20);
    const p = await makeProduct();
    await link(p.id, supplierId, "50.00", true, "SUP-1");
    const { json } = await preview(csvFile(line({ sku: "SUP-1", name: "Cabo", cost: "10,00" })));
    await apply(json.importId, json.previewToken);

    const res = await historyGET(new NextRequest(`http://localhost/api/admin/supplier-import?supplierId=${supplierId}`));
    const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(body.imports.length).toBeGreaterThanOrEqual(1);
    expect(body.imports[0]).toMatchObject({
      id: json.importId, status: "completed", rowCount: 1, batchesDone: 1,
      supplierName: `${TAG} Fornecedor A`,
    });
    expect(body.imports[0].fileHash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.imports[0].finishedAt).toBeTruthy();
    expect(p).toBeTruthy();

    const bad = await historyGET(new NextRequest("http://localhost/api/admin/supplier-import?supplierId=abc"));
    expect(bad.status).toBe(400);
  });
});

describe("C.3.1 — disappeared products are detected, never acted on", () => {
  it("compares only with the last completed import of the same supplier", async () => {
    await globalRule(20);
    const kept = await makeProduct();
    const gone = await makeProduct();
    await link(kept.id, supplierId, "10.00", true, "SUP-KEEP");
    await link(gone.id, supplierId, "10.00", true, "SUP-GONE");

    const first = await preview(csvFile(
      line({ sku: "SUP-KEEP", name: "keep", cost: "10,00" }),
      line({ sku: "SUP-GONE", name: "gone", cost: "10,00" }),
    ));
    expect(first.json.missingProducts).toMatchObject({ action: "none", count: 0, skippedReason: "NO_PREVIOUS_COMPLETED_IMPORT" });
    await apply(first.json.importId, first.json.previewToken);

    // Second file: SUP-GONE is no longer offered by this supplier.
    const second = await preview(csvFile(line({ sku: "SUP-KEEP", name: "keep", cost: "11,00" })));
    expect(second.json.missingProducts).toMatchObject({ action: "none", count: 1, comparedToImportId: first.json.importId });
    expect(second.json.missingProducts.items[0]).toMatchObject({ supplierSku: "SUP-GONE", productId: gone.id });

    const applied = await apply(second.json.importId, second.json.previewToken);
    expect(applied.json.status).toBe("completed");

    // Detection only: the product is still active, still stocked, priced by the engine.
    const [stillThere] = await db.select().from(products).where(eq(products.id, gone.id));
    expect(stillThere.isActive).toBe(true);
    expect(stillThere.stock).toBe(0);
    expect(stillThere.price).toBe("14.99");
    expect(await db.select().from(stockMovements).where(eq(stockMovements.productId, gone.id))).toHaveLength(0);

    // Another supplier's file never reports this supplier's disappearances.
    const otherRun = await previewPOST(post("/api/admin/supplier-import", {
      supplierId: otherSupplierId, fileName: "other.csv", data: csvFile(line({ sku: "NADA", name: "x", cost: "1,00" })),
    }));
    const otherBody = await otherRun.json() as any;
    expect(otherBody.missingProducts.skippedReason).toBe("NO_PREVIOUS_COMPLETED_IMPORT");
  });

  it("does not invent a disappearance from a missing or ambiguous key", async () => {
    await globalRule(20);
    const eanOnly = await makeProduct({ ean: eanFor("333333333333") });
    const dupA = await makeProduct();
    const dupB = await makeProduct();
    await link(dupA.id, supplierId, null, false, "SUP-DUP");
    await link(dupB.id, supplierId, null, false, "SUP-DUP");

    // Previous import: one line identified ONLY by EAN (so the snapshot has no
    // supplier SKU for that product) and a pair of lines whose supplier SKU
    // repeats. Neither can prove that a product disappeared.
    const first = await preview(csvFile(
      line({ name: "por ean", cost: "1,00", stock: "2", ean: eanFor("333333333333") }),
      line({ sku: "SUP-DUP", name: "a", cost: "1,00" }),
      line({ sku: "SUP-DUP", name: "b", cost: "1,00" }),
    ));
    expect(first.json.summary).toMatchObject({ ready: 1, conflicts: 2 });
    await apply(first.json.importId, first.json.previewToken);
    expect((await db.select().from(products).where(eq(products.id, eanOnly.id)))[0].stock).toBe(2);

    const second = await preview(csvFile(line({ sku: `${TAG}-GONE2`, name: "b", cost: "2,00", internalSku: `${TAG}-GONE2` })));
    expect(second.json.missingProducts).toMatchObject({ count: 0, ambiguous: 1 });
    expect(second.json.missingProducts.items).toEqual([]);
  });

  it("skips detection when the file has no supplier SKU column at all", async () => {
    const { json } = await preview(["internalSku;nome;custo", `${TAG}-X;x;1,00`].join("\n"));
    expect(json.missingProducts).toMatchObject({ action: "none", count: 0, skippedReason: "NO_SUPPLIER_SKU_IN_FILE" });
  });
});

// ─── C.3.1 audit fix: the internal SKU of a new product is MDTech's own ───
//
// products.sku is the catalogue's global reference and product_suppliers.supplier_sku
// is one supplier's code for the same article. A supplier list may never write the
// second into the first: a minted MD-… number is used instead, allocated by a
// PostgreSQL sequence so concurrent imports cannot collide, and so a collision can
// never roll back the 500-row batch it happened in.
describe("C.3.1 — new products get an internal MDTech SKU", () => {
  /** Raw rows from db.execute (drizzle keeps the PG result shape here). */
  async function raw(query: ReturnType<typeof sql>) {
    const r = await db.execute(query) as unknown;
    return (Array.isArray(r) ? r : (r as { rows?: unknown[] }).rows ?? []) as Record<string, unknown>[];
  }

  const mdSku = (value: number) => `MD-${String(value).padStart(6, "0")}`;

  async function productFor(supplierSku: string) {
    const [row] = await db.select().from(products).where(eq(products.sku, supplierSku)).limit(1);
    return row ?? null;
  }

  it("mints MD-… for a line without an internal SKU, and never copies the supplier's code", async () => {
    const { json } = await preview(csvFile(line({ sku: "SUP-MD-1", name: "Cabo Minton", cost: "10,00", stock: "3" })));
    expect(json.lines[0]).toMatchObject({ status: "new_product", matchType: "none" });

    const applied = await apply(json.importId, json.previewToken);
    expect(applied.json).toMatchObject({ status: "completed", created: 1, pending: 0 });
    expect(applied.json.error).toBeUndefined();

    // The supplier's code is NOT the product's internal SKU.
    expect(await productFor("SUP-MD-1")).toBeNull();
    const [stored] = await db.select().from(supplierImportRows).where(eq(supplierImportRows.importId, json.importId));
    const [created] = await db.select().from(products).where(eq(products.id, stored.productId as number));
    expect(created.sku).toMatch(/^MD-\d{6}$/);
    expect(created.name).toBe("Cabo Minton");
    expect(created.priceMode).toBe("auto");
    // …and it is recorded on the row, so the operator can find the product.
    expect(stored.message).toContain(created.sku as string);

    const [linkRow] = await db.select().from(productSuppliers).where(eq(productSuppliers.productId, created.id));
    expect(linkRow).toMatchObject({ supplierId, supplierSku: "SUP-MD-1", isPreferred: true, costPrice: "10.00" });
  });

  it("honours an internal SKU the operator mapped explicitly, untouched", async () => {
    const explicit = `${TAG}-EXPLICIT-9`;
    const { json } = await preview(csvFile(line({ sku: "SUP-MD-2", name: "Cabo Explícito", cost: "10,00", internalSku: explicit })));
    const applied = await apply(json.importId, json.previewToken);
    expect(applied.json).toMatchObject({ status: "completed", created: 1 });

    const [created] = await db.select().from(products).where(eq(products.sku, explicit));
    expect(created).toBeTruthy();
    expect(created.sku).toBe(explicit); // never replaced by a minted number
    expect(created.priceMode).toBe("auto");
    const [linkRow] = await db.select().from(productSuppliers).where(eq(productSuppliers.productId, created.id));
    expect(linkRow.supplierSku).toBe("SUP-MD-2");
  });

  it("lets two suppliers use the same code: no merge, no unique violation, no stalled import", async () => {
    await globalRule(20);
    // Supplier A's product was once created from its own file, so its internal
    // SKU literally is A's article code. That is exactly the state a supplier B
    // file used to abort on.
    const aSku = "SHARED-CODE";
    const [a] = await db.insert(products).values({
      name: "Produto de A", slug: `${TAG}-shared-a`, sku: aSku, price: "100.00",
      vatRate: "23.00", priceMode: "auto", costPrice: "40.00", stock: 1,
    }).returning();
    await link(a.id, supplierId, "40.00", true, aSku);

    // B sends the same string as its own code: level 1 is scoped to B, so it must
    // not match A's product; the preview says so instead of deciding silently.
    const [other] = await db.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.name, `${TAG} Fornecedor B`));
    const bPreview = await preview(csvFile(line({ sku: aSku, name: "Cabo de B", cost: "10,00", stock: "4" })), { supplierId: other?.id });
    expect(bPreview.json.lines[0]).toMatchObject({ status: "new_product", matchType: "none" });
    expect(bPreview.json.lines[0].codes).toEqual([]);
    expect(bPreview.json.lines[0].issues.map((i: { code: string }) => i.code)).toContain("SUPPLIER_SKU_IS_FOREIGN_INTERNAL_SKU");

    const applied = await apply(bPreview.json.importId, bPreview.json.previewToken);
    expect(applied.json).toMatchObject({ status: "completed", created: 1, pending: 0 });
    expect(applied.json.error).toBeUndefined();

    // A's product is untouched: its own cost and price stay as they were.
    const [afterA] = await db.select().from(products).where(eq(products.id, a.id));
    expect(afterA.costPrice).toBe("40.00");
    expect(afterA.price).toBe("100.00");
    expect(afterA.stock).toBe(1);

    // B got a separate product with a minted SKU, and its own link.
    const [bRow] = await db.select().from(supplierImportRows).where(eq(supplierImportRows.importId, bPreview.json.importId));
    const [bProduct] = await db.select().from(products).where(eq(products.id, bRow.productId as number));
    expect(bProduct.id).not.toBe(a.id);
    expect(bProduct.sku).toMatch(/^MD-\d{6}$/);
    const [bLink] = await db.select().from(productSuppliers)
      .where(and(eq(productSuppliers.productId, bProduct.id), eq(productSuppliers.supplierId, other?.id as number)));
    expect(bLink).toMatchObject({ supplierSku: aSku, costPrice: "10.00" });
  });

  it("skips a minted number already taken by hand-written data instead of failing the batch", async () => {
    // Occupy the value the import is about to be handed, then rewind the
    // sequence so the collision really happens on the first attempt.
    const before = await raw(sql`SELECT nextval('product_internal_sku_seq') AS n`);
    const taken = Number(before[0]?.n);
    expect(Number.isFinite(taken)).toBe(true);
    await db.insert(products).values({
      name: "Ocupado à mão", slug: `${TAG}-occupied`, sku: mdSku(taken),
      price: "100.00", vatRate: "23.00", priceMode: "auto", stock: 0,
    });
    // is_called = false: the import is handed `taken` again, so the collision
    // really happens on its first allocation attempt instead of being pretended.
    await raw(sql`SELECT setval('product_internal_sku_seq', ${taken}::bigint, false)`);

    const { json } = await preview(csvFile(line({ sku: "SUP-MD-3", name: "Cabo Riscado", cost: "10,00" })));
    const applied = await apply(json.importId, json.previewToken);
    expect(applied.json).toMatchObject({ status: "completed", created: 1, pending: 0 });
    expect(applied.json.error).toBeUndefined();

    const [row] = await db.select().from(supplierImportRows).where(eq(supplierImportRows.importId, json.importId));
    const [created] = await db.select().from(products).where(eq(products.id, row.productId as number));
    expect(created.sku).not.toBe(mdSku(taken)); // the occupied value was refused
    expect(created.sku).toMatch(/^MD-\d{6}$/); // and a fresh one took its place
    expect((await db.select().from(products).where(eq(products.slug, `${TAG}-occupied`)))[0].name).toBe("Ocupado à mão");
  });

  it("gives concurrent imports distinct SKUs, and both imports finish", async () => {
    const first = await preview(csvFile(line({ sku: "SUP-RACE-A", name: "Cabo corrida A", cost: "10,00" })));
    const [other] = await db.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.name, `${TAG} Fornecedor B`));
    const second = await preview(csvFile(line({ sku: "SUP-RACE-B", name: "Cabo corrida B", cost: "11,00" })), { supplierId: other?.id });

    const results = await Promise.all([
      apply(first.json.importId, first.json.previewToken),
      apply(second.json.importId, second.json.previewToken),
    ]);
    for (const res of results) {
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ status: "completed", created: 1, pending: 0 });
      expect(res.json.error).toBeUndefined();
    }

    const rows = await db
      .select({ sku: products.sku, supplierSku: productSuppliers.supplierSku })
      .from(supplierImportRows)
      .innerJoin(products, eq(products.id, supplierImportRows.productId))
      .innerJoin(productSuppliers, eq(productSuppliers.productId, products.id))
      .where(inArray(supplierImportRows.importId, [first.json.importId, second.json.importId]));
    const skus = rows.map((r) => r.sku);
    expect(skus).toHaveLength(2);
    expect(new Set(skus).size).toBe(2); // nextval() never handed out the same number twice
    expect(skus.every((s) => /^MD-\d{6}$/.test(String(s)))).toBe(true);
    expect(rows.map((r) => r.supplierSku).sort()).toEqual(["SUP-RACE-A", "SUP-RACE-B"]);
  });
});

// ─── C.3.1 audit fixes: persistence, disappearance and the size ceiling ───
describe("C.3.1 — preview persistence, missing products and file size", () => {
  it("rolls the whole preview back when a snapshot row cannot be written", async () => {
    // 501 lines: the header and the first chunk are already in the database when
    // the second chunk explodes (a cost beyond numeric(10,2)). A half-written
    // snapshot must not survive, because that subset is exactly what apply would
    // otherwise consume.
    const rows = Array.from({ length: 501 }, (_, i) =>
      line({ sku: `${TAG}-TX-${i}`, name: `linha ${i}`, cost: i === 500 ? "999999999,99" : "1,00" }));
    const res = await preview(csvFile(...rows), { fileName: `${TAG}-tx.csv` });

    expect(res.status).toBe(500);
    expect(res.json.error).toBe("SUPPLIER_IMPORT_PREVIEW_FAILED");
    expect(await db.select().from(supplierImports).where(eq(supplierImports.fileName, `${TAG}-tx.csv`))).toHaveLength(0);
    // Nothing of this file exists either, and the user's history is untouched.
    const orphans = await db.execute(sql`
      SELECT count(*)::int AS count FROM supplier_import_rows r
        JOIN supplier_imports i ON i.id = r.import_id
       WHERE i.file_name = ${`${TAG}-tx.csv`}
    `) as unknown as { rows?: { count: number }[] };
    expect(orphans.rows?.[0]?.count ?? 0).toBe(0);
  }, 120000);

  it("counts a reference repeated in the new file as seen, not as disappeared", async () => {
    await globalRule(20);
    // A completed import establishes SUP-KEEP as this supplier's line…
    const first = await preview(csvFile(line({ sku: "SUP-KEEP", name: "Cabo", cost: "10,00" })));
    expect((await apply(first.json.importId, first.json.previewToken)).json).toMatchObject({ status: "completed", created: 1 });

    // …and the next file still lists it, twice, so both rows are conflicts.
    // Repetition is ambiguity; it is never proof that the product vanished.
    const second = await preview(csvFile(
      line({ sku: "SUP-KEEP", name: "Cabo a", cost: "11,00" }),
      line({ sku: "SUP-KEEP", name: "Cabo b", cost: "12,00" }),
    ));
    expect(second.json.summary).toMatchObject({ conflicts: 2, actionable: 0 });
    expect(second.json.missingProducts).toMatchObject({
      action: "none", count: 0, ambiguous: 0, comparedToImportId: first.json.importId,
    });
    expect(second.json.missingProducts.items).toEqual([]);

    // A reference that is genuinely absent is still reported — the fix must not
    // turn the report into a no-op.
    const third = await preview(csvFile(line({ sku: "SUP-OUTRA", name: "Outro", cost: "11,00" })));
    expect(third.json.missingProducts).toMatchObject({ action: "none", count: 1 });
    expect(third.json.missingProducts.items[0]).toMatchObject({ supplierSku: "SUP-KEEP" });
  });

  it("measures the file in UTF-8 bytes, not in characters", async () => {
    // 2.1 million "€" are 6.3 MB: over the ceiling even though the string looks
    // small. The guard must refuse it before parsing anything.
    const heavy = `"${"€".repeat(2_100_000)}"`;
    const data = `skuFornecedor;nome;custo\nSUP-BYTES;${heavy};1,00`;
    expect(data.length).toBeLessThan(5 * 1024 * 1024);
    const big = await preview(data);
    expect(big.status).toBe(400);
    expect(big.json.error).toBe("CSV_FILE_TOO_LARGE");
    // 2.1 million "€" are 6 300 000 bytes: the message reports the real weight.
    expect(big.json.message).toMatch(/^Ficheiro com 6\.0 MB — o limite é 5 MB$/);

    // The same refusal by ASCII weight, so the rule is one number and not a
    // coincidence of encoding: characters and bytes are only equal when they are.
    const ascii = await preview(`skuFornecedor;nome;custo\nSUP-BYTES;${"x".repeat(5_300_000)};1,00`);
    expect(ascii.json.error).toBe("CSV_FILE_TOO_LARGE");

    // And a multi-byte file under the ceiling is accepted: the guard never counts
    // characters, in either direction. The size that is recorded is the byte count.
    const text = csvFile(...Array.from({ length: 200 }, (_, i) => line({ sku: `SUP-MB-${i}`, name: `cabo€${i}€`, cost: "1,00" })));
    const ok = await preview(text);
    expect(ok.status).toBe(200);
    expect(ok.json.fileSizeBytes).toBe(Buffer.byteLength(text, "utf8"));
    expect(ok.json.fileSizeBytes).toBeGreaterThan(text.length);
    expect(ok.json.summary.total).toBe(200);
  }, 120000);
});
