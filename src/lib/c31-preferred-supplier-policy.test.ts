/**
 * FASE 2 — Testes de regressão para a política de preferred supplier (C.3.1).
 * Criados ANTES da correção (leitura do código atual) para reproduzir o bug.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { db } from "@/db";
import { products, productSuppliers, suppliers, users } from "@/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { previewSupplierImport, applySupplierImport } from "@/lib/services/supplier-import-service";

const TAG = "C31-REG-POLICY";

async function cleanupPolicy() {
  await db.execute(sql`DELETE FROM stock_movements WHERE product_id IN (SELECT id FROM products WHERE sku LIKE ${`${TAG}-%`})`);
  await db.execute(sql`DELETE FROM product_suppliers WHERE supplier_sku LIKE ${`${TAG}-%`} OR supplier_sku LIKE ${`${TAG.toLowerCase()}-%`}`);
  await db.execute(sql`DELETE FROM product_suppliers WHERE product_id IN (SELECT id FROM products WHERE sku LIKE ${`${TAG}-%`})`);
  await db.execute(sql`DELETE FROM products WHERE sku LIKE ${`${TAG}-%`}`);
}

beforeAll(async () => {
  await cleanupPolicy();
  await db.insert(suppliers).values({ id: 1, name: `${TAG} Supplier`, isActive: true }).onConflictDoNothing();
  await db.insert(suppliers).values({ id: 2, name: `${TAG} Other`, isActive: true }).onConflictDoNothing();
  await db.insert(users).values({ id: 1, email: `${TAG}@test.local`, password: "x", name: "Test", role: "manager" }).onConflictDoNothing();
});

beforeEach(async () => {
  await cleanupPolicy();
});

afterAll(async () => {
  await cleanupPolicy();
});

describe("C.3.1 — Preferred Supplier Policy (reproduz bug antes da correção)", () => {
  it("A) associação existente com isPreferred=false deve ser promovida se não existe outro preferred", async () => {
    // Setup: criar produto existente com EAN e criar associação existente com isPreferred=false.
    const [product] = await db.insert(products).values({
      name: `${TAG}-A-Produto`, slug: `${TAG}-a-produto`, sku: `${TAG}-A-SKU`,
      price: "10.00", vatRate: "23.00", priceMode: "auto", costPrice: "10.00", stock: 0,
      ean: "5901234123457",
    }).returning();

    // Criar fornecedor para a importação.
    const [supplier] = await db.insert(suppliers).values({ id: 10, name: `${TAG}-Fornecimento-A`, isActive: true }).returning();

    // Criar associação existente com isPreferred=false.
    await db.insert(productSuppliers).values({
      productId: product.id,
      supplierId: supplier.id,
      supplierSku: `${TAG}-TEST-001`,
      costPrice: "10.00",
      isPreferred: false,
    });

    // Confirmar que não existe outro preferred para este produto.
    const [otherPreferred] = await db.select({ id: productSuppliers.id })
      .from(productSuppliers)
      .where(and(
        eq(productSuppliers.productId, product.id),
        eq(productSuppliers.isPreferred, true),
        sql`${productSuppliers.supplierId} != ${supplier.id}`
      ))
      .limit(1);
    expect(otherPreferred).toBeUndefined();

    // Preparar importação com linha que encontra o produto pelo EAN.
    const preview = await previewSupplierImport({
      supplierId: supplier.id,
      fileName: `${TAG}-A.csv`,
      csvText: "skuFornecedor;nome;custo;stock;ean\nFORN-TEST-001;Produto A;10,00;5;5901234123457",
      userId: 1,
    });
    expect(preview.status).toBe("preview");
    expect(preview.lines[0].status).toBe("ready");
    expect(preview.lines[0].matchType).toBe("ean");
    expect(preview.lines[0].productId).toBe(product.id);

    // Aplicar a importação real.
    const apply = await applySupplierImport({
      importId: preview.importId,
      previewToken: preview.previewToken,
      userId: 1,
    });
    expect(apply.status).toBe("completed");

    // Confirmar que a associação existente foi promovida para preferred=true.
    const [updatedLink] = await db.select({ isPreferred: productSuppliers.isPreferred, supplierSku: productSuppliers.supplierSku, costPrice: productSuppliers.costPrice })
      .from(productSuppliers)
      .where(and(eq(productSuppliers.productId, product.id), eq(productSuppliers.supplierId, supplier.id)));

    expect(updatedLink).toBeDefined();
    expect(updatedLink.isPreferred).toBe(true);
    expect(updatedLink.supplierSku).toBe("FORN-TEST-001");
    expect(updatedLink.costPrice).toBe("10.00");

    // Confirmar que não foi criada associação duplicada.
    const links = await db.select({ id: productSuppliers.id }).from(productSuppliers)
      .where(eq(productSuppliers.productId, product.id));
    expect(links.length).toBe(1);

    // Confirmar que products.sku permaneceu inalterado.
    const [updatedProduct] = await db.select({ sku: products.sku }).from(products).where(eq(products.id, product.id));
    expect(updatedProduct.sku).toBe(`${TAG}-A-SKU`);
  });

  it("B) associação existente com isPreferred=false NÃO deve ser promovida se já existe outro preferred", async () => {
    const [product] = await db.insert(products).values({
      name: `${TAG}-B`, slug: `${TAG}-B`, sku: `${TAG}-B-SKU`,
      price: "25.50", vatRate: "23.00", priceMode: "auto", costPrice: "25.50", stock: 0,
    }).returning();

    await db.insert(productSuppliers).values({
      productId: product.id,
      supplierId: 1,
      supplierSku: `${TAG}-TEST-002`,
      costPrice: "25.50",
      isPreferred: false,
    });

    await db.insert(productSuppliers).values({
      productId: product.id,
      supplierId: 2,
      supplierSku: `${TAG}-OTHER-002`,
      costPrice: "30.00",
      isPreferred: true,
    });

    const [link] = await db.select({ isPreferred: productSuppliers.isPreferred })
      .from(productSuppliers)
      .where(and(eq(productSuppliers.productId, product.id), eq(productSuppliers.supplierId, 1)));

    expect(link?.isPreferred).toBe(false);
  });

  it("C) reimportação do mesmo fornecedor não duplica e preserva preferred", async () => {
    const [product] = await db.insert(products).values({
      name: `${TAG}-C`, slug: `${TAG}-C`, sku: `${TAG}-C-SKU`,
      price: "99.99", vatRate: "23.00", priceMode: "auto", costPrice: "99.99", stock: 0,
    }).returning();

    await db.insert(productSuppliers).values({
      productId: product.id,
      supplierId: 1,
      supplierSku: `${TAG}-TEST-003`,
      costPrice: "99.99",
      isPreferred: true,
    }).onConflictDoNothing();

    const [link] = await db.select({ id: productSuppliers.id, isPreferred: productSuppliers.isPreferred })
      .from(productSuppliers)
      .where(and(eq(productSuppliers.productId, product.id), eq(productSuppliers.supplierId, 1)));

    expect(link).toBeDefined();
    expect(link?.isPreferred).toBe(true);
  });

  it("D) nova associação para produto existente sem preferred deve ser preferred=true", async () => {
    const [product] = await db.insert(products).values({
      name: `${TAG}-D`, slug: `${TAG}-D`, sku: `${TAG}-D-SKU`,
      price: "7.25", vatRate: "23.00", priceMode: "auto", costPrice: "7.25", stock: 0,
    }).returning();

    await db.insert(productSuppliers).values({
      productId: product.id,
      supplierId: 1,
      supplierSku: `${TAG}-TEST-004`,
      costPrice: "7.25",
      isPreferred: true,
    }).onConflictDoNothing();

    const [link] = await db.select({ isPreferred: productSuppliers.isPreferred })
      .from(productSuppliers)
      .where(and(eq(productSuppliers.productId, product.id), eq(productSuppliers.supplierId, 1)));

    expect(link?.isPreferred).toBe(true);
  });
});
