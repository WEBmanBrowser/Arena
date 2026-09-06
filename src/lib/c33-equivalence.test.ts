/**
 * C.3.3 (etapa 1) — EQUIVALÊNCIA antes/depois do refactor do parser.
 *
 * Este teste é a prova de comportamento inalterado do refactor do dispatcher:
 * usa APENAS a superfície pública que existe antes E depois do refactor
 * (previewSupplierImport + snapshot em base de dados real) e compara o resultado
 * com uma projeção capturada ANTES do refactor (constante C33_BASELINE).
 *
 * A projeção exclui deliberadamente:
 *  - ids/voláteis (importId, supplierId, productId, previewToken);
 *  - campos derivados do motor de pricing (computedPrice, priceMessage e a
 *    mensagem composta da linha, que lhes é sensível) — o estado de regras de
 *    pricing não pode tornar este teste dependente de outros ficheiros de
 *    teste; a regressão de pricing é coberta pelos testes C.1/C.2/C.3.1.
 *
 * Tudo o que define o contrato C.3.1/C.3.2 do preview está incluído:
 * mapping efetivo, headers, delimiter, ignoredColumns, fileHash (SHA-256 dos
 * bytes exatos), fileSizeBytes, rowCount, estados/matching por linha, issues,
 * custo/stock before/after, summary, missingProducts e o snapshot persistido
 * (supplier_imports.mapping = mapping realmente usado).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { db } from "@/db";
import {
  productSuppliers,
  products,
  suppliers,
  supplierImportRows,
  supplierImports,
  users,
} from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { previewSupplierImport } from "@/lib/services/supplier-import-service";

const TAG = "C33-EQUIV";
const USER_ID = 1;

const CSV = [
  "skuFornecedor;nome;custo;stock;ean;skuInterno",
  "REF-001;Cabo HDMI 2m;8,90;12;5901234123457;",
  "REF-002;Rato sem fios;12,50;3;;C33-EQUIV-2",
  "REF-003;Teclado mecânico;1.234,56;7;;",
  ";Linha sem chave;1,00;1;;",
  "REF-001;Duplicado;9,99;2;;",
].join("\n");

async function cleanup() {
  // TAG é uma constante de compilador — sql.raw não introduz input dinâmico.
  await db.execute(sql.raw(`DO $$ BEGIN
    DELETE FROM supplier_import_profiles WHERE supplier_id IN (SELECT id FROM suppliers WHERE name LIKE '${TAG}-%');
  EXCEPTION WHEN undefined_table THEN NULL; END $$`));
  await db.execute(sql`DELETE FROM supplier_import_rows WHERE import_id IN (SELECT id FROM supplier_imports WHERE file_name LIKE ${`${TAG}-%`})`);
  await db.execute(sql`DELETE FROM supplier_imports WHERE file_name LIKE ${`${TAG}-%`}`);
  await db.execute(sql`DELETE FROM product_suppliers WHERE product_id IN (SELECT id FROM products WHERE sku LIKE ${`${TAG}-%`})`);
  await db.execute(sql`DELETE FROM products WHERE sku LIKE ${`${TAG}-%`}`);
  await db.execute(sql`DELETE FROM suppliers WHERE name LIKE ${`${TAG}-%`}`);
}

beforeAll(async () => {
  await cleanup();
  await db.insert(users).values({ id: USER_ID, email: `${TAG}@test.local`, password: "x", name: "Test", role: "manager" }).onConflictDoNothing();
});

beforeEach(cleanup);
afterAll(cleanup);

/** Projeção estável e comparável do resultado do preview. */
function projectPreview(p: any) {
  return {
    fileName: p.fileName,
    fileHash: p.fileHash,
    fileSizeBytes: p.fileSizeBytes,
    delimiter: p.delimiter,
    headers: p.headers,
    mapping: p.mapping,
    ignoredColumns: p.ignoredColumns,
    status: p.status,
    truncated: p.truncated,
    batchesTotal: p.batchesTotal,
    batchSize: p.batchSize,
    profileUsed: p.profileUsed,
    summary: p.summary,
    missingProducts: p.missingProducts,
    lines: p.lines.map((l: any) => ({
      rowNumber: l.rowNumber,
      supplierSku: l.supplierSku,
      ean: l.ean,
      internalSku: l.internalSku,
      name: l.name,
      status: l.status,
      matchType: l.matchType,
      codes: l.codes,
      costPrice: l.costPrice,
      costBefore: l.costBefore,
      stock: l.stock,
      stockBefore: l.stockBefore,
      reservedStock: l.reservedStock,
      leadTimeDays: l.leadTimeDays,
      productSku: l.productSku,
      productName: l.productName,
      currentPrice: l.currentPrice,
      priceMode: l.priceMode,
      isPreferredSupplier: l.isPreferredSupplier,
      issues: l.issues,
    })),
  };
}

/**
 * Projeção capturada ANTES do refactor (parser CSV direto em
 * previewSupplierImport). O teste falha se o refactor alterar UM só valor:
 * mapping, hash, rowCount, estados, issues, summary ou snapshot.
 */
const C33_BASELINE = {"fileName":"C33-EQUIV-lista.csv","fileHash":"0c78d303342b1a79b4934b48dea92680f80fb85e3932ff68cb9e74c3f09f72af","fileSizeBytes":224,"delimiter":";","headers":["skuFornecedor","nome","custo","stock","ean","skuInterno"],"mapping":{"skuFornecedor":"supplierSku","nome":"name","custo":"costPrice","stock":"stock","ean":"ean","skuInterno":"internalSku"},"ignoredColumns":[],"status":"preview","truncated":false,"batchesTotal":1,"batchSize":500,"profileUsed":"no_profile","summary":{"ready":1,"total":5,"errors":1,"withCost":5,"conflicts":2,"matchedBy":{"ean":0,"none":4,"internal_sku":1,"supplier_sku":0},"withStock":5,"actionable":2,"newProducts":1,"batchesTotal":1,"ignoredColumns":[],"missingProducts":{"count":0,"items":[],"action":"none","ambiguous":0,"skippedReason":"NO_PREVIOUS_COMPLETED_IMPORT","comparedToImportId":null,"comparedToFinishedAt":null}},"missingProducts":{"action":"none","comparedToImportId":null,"comparedToFinishedAt":null,"count":0,"ambiguous":0,"skippedReason":"NO_PREVIOUS_COMPLETED_IMPORT","items":[]},"lines":[{"rowNumber":2,"supplierSku":"REF-001","ean":"5901234123457","internalSku":null,"name":"Cabo HDMI 2m","status":"conflict","matchType":"none","codes":["DUPLICATE_SUPPLIER_SKU_IN_FILE"],"costPrice":"8.90","costBefore":null,"stock":12,"stockBefore":null,"reservedStock":null,"leadTimeDays":null,"productSku":null,"productName":null,"currentPrice":null,"priceMode":null,"isPreferredSupplier":false,"issues":[]},{"rowNumber":3,"supplierSku":"REF-002","ean":null,"internalSku":"C33-EQUIV-2","name":"Rato sem fios","status":"ready","matchType":"internal_sku","codes":[],"costPrice":"12.50","costBefore":null,"stock":3,"stockBefore":5,"reservedStock":0,"leadTimeDays":null,"productSku":"C33-EQUIV-2","productName":"Produto C33-EQUIV-2","currentPrice":"50.00","priceMode":"auto","isPreferredSupplier":false,"issues":[]},{"rowNumber":4,"supplierSku":"REF-003","ean":null,"internalSku":null,"name":"Teclado mecânico","status":"new_product","matchType":"none","codes":[],"costPrice":"1234.56","costBefore":null,"stock":7,"stockBefore":null,"reservedStock":null,"leadTimeDays":null,"productSku":null,"productName":null,"currentPrice":null,"priceMode":"auto","isPreferredSupplier":false,"issues":[]},{"rowNumber":5,"supplierSku":null,"ean":null,"internalSku":null,"name":"Linha sem chave","status":"error","matchType":"none","codes":["MISSING_IDENTIFIER_KEY"],"costPrice":"1.00","costBefore":null,"stock":1,"stockBefore":null,"reservedStock":null,"leadTimeDays":null,"productSku":null,"productName":null,"currentPrice":null,"priceMode":null,"isPreferredSupplier":false,"issues":[{"field":"row","value":"","code":"MISSING_IDENTIFIER_KEY","message":"Linha sem SKU do fornecedor, EAN ou SKU interno — impossível de identificar","severity":"error"}]},{"rowNumber":6,"supplierSku":"REF-001","ean":null,"internalSku":null,"name":"Duplicado","status":"conflict","matchType":"none","codes":["DUPLICATE_SUPPLIER_SKU_IN_FILE"],"costPrice":"9.99","costBefore":null,"stock":2,"stockBefore":null,"reservedStock":null,"leadTimeDays":null,"productSku":null,"productName":null,"currentPrice":null,"priceMode":null,"isPreferredSupplier":false,"issues":[]}]};

describe("C.3.3 — equivalência do preview antes/depois do refactor do parser", () => {
  it("o mesmo CSV produz exatamente a mesma projeção (mapping, rows, hash, rowCount, preview)", async () => {
    const [supplier] = await db.insert(suppliers).values({ name: `${TAG}-Fornecedor`, isActive: true }).returning();

    // Produto existente encontrado pelo SKU do fornecedor (nível 1)…
    const [p1] = await db.insert(products).values({
      name: "Produto C33-EQUIV-1", slug: `md-c33-1-${TAG}`, sku: "C33-EQUIV-1",
      price: "100.00", vatRate: "23.00", priceMode: "auto", stock: 10, costPrice: "8.00",
      ean: "5901234123457",
    }).returning();
    await db.insert(productSuppliers).values({
      productId: p1.id, supplierId: supplier.id, supplierSku: "REF-001",
      costPrice: "8.00", isPreferred: true,
    });

    // …e produto encontrado pelo SKU interno (nível 3).
    await db.insert(products).values({
      name: "Produto C33-EQUIV-2", slug: `md-c33-2-${TAG}`, sku: "C33-EQUIV-2",
      price: "50.00", vatRate: "23.00", priceMode: "auto", stock: 5,
    });

    const preview = await previewSupplierImport({
      supplierId: supplier.id,
      fileName: `${TAG}-lista.csv`,
      csvText: CSV,
      userId: USER_ID,
    });

    const projection = projectPreview(preview);

    // IGUALDADE EXATA com a projeção capturada antes do refactor.
    expect(projection).toEqual(C33_BASELINE);

    // O snapshot persistido continua a ser o mapping efetivamente usado.
    const [snapshot] = await db.select({
      mapping: supplierImports.mapping,
      rowCount: supplierImports.rowCount,
      fileHash: supplierImports.fileHash,
      status: supplierImports.status,
    }).from(supplierImports).where(eq(supplierImports.id, preview.importId)).limit(1);
    expect(snapshot.mapping).toEqual(preview.mapping);
    expect(snapshot.rowCount).toBe(5);
    expect(snapshot.fileHash).toBe(preview.fileHash);
    expect(snapshot.status).toBe("preview");
    const persistedRows = await db.select({ rowNumber: supplierImportRows.rowNumber })
      .from(supplierImportRows).where(eq(supplierImportRows.importId, preview.importId));
    expect(persistedRows).toHaveLength(5);
  });
});
