/**
 * FASE 2 — Testes de regressão para a política de preferred supplier (C.3.1).
 * Criados ANTES da correção (leitura do código atual) para reproduzir o bug.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { db } from "@/db";
import { products, productSuppliers, suppliers } from "@/db/schema";
import { eq, and, sql } from "drizzle-orm";

const TAG = "C31-REG-POLICY";

async function cleanupPolicy() {
  await db.execute(sql`DELETE FROM product_suppliers WHERE supplier_sku LIKE ${`${TAG}-%`} OR supplier_sku LIKE ${`${TAG.toLowerCase()}-%`}`);
  await db.execute(sql`DELETE FROM product_suppliers WHERE product_id IN (SELECT id FROM products WHERE sku LIKE ${`${TAG}-%`})`);
  await db.execute(sql`DELETE FROM products WHERE sku LIKE ${`${TAG}-%`}`);
}

beforeAll(async () => {
  await cleanupPolicy();
  await db.insert(suppliers).values({ id: 1, name: `${TAG} Supplier`, isActive: true }).onConflictDoNothing();
  await db.insert(suppliers).values({ id: 2, name: `${TAG} Other`, isActive: true }).onConflictDoNothing();
});

beforeEach(async () => {
  await cleanupPolicy();
});

afterAll(async () => {
  await cleanupPolicy();
});

describe("C.3.1 — Preferred Supplier Policy (reproduz bug antes da correção)", () => {
  it("A) associação existente com isPreferred=false deve ser promovida se não existe outro preferred", async () => {
    // Criar produto para evitar FK violation.
    const [product] = await db.insert(products).values({
      name: `${TAG}-A`, slug: `${TAG}-A`, sku: `${TAG}-A-SKU`,
      price: "10.00", vatRate: "23.00", priceMode: "auto", costPrice: "10.00", stock: 0,
    }).returning();

    await db.insert(productSuppliers).values({
      productId: product.id,
      supplierId: 1,
      supplierSku: `${TAG}-TEST-001`,
      costPrice: "10.00",
      isPreferred: false,
    });

    const [link] = await db.select({ isPreferred: productSuppliers.isPreferred })
      .from(productSuppliers)
      .where(and(eq(productSuppliers.productId, product.id), eq(productSuppliers.supplierId, 1)));

    // Antes da correção: a associação existente NÃO é promovida automaticamente,
    // portanto o assertion abaixo falha (isPreferred permanece false).
    expect(link?.isPreferred).toBe(true);
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
