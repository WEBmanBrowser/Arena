/**
 * C.3.2 — Regressão: "Guardar perfil" durante o PREVIEW.
 *
 * Bug: o painel enviava saveProfile=true, mas o valor não era propagado até
 * previewSupplierImport, pelo que saveSupplierProfile nunca era chamado e o
 * preview continuava a devolver profileUsed="no_profile".
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { db } from "@/db";
import { suppliers, supplierImports, users } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { loadSupplierProfile, previewSupplierImport } from "@/lib/services/supplier-import-service";
import { uploadSource } from "@/lib/supplier-import/source";

const TAG = "C32-SAVEPREVIEW";
const CSV = "skuFornecedor;nome;custo;stock;ean\nTEST-001;Produto A;10,00;5;5901234123457";

async function cleanup() {
  await db.execute(sql`DO $$ BEGIN DELETE FROM supplier_import_profiles WHERE supplier_id IN (SELECT id FROM suppliers WHERE name LIKE 'C32-SAVEPREVIEW-%'); EXCEPTION WHEN undefined_table THEN NULL; END $$`);
  await db.execute(sql`DELETE FROM supplier_import_rows WHERE import_id IN (SELECT id FROM supplier_imports WHERE file_name LIKE ${`${TAG}-%`})`);
  await db.execute(sql`DELETE FROM supplier_imports WHERE file_name LIKE ${`${TAG}-%`}`);
  await db.execute(sql`DELETE FROM suppliers WHERE name LIKE ${`${TAG}-%`} AND id > 2`);
}

beforeAll(async () => {
  await cleanup();
  await db.insert(users).values({ id: 1, email: `${TAG}@test.local`, password: "x", name: "Test", role: "manager" }).onConflictDoNothing();
});

beforeEach(cleanup);
afterAll(cleanup);

describe("C.3.2 — saveProfile no preview", () => {
  it("saveProfile=true grava o perfil e o preview reflete-o", async () => {
    const [supplier] = await db.insert(suppliers).values({ id: 210, name: `${TAG}-Save`, isActive: true }).returning();

    expect(await loadSupplierProfile(supplier.id)).toBeNull();

    const preview = await previewSupplierImport({
      supplierId: supplier.id,
      source: uploadSource({ fileName: `${TAG}-1.csv`, csvText: CSV }), userId: 1,
      saveProfile: true,
    });

    const saved = await loadSupplierProfile(supplier.id);
    expect(saved).not.toBeNull();
    expect(saved!.mapping).toEqual(preview.mapping);
    expect(preview.profileUsed).toBe("profile_valid");
    expect(preview.profileName).toBe(`Perfil #${saved!.id}`);

    // Snapshot persistido continua a ser o mapping efetivamente usado.
    const [row] = await db.select({ mapping: supplierImports.mapping })
      .from(supplierImports).where(eq(supplierImports.id, preview.importId)).limit(1);
    expect(row.mapping).toEqual(preview.mapping);
  });

  it("segundo preview reutiliza o perfil guardado", async () => {
    const [supplier] = await db.insert(suppliers).values({ id: 211, name: `${TAG}-Reuse`, isActive: true }).returning();

    await previewSupplierImport({
      supplierId: supplier.id, source: uploadSource({ fileName: `${TAG}-2a.csv`, csvText: CSV }), userId: 1, saveProfile: true,
    });
    const first = await loadSupplierProfile(supplier.id);

    const second = await previewSupplierImport({
      supplierId: supplier.id, source: uploadSource({ fileName: `${TAG}-2b.csv`, csvText: CSV }), userId: 1,
    });

    expect(second.profileUsed).toBe("profile_valid");
    expect(second.profileName).toBe(`Perfil #${first!.id}`);
    expect(second.mapping).toEqual(first!.mapping);
  });

  it("sem saveProfile o comportamento C.3.1 mantém-se (no_profile)", async () => {
    const [supplier] = await db.insert(suppliers).values({ id: 212, name: `${TAG}-NoSave`, isActive: true }).returning();

    const preview = await previewSupplierImport({
      supplierId: supplier.id, source: uploadSource({ fileName: `${TAG}-3.csv`, csvText: CSV }), userId: 1,
    });

    expect(preview.profileUsed).toBe("no_profile");
    expect(await loadSupplierProfile(supplier.id)).toBeNull();
  });
});
