/**
 * C.3.3 (etapa 2) — Pipeline XLSX: preview, perfis C.3.2 e equivalência
 * CSV ↔ XLSX em base de dados REAL (mesma superfície do C.3.1/C.3.2:
 * previewSupplierImport + snapshot persistido + supplier_import_profiles).
 *
 * Requisitos cobertos:
 *  1. XLSX sem perfil → auto mapping (no_profile);
 *  2. XLSX + guardar mapping → perfil persistido (delimiter = null);
 *  3. segundo XLSX com os mesmos headers → perfil reutilizado (profile_valid);
 *  4. perfil incompatível → fallback seguro (profile_invalid + auto mapping);
 *  5. mapping manual não vazio → prioridade sobre o perfil;
 *  6. perfil criado via CSV → reutilizado num XLSX equivalente;
 *  7. perfil criado via XLSX → reutilizado num CSV equivalente;
 *  T. equivalência: CSV e XLSX com os mesmos dados → os MESMOS
 *     NormalizedSupplierRow / mapping / matching / pricing / preview statuses
 *     (o hash NÃO é comparado: os bytes dos ficheiros são diferentes).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import * as XLSX from "@e965/xlsx";
import { db } from "@/db";
import {
  productSuppliers,
  products,
  suppliers,
  supplierImports,
  supplierImportProfiles,
  users,
} from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import {
  previewSupplierImport,
  loadSupplierProfile,
} from "@/lib/services/supplier-import-service";
import { sha256HexBytes } from "@/lib/supplier-import/normalize";
import { uploadSource } from "@/lib/supplier-import/source";

const TAG = "C33X";
const USER_ID = 1;

const HEADERS = ["sku", "ean", "nome", "custo", "stock", "skuInterno"];

/** Mesma tabela de dados nos dois formatos (valores canónicos). */
const DATA: (string | number | "")[][] = [
  ["REF-001", "5901234123457", "Cabo HDMI 2m", 8.9, 12, ""],
  ["REF-002", "", "Rato sem fios", 12.5, 3, `${TAG}-2`],
  ["REF-003", "", "Teclado mecânico", 1234.56, 7, ""],
  ["", "", "Linha sem chave", 1, 1, ""],
  ["REF-001", "", "Duplicado", 9.99, 2, ""],
];

const CSV = [HEADERS.join(";"), ...DATA.map((r) => r.map((v) => (v === "" ? "" : String(v))).join(";"))].join("\n");

function buildXlsx(): Uint8Array {
  const ws: any = {};
  HEADERS.forEach((h, i) => { ws[XLSX.utils.encode_cell({ r: 0, c: i })] = { t: "s", v: h }; });
  DATA.forEach((row, r) => row.forEach((v, c) => {
    if (v === "") return;
    ws[XLSX.utils.encode_cell({ r: r + 1, c })] = typeof v === "number" ? { t: "n", v } : { t: "s", v };
  }));
  ws["!ref"] = "A1:F6";
  return new Uint8Array(XLSX.write({ SheetNames: ["Lista"], Sheets: { Lista: ws } }, { type: "buffer", bookType: "xlsx" }));
}

async function cleanup() {
  const pattern = `${TAG}-%`;
  await db.execute(sql`DELETE FROM supplier_import_rows WHERE import_id IN (SELECT id FROM supplier_imports WHERE file_name LIKE ${pattern})`);
  await db.execute(sql`DELETE FROM supplier_imports WHERE file_name LIKE ${pattern}`);
  await db.execute(sql`DELETE FROM supplier_import_profiles WHERE supplier_id IN (SELECT id FROM suppliers WHERE name LIKE ${pattern})`);
  await db.execute(sql`DELETE FROM product_suppliers WHERE product_id IN (SELECT id FROM products WHERE sku LIKE ${pattern})`);
  await db.execute(sql`DELETE FROM products WHERE sku LIKE ${pattern}`);
  await db.execute(sql`DELETE FROM suppliers WHERE name LIKE ${pattern}`);
}

/** Semeia o fornecedor + produtos de matching uma vez. */
async function seedCatalog() {
  const [supplier] = await db.insert(suppliers).values({ name: `${TAG}-Fornecedor`, isActive: true }).returning();
  const [p1] = await db.insert(products).values({
    name: `Produto ${TAG}-1`, slug: `md-c33x-1-${TAG}`, sku: `${TAG}-1`,
    price: "100.00", vatRate: "23.00", priceMode: "auto", stock: 10, costPrice: "8.00",
    ean: "5901234123457",
  }).returning();
  await db.insert(productSuppliers).values({
    productId: p1.id, supplierId: supplier.id, supplierSku: "REF-001",
    costPrice: "8.00", isPreferred: true,
  });
  await db.insert(products).values({
    name: `Produto ${TAG}-2`, slug: `md-c33x-2-${TAG}`, sku: `${TAG}-2`,
    price: "50.00", vatRate: "23.00", priceMode: "auto", stock: 5,
  });
  return supplier;
}

/** Projeção comparável: tudo menos ids/hashes/voláteis (derivados do ficheiro). */
function project(p: any) {
  return {
    delimiter: p.delimiter,
    headers: p.headers,
    mapping: p.mapping,
    ignoredColumns: p.ignoredColumns,
    status: p.status,
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
      message: l.message,
      issues: l.issues,
      costPrice: l.costPrice,
      costBefore: l.costBefore,
      stock: l.stock,
      stockBefore: l.stockBefore,
      reservedStock: l.reservedStock,
      leadTimeDays: l.leadTimeDays,
      productSku: l.productSku,
      productName: l.productName,
      currentPrice: l.currentPrice,
      computedPrice: l.computedPrice,
      priceMode: l.priceMode,
      isPreferredSupplier: l.isPreferredSupplier,
    })),
  };
}

beforeAll(async () => {
  await cleanup();
  await db.insert(users).values({ id: USER_ID, email: `${TAG}@test.local`, password: "x", name: "Test", role: "manager" }).onConflictDoNothing();
});

beforeEach(cleanup);
afterAll(cleanup);

describe("C.3.3 XLSX — preview e transporte (1, hash, snapshot)", () => {
  it("1: XLSX sem perfil → auto mapping, no_profile; hash = SHA-256 dos BYTES originais", async () => {
    const supplier = await seedCatalog();
    const bytes = buildXlsx();
    const preview = await previewSupplierImport({
      supplierId: supplier.id,
      source: uploadSource({ fileName: `${TAG}-lista.xlsx`, csvText: "", xlsxBytes: bytes }),
      userId: USER_ID,
    });

    expect(preview.profileUsed).toBe("no_profile");
    expect(preview.delimiter).toBeNull();
    expect(preview.fileHash).toBe(sha256HexBytes(bytes));
    expect(preview.fileSizeBytes).toBe(bytes.length);
    expect(preview.fileName).toBe(`${TAG}-lista.xlsx`);
    expect(preview.headers).toEqual(HEADERS);
    expect(preview.mapping).toEqual({
      sku: "supplierSku", ean: "ean", nome: "name", custo: "costPrice", stock: "stock", skuInterno: "internalSku",
    });
    // O snapshot persistido leva o MESMO hash (dos bytes originais) e o mapping usado.
    const [snap] = await db.select({
      fileHash: supplierImports.fileHash,
      mapping: supplierImports.mapping,
      rowCount: supplierImports.rowCount,
    }).from(supplierImports).where(eq(supplierImports.id, preview.importId)).limit(1);
    expect(snap.fileHash).toBe(sha256HexBytes(bytes));
    expect(snap.mapping).toEqual(preview.mapping);
    expect(snap.rowCount).toBe(DATA.length);
  });
});

describe("C.3.3 XLSX — perfis C.3.2 (2–7)", () => {
  it("2: XLSX + saveProfile → perfil persistido com delimiter = null", async () => {
    const supplier = await seedCatalog();
    const preview = await previewSupplierImport({
      supplierId: supplier.id,
      source: uploadSource({ fileName: `${TAG}-p1.xlsx`, csvText: "", xlsxBytes: buildXlsx() }),
      mapping: {},
      saveProfile: true,
      userId: USER_ID,
    });
    expect(preview.profileUsed).toBe("profile_valid"); // save + re-leitura confirmada
    const profile = await loadSupplierProfile(supplier.id);
    expect(profile).not.toBeNull();
    expect(profile!.mapping).toEqual(preview.mapping);
    expect(profile!.delimiter).toBeNull(); // XLSX: separador não se aplica
  });

  it("3: segundo XLSX com os mesmos headers → perfil reutilizado (profile_valid)", async () => {
    const supplier = await seedCatalog();
    await previewSupplierImport({
      supplierId: supplier.id, source: uploadSource({ fileName: `${TAG}-p2a.xlsx`, csvText: "", xlsxBytes: buildXlsx() }), saveProfile: true, userId: USER_ID,
    });
    const second = await previewSupplierImport({
      supplierId: supplier.id, source: uploadSource({ fileName: `${TAG}-p2b.xlsx`, csvText: "", xlsxBytes: buildXlsx() }), mapping: {}, userId: USER_ID,
    });
    expect(second.profileUsed).toBe("profile_valid");
    const profile = await loadSupplierProfile(supplier.id);
    expect(second.mapping).toEqual(profile!.mapping);
  });

  it("4: perfil incompatível → fallback seguro (profile_invalid + auto mapping)", async () => {
    const supplier = await seedCatalog();
    await previewSupplierImport({
      supplierId: supplier.id, source: uploadSource({ fileName: `${TAG}-p3.xlsx`, csvText: "", xlsxBytes: buildXlsx() }), saveProfile: true, userId: USER_ID,
    });
    // Perfura o perfil diretamente para um formato que o ficheiro não tem.
    const profile = await loadSupplierProfile(supplier.id);
    await db.update(supplierImportProfiles)
      .set({ mapping: { headerQueNaoExiste: "supplierSku" } })
      .where(eq(supplierImportProfiles.id, profile!.id));

    const preview = await previewSupplierImport({
      supplierId: supplier.id, source: uploadSource({ fileName: `${TAG}-p4.xlsx`, csvText: "", xlsxBytes: buildXlsx() }), mapping: {}, userId: USER_ID,
    });
    expect(preview.profileUsed).toBe("profile_invalid");
    // Fallback: o parse usado é o auto-mapping (o do ficheiro), não o do perfil.
    expect(preview.mapping).toEqual({
      sku: "supplierSku", ean: "ean", nome: "name", custo: "costPrice", stock: "stock", skuInterno: "internalSku",
    });
  });

  it("5: mapping manual não vazio → prioridade sobre o perfil", async () => {
    const supplier = await seedCatalog();
    // Ficheiro de 2 colunas: sku + nome (auto: sku→supplierSku, nome→name).
    const twoCol = () => {
      const ws: any = {};
      ["sku", "nome"].forEach((h, i) => { ws[XLSX.utils.encode_cell({ r: 0, c: i })] = { t: "s", v: h }; });
      [["REF-001", "Cabo HDMI 2m"], ["REF-002", "Rato sem fios"]].forEach((row, r) =>
        row.forEach((v, c) => { ws[XLSX.utils.encode_cell({ r: r + 1, c })] = { t: "s", v }; })
      );
      ws["!ref"] = "A1:B3";
      return new Uint8Array(XLSX.write({ SheetNames: ["Lista"], Sheets: { Lista: ws } }, { type: "buffer", bookType: "xlsx" }));
    };
    // Perfil guardado do formato de 2 colunas (auto-mapping).
    await previewSupplierImport({
      supplierId: supplier.id, source: uploadSource({ fileName: `${TAG}-m1.xlsx`, csvText: "", xlsxBytes: twoCol() }), saveProfile: true, userId: USER_ID,
    });
    // Manual: nome → internalSku (override; no auto-mapping seria "name").
    const manual = { nome: "internalSku" };
    const preview = await previewSupplierImport({
      supplierId: supplier.id, source: uploadSource({ fileName: `${TAG}-m2.xlsx`, csvText: "", xlsxBytes: twoCol() }), mapping: manual, userId: USER_ID,
    });
    expect(preview.profileUsed).toBe("profile_valid"); // perfil reportado…
    // …mas o parse usa o mapping do operador (o override venceu o perfil/auto).
    expect(preview.mapping).toEqual({ sku: "supplierSku", nome: "internalSku" });
    const line1 = preview.lines.find((l) => l.rowNumber === 2)!;
    expect(line1.internalSku).toBe("Cabo HDMI 2m"); // valor da coluna nome
    expect(line1.name).toBeNull();
  });

  it("6: perfil criado via CSV → reutilizado num XLSX equivalente", async () => {
    const supplier = await seedCatalog();
    await previewSupplierImport({
      supplierId: supplier.id, source: uploadSource({ fileName: `${TAG}-p7.csv`, csvText: CSV }), saveProfile: true, userId: USER_ID,
    });
    const profile = await loadSupplierProfile(supplier.id);
    expect(profile!.delimiter).toBe(";");
    const preview = await previewSupplierImport({
      supplierId: supplier.id, source: uploadSource({ fileName: `${TAG}-p8.xlsx`, csvText: "", xlsxBytes: buildXlsx() }), mapping: {}, userId: USER_ID,
    });
    expect(preview.profileUsed).toBe("profile_valid");
    expect(preview.mapping).toEqual(profile!.mapping);
    // O formato lógico é o do perfil — o físico (delimiter) é o do XLSX (null).
    expect(preview.delimiter).toBeNull();
  });

  it("7: perfil criado via XLSX → reutilizado num CSV equivalente", async () => {
    const supplier = await seedCatalog();
    await previewSupplierImport({
      supplierId: supplier.id, source: uploadSource({ fileName: `${TAG}-p9.xlsx`, csvText: "", xlsxBytes: buildXlsx() }), saveProfile: true, userId: USER_ID,
    });
    const profile = await loadSupplierProfile(supplier.id);
    expect(profile!.delimiter).toBeNull();
    const preview = await previewSupplierImport({
      supplierId: supplier.id, source: uploadSource({ fileName: `${TAG}-p10.csv`, csvText: CSV }), mapping: {}, userId: USER_ID,
    });
    expect(preview.profileUsed).toBe("profile_valid");
    expect(preview.mapping).toEqual(profile!.mapping);
    expect(preview.delimiter).toBe(";");
  });
});

describe("C.3.3 XLSX — equivalência CSV ↔ XLSX no pipeline (T)", () => {
  it("mesmos dados → MESMOS mapping/rows/matching/pricing/statuses (hashes diferentes, por definição)", async () => {
    const supplier = await seedCatalog();
    const bytes = buildXlsx();

    const csvPreview = await previewSupplierImport({
      supplierId: supplier.id, source: uploadSource({ fileName: `${TAG}-equiv.csv`, csvText: CSV }), userId: USER_ID,
    });
    const xlsxPreview = await previewSupplierImport({
      supplierId: supplier.id, source: uploadSource({ fileName: `${TAG}-equiv.xlsx`, csvText: "", xlsxBytes: bytes }), userId: USER_ID,
    });

    // Os hashes SÃO diferentes (bytes diferentes) — e o XLSX é o dos bytes reais.
    expect(csvPreview.fileHash).not.toBe(xlsxPreview.fileHash);
    expect(xlsxPreview.fileHash).toBe(sha256HexBytes(bytes));

    const a = project(csvPreview);
    const b = project(xlsxPreview);
    // Deliberadamente a única diferença estrutural: o delimiter.
    expect(a.delimiter).toBe(";");
    expect(b.delimiter).toBeNull();
    a.delimiter = null; b.delimiter = null;

    expect(b).toEqual(a);

    // Estados concretos (trava o matching real, não só a igualdade entre si):
    expect(b.lines.map((l: any) => [l.rowNumber, l.status, l.matchType])).toEqual([
      [2, "conflict", "none"],          // REF-001 duplicado no ficheiro
      [3, "ready", "internal_sku"],     // C33X-2 por SKU interno
      [4, "new_product", "none"],
      [5, "error", "none"],             // sem chave
      [6, "conflict", "none"],          // REF-001 duplicado
    ]);
  });
});
