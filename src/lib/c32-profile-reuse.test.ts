/**
 * C.3.2 — Regressão: REUTILIZAÇÃO DO PERFIL.
 *
 * Bug confirmado em staging: existia perfil persistido (id=1, supplier_id=1,
 * mapping = "{\"nome\":\"name\",\"custo\":\"costPrice\",…}" — string JSON no
 * JSONB), mas o segundo Preview com saveProfile=false mostrava
 * "perfil #no_profile". Causas cobertas por estes testes:
 *  A) loadSupplierProfile rejeitava mapping guardado como string JSON;
 *  B) a UI envia sempre mapping:{} e a route considerava {} truthy, pelo que
 *     o mapping do perfil nunca chegava a ser aplicado;
 *  C) o segundo preview (saveProfile=false) não reutilizava o perfil;
 *  D) o save reportava sucesso pelo retorno do save, sem releitura;
 *  E) o mapping manual não vazio continua a ter prioridade (preservado);
 *  F) um preview falhado não grava nem sobrescreve o perfil.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { db } from "@/db";
import { suppliers, supplierImports, supplierImportProfiles, users } from "@/db/schema";
import { eq, sql } from "drizzle-orm";

const getCurrentUserMock = vi.fn();
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getCurrentUser: () => getCurrentUserMock() };
});

import { NextRequest } from "next/server";
import {
  loadSupplierProfile,
  previewSupplierImport,
  saveSupplierProfile,
} from "@/lib/services/supplier-import-service";
import { POST as supplierImportPOST } from "@/app/api/admin/supplier-import/route";
import { uploadSource } from "@/lib/supplier-import/source";

const TAG = "C32-REUSE";
const CSV = "skuFornecedor;nome;custo;stock;ean\nTEST-001;Produto A;10,00;5;5901234123457";
/** Exatamente o mapping persistido em staging. */
const STAGING_MAPPING = { nome: "name", custo: "costPrice", stock: "stock", skuFornecedor: "supplierSku" };
/** O mapping final mergeia o perfil com os aliases das restantes headers. */
const STAGING_MAPPING_APPLIED = { ...STAGING_MAPPING, ean: "ean" };

const MANAGER = { id: 1, email: `${TAG}@test.local`, password: "x", name: "Test", role: "manager" };

async function cleanup() {
  // Nota: dentro de DO $$ … $$ os parâmetros ($1) não são aceites — o LIKE usa
  // literal, tal como nos restantes testes C.3.1/C.3.2.
  await db.execute(sql`DO $$ BEGIN DELETE FROM supplier_import_profiles WHERE supplier_id IN (SELECT id FROM suppliers WHERE name LIKE 'C32-REUSE-%'); EXCEPTION WHEN undefined_table THEN NULL; END $$`);
  await db.execute(sql`DELETE FROM supplier_import_rows WHERE import_id IN (SELECT id FROM supplier_imports WHERE file_name LIKE ${`${TAG}-%`})`);
  await db.execute(sql`DELETE FROM supplier_imports WHERE file_name LIKE ${`${TAG}-%`}`);
  await db.execute(sql`DELETE FROM suppliers WHERE name LIKE ${`${TAG}-%`} AND id > 2`);
}

/** Insere um perfil com o mapping exatamente na forma guardada (JSONB puro). */
async function insertRawProfile(supplierId: number, jsonbValue: string) {
  await db.execute(
    sql`INSERT INTO supplier_import_profiles (supplier_id, mapping) VALUES (${supplierId}, ${jsonbValue}::jsonb)`
  );
}

async function snapshotMappingOf(importId: number): Promise<Record<string, string>> {
  const [row] = await db.select({ mapping: supplierImports.mapping })
    .from(supplierImports).where(eq(supplierImports.id, importId)).limit(1);
  return (row?.mapping as Record<string, string>) ?? {};
}

beforeAll(async () => {
  await cleanup();
  await db.insert(users).values({ id: 1, email: `${TAG}@test.local`, password: "x", name: "Test", role: "manager" }).onConflictDoNothing();
});

beforeEach(async () => {
  getCurrentUserMock.mockReset();
  getCurrentUserMock.mockResolvedValue(MANAGER);
  await cleanup();
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(cleanup);

describe("C.3.2 — Reutilização do perfil (correção)", () => {
  it("A) loadSupplierProfile aceita mapping JSONB guardado como string JSON", async () => {
    const [supplier] = await db.insert(suppliers).values({ name: `${TAG}-Str`, isActive: true }).returning();

    // Reproduz o registo de staging: o JSONB guarda uma STRING JSON
    // (dupla codificação), não o objeto.
    await insertRawProfile(supplier.id, JSON.stringify(JSON.stringify(STAGING_MAPPING)));

    const profile = await loadSupplierProfile(supplier.id);
    expect(profile).not.toBeNull();
    expect(profile!.mapping).toEqual(STAGING_MAPPING);

    // E o preview reutiliza esse perfil sem mapping manual.
    const preview = await previewSupplierImport({
      supplierId: supplier.id, source: uploadSource({ fileName: `${TAG}-A.csv`, csvText: CSV }), userId: 1,
    });
    expect(preview.profileUsed).toBe("profile_valid");
    expect(preview.profileName).toBe(`Perfil #${profile!.id}`);
    expect(preview.mapping).toEqual(STAGING_MAPPING_APPLIED);
    expect(await snapshotMappingOf(preview.importId)).toEqual(STAGING_MAPPING_APPLIED);
  });

  it("A2) mapping JSONB ilegível → perfil ignorado com logging seguro (sem conteúdo)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // (a) string JSON que representa um array — não é Record<string,string>
    const [s1] = await db.insert(suppliers).values({ name: `${TAG}-ArrStr`, isActive: true }).returning();
    await insertRawProfile(s1.id, JSON.stringify(JSON.stringify([1, 2])));
    expect(await loadSupplierProfile(s1.id)).toBeNull();

    // (b) JSONB array direto
    const [s2] = await db.insert(suppliers).values({ name: `${TAG}-Arr`, isActive: true }).returning();
    await insertRawProfile(s2.id, "[1,2]");
    expect(await loadSupplierProfile(s2.id)).toBeNull();

    // (c) string JSON com um valor que não deve vazar para o log
    const [s3] = await db.insert(suppliers).values({ name: `${TAG}-Secret`, isActive: true }).returning();
    await insertRawProfile(s3.id, JSON.stringify("SECRET-MARKER-XYZ"));
    expect(await loadSupplierProfile(s3.id)).toBeNull();

    expect(warnSpy).toHaveBeenCalledTimes(3);
    for (const call of warnSpy.mock.calls) {
      const message = String(call[0]);
      expect(message).not.toContain("SECRET-MARKER-XYZ"); // logging sem dados sensíveis
      expect(message).toContain("mapping JSONB inválido");
    }

    // O preview continua funcional (fallback autoMap), mas nunca diz profile_valid.
    const preview = await previewSupplierImport({
      supplierId: s3.id, source: uploadSource({ fileName: `${TAG}-A2.csv`, csvText: CSV }), mapping: {}, userId: 1,
    });
    expect(preview.status).toBe("preview");
    expect(preview.profileUsed).toBe("no_profile");
    // A releitura interna do preview também avisou — sempre sem conteúdo sensível.
    expect(warnSpy).toHaveBeenCalledTimes(4);
    expect(warnSpy.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain("SECRET-MARKER-XYZ");
  });

  it("B) mapping:{} da UI não impede a utilização do perfil guardado", async () => {
    const [supplier] = await db.insert(suppliers).values({ name: `${TAG}-Empty`, isActive: true }).returning();
    await saveSupplierProfile(supplier.id, STAGING_MAPPING);
    const profile = await loadSupplierProfile(supplier.id);
    expect(profile).not.toBeNull();

    // A UI envia sempre mapping:{} — tem de contar como "sem mapping manual".
    const preview = await previewSupplierImport({
      supplierId: supplier.id, source: uploadSource({ fileName: `${TAG}-B.csv`, csvText: CSV }), mapping: {}, userId: 1,
    });
    expect(preview.profileUsed).toBe("profile_valid");
    expect(preview.mapping).toEqual(STAGING_MAPPING_APPLIED); // parseado com o mapping do perfil
    expect(await snapshotMappingOf(preview.importId)).toEqual(preview.mapping); // snapshot = mapping usado
  });

  it("B2) route trata mapping:{} como ausente e usa o perfil guardado", async () => {
    const [supplier] = await db.insert(suppliers).values({ name: `${TAG}-Route`, isActive: true }).returning();
    const saved = await saveSupplierProfile(supplier.id, STAGING_MAPPING);
    expect(saved.updated).toBe(false);

    const req = new NextRequest("http://localhost/api/admin/supplier-import", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({
        supplierId: supplier.id, fileName: `${TAG}-route.csv`, data: CSV,
        mapping: {}, saveProfile: false,
      }),
    });
    const res = await supplierImportPOST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profileUsed).toBe("profile_valid");
    expect(body.profileName).toBe(`Perfil #${saved.id}`);
    expect(body.mapping).toEqual(STAGING_MAPPING_APPLIED);
  });

  it("C) segundo preview com saveProfile=false reutiliza o perfil persistido", async () => {
    const [supplier] = await db.insert(suppliers).values({ name: `${TAG}-Second`, isActive: true }).returning();

    // 1º preview: grava o perfil (como a UI com a checkbox marcada).
    const first = await previewSupplierImport({
      supplierId: supplier.id, source: uploadSource({ fileName: `${TAG}-C1.csv`, csvText: CSV }), mapping: {}, userId: 1, saveProfile: true,
    });
    expect(first.profileUsed).toBe("profile_valid");
    const saved = await loadSupplierProfile(supplier.id);
    expect(saved).not.toBeNull();

    // 2º preview: saveProfile=false e mapping:{} — o bug mostrava "no_profile".
    const second = await previewSupplierImport({
      supplierId: supplier.id, source: uploadSource({ fileName: `${TAG}-C2.csv`, csvText: CSV }), mapping: {}, userId: 1, saveProfile: false,
    });
    expect(second.profileUsed).toBe("profile_valid");
    expect(second.profileName).toBe(`Perfil #${saved!.id}`);
    expect(second.mapping).toEqual(saved!.mapping); // CSV parseado com o mapping do perfil
    expect(await snapshotMappingOf(second.importId)).toEqual(second.mapping);

    // Sem saveProfile, o perfil não é regravado entre previews.
    const after = await loadSupplierProfile(supplier.id);
    expect(after!.mapping).toEqual(saved!.mapping);
    expect(after!.id).toBe(saved!.id);
  });

  it("D) saveProfile=true só reporta profile_valid depois de releitura válida", async () => {
    const [supplier] = await db.insert(suppliers).values({ name: `${TAG}-Reread`, isActive: true }).returning();

    const preview = await previewSupplierImport({
      supplierId: supplier.id, source: uploadSource({ fileName: `${TAG}-D.csv`, csvText: CSV }), mapping: {}, userId: 1, saveProfile: true,
    });

    // O id reportado vem da releitura, não apenas do retorno do save.
    const reread = await loadSupplierProfile(supplier.id);
    expect(reread).not.toBeNull();
    expect(preview.profileUsed).toBe("profile_valid");
    expect(preview.profileName).toBe(`Perfil #${reread!.id}`);
    expect(reread!.mapping).toEqual(preview.mapping); // legível de volta = o mapping usado
  });

  it("D2) perfil ilegível nunca é reportado como profile_valid", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const [supplier] = await db.insert(suppliers).values({ name: `${TAG}-Unread`, isActive: true }).returning();
    await insertRawProfile(supplier.id, JSON.stringify("SECRET-MARKER-XYZ"));

    const preview = await previewSupplierImport({
      supplierId: supplier.id, source: uploadSource({ fileName: `${TAG}-D2.csv`, csvText: CSV }), mapping: {}, userId: 1,
    });
    expect(preview.profileUsed).not.toBe("profile_valid");
    expect(preview.profileUsed).toBe("no_profile");
    expect(warnSpy.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain("SECRET-MARKER-XYZ");
  });

  it("E) mapping manual não vazio continua a ter prioridade", async () => {
    const [supplier] = await db.insert(suppliers).values({ name: `${TAG}-Manual`, isActive: true }).returning();
    // Perfil COMPATÍVEL com o ficheiro, mas aponta o custo para outra coluna.
    await saveSupplierProfile(supplier.id, {
      skuFornecedor: "supplierSku", nome: "name", custoAlt2: "costPrice", stock: "stock",
    });
    const profile = await loadSupplierProfile(supplier.id);

    const csv = "skuFornecedor;nome;stock;precoCustoAlt;custoAlt2\nTEST-001;Produto A;5;20,00;99,00";
    const manual = { skuFornecedor: "supplierSku", precoCustoAlt: "costPrice" };

    const preview = await previewSupplierImport({
      supplierId: supplier.id, source: uploadSource({ fileName: `${TAG}-E.csv`, csvText: csv }), mapping: manual, userId: 1,
    });

    // O CSV foi lido com o mapeamento MANUAL, não com o do perfil.
    expect(preview.mapping).toEqual({
      skuFornecedor: "supplierSku", precoCustoAlt: "costPrice", nome: "name", stock: "stock",
    });
    expect(preview.mapping["custoAlt2"]).toBeUndefined();
    // O custo vem da coluna manual (20,00), não da coluna do perfil (99,00).
    expect(preview.lines[0].costPrice).toBe("20.00");
    // Snapshot = mapping realmente usado (manual).
    expect(await snapshotMappingOf(preview.importId)).toEqual(preview.mapping);
    // O perfil guardado não foi alterado.
    const after = await loadSupplierProfile(supplier.id);
    expect(after!.mapping).toEqual(profile!.mapping);
    // Comportamento atual preservado: perfil compatível continua reportado.
    expect(preview.profileUsed).toBe("profile_valid");
  });

  it("E2) manual também vence quando o perfil é incompatível (fallback atual)", async () => {
    const [supplier] = await db.insert(suppliers).values({ name: `${TAG}-ManualInv`, isActive: true }).returning();
    await saveSupplierProfile(supplier.id, { skuFornecedor: "supplierSku", colunaVelha: "name" });

    const csv = "skuFornecedor;nome;stock;precoCustoAlt\nTEST-001;Produto A;5;20,00";
    const manual = { skuFornecedor: "supplierSku", precoCustoAlt: "costPrice" };

    const preview = await previewSupplierImport({
      supplierId: supplier.id, source: uploadSource({ fileName: `${TAG}-E2.csv`, csvText: csv }), mapping: manual, userId: 1,
    });
    expect(preview.profileUsed).toBe("profile_invalid");
    expect(preview.mapping).toEqual({
      skuFornecedor: "supplierSku", precoCustoAlt: "costPrice", nome: "name", stock: "stock",
    });
    expect(preview.lines[0].costPrice).toBe("20.00");
    expect(await snapshotMappingOf(preview.importId)).toEqual(preview.mapping);
  });

  it("F) preview falhado não grava nem sobrescreve o perfil", async () => {
    // F1 — fornecedor novo: o CSV falha no parse (sem coluna-chave) → sem perfil.
    const [fresh] = await db.insert(suppliers).values({ name: `${TAG}-FailNew`, isActive: true }).returning();
    await expect(previewSupplierImport({
      supplierId: fresh.id, source: uploadSource({ fileName: `${TAG}-F1.csv`, csvText: "nome;custo\nA;1" }), mapping: {}, saveProfile: true, userId: 1,
    })).rejects.toThrow();
    expect(await loadSupplierProfile(fresh.id)).toBeNull();
    const [count1] = await db.select({ count: sql<number>`count(*)` })
      .from(supplierImportProfiles).where(eq(supplierImportProfiles.supplierId, fresh.id));
    expect(Number(count1?.count ?? 0)).toBe(0);

    // F2 — fornecedor com perfil: preview falhado (CSV vazio) não o altera.
    const [withProfile] = await db.insert(suppliers).values({ name: `${TAG}-FailOld`, isActive: true }).returning();
    await saveSupplierProfile(withProfile.id, { skuFornecedor: "supplierSku", nome: "name" });
    const before = await loadSupplierProfile(withProfile.id);

    await expect(previewSupplierImport({
      supplierId: withProfile.id, source: uploadSource({ fileName: `${TAG}-F2.csv`, csvText: "" }), mapping: {}, saveProfile: true, userId: 1,
    })).rejects.toThrow();

    const after = await loadSupplierProfile(withProfile.id);
    expect(after!.id).toBe(before!.id);
    expect(after!.mapping).toEqual(before!.mapping);
  });
});
