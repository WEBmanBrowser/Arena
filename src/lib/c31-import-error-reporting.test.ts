/**
 * C.3.1 — Import error reporting against a real PostgreSQL.
 *
 * The audited fix has two halves, both proven here with a real database:
 *
 *  1. a supplier file whose values do not fit the snapshot columns
 *     (EAN varchar(50), cost decimal(10,2), stock/lead_time int4) must fail the
 *     ROW, not the preview: preview stays 200, the row is marked `error`, the
 *     offending value is never written to the snapshot, and apply skips it;
 *  2. when the database genuinely refuses a write, the response is classified
 *     into a safe, human category (IMPORT_VALUE_* / IMPORT_SCHEMA_MISSING) —
 *     the technical error is logged server-side and the browser never sees
 *     SQL, query, params, a stack or constraint/relation names.
 *
 * Row fixtures are keyed on `${TAG}` internal SKUs and `MD-…` products are
 * found through the snapshot rows, so cleanup below always catches them.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { productSuppliers, products, stockMovements, suppliers, supplierImportRows, supplierImports, users } from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { formatImportError, formatImportErrors } from "@/lib/import-error-text";
import { classifyImportStorageFailure } from "@/lib/supplier-import/error-messages";

const getCurrentUserMock = vi.fn();
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getCurrentUser: () => getCurrentUserMock() };
});

import { POST as previewPOST } from "@/app/api/admin/supplier-import/route";
import { POST as applyPOST } from "@/app/api/admin/supplier-import/apply/route";

const TAG = "C31ERR";
const MANAGER = { id: 9751, email: "c31-error-reporting@test.local", name: "C31 Errors", role: "manager", phone: null, nif: null, company: null };

let supplierId = 0;

/** Valid GTIN-13 from a 12-digit base, so valid-EAN fixtures never trip checksum. */
function eanFor(base12: string): string {
  const digits = base12.padStart(12, "0").slice(0, 12).split("").map(Number);
  const sum = digits.reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 1 : 3), 0);
  return `${base12}${(10 - (sum % 10)) % 10}`;
}

function post(path: string, body: unknown, withOrigin = true) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (withOrigin) headers.origin = "http://localhost";
  return new NextRequest(`http://localhost${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

const HEADER = "skuFornecedor;nome;custo;stock;ean;internalSku;leadTime";
const line = (
  opts: { sku?: string; name?: string; cost?: string; stock?: string; ean?: string; internalSku?: string; leadTime?: string } = {}
) => [opts.sku ?? "", opts.name ?? "", opts.cost ?? "", opts.stock ?? "", opts.ean ?? "", opts.internalSku ?? "", opts.leadTime ?? ""].join(";");
const csvFile = (...rows: string[]) => [HEADER, ...rows].join("\n");

async function preview(csvText: string, body: Record<string, unknown> = {}) {
  const res = await previewPOST(post("/api/admin/supplier-import", { supplierId, fileName: `${TAG}.csv`, data: csvText, ...body }));
  return { status: res.status, json: await res.json() as any };
}

async function apply(importId: number, previewToken?: string) {
  const res = await applyPOST(post("/api/admin/supplier-import/apply", { importId, ...(previewToken ? { previewToken } : {}) }));
  return { status: res.status, json: await res.json() as any };
}

async function importedProductIds(): Promise<number[]> {
  const rows = await db
    .select({ productId: supplierImportRows.productId })
    .from(supplierImportRows)
    .innerJoin(supplierImports, eq(supplierImports.id, supplierImportRows.importId))
    .where(and(eq(supplierImports.userId, MANAGER.id), sql`${supplierImportRows.productId} IS NOT NULL`));
  return [...new Set(rows.map((r) => r.productId).filter((v): v is number => typeof v === "number"))];
}

async function cleanup() {
  const ids = await importedProductIds();
  const list = ids.length ? sql.join(ids.map((id) => sql`${id}`), sql`,`) : null;
  if (list) {
    await db.execute(sql`DELETE FROM stock_movements WHERE product_id IN (${list})`);
    await db.execute(sql`DELETE FROM product_suppliers WHERE product_id IN (${list})`);
  }
  await db.execute(sql`DELETE FROM supplier_import_rows WHERE import_id IN (SELECT id FROM supplier_imports WHERE user_id = ${MANAGER.id})`);
  await db.execute(sql`DELETE FROM supplier_imports WHERE user_id = ${MANAGER.id}`);
  await db.execute(sql`DELETE FROM pricing_rules WHERE notes LIKE ${`${TAG}%`}`);
  const tagged = sql`SELECT id FROM products WHERE sku LIKE ${`${TAG}-%`} OR lower(slug) LIKE ${`${TAG.toLowerCase()}%`}`;
  await db.execute(sql`DELETE FROM stock_movements WHERE product_id IN (${tagged})`);
  await db.execute(sql`DELETE FROM product_suppliers WHERE product_id IN (${tagged})`);
  await db.execute(sql`DELETE FROM products WHERE id IN (${tagged})`);
  if (list) await db.execute(sql`DELETE FROM products WHERE id IN (${list})`);
}

beforeAll(async () => {
  await db.insert(users).values([
    { id: MANAGER.id, email: MANAGER.email, password: "x", name: MANAGER.name, role: MANAGER.role },
  ]).onConflictDoNothing();
  const [a] = await db.insert(suppliers).values({ name: `${TAG} Fornecedor` }).returning();
  supplierId = a.id;
});

beforeEach(async () => {
  getCurrentUserMock.mockReset();
  getCurrentUserMock.mockResolvedValue(MANAGER);
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await db.execute(sql`DELETE FROM audit_logs WHERE user_id = ${MANAGER.id}`);
  await db.execute(sql`DELETE FROM suppliers WHERE name LIKE ${`${TAG}%`}`);
  await db.execute(sql`DELETE FROM users WHERE id = ${MANAGER.id}`);
});

describe("C.3.1 — values beyond the snapshot columns are row errors, not preview failures", () => {
  it("an over-long EAN: preview 200, row in error, value not written to the snapshot", async () => {
    const longEan = "1".repeat(60);
    const res = await preview(csvFile(line({ sku: "SUP-EAN", name: "EAN impossível", ean: longEan, cost: "10,00" })));
    expect(res.status).toBe(200);
    expect(res.json.summary).toMatchObject({ total: 1, errors: 1, actionable: 0 });
    expect(res.json.lines[0]).toMatchObject({ status: "error" });
    expect(res.json.lines[0].issues.map((i: any) => i.code)).toContain("EAN_TOO_LONG");

    const [stored] = await db.select().from(supplierImportRows).where(eq(supplierImportRows.importId, res.json.importId));
    expect(stored).toMatchObject({ rowNumber: 2, status: "error", applied: false });
    expect(stored.ean).toBeNull(); // the value that does not fit is never recorded

    const applied = await apply(res.json.importId, res.json.previewToken);
    expect(applied.json).toMatchObject({ status: "completed", appliedNow: 0, created: 0, errors: 1 });
    expect(await db.select().from(products).where(eq(products.name, "EAN impossível"))).toHaveLength(0);
  });

  it("an EAN with a valid length but bad checksum is also a row error, not a 500", async () => {
    const res = await preview(csvFile(line({ sku: "SUP-GTIN", name: "EAN inválido", ean: "4006381333932", cost: "10,00" })));
    expect(res.status).toBe(200);
    expect(res.json.lines[0]).toMatchObject({ status: "error" });
    expect(res.json.lines[0].issues.map((i: any) => i.code)).toContain("INVALID_GTIN");
  });

  it("a cost beyond numeric(10,2) is a row error and never reaches the snapshot", async () => {
    const res = await preview(csvFile(line({ sku: "SUP-COST", name: "Custo impossível", cost: "999999999,99", stock: "1" })));
    expect(res.status).toBe(200);
    expect(res.json.summary).toMatchObject({ errors: 1, actionable: 0 });
    const issue = res.json.lines[0].issues.find((i: any) => i.code === "COST_OUT_OF_RANGE");
    expect(issue).toBeTruthy();
    expect(issue.message).toMatch(/não é truncado/); // human, in PT

    const [stored] = await db.select().from(supplierImportRows).where(eq(supplierImportRows.importId, res.json.importId));
    expect(stored.costPrice).toBeNull();
  });

  it("a stock beyond int4 is a row error and never reaches the snapshot", async () => {
    const res = await preview(csvFile(line({ sku: "SUP-STOCK", name: "Stock impossível", stock: "99999999999", cost: "10,00" })));
    expect(res.status).toBe(200);
    expect(res.json.lines[0].issues.map((i: any) => i.code)).toContain("STOCK_OUT_OF_RANGE");
    const [stored] = await db.select().from(supplierImportRows).where(eq(supplierImportRows.importId, res.json.importId));
    expect(stored.stock).toBeNull();
  });

  it("a lead time beyond int4 is a row error and never reaches the snapshot", async () => {
    const res = await preview(csvFile(line({ sku: "SUP-LEAD", name: "Prazo impossível", cost: "10,00", leadTime: "2147483648" })));
    expect(res.status).toBe(200);
    expect(res.json.lines[0].issues.map((i: any) => i.code)).toContain("LEAD_TIME_OUT_OF_RANGE");
    const [stored] = await db.select().from(supplierImportRows).where(eq(supplierImportRows.importId, res.json.importId));
    expect(stored.leadTimeDays).toBeNull();
  });

  it("exact column limits are accepted end to end", async () => {
    const res = await preview(csvFile(line({
      sku: "SUP-EXACT", name: "Valores no limite exacto", cost: "99999999.99",
      stock: "2147483647", leadTime: "2147483647",
    })));
    expect(res.status).toBe(200);
    expect(res.json.summary).toMatchObject({ total: 1, errors: 0, newProducts: 1 });
    expect(res.json.lines[0].issues).toEqual([]);

    const applied = await apply(res.json.importId, res.json.previewToken);
    expect(applied.json).toMatchObject({ status: "completed", created: 1, errors: 0 });

    const [stored] = await db.select().from(supplierImportRows).where(eq(supplierImportRows.importId, res.json.importId));
    expect(stored.costPrice).toBe("99999999.99");
    expect(stored.stock).toBe(2147483647);
    expect(stored.leadTimeDays).toBe(2147483647);

    const [created] = await db.select().from(products).where(eq(products.id, stored.productId as number));
    expect(created.costPrice).toBe("99999999.99");
    expect(created.stock).toBe(2147483647);
  });

  it("an all-error file applies nothing", async () => {
    const res = await preview(csvFile(
      line({ sku: "SUP-ERR1", name: "Erro um", cost: "999999999,99" }),
      line({ sku: "SUP-ERR2", name: "Erro dois", stock: "99999999999", cost: "1,00" }),
      line({ name: "Sem chave", cost: "1,00" }),
    ));
    expect(res.status).toBe(200);
    expect(res.json.summary).toMatchObject({ errors: 3, actionable: 0 });

    const applied = await apply(res.json.importId, res.json.previewToken);
    expect(applied.json).toMatchObject({ status: "completed", appliedNow: 0, created: 0, errors: 3, pending: 0 });

    for (const name of ["Erro um", "Erro dois", "Sem chave"]) {
      expect(await db.select().from(products).where(eq(products.name, name))).toHaveLength(0);
    }
  });

  it("a mixed file applies only the valid row and mints an MD-… SKU", async () => {
    const res = await preview(csvFile(
      line({ sku: "SUP-OK", name: "Cabo válido", cost: "10,00", stock: "3" }),
      line({ sku: "SUP-BAD", name: "Custo fora", cost: "999999999,99" }),
    ));
    expect(res.status).toBe(200);
    expect(res.json.summary).toMatchObject({ newProducts: 1, errors: 1, actionable: 1 });

    const applied = await apply(res.json.importId, res.json.previewToken);
    expect(applied.json).toMatchObject({ status: "completed", appliedNow: 1, created: 1, errors: 1 });

    const [created] = await db.select().from(products).where(eq(products.name, "Cabo válido"));
    expect(created).toBeTruthy();
    expect(created.sku).toMatch(/^MD-\d{6}$/);
    expect(created.costPrice).toBe("10.00");
    expect(created.stock).toBe(3);
    expect(await db.select().from(products).where(eq(products.name, "Custo fora"))).toHaveLength(0);
  });
});

describe("C.3.1 — real database failures are classified without leaking internals", () => {
  async function validImportId(): Promise<number> {
    const res = await preview(csvFile(line({ sku: "SUP-SEED", name: "Semente", cost: "1,00" })));
    return res.json.importId;
  }

  it("classifies a real numeric overflow as a safe, human category", async () => {
    const importId = await validImportId();
    let caught: unknown = null;
    try {
      await db.execute(sql`
        INSERT INTO supplier_import_rows (import_id, row_number, status, cost_price)
        VALUES (${importId}, 9999, 'error', ${"99999999999999.99"})
      `);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();

    const classified = classifyImportStorageFailure(caught);
    expect(classified?.code).toBe("IMPORT_VALUE_OUT_OF_RANGE");
    if (!classified) throw new Error("expected a classification");
    expect(classified.message).toBeTruthy();
    const leak = JSON.stringify(classified);
    expect(leak).not.toMatch(/numeric|overflow|insert into|supplier_import_rows/i);
    expect(leak).not.toMatch(/sql/i);
    // Nothing was persisted by the failed statement.
    const rows = await db.select().from(supplierImportRows).where(eq(supplierImportRows.importId, importId));
    expect(rows.every((r) => r.rowNumber !== 9999)).toBe(true);
  });

  it("classifies a real too-long value and an undefined table safely", async () => {
    const importId = await validImportId();
    let caught: unknown = null;
    try {
      await db.execute(sql`
        INSERT INTO supplier_import_rows (import_id, row_number, status, name)
        VALUES (${importId}, 9998, 'error', ${"x".repeat(300)})
      `);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    const classified = classifyImportStorageFailure(caught);
    expect(classified?.code).toBe("IMPORT_VALUE_TOO_LONG");
    if (!classified) throw new Error("expected a classification");
    expect(JSON.stringify(classified)).not.toMatch(/character varying|insert into/i);

    const missing = classifyImportStorageFailure({ code: "42P01", message: 'relation "supplier_import_rows" does not exist' });
    expect(missing?.code).toBe("IMPORT_SCHEMA_MISSING");
    // Safe wording pointing at migration 0010 — never the relation name.
    expect(missing?.message).toContain("0010");
    expect(JSON.stringify(missing)).not.toContain("supplier_import_rows");
  });

  it("keeps per-row file messages human and code-bearing", async () => {
    const res = await preview(csvFile(line({ sku: "SUP-MSG", name: "Msg", cost: "999999999,99" })));
    const issue = res.json.lines[0].issues[0];
    expect(issue.message).toMatch(/[a-záàâãéêíóôõúç]/i); // real words
    expect(issue.code).toBe("COST_OUT_OF_RANGE");
    expect(JSON.stringify(res.json.lines[0].issues)).not.toContain("[object Object]");
  });

  it("renders legacy-style error objects as text, never [object Object]", () => {
    const legacyErrors = [
      { row: 2, field: "ean", value: "123", code: "INVALID_GTIN", message: "EAN/GTIN com checksum inválido" },
      { row: 3, field: "stock", value: "abc", code: "INVALID_STOCK", message: "Stock inválido" },
    ];
    const text = formatImportErrors(legacyErrors);
    expect(text).toContain("linha 2");
    expect(text).toContain("INVALID_GTIN");
    expect(text).toContain("linha 3");
    expect(text).not.toContain("[object Object]");
    // and the same for a single structured error object
    expect(formatImportError(legacyErrors[0])).toContain("campo ean");
  });
});
