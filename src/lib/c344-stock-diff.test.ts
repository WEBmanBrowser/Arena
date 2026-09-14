/**
 * C.3.4.4 — GRUPO C: diff incremental ALSO stock-only (DB real).
 *
 * Trava a autoridade de stock + o vocabulário new/changed/unchanged/error:
 *  - preview: diffStatus/changedFields por linha, summary com
 *    diffChanged/diffUnchanged, stock físico sempre null nas linhas ALSO;
 *  - apply: linhas changed escrevem SÓ product_suppliers (supplier_stock +
 *    datas + lastSyncAt); products.* intactos; zero stock movements;
 *  - segunda passagem idêntica → tudo unchanged → apply aplica 0 e NÃO toca
 *    no link (updatedAt/lastSyncAt byte-idênticos: zero writes);
 *  - incoming null (incl. -1) nunca limpa valores guardados;
 *  - desconhecidos/duplicados → diffStatus error; reopen preserva o diff;
 *  - linhas genéricas (CSV) têm diff nulo (sem fugas do ALSO).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import {
  products,
  productSuppliers,
  suppliers,
  supplierImports,
  supplierImportRows,
  users,
} from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";
import {
  applySupplierImport,
  previewSupplierImport,
  reopenSupplierImportPreview,
} from "@/lib/services/supplier-import-service";
import { uploadSource } from "@/lib/supplier-import/source";

const TAG = "C344DIFF";
const MANAGER = { id: 9751, email: "c344-diff@test.local", name: "C344 Diff", role: "manager" as const };
let supplierId = 0;

const HEADER_6 = ["ProductID", "AvailableQuantity", "AvailableNextDate", "AvailableNextQuantity", "AvailabilityDate", "AvailabilityTime"];

function stockTxt(rows: Array<Record<string, string>>): string {
  return [HEADER_6.join("\t"), ...rows.map((r) => HEADER_6.map((h) => r[h] ?? "").join("\t"))].join("\n");
}

async function makeProduct(sku: string, stock: number) {
  const [product] = await db.insert(products).values({
    name: `Prod ${sku}`, slug: `${sku.toLowerCase()}-${Date.now()}`, sku,
    price: "100.00", costPrice: "60.00", vatRate: "23.00", priceMode: "auto", stock,
  }).returning();
  return product;
}

async function makeLink(productId: number, supplierSku: string, extra: Record<string, unknown> = {}) {
  const [link] = await db.insert(productSuppliers).values({
    productId, supplierId, supplierSku, costPrice: "60.00", isPreferred: true, ...extra,
  } as never).returning();
  return link;
}

async function getLink(productId: number) {
  const [link] = await db.select().from(productSuppliers)
    .where(and(eq(productSuppliers.productId, productId), eq(productSuppliers.supplierId, supplierId))).limit(1);
  return link;
}

async function cleanupTag() {
  const tagged = await db.select({ id: products.id }).from(products)
    .where(sql`sku LIKE ${`${TAG}%`} OR slug LIKE ${`${TAG.toLowerCase()}%`}`);
  const ids = tagged.map((p) => p.id);
  if (ids.length) {
    const idList = sql.join(ids.map((id) => sql`${id}`), sql`,`);
    await db.execute(sql`DELETE FROM stock_movements WHERE product_id IN (${idList})`);
    await db.execute(sql`DELETE FROM product_suppliers WHERE product_id IN (${idList})`);
    await db.execute(sql`DELETE FROM supplier_import_rows WHERE product_id IN (${idList})`);
    await db.delete(products).where(sql`id IN (${idList})`);
  }
  await db.execute(sql`DELETE FROM supplier_import_rows WHERE import_id IN (SELECT id FROM supplier_imports WHERE user_id = ${MANAGER.id})`);
  await db.execute(sql`DELETE FROM supplier_imports WHERE user_id = ${MANAGER.id}`);
}

beforeAll(async () => {
  await db.insert(users).values({ id: MANAGER.id, email: MANAGER.email, password: "x", name: MANAGER.name, role: MANAGER.role }).onConflictDoNothing();
  const [s] = await db.insert(suppliers).values({ name: `${TAG} Supplier` }).returning();
  supplierId = s.id;
});
afterAll(async () => {
  await db.execute(sql`DELETE FROM audit_logs WHERE user_id = ${MANAGER.id}`);
  await cleanupTag();
  await db.execute(sql`DELETE FROM audit_logs WHERE user_id = ${MANAGER.id}`);
  await db.execute(sql`DELETE FROM suppliers WHERE name LIKE ${`${TAG}%`}`);
  await db.execute(sql`DELETE FROM users WHERE id = ${MANAGER.id}`);
});
beforeEach(async () => { await cleanupTag(); });

describe("C.3.4.4 [C] — preview: diff por linha + summary", () => {
  it("primeira passagem: changed com ordem estável de changedFields", async () => {
    const sku = `${TAG}-FIRST`;
    const product = await makeProduct(sku, 5);
    await makeLink(product.id, "PID-C1");
    const txt = stockTxt([{
      ProductID: "PID-C1", AvailableQuantity: "25",
      AvailableNextDate: "20261001", AvailableNextQuantity: "5",
      AvailabilityDate: "20260907", AvailabilityTime: "143000",
    }]);
    const preview = await previewSupplierImport({
      supplierId, source: uploadSource({ fileName: "stock.txt", csvText: txt }), userId: MANAGER.id,
    });
    expect(preview.lines).toHaveLength(1);
    const line = preview.lines[0];
    expect(line.status).toBe("ready");
    expect(line.supplierStock).toBe(25);
    expect(line.supplierStockBefore).toBeNull();
    expect(line.stock).toBeNull();
    expect(line.stockBefore).toBeNull();
    expect(line.diffStatus).toBe("changed");
    expect(line.changedFields).toEqual([
      "supplierStock", "availableNextDate", "availableNextQuantity", "availabilityTimestamp",
    ]);
    const summary = preview.summary as Record<string, unknown>;
    expect(summary.diffChanged).toBe(1);
    expect(summary.diffUnchanged).toBe(0);
    // Persistido no snapshot.
    const [snap] = await db.select().from(supplierImportRows).where(eq(supplierImportRows.importId, preview.importId)).limit(1);
    expect(snap.supplierStock).toBe(25);
    expect(snap.stock).toBeNull();
    expect(snap.diffStatus).toBe("changed");
    expect(snap.changedFields).toEqual(line.changedFields);
  });

  it("apply escreve SÓ a associação; produto e movimentos intactos", async () => {
    const sku = `${TAG}-APPLY`;
    const product = await makeProduct(sku, 5);
    await makeLink(product.id, "PID-C2");
    const txt = stockTxt([{
      ProductID: "PID-C2", AvailableQuantity: "25",
      AvailableNextDate: "20261001", AvailableNextQuantity: "5",
      AvailabilityDate: "20260907", AvailabilityTime: "143000",
    }]);
    const preview = await previewSupplierImport({
      supplierId, source: uploadSource({ fileName: "stock.txt", csvText: txt }), userId: MANAGER.id,
    });
    const outcome = await applySupplierImport({ importId: preview.importId, previewToken: preview.previewToken, userId: MANAGER.id });
    expect(outcome.applied).toBe(1);

    const [afterProd] = await db.select().from(products).where(eq(products.id, product.id)).limit(1);
    expect(afterProd.stock).toBe(5);
    expect(afterProd.price).toBe("100.00");
    expect(afterProd.costPrice).toBe("60.00");
    const mv = await db.execute(sql`SELECT count(*)::int AS c FROM stock_movements WHERE product_id = ${product.id}`);
    expect(Number((mv.rows as { c: number }[])[0].c)).toBe(0);

    const link = await getLink(product.id);
    expect(link.supplierStock).toBe(25);
    expect(String(link.availableNextDate).slice(0, 10)).toBe("2026-10-01");
    expect(link.availableNextQuantity).toBe(5);
    expect(link.availabilityTimestamp).not.toBeNull();
    expect(link.lastSyncAt).not.toBeNull();
    expect(link.costPrice).toBe("60.00");
    expect(link.isPreferred).toBe(true);
  });
});

describe("C.3.4.4 [C] — segunda passagem idêntica: unchanged, zero writes", () => {
  it("unchanged não é claimed/applied e não toca no link", async () => {
    const sku = `${TAG}-UNCH`;
    const product = await makeProduct(sku, 5);
    await makeLink(product.id, "PID-C3");
    const txt = stockTxt([{
      ProductID: "PID-C3", AvailableQuantity: "25",
      AvailableNextDate: "20261001", AvailableNextQuantity: "5",
      AvailabilityDate: "20260907", AvailabilityTime: "143000",
    }]);
    const first = await previewSupplierImport({
      supplierId, source: uploadSource({ fileName: "stock.txt", csvText: txt }), userId: MANAGER.id,
    });
    await applySupplierImport({ importId: first.importId, previewToken: first.previewToken, userId: MANAGER.id });
    const linkBefore = await getLink(product.id);
    expect(linkBefore.supplierStock).toBe(25);

    const second = await previewSupplierImport({
      supplierId, source: uploadSource({ fileName: "stock.txt", csvText: txt }), userId: MANAGER.id,
    });
    expect(second.lines[0].diffStatus).toBe("unchanged");
    expect(second.lines[0].changedFields).toBeNull();
    expect(second.lines[0].supplierStockBefore).toBe(25);
    expect((second.summary as Record<string, unknown>).diffUnchanged).toBe(1);
    expect((second.summary as Record<string, unknown>).diffChanged).toBe(0);

    const outcome = await applySupplierImport({ importId: second.importId, previewToken: second.previewToken, userId: MANAGER.id });
    expect(outcome.applied).toBe(0);
    const [snap] = await db.select().from(supplierImports).where(eq(supplierImports.id, second.importId)).limit(1);
    expect(snap.status).toBe("completed"); // unchanged não bloqueia a conclusão

    const linkAfter = await getLink(product.id);
    expect(linkAfter.updatedAt.getTime()).toBe(linkBefore.updatedAt.getTime());
    expect(linkAfter.lastSyncAt!.getTime()).toBe(linkBefore.lastSyncAt!.getTime());
    expect(linkAfter.supplierStock).toBe(25);
  });

  it("mudança parcial: só o campo mudado entra no patch", async () => {
    const sku = `${TAG}-PARTIAL`;
    const product = await makeProduct(sku, 5);
    await makeLink(product.id, "PID-C4", {
      supplierStock: 25, availableNextDate: "2026-10-01", availableNextQuantity: 5,
    });
    const txt = stockTxt([{ ProductID: "PID-C4", AvailableQuantity: "30" }]);
    const preview = await previewSupplierImport({
      supplierId, source: uploadSource({ fileName: "stock.txt", csvText: txt }), userId: MANAGER.id,
    });
    expect(preview.lines[0].diffStatus).toBe("changed");
    expect(preview.lines[0].changedFields).toEqual(["supplierStock"]);
    await applySupplierImport({ importId: preview.importId, previewToken: preview.previewToken, userId: MANAGER.id });
    const link = await getLink(product.id);
    expect(link.supplierStock).toBe(30);
    // Os outros campos de fornecedor ficam exatamente como estavam.
    expect(String(link.availableNextDate).slice(0, 10)).toBe("2026-10-01");
    expect(link.availableNextQuantity).toBe(5);
  });
});

describe("C.3.4.4 [C] — null (incl. -1) nunca limpa", () => {
  it("linha toda -1 → unchanged; valores guardados intactos", async () => {
    const sku = `${TAG}-MINUS1`;
    const product = await makeProduct(sku, 5);
    await makeLink(product.id, "PID-C5", {
      supplierStock: 50, availableNextDate: "2026-12-01", availableNextQuantity: 60,
      availabilityTimestamp: new Date("2026-09-01T10:00:00Z"),
    });
    const txt = stockTxt([{
      ProductID: "PID-C5", AvailableQuantity: "-1",
      AvailableNextDate: "-1", AvailableNextQuantity: "-1",
      AvailabilityDate: "-1", AvailabilityTime: "-1",
    }]);
    const preview = await previewSupplierImport({
      supplierId, source: uploadSource({ fileName: "stock.txt", csvText: txt }), userId: MANAGER.id,
    });
    // Tudo "desconhecido" = nada para comparar = unchanged (nunca limpa).
    expect(preview.lines[0].diffStatus).toBe("unchanged");
    expect(preview.lines[0].supplierStock).toBeNull();
    const outcome = await applySupplierImport({ importId: preview.importId, previewToken: preview.previewToken, userId: MANAGER.id });
    expect(outcome.applied).toBe(0);
    const link = await getLink(product.id);
    expect(link.supplierStock).toBe(50);
    expect(String(link.availableNextDate).slice(0, 10)).toBe("2026-12-01");
    expect(link.availableNextQuantity).toBe(60);
    expect(link.availabilityTimestamp).not.toBeNull();
  });

  it("misto: quantidade muda, -1 noutro campo preserva o guardado", async () => {
    const sku = `${TAG}-MIXED`;
    const product = await makeProduct(sku, 5);
    await makeLink(product.id, "PID-C6", { supplierStock: 10, availableNextQuantity: 60 });
    const txt = stockTxt([{ ProductID: "PID-C6", AvailableQuantity: "11", AvailableNextQuantity: "-1" }]);
    const preview = await previewSupplierImport({
      supplierId, source: uploadSource({ fileName: "stock.txt", csvText: txt }), userId: MANAGER.id,
    });
    expect(preview.lines[0].diffStatus).toBe("changed");
    expect(preview.lines[0].changedFields).toEqual(["supplierStock"]);
    await applySupplierImport({ importId: preview.importId, previewToken: preview.previewToken, userId: MANAGER.id });
    const link = await getLink(product.id);
    expect(link.supplierStock).toBe(11);
    expect(link.availableNextQuantity).toBe(60); // o -1 não limpou
  });
});

describe("C.3.4.4 [C] — error, reopen e isolamento do genérico", () => {
  it("desconhecido e duplicado → diffStatus error", async () => {
    const sku = `${TAG}-ERR`;
    const product = await makeProduct(sku, 5);
    await makeLink(product.id, "PID-C7");
    const txt = stockTxt([
      { ProductID: "PID-DESCONHECIDO-ZZZ", AvailableQuantity: "10" },
      { ProductID: "PID-C7", AvailableQuantity: "10" },
      { ProductID: "PID-C7", AvailableQuantity: "20" },
    ]);
    const preview = await previewSupplierImport({
      supplierId, source: uploadSource({ fileName: "stock.txt", csvText: txt }), userId: MANAGER.id,
    });
    expect(preview.lines[0].status).toBe("error");
    expect(preview.lines[0].diffStatus).toBe("error");
    expect(preview.lines[1].status).toBe("conflict");
    expect(preview.lines[1].diffStatus).toBe("error");
    expect(preview.lines[2].diffStatus).toBe("error");
    const outcome = await applySupplierImport({ importId: preview.importId, previewToken: preview.previewToken, userId: MANAGER.id });
    expect(outcome.applied).toBe(0);
    // Nada escrito em lado nenhum.
    const [afterProd] = await db.select().from(products).where(eq(products.id, product.id)).limit(1);
    expect(afterProd.stock).toBe(5);
    expect((await getLink(product.id)).supplierStock).toBeNull();
  });

  it("reopen devolve o diff do snapshot", async () => {
    const sku = `${TAG}-REOPEN`;
    const product = await makeProduct(sku, 5);
    await makeLink(product.id, "PID-C8");
    const txt = stockTxt([{ ProductID: "PID-C8", AvailableQuantity: "42" }]);
    const preview = await previewSupplierImport({
      supplierId, source: uploadSource({ fileName: "stock.txt", csvText: txt }), userId: MANAGER.id,
    });
    const reopened = await reopenSupplierImportPreview(preview.importId);
    expect(reopened.reopened).toBe(true);
    expect(reopened.lines[0].supplierStock).toBe(42);
    expect(reopened.lines[0].diffStatus).toBe("changed");
    expect(reopened.lines[0].changedFields).toEqual(["supplierStock"]);
  });

  it("linhas genéricas (CSV) têm diff nulo", async () => {
    const csv = "skuFornecedor;nome;custo;stock\nREF-G1;Produto G;10,00;7\n";
    const preview = await previewSupplierImport({
      supplierId, source: uploadSource({ fileName: "lista.csv", csvText: csv }), userId: MANAGER.id,
    });
    expect(preview.lines).toHaveLength(1);
    expect(preview.lines[0].diffStatus).toBeNull();
    expect(preview.lines[0].changedFields).toBeNull();
    expect(preview.lines[0].supplierStock).toBeNull();
    expect((preview.summary as Record<string, unknown>).diffChanged).toBeUndefined();
    const [snap] = await db.select().from(supplierImportRows).where(eq(supplierImportRows.importId, preview.importId)).limit(1);
    expect(snap.diffStatus).toBeNull();
    expect(snap.supplierStock).toBeNull();
  });
});
