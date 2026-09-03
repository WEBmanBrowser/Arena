/**
 * C.3.1 — REGRESSION: the legacy catalogue importer must never write
 * products.price directly.
 *
 * Before C.3.1 the CSV importer did
 *
 *   price: price?.toFixed(2) || "0.00"          (on create)
 *   if (price !== null) updateData.price = …   (on update)
 *
 * which let a supplier/catalogue file overwrite a price that the C.1/C.2 engine
 * owns (auto) or that a human owns (manual). These tests lock the fix:
 *
 *   - the file's price column is never written, in either price mode;
 *   - price_mode='manual' products keep their price even when the cost changes;
 *   - price_mode='auto' products are repriced ONLY by the engine, from the cost
 *     of the PREFERRED supplier (10 € + 20 % + 23 % IVA → 14,99 €);
 *   - a new product's initial price is the engine's, not the file's;
 *   - stock still lands with exactly one movement (the fix removed nothing else).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { pricingRules, productSuppliers, products, stockMovements, suppliers, users } from "@/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";

const getCurrentUserMock = vi.fn();
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getCurrentUser: () => getCurrentUserMock() };
});

import { POST as legacyImportPOST } from "@/app/api/admin/import/route";

const TAG = "C31LEG";
const MANAGER = { id: 9731, email: "c31-legacy@test.local", name: "C31 Legacy", role: "manager", phone: null, nif: null, company: null };
const STAFF = { id: 9732, email: "c31-legacy-staff@test.local", name: "C31 Legacy Staff", role: "staff", phone: null, nif: null, company: null };

let supplierId = 0;
let otherSupplierId = 0;
const createdProductIds: number[] = [];

async function cleanup() {
  if (createdProductIds.length) {
    await db.delete(stockMovements).where(inArray(stockMovements.productId, createdProductIds));
    await db.delete(productSuppliers).where(inArray(productSuppliers.productId, createdProductIds));
  }
  await db.execute(sql`DELETE FROM pricing_rules WHERE notes LIKE ${`${TAG}%`}`);
  await db.execute(sql`DELETE FROM supplier_import_rows WHERE product_id IN (SELECT id FROM products WHERE sku LIKE ${`${TAG}-%`})`);
  await db.execute(sql`DELETE FROM supplier_imports WHERE user_id IN (${MANAGER.id}, ${STAFF.id})`);
  await db.execute(sql`DELETE FROM stock_movements WHERE product_id IN (SELECT id FROM products WHERE sku LIKE ${`${TAG}-%`})`);
  await db.execute(sql`DELETE FROM product_suppliers WHERE product_id IN (SELECT id FROM products WHERE sku LIKE ${`${TAG}-%`})`);
  await db.execute(sql`DELETE FROM products WHERE sku LIKE ${`${TAG}-%`}`);
  createdProductIds.length = 0;
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

let seq = 0;
async function makeProduct(extra: Record<string, unknown> = {}) {
  seq += 1;
  const sku = `${TAG}-${seq}`;
  const [p] = await db.insert(products).values({
    name: `Produto ${sku}`, slug: sku.toLowerCase(), sku,
    price: "100.00", vatRate: "23.00", priceMode: "auto", stock: 0,
    ...extra,
  }).returning();
  createdProductIds.push(p.id);
  return p;
}

/** Global markup-on-cost rule → the engine's commercial price. */
async function globalRule(ratePercent = 20) {
  const [r] = await db.insert(pricingRules).values({
    scope: "global", method: "markup_on_cost", ratePercent: String(ratePercent),
    roundingPolicy: "auto", notes: `${TAG} global`,
  }).returning();
  return r;
}

async function link(productId: number, supId: number, cost: string | null, isPreferred: boolean) {
  await db.insert(productSuppliers).values({ productId, supplierId: supId, costPrice: cost, isPreferred });
}

async function runImport(body: Record<string, unknown>) {
  const res = await legacyImportPOST(new NextRequest("http://localhost/api/admin/import", {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "http://localhost" },
    body: JSON.stringify(body),
  }));
  return { status: res.status, json: await res.json() as any };
}

function csv(rows: string[]) {
  return ["SKU,Nome,Preço,Stock,Fornecedor,Custo", ...rows].join("\n");
}

describe("legacy importer — products.price is never written by a file", () => {
  it("does not apply the CSV price column to an AUTO product", async () => {
    await globalRule(20);
    const p = await makeProduct({ costPrice: "10.00" });

    const { status, json } = await runImport({ data: csv([`${p.sku},"Nome qualquer",29.99,,${TAG} Fornecedor A,`]), mode: "execute" });
    expect(status).toBe(200);
    expect(json.error).toBeUndefined();

    // The file said 29.99. It is simply not written: an import that changes no
    // cost changes no price, whoever owns the price.
    const [row] = await db.select().from(products).where(eq(products.id, p.id));
    expect(row.price).toBe("100.00");
    const line = json.results.find((r: any) => r.sku === p.sku);
    expect(line.priceNote).toContain("ignorada");
  });

  it("does not apply the CSV price column to a MANUAL product either", async () => {
    await globalRule(20);
    const p = await makeProduct({ priceMode: "manual", price: "88.00", costPrice: "10.00" });

    await runImport({ data: csv([`${p.sku},Nome,5.00,,${TAG} Fornecedor A,`]), mode: "execute" });

    const [row] = await db.select().from(products).where(eq(products.id, p.id));
    expect(row.price).toBe("88.00");
  });

  it("keeps a manual price even when the preferred supplier cost changes", async () => {
    await globalRule(20);
    const p = await makeProduct({ priceMode: "manual", price: "88.00" });
    await link(p.id, supplierId, "50.00", true);

    const { status } = await runImport({ data: csv([`${p.sku},Nome,,  ,${TAG} Fornecedor A,10.00`]), mode: "execute" });
    expect(status).toBe(200);

    const [row] = await db.select().from(products).where(eq(products.id, p.id));
    expect(row.costPrice).toBe("10.00"); // cost may follow the file…
    expect(row.price).toBe("88.00");     // …the price may not
    const [linkRow] = await db.select().from(productSuppliers)
      .where(and(eq(productSuppliers.productId, p.id), eq(productSuppliers.supplierId, supplierId)));
    expect(linkRow.costPrice).toBe("10.00");
    expect(linkRow.lastCostPrice).toBe("50.00");
  });

  it("reprices an AUTO product through the engine when the preferred cost changes", async () => {
    await globalRule(20);
    const p = await makeProduct({ price: "999.99" });
    await link(p.id, supplierId, "50.00", true);

    await runImport({ data: csv([`${p.sku},Nome,,,${TAG} Fornecedor A,10.00`]), mode: "execute" });

    const [row] = await db.select().from(products).where(eq(products.id, p.id));
    // 10 € cost → 12 € net → 14.76 gross → commercial rounding → 14.99.
    expect(row.price).toBe("14.99");
  });

  it("does NOT reprice when a NON-preferred supplier's cost changes", async () => {
    await globalRule(20);
    const p = await makeProduct({ costPrice: "10.00", price: "14.99" });
    await link(p.id, supplierId, "10.00", true);      // authoritative
    await link(p.id, otherSupplierId, "99.00", false); // the file's supplier

    await runImport({ data: csv([`${p.sku},Nome,,,${TAG} Fornecedor B,5.00`]), mode: "execute" });

    const [row] = await db.select().from(products).where(eq(products.id, p.id));
    expect(row.costPrice).toBe("10.00"); // untouched: the file is not preferred
    expect(row.price).toBe("14.99");
  });

  it("gives a NEW product its price from the engine, never from the file", async () => {
    await globalRule(20);
    const sku = `${TAG}-NEW1`;

    const { status } = await runImport({ data: csv([`${sku},Produto Novo,250.00,,${TAG} Fornecedor A,10.00`]), mode: "execute" });
    expect(status).toBe(200);

    const [row] = await db.select().from(products).where(eq(products.sku, sku));
    expect(row).toBeTruthy();
    createdProductIds.push(row.id);
    expect(row.price).toBe("14.99"); // NOT 250.00
    expect(row.priceMode).toBe("auto");
    expect(row.costPrice).toBe("10.00"); // synced from the new preferred link
  });

  it("leaves a new product at 0.00 when there is no cost to price from", async () => {
    await globalRule(20);
    const sku = `${TAG}-NEW2`;

    await runImport({ data: csv([`${sku},Produto Sem Custo,250.00`]), mode: "execute" });

    const row = (await db.select().from(products).where(eq(products.sku, sku)))[0];
    expect(row).toBeTruthy();
    createdProductIds.push(row.id);
    expect(row.price).toBe("0.00");
  });

  it("still applies stock, with exactly one movement", async () => {
    const p = await makeProduct({ stock: 4 });

    await runImport({ data: csv([`${p.sku},Nome,,12`]), mode: "execute" });

    const [row] = await db.select().from(products).where(eq(products.id, p.id));
    expect(row.stock).toBe(12);
    const movements = await db.select().from(stockMovements).where(eq(stockMovements.productId, p.id));
    expect(movements).toHaveLength(1);
    expect(movements[0].quantity).toBe(8);
  });

  it("preview reports the engine prediction instead of a direct price change", async () => {
    await globalRule(20);
    const p = await makeProduct({ costPrice: "10.00", price: "99.00" });
    await link(p.id, supplierId, "50.00", true);

    const { json } = await runImport({
      data: csv([`${p.sku},Nome,29.99,,${TAG} Fornecedor A,10.00`]),
      mode: "preview",
    });
    const line = json.results[0];
    expect(line.changes.price.to).toBe("14.99");
    expect(line.changes.price.from).toBe("99.00");
    expect(line.priceNote).toContain("motor de preços");
    // The file's own number must not appear as the target price anywhere.
    expect(JSON.stringify(line.changes)).not.toContain("29.99");
  });

  it("rejects staff-only callers exactly as before (RBAC unchanged)", async () => {
    getCurrentUserMock.mockResolvedValue(STAFF);
    const { status } = await runImport({ data: csv([`${TAG}-X,nome,1`]), mode: "execute" });
    expect(status).toBe(403);
  });
});
