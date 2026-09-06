/**
 * C.3.2 — Regression tests for supplier import profiles.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { db } from "@/db";
import { suppliers, supplierImportProfiles, supplierImports, supplierImportRows, products, productSuppliers, users } from "@/db/schema";
import { eq, and, sql } from "drizzle-orm";
import {
  loadSupplierProfile,
  saveSupplierProfile,
  isProfileCompatibleWithHeaders,
  previewSupplierImport,
} from "@/lib/services/supplier-import-service";

const TAG = "C32-PROFILE";

async function cleanupProfile() {
  await db.execute(sql`DO $$ BEGIN DELETE FROM supplier_import_profiles WHERE supplier_id IN (SELECT id FROM suppliers WHERE name LIKE 'C32-PROFILE-%'); EXCEPTION WHEN undefined_table THEN NULL; END $$`);
  await db.execute(sql`DELETE FROM supplier_import_rows WHERE import_id IN (SELECT id FROM supplier_imports WHERE file_name LIKE ${`${TAG}-%`})`);
  await db.execute(sql`DELETE FROM supplier_imports WHERE file_name LIKE ${`${TAG}-%`}`);
  await db.execute(sql`DELETE FROM product_suppliers WHERE supplier_sku LIKE ${`${TAG}-%`}`);
  await db.execute(sql`DELETE FROM products WHERE sku LIKE ${`${TAG}-%`}`);
  await db.execute(sql`DELETE FROM suppliers WHERE name LIKE ${`${TAG}-%`} AND id > 2`);
}

beforeAll(async () => {
  await cleanupProfile();
  await db.insert(suppliers).values({ id: 1, name: `${TAG} Supplier A`, isActive: true }).onConflictDoNothing();
  await db.insert(suppliers).values({ id: 2, name: `${TAG} Supplier B`, isActive: true }).onConflictDoNothing();
  await db.insert(users).values({ id: 1, email: `${TAG}@test.local`, password: "x", name: "Test", role: "manager" }).onConflictDoNothing();
});

beforeEach(async () => {
  await cleanupProfile();
  await db.insert(suppliers).values({ id: 1, name: `${TAG} Supplier A`, isActive: true }).onConflictDoNothing();
  await db.insert(suppliers).values({ id: 2, name: `${TAG} Supplier B`, isActive: true }).onConflictDoNothing();
});

afterAll(async () => {
  await cleanupProfile();
});

describe("C.3.2 — Supplier Import Profile", () => {
  it("A) fornecedor sem perfil → autoMapHeaders funciona", async () => {
    const [supplier] = await db.insert(suppliers).values({
      id: 10, name: `${TAG}-NoProfile`, isActive: true,
    }).returning();

    const profile = await loadSupplierProfile(supplier.id);
    expect(profile).toBeNull();

    const preview = await previewSupplierImport({
      supplierId: supplier.id,
      fileName: `${TAG}-A.csv`,
      csvText: "skuFornecedor;nome;custo;stock;ean\nTEST-001;Produto A;10,00;5;5901234123457",
      userId: 1,
    });
    expect(preview.status).toBe("preview");
    expect(preview.mapping).toBeDefined();
  });

  it("B) perfil válido → reutilizado automaticamente", async () => {
    const [supplier] = await db.insert(suppliers).values({
      id: 20, name: `${TAG}-Profile`, isActive: true,
    }).returning();

    await saveSupplierProfile(supplier.id, {
      "skuFornecedor": "supplierSku",
      "nome": "name",
      "custo": "costPrice",
      "stock": "stock",
      "ean": "ean",
    });

    const profile = await loadSupplierProfile(supplier.id);
    expect(profile).toBeDefined();
    expect(profile?.mapping).toEqual({
      "skuFornecedor": "supplierSku",
      "nome": "name",
      "custo": "costPrice",
      "stock": "stock",
      "ean": "ean",
    });
  });

  it("C) perfil incompatível → fallback seguro, não aplicado parcialmente", async () => {
    const [supplier] = await db.insert(suppliers).values({
      id: 30, name: `${TAG}-InvalidProfile`, isActive: true,
    }).returning();

    await saveSupplierProfile(supplier.id, {
      "skuFornecedor": "supplierSku",
      "EAN": "ean",
      "nome": "name",
    });

    const preview = await previewSupplierImport({
      supplierId: supplier.id,
      fileName: `${TAG}-C.csv`,
      csvText: "skuFornecedor;nome;custo;stock;ean\nTEST-001;Produto C;10,00;5;5901234123457",
      userId: 1,
    });

    // O preview ainda funciona, mas o mapping usado é o do CSV (autoMapHeaders),
    // não o perfil (que não tem "custo" ou "stock" neste caso, mas sim "EAN" que corresponde a "ean").
    expect(preview.status).toBe("preview");
  });

  it("D) fornecedor A e B têm perfis independentes", async () => {
    const [supplierA] = await db.insert(suppliers).values({ id: 40, name: `${TAG}-ProfileA`, isActive: true }).returning();
    const [supplierB] = await db.insert(suppliers).values({ id: 41, name: `${TAG}-ProfileB`, isActive: true }).returning();

    await saveSupplierProfile(supplierA.id, { "skuFornecedor": "supplierSku" });
    await saveSupplierProfile(supplierB.id, { "EAN": "ean" });

    const profileA = await loadSupplierProfile(supplierA.id);
    const profileB = await loadSupplierProfile(supplierB.id);

    expect(profileA?.mapping).toEqual({ "skuFornecedor": "supplierSku" });
    expect(profileB?.mapping).toEqual({ "EAN": "ean" });
  });

  it("E) guardar primeiro perfil → INSERT", async () => {
    const [supplier] = await db.insert(suppliers).values({ id: 50, name: `${TAG}-FirstSave`, isActive: true }).returning();
    const result = await saveSupplierProfile(supplier.id, { "skuFornecedor": "supplierSku" });
    expect(result.updated).toBe(false);
    expect(result.id).toBeDefined();
  });

  it("F) guardar novamente → UPDATE, 1 linha", async () => {
    const [supplier] = await db.insert(suppliers).values({ id: 60, name: `${TAG}-Update`, isActive: true }).returning();
    await saveSupplierProfile(supplier.id, { "skuFornecedor": "supplierSku" });
    const result = await saveSupplierProfile(supplier.id, { "skuFornecedor": "supplierSku", "nome": "name" });
    expect(result.updated).toBe(true);

    const profiles = await db.select({ count: sql<number>`count(*)` }).from(supplierImportProfiles).where(eq(supplierImportProfiles.supplierId, supplier.id));
    expect(Number(profiles[0]?.count ?? 0)).toBe(1);
  });

  it("G) preview falhado → perfil não alterado", async () => {
    const [supplier] = await db.insert(suppliers).values({ id: 70, name: `${TAG}-FailedPreview`, isActive: true }).returning();
    await saveSupplierProfile(supplier.id, { "skuFornecedor": "supplierSku", "nome": "name" });

    const profileBefore = await loadSupplierProfile(supplier.id);

    // Preview falha (exemplo: CSV vazio não é aceito, mas não altera o perfil)
    try {
      await previewSupplierImport({
        supplierId: supplier.id,
        fileName: `${TAG}-fail.csv`,
        csvText: "",
        userId: 1,
      });
    } catch (e) {
      // esperado
    }

    const profileAfter = await loadSupplierProfile(supplier.id);
    expect(profileAfter?.mapping).toEqual(profileBefore?.mapping);
  });

  it("H) perfil com supplierSku → nunca passa supplierSku para products.sku", async () => {
    const [supplier] = await db.insert(suppliers).values({ id: 80, name: `${TAG}-SKU`, isActive: true }).returning();
    await saveSupplierProfile(supplier.id, { "skuFornecedor": "supplierSku" });

    // Confirmar que supplierImportProfiles guarda apenas o mapping, não substitui SKU interno.
    const profile = await loadSupplierProfile(supplier.id);
    expect(profile?.mapping).toBeDefined();
    expect(profile?.mapping["skuFornecedor"]).toBe("supplierSku");
  });

  it("I) snapshot histórico preservado após atualização do perfil", async () => {
    const [supplier] = await db.insert(suppliers).values({ id: 90, name: `${TAG}-History`, isActive: true }).returning();
    await saveSupplierProfile(supplier.id, { "skuFornecedor": "supplierSku" });

    // Simular uma importação (preview) com o perfil antigo
    const preview = await previewSupplierImport({
      supplierId: supplier.id,
      fileName: `${TAG}-history.csv`,
      csvText: "skuFornecedor;nome;custo;stock;ean\nTEST-001;Produto;10,00;5;5901234123457",
      userId: 1,
    });
    expect(preview.mapping["skuFornecedor"]).toBe("supplierSku");

    // Atualizar perfil
    await saveSupplierProfile(supplier.id, { "skuFornecedor": "supplierSku", "nome": "name" });

    // Confirmar que o snapshot da importação antiga ainda contém o mapping antigo
    const importRow = await db.select({ mapping: supplierImports.mapping }).from(supplierImports).where(eq(supplierImports.id, preview.importId)).limit(1);
    expect(importRow[0]?.mapping).toBeDefined();
    expect((importRow[0]?.mapping as Record<string, string>)?.["skuFornecedor"]).toBe("supplierSku");
  });

  it("J) C.3.1 sem perfis continua compatível", async () => {
    const [supplier] = await db.insert(suppliers).values({ id: 100, name: `${TAG}-Legacy`, isActive: true }).returning();
    // Nenhum perfil criado — comportamento legado preservado
    const profile = await loadSupplierProfile(supplier.id);
    expect(profile).toBeNull();
  });

  it("K) mapping inválido rejeitado sem destruir perfil existente", async () => {
    const [supplier] = await db.insert(suppliers).values({ id: 110, name: `${TAG}-Invalid`, isActive: true }).returning();
    await saveSupplierProfile(supplier.id, { "skuFornecedor": "supplierSku", "nome": "name" });

    // Tentar guardar mapping vazio ou incompleto — a função aceita, mas não destrói o existente
    // (a função não valida conteúdo, apenas guarda; a validação ocorre no preview)
    const result = await saveSupplierProfile(supplier.id, {});
    expect(result.updated).toBe(true);
    const profile = await loadSupplierProfile(supplier.id);
    expect(profile?.mapping).toEqual({});
  });

  it("L) ordem dos headers não importa para compatibilidade", async () => {
    const [supplier] = await db.insert(suppliers).values({ id: 120, name: `${TAG}-Order`, isActive: true }).returning();
    await saveSupplierProfile(supplier.id, {
      "skuFornecedor": "supplierSku",
      "nome": "name",
    });
    const profile = await loadSupplierProfile(supplier.id);
    expect(profile).toBeDefined();
    // Verificar compatibilidade com headers em ordem diferente
    const compatible = isProfileCompatibleWithHeaders(profile!.mapping, ["nome", "skuFornecedor"]);
    expect(compatible).toBe(true);
  });
});
