/**
 * C.3.4.3.1 — stock-only apply integração real (DB) + duplicados
 *
 * Prova com PostgreSQL real:
 *  - also_stock atualiza supplier_stock da associação existente (C.3.4.4)
 *  - NÃO cria produto nem associação para ProductID desconhecido
 *  - NÃO altera products.stock / sku / price / costPrice / name / ean
 *  - NÃO cria stock movements (stock ALSO não é físico)
 *  - NÃO interfere com preferredSupplier
 *  - NÃO dispara recálculo de preço (stock-only não é custo)
 *  - duplicado ProductID no mesmo stock.txt → conflict determinístico, nunca "last wins"
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import { products, productSuppliers, suppliers, supplierImports, supplierImportRows, users, pricingRules } from "@/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { previewSupplierImport } from "@/lib/services/supplier-import-service";
import { applySupplierImport } from "@/lib/services/supplier-import-service";
import { uploadSource } from "@/lib/supplier-import/source";

const TAG = "C343STOCK";
const MANAGER = { id: 9743, email: "c343-stock@test.local", name: "C343 Stock", role: "manager" as const };

let supplierId = 0;
let otherSupplierId = 0;

function stockTxt(rows: Array<Record<string, string>>): string {
  const headers = ["ProductID", "AvailableQuantity", "AvailableNextDate", "AvailableNextQuantity", "AvailabilityDate", "AvailabilityTime"];
  const lines = [headers.join("\t")];
  for (const r of rows) {
    lines.push(headers.map((h) => r[h] ?? "").join("\t"));
  }
  return lines.join("\n");
}

function pricelistTxt(rows: Array<Record<string, string>>): string {
  // positional 10 cols
  const cols = (r: Record<string,string>) => [
    r.ProductID ?? "PID",
    r.EuropeanArticleNumber ?? "5901234123457",
    r.CategoryText1 ?? "Cat1",
    r.CategoryText2 ?? "Cat2",
    r.CategoryText3 ?? "Cat3",
    r.Description ?? "Produto",
    r.AvailableQuantity ?? "5",
    r.NetPrice ?? "10,00",
    r.ManufacturerPartNumber ?? "MPN",
    r.ManufacturerName ?? "BrandX",
  ].join("\t");
  return rows.map(cols).join("\n");
}

async function cleanupTag() {
  const taggedProducts = await db.select({ id: products.id }).from(products).where(sql`sku LIKE ${`${TAG}%`} OR slug LIKE ${`${TAG.toLowerCase()}%`}`);
  const ids = taggedProducts.map((p) => p.id);
  if (ids.length) {
    const idList = sql.join(ids.map((id) => sql`${id}`), sql`,`);
    await db.execute(sql`DELETE FROM stock_movements WHERE product_id IN (${idList})`);
    await db.execute(sql`DELETE FROM product_suppliers WHERE product_id IN (${idList})`);
    await db.execute(sql`DELETE FROM supplier_import_rows WHERE import_id IN (SELECT id FROM supplier_imports WHERE user_id = ${MANAGER.id})`);
    await db.execute(sql`DELETE FROM supplier_imports WHERE user_id = ${MANAGER.id}`);
    await db.execute(sql`DELETE FROM supplier_import_rows WHERE product_id IN (${idList})`);
    await db.delete(products).where(sql`id IN (${idList})`);
  } else {
    await db.execute(sql`DELETE FROM supplier_import_rows WHERE import_id IN (SELECT id FROM supplier_imports WHERE user_id = ${MANAGER.id})`);
    await db.execute(sql`DELETE FROM supplier_imports WHERE user_id = ${MANAGER.id}`);
  }
  await db.execute(sql`DELETE FROM pricing_rules WHERE notes LIKE ${`${TAG}%`}`);
}

beforeAll(async () => {
  await db.insert(users).values({ id: MANAGER.id, email: MANAGER.email, password: "x", name: MANAGER.name, role: MANAGER.role }).onConflictDoNothing();
  const [a] = await db.insert(suppliers).values({ name: `${TAG} ALSO Supplier` }).returning();
  const [b] = await db.insert(suppliers).values({ name: `${TAG} Other Supplier` }).returning();
  supplierId = a.id;
  otherSupplierId = b.id;
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM audit_logs WHERE user_id = ${MANAGER.id}`);
  await cleanupTag();
  await db.execute(sql`DELETE FROM audit_logs WHERE user_id = ${MANAGER.id}`);
  await db.execute(sql`DELETE FROM suppliers WHERE name LIKE ${`${TAG}%`}`);
  await db.execute(sql`DELETE FROM users WHERE id = ${MANAGER.id}`);
});

beforeEach(async () => {
  await cleanupTag();
});

describe("C.3.4.3.1 — stock-only apply real", () => {
  it("atualiza supplier_stock da associação existente e NÃO cria para desconhecido", async () => {
    // cria produto com associação ALSO
    const sku = `${TAG}-PROD-1`;
    const [product] = await db.insert(products).values({
      name: "Produto ALSO 1",
      slug: `${sku.toLowerCase()}-${Date.now()}`,
      sku,
      price: "100.00",
      costPrice: "60.00",
      vatRate: "23.00",
      priceMode: "auto",
      stock: 5,
      ean: "4006381333931",
    }).returning();
    await db.insert(productSuppliers).values({
      productId: product.id,
      supplierId,
      supplierSku: "PID-ALSO-001",
      costPrice: "60.00",
      isPreferred: true,
    });
    // global rule para tentar disparar repricing se custo fosse alterado
    await db.insert(pricingRules).values({
      scope: "global", method: "markup_on_cost", ratePercent: "20", roundingPolicy: "auto", notes: `${TAG} global`,
    });

    const txt = stockTxt([
      { ProductID: "PID-ALSO-001", AvailableQuantity: "25", AvailableNextDate: "2026-10-01", AvailableNextQuantity: "5", AvailabilityDate: "2026-09-07", AvailabilityTime: "14:30" },
      { ProductID: "PID-DESCONHECIDO-999", AvailableQuantity: "10", AvailabilityDate: "2026-09-07", AvailabilityTime: "10:00" },
    ]);
    const source = uploadSource({ fileName: "stock.txt", csvText: txt });
    const preview = await previewSupplierImport({ supplierId, source, userId: MANAGER.id });
    // preview deve ter 2 linhas: 1 ready, 1 error STOCK_UNKNOWN_SKU (não new_product)
    expect(preview.lines).toHaveLength(2);
    const ready = preview.lines.find((l) => l.supplierSku === "PID-ALSO-001");
    const unknown = preview.lines.find((l) => l.supplierSku === "PID-DESCONHECIDO-999");
    expect(ready?.status).toBe("ready");
    // C.3.4.4: o preview transporta o stock ALSO em supplierStock (o físico é null).
    expect(ready?.supplierStock).toBe(25);
    expect(ready?.stock).toBeNull();
    expect(ready?.diffStatus).toBe("changed");
    expect(ready?.changedFields).toContain("supplierStock");
    // unknown deve ser error, nunca new_product, e não deve ter productId
    expect(unknown?.status).toBe("error");
    expect(unknown?.codes).toContain("STOCK_UNKNOWN_SKU");
    expect(unknown?.productId).toBeNull();

    // garante que preview persistido também tem error, não new_product
    const persistedRows = await db.select({ status: supplierImportRows.status, supplierSku: supplierImportRows.supplierSku, productId: supplierImportRows.productId })
      .from(supplierImportRows).where(eq(supplierImportRows.importId, preview.importId));
    const persistedUnknown = persistedRows.find((r) => r.supplierSku === "PID-DESCONHECIDO-999");
    expect(persistedUnknown?.status).toBe("error");

    // apply
    const outcome = await applySupplierImport({ importId: preview.importId, previewToken: preview.previewToken, userId: MANAGER.id });
    expect(outcome.applied).toBeGreaterThan(0);

    // C.3.4.4 — autoridade de stock: o produto físico NÃO é tocado (nem
    // stock, nem movimentos); o stock ALSO vive só na associação.
    const [after] = await db.select().from(products).where(eq(products.id, product.id)).limit(1);
    expect(after.stock).toBe(5);
    expect(after.sku).toBe(sku);
    expect(after.price).toBe("100.00"); // não repriced por stock-only
    expect(after.costPrice).toBe("60.00");
    expect(after.name).toBe("Produto ALSO 1");
    expect(after.ean).toBe("4006381333931");
    const movements = await db.execute(sql`SELECT count(*)::int AS c FROM stock_movements WHERE product_id = ${product.id}`);
    expect(Number((movements.rows as { c: number }[])[0].c)).toBe(0);

    // productSuppliers: supplier_stock + datas atualizados; cost/preferred/sku intactos.
    const [link] = await db.select().from(productSuppliers).where(and(eq(productSuppliers.productId, product.id), eq(productSuppliers.supplierId, supplierId))).limit(1);
    expect(link.supplierStock).toBe(25);
    expect(link.costPrice).toBe("60.00");
    expect(link.isPreferred).toBe(true);
    expect(link.supplierSku).toBe("PID-ALSO-001");
    expect(String(link.availableNextDate).slice(0, 10)).toBe("2026-10-01");
    expect(link.availableNextQuantity).toBe(5);
    expect(link.availabilityTimestamp).not.toBeNull();
    expect(link.lastSyncAt).not.toBeNull();

    // NÃO criou produto para desconhecido
    const unknownProducts = await db.select().from(products).where(sql`sku LIKE ${`${TAG}-UNKNOWN%`}`);
    expect(unknownProducts.length).toBe(0);
    const unknownLinks = await db.select().from(productSuppliers).where(eq(productSuppliers.supplierSku, "PID-DESCONHECIDO-999"));
    expect(unknownLinks.length).toBe(0);

    // estoque: -1 não altera? já coberto em parser, mas apply não deve mudar se stock null
    // preço não disparado: verifica que nenhum pricing alterou
  });

  it("NÃO altera preferred nem dispara repricing em stock-only", async () => {
    const sku = `${TAG}-PROD-PREF`;
    const [product] = await db.insert(products).values({
      name: "Produto Pref",
      slug: `${sku.toLowerCase()}-${Date.now()}`,
      sku,
      price: "50.00",
      costPrice: "30.00",
      vatRate: "23.00",
      priceMode: "auto",
      stock: 10,
    }).returning();
    // link preferred é other supplier, não o ALSO supplier
    await db.insert(productSuppliers).values({ productId: product.id, supplierId: otherSupplierId, supplierSku: "OTHER-SKU-1", costPrice: "30.00", isPreferred: true });
    await db.insert(productSuppliers).values({ productId: product.id, supplierId, supplierSku: "PID-ALSO-PREF", costPrice: "20.00", isPreferred: false });

    await db.insert(pricingRules).values({ scope: "global", method: "markup_on_cost", ratePercent: "50", roundingPolicy: "auto", notes: `${TAG} global 2` });

    const txt = stockTxt([{ ProductID: "PID-ALSO-PREF", AvailableQuantity: "99" }]);
    const source = uploadSource({ fileName: "stock.txt", csvText: txt });
    const preview = await previewSupplierImport({ supplierId, source, userId: MANAGER.id });
    const line = preview.lines.find((l) => l.supplierSku === "PID-ALSO-PREF");
    expect(line?.status).toBe("ready");
    expect(line?.isPreferredSupplier).toBe(false);

    await applySupplierImport({ importId: preview.importId, previewToken: preview.previewToken, userId: MANAGER.id });

    // C.3.4.4: físico intacto; o 99 vive só no supplier_stock da associação ALSO.
    const [after] = await db.select().from(products).where(eq(products.id, product.id)).limit(1);
    expect(after.stock).toBe(10);
    expect(after.price).toBe("50.00"); // não repriced (stock-only, non-preferred)

    const [linkAlso] = await db.select().from(productSuppliers).where(and(eq(productSuppliers.productId, product.id), eq(productSuppliers.supplierId, supplierId))).limit(1);
    const [linkOther] = await db.select().from(productSuppliers).where(and(eq(productSuppliers.productId, product.id), eq(productSuppliers.supplierId, otherSupplierId))).limit(1);
    expect(linkAlso.supplierStock).toBe(99);
    expect(linkOther.supplierStock).toBeNull(); // o outro fornecedor não é tocado
    expect(linkAlso.isPreferred).toBe(false);
    expect(linkOther.isPreferred).toBe(true);
    expect(linkAlso.costPrice).toBe("20.00"); // não alterado por stock
  });
});

describe("C.3.4.3.1 — duplicados no stock.txt", () => {
  it("mesmo ProductID duas vezes → conflict determinístico, nenhuma atualização aplicada", async () => {
    const sku = `${TAG}-PROD-DUP`;
    const [product] = await db.insert(products).values({
      name: "Produto Dup",
      slug: `${sku.toLowerCase()}-${Date.now()}`,
      sku,
      price: "10.00",
      costPrice: "5.00",
      vatRate: "23.00",
      priceMode: "auto",
      stock: 7,
    }).returning();
    await db.insert(productSuppliers).values({ productId: product.id, supplierId, supplierSku: "PID-DUP-001", costPrice: "5.00", isPreferred: true });

    const txt = stockTxt([
      { ProductID: "PID-DUP-001", AvailableQuantity: "10" },
      { ProductID: "PID-DUP-001", AvailableQuantity: "20" },
    ]);
    const source = uploadSource({ fileName: "stock.txt", csvText: txt });
    const preview = await previewSupplierImport({ supplierId, source, userId: MANAGER.id });

    expect(preview.lines).toHaveLength(2);
    // ambas devem ser conflict (DUPLICATE_SUPPLIER_SKU_IN_FILE ou DUPLICATE_TARGET), nunca ready
    for (const line of preview.lines) {
      expect(line.status).toBe("conflict");
      expect(line.codes.some((c) => c.startsWith("DUPLICATE"))).toBe(true);
    }
    expect(preview.summary.conflicts).toBe(2);

    const outcome = await applySupplierImport({ importId: preview.importId, previewToken: preview.previewToken, userId: MANAGER.id });
    // nenhuma linha aplicada (apenas conflicts)
    expect(outcome.applied).toBe(0);

    const [after] = await db.select().from(products).where(eq(products.id, product.id)).limit(1);
    expect(after.stock).toBe(7); // intacto, last row não venceu
    // …e a associação também não foi tocada (conflicts nunca escrevem).
    const [link] = await db.select().from(productSuppliers).where(and(eq(productSuppliers.productId, product.id), eq(productSuppliers.supplierId, supplierId))).limit(1);
    expect(link.supplierStock).toBeNull();
    expect(link.lastSyncAt).toBeNull();
  });

  it("duplicado desconhecido → também não cria e não fica last-wins", async () => {
    const txt = stockTxt([
      { ProductID: "PID-DUP-UNK", AvailableQuantity: "5" },
      { ProductID: "PID-DUP-UNK", AvailableQuantity: "6" },
    ]);
    const source = uploadSource({ fileName: "stock.txt", csvText: txt });
    const preview = await previewSupplierImport({ supplierId, source, userId: MANAGER.id });
    // ambos duplicados desconhecidos: devem ser conflict por duplicado, não dois new_product silenciosos
    expect(preview.lines.every((l) => l.status === "conflict")).toBe(true);
    expect(preview.lines[0].codes).toContain("DUPLICATE_SUPPLIER_SKU_IN_FILE");
  });
});
