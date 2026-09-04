/**
 * C.3.1 — Regression tests for BUG A (C.3.1 Apply / ProductSuppliers).
 *
 * The fix guarantees that every applied line — including a product found by
 * EAN (`ready`) — results in an upserted `productSuppliers` association with:
 *   - supplierId = import supplier
 *   - supplierSku = line supplier SKU
 *   - costPrice = line cost
 *   - products.sku NEVER receives supplierSku
 *
 * Before the fix, a product existing by EAN (`ready`) could miss the link
 * update because the association was inserted with isPreferred false and
 * syncCost was not triggered, leaving the supplier association incomplete.
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
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
import { applySupplierImport, previewSupplierImport } from "@/lib/services/supplier-import-service";

const TAG = "C31A";

async function cleanupSupplier() {
  // Limpa associações antes dos produtos para evitar violação de FK.
  await db.execute(sql`DELETE FROM supplier_import_rows WHERE import_id IN (SELECT id FROM supplier_imports WHERE file_name LIKE ${`${TAG}%`})`);
  await db.execute(sql`DELETE FROM supplier_imports WHERE file_name LIKE ${`${TAG}%`}`);
  // Apaga associações por referência direta aos produtos criados pelo teste.
  await db.execute(sql`DELETE FROM product_suppliers WHERE product_id IN (SELECT id FROM products WHERE sku LIKE ${`${TAG}-%`})`);
  // Se ainda restarem associações com supplierSku do teste, apaga por LIKE.
  await db.execute(sql`DELETE FROM product_suppliers WHERE supplier_sku LIKE ${`${TAG}-%`} OR supplier_sku LIKE ${`${TAG.toLowerCase()}-%`}`);
  // Limpa movimentos de stock antes de apagar produtos.
  await db.execute(sql`DELETE FROM stock_movements WHERE product_id IN (SELECT id FROM products WHERE sku LIKE ${`${TAG}-%`})`);
  await db.execute(sql`DELETE FROM products WHERE sku LIKE ${`${TAG}-%`}`);
  await db.execute(sql`DELETE FROM suppliers WHERE name LIKE ${`${TAG}%`} AND id != 1`);
}

beforeAll(async () => {
  await cleanupSupplier();
  // Garante registos necessários para FK (supplier_imports → users, supplier_imports → suppliers).
  await db.insert(suppliers).values({ name: `${TAG} Supplier`, isActive: true }).onConflictDoNothing();
  await db.insert(users).values({ id: 1, email: `${TAG}@test.local`, password: "x", name: "Test", role: "manager" }).onConflictDoNothing();
});

beforeEach(async () => {
  await cleanupSupplier();
});

afterAll(async () => {
  await cleanupSupplier();
});

describe("BUG A — supplier import apply creates/updates productSuppliers (including EAN match)", () => {
  it("existing product found by EAN gets supplier link with supplierSku, not copied into products.sku", async () => {
    // Setup: supplier and product with known EAN.
    const [supplier] = await db.insert(suppliers).values({ name: `${TAG} Fornecedor`, isActive: true }).returning();
    const [existingProduct] = await db.insert(products).values({
      name: `${TAG} Produto EAN`, slug: `${TAG}-ean-produto`, sku: `${TAG}-SKU-EAN`,
      price: "50.00", vatRate: "23.00", priceMode: "auto", costPrice: "40.00", stock: 3,
      ean: "5901234123457",
    }).returning();

    // No existing link for this supplier/product.
    const beforeLinks = await db.select().from(productSuppliers)
      .where(and(eq(productSuppliers.productId, existingProduct.id), eq(productSuppliers.supplierId, supplier.id)));
    expect(beforeLinks).toHaveLength(0);

    // Preview with EAN match.
    const previewResult = await previewSupplierImport({
      supplierId: supplier.id,
      fileName: `${TAG}-ean.csv`,
      csvText: "skuFornecedor;nome;custo;stock;ean\nSUP-EAN;Produto EAN;10,00;5;5901234123457",
      userId: 1,
    });
    expect(previewResult.status).toBe("preview");
    expect(previewResult.lines[0].status).toBe("ready");
    expect(previewResult.lines[0].matchType).toBe("ean");
    expect(previewResult.lines[0].productId).toBe(existingProduct.id);
    expect(previewResult.lines[0].isPreferredSupplier).toBe(false); // no link yet

    // Apply.
    const applyResult = await applySupplierImport({
      importId: previewResult.importId,
      previewToken: previewResult.previewToken,
      userId: 1,
    });
    expect(applyResult.status).toBe("completed");

    // Confirm productSuppliers association exists with correct fields.
    const [link] = await db.select().from(productSuppliers)
      .where(and(eq(productSuppliers.productId, existingProduct.id), eq(productSuppliers.supplierId, supplier.id)));
    expect(link).toBeTruthy();
    expect(link.productId).toBe(existingProduct.id);
    expect(link.supplierId).toBe(supplier.id);
    expect(link.supplierSku).toBe("SUP-EAN");
    expect(link.costPrice).toBe("10.00");
    expect(link.isPreferred).toBe(true); // created as preferred when missing

    // Confirm products.sku was NEVER overwritten by supplierSku.
    const [updatedProduct] = await db.select().from(products).where(eq(products.id, existingProduct.id));
    expect(updatedProduct.sku).toBe(`${TAG}-SKU-EAN`); // unchanged
    expect(updatedProduct.sku).not.toBe("SUP-EAN");
  });

  it("re-import of existing product by EAN updates link cost and supplierSku without duplicating", async () => {
    const [supplier] = await db.insert(suppliers).values({ name: `${TAG} Fornecedor 2`, isActive: true }).returning();
    const [existingProduct] = await db.insert(products).values({
      name: `${TAG}-Produto Reimport`, slug: `${TAG}-reimport`, sku: `${TAG}-SKU-RE`,
      price: "20.00", vatRate: "23.00", priceMode: "auto", costPrice: "5.00", stock: 0,
      ean: "4006381333931",
    }).returning();

    // First import creates the link.
    await db.insert(productSuppliers).values({
      productId: existingProduct.id, supplierId: supplier.id, supplierSku: "SUP-RE-OLD",
      costPrice: "5.00", isPreferred: true,
    });

    const preview = await previewSupplierImport({
      supplierId: supplier.id,
      fileName: `${TAG}-reimport.csv`,
      csvText: "skuFornecedor;nome;custo;stock;ean\nSUP-RE-NEW;Produto Reimportado;8,00;2;4006381333931",
      userId: 1,
    });
    const apply = await applySupplierImport({ importId: preview.importId, previewToken: preview.previewToken, userId: 1 });
    expect(apply.status).toBe("completed");

    const [updatedLink] = await db.select().from(productSuppliers)
      .where(and(eq(productSuppliers.productId, existingProduct.id), eq(productSuppliers.supplierId, supplier.id)));
    expect(updatedLink.supplierSku).toBe("SUP-RE-NEW"); // updated
    expect(updatedLink.costPrice).toBe("8.00");
    expect(updatedLink.isPreferred).toBe(true); // never demoted

    // Only one association exists (no duplicate).
    const links = await db.select().from(productSuppliers)
      .where(eq(productSuppliers.productId, existingProduct.id));
    expect(links.length).toBe(1);
  });
});
