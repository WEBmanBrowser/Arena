/**
 * C.3.4.3.1 (fix de staging pós-PR #35) — O CAMINHO REAL do botão "Pré-visualizar".
 *
 * Os testes da PR #35 (c343-also-detection*) cobriam o detector e o
 * uploadSource isoladamente — mas o bug de staging sobreviveu porque o
 * caminho REAL da UI (Admin → Importar lista de fornecedor → Pré-visualizar)
 * passa pela route POST /api/admin/supplier-import, carrega o perfil C.3.2
 * do fornecedor e devolve um contrato de preview que a UI usa para decidir
 * o que mostrar. Estes testes invocam a MESMA route (mesmo entry point do
 * botão) com o MESMO cenário de staging:
 *
 *  - fornecedor "Also portugal" com um perfil C.3.2 guardado ("Perfil #1",
 *    mapping genérico de uma importação anterior);
 *  - ficheiro also-pricelist-teste.txt — pricelist ALSO real, TSV, sem header;
 *  - a UI envia sempre mapping:{} (sem caixas de mapeamento marcadas).
 *
 * Contrato esperado (o que a UI precisa para parar de induzir C.3.2):
 *  - o preview expõe o FORMATO efetivo (also_pricelist) — sem isso a UI não
 *    distingue "parser ALSO fixo" de "mapping C.3.2", mostra o separador
 *    errado e o banner "perfil inválido — usou fallback";
 *  - as linhas vêm do parser ALSO (ProductID→supplierSku, Description→name,
 *    NetPrice→cost, AvailableQuantity→stock, MPN/marca/categoria preservados);
 *  - o preço de venda vem do motor MDTech, nunca do ficheiro;
 *  - preview_only: nada de catálogo é tocado.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { db } from "@/db";
import { suppliers, supplierImports, supplierImportRows, users, pricingRules, products } from "@/db/schema";
import { eq, sql } from "drizzle-orm";

const getCurrentUserMock = vi.fn();
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getCurrentUser: () => getCurrentUserMock() };
});

import { NextRequest } from "next/server";
import { POST as supplierImportPOST } from "@/app/api/admin/supplier-import/route";
import { saveSupplierProfile } from "@/lib/services/supplier-import-service";
import { inferSupplierImportFormat } from "@/lib/supplier-import/file";

const TAG = "C343REAL";
const MANAGER = { id: 9750, email: `${TAG}@test.local`, password: "x", name: "Real Flow", role: "manager" as const };

// Pricelist ALSO real (estágio): TSV sem header, 10 linhas, CRLF.
// Cols: 0 ProductID, 1 EAN, 2-4 CategoryText1-3, 5 Description, 6 AvailableQuantity,
//       7 NetPrice, 8 ManufacturerPartNumber, 9 ManufacturerName, 10-11 extras ignorados.
const ALSO_ROWS: string[][] = [
  ["1203387", "4017858000003", "Networking", "Routers", "Gaming Routers", "HP 3y PickupRtrn 324", "120", "189.99", "J2P32A", "HP", "extra", "x"],
  ["1204001", "4008321741189", "PCs", "Desktops", "All-in-One", "HP All-in-One 27 27-aa0005", "45", "349.00", "51A22EA", "HP", "extra", "x"],
  ["1204555", "4895903520108", "Audio", "Headsets", "Gaming", "HyperX Cloud II Wired Headset", "8", "129.95", "HMBS260", "HyperX", "extra", "x"],
  ["1205000", "4711234567899", "Storage", "SSDs", "M.2 NVMe", "Samsung 980 Pro 2TB", "-1", "179.90", "MZ-V8P2T0B", "Samsung", "extra", "x"],
  ["1205123", "4043677000122", "Monitors", "27 inch", "QHD", "LG UltraGear 27GP850", "33", "289.00", "27GP850-B", "LG", "extra", "x"],
  ["1206001", "4260101234568", "Keyboards", "Mechanical", "RGB", "Logitech G Pro X TKL", "17", "199.99", "910-006024", "Logitech", "extra", "x"],
  ["1206100", "4017858999994", "Networking", "Switches", "Gigabit", "HP 8-Port Gigabit Ethernet Switch", "55", "59.90", "J6V89A", "HP", "extra", "x"],
  ["1207000", "4710654891713", "Laptops", "15 inch", "Core i5", "Lenovo IdeaPad 3 15", "12", "429.00", "82M200QSPB", "Lenovo", "extra", "x"],
  ["1208000", "4017858111112", "Accessories", "Mouse", "Gaming", "Razer DeathAdder V2", "200", "69.99", "RZ03-03210100", "Razer", "extra", "x"],
  ["1209000", "4895903111221", "Chargers", "USB-C", "65W", "Anker 65W GaN Charger", "75", "45.00", "A2665", "Anker", "extra", "x"],
];
const ALSO_FILE = ALSO_ROWS.map((r) => r.join("\t")).join("\r\n") + "\r\n";
const ALSO_FILE_NAME = "also-pricelist-teste.txt";

// Perfil C.3.2 "guardado" do fornecedor no staging: mapping genérico de uma
// importação anterior (headers SKU/fornecedor;nome;custo;stock).
const GENERIC_PROFILE_MAPPING = { skuFornecedor: "supplierSku", nome: "name", custo: "costPrice", stock: "stock" };

let supplierId = 0;

async function cleanup() {
  await db.execute(sql`DELETE FROM supplier_import_rows WHERE import_id IN (SELECT id FROM supplier_imports WHERE user_id = ${MANAGER.id})`);
  await db.execute(sql`DELETE FROM supplier_imports WHERE user_id = ${MANAGER.id}`);
  await db.execute(sql`DELETE FROM pricing_rules WHERE notes LIKE ${`${TAG}%`}`);
  await db.execute(sql`DELETE FROM supplier_import_profiles WHERE supplier_id IN (SELECT id FROM suppliers WHERE name LIKE ${`${TAG}%`})`);
  await db.execute(sql`DELETE FROM suppliers WHERE name LIKE ${`${TAG}%`}`);
  await db.execute(sql`DELETE FROM products WHERE sku LIKE ${`${TAG}%`}`);
}

/** POST exatamente como o botão "Pré-visualizar" (JSON, mapping da UI). */
async function postPreview(body: Record<string, unknown>): Promise<{ ok: boolean; status: number; body: any }> {
  const req = new NextRequest("http://localhost/api/admin/supplier-import", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify(body),
  });
  const res = await supplierImportPOST(req);
  let parsed: any = null;
  try { parsed = await res.json(); } catch { /* sem body */ }
  return { ok: res.ok, status: res.status, body: parsed };
}

beforeAll(async () => {
  await db.insert(users).values({ id: MANAGER.id, email: MANAGER.email, password: "x", name: MANAGER.name, role: MANAGER.role }).onConflictDoNothing();
});

beforeEach(async () => {
  getCurrentUserMock.mockReset();
  getCurrentUserMock.mockResolvedValue(MANAGER);
  await cleanup();
  const [s] = await db.insert(suppliers).values({ name: `${TAG} — Also portugal` }).returning();
  supplierId = s.id;
  // Motor MDTech (C.1): markup 20% sobre o custo + IVA 23% do produto.
  await db.insert(pricingRules).values({
    scope: "supplier", supplierId, method: "markup_on_cost", ratePercent: "20",
    roundingPolicy: "auto", notes: `${TAG} engine rule`, isActive: true,
  });
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await cleanup(); });

describe("C.3.4.3.1 — inferSupplierImportFormat (reabertura: formato do snapshot)", () => {
  const alsoPricelistMapping = {
    ProductID: "supplierSku", EuropeanArticleNumber: "ean", CategoryText1: "alsoCategoryPath",
    CategoryText2: "alsoCategoryPath", CategoryText3: "alsoCategoryPath", Description: "name",
    AvailableQuantity: "stock", NetPrice: "costPrice",
    ManufacturerPartNumber: "alsoManufacturerPartNumber", ManufacturerName: "alsoManufacturerName",
  };
  it("mapping ALSO pricelist (mesmo contendo ProductID+AvailableQuantity) → also_pricelist", () => {
    expect(inferSupplierImportFormat("also-pricelist-teste.txt", alsoPricelistMapping)).toBe("also_pricelist");
    // Um subconjunto do mapping também preserva a assinatura (chaves ⊆ fixas).
    expect(inferSupplierImportFormat("qualquer.txt", { ProductID: "supplierSku", NetPrice: "costPrice" })).toBe("also_pricelist");
  });

  it("mapping com headers de stock (ProductID + AvailableQuantity, outras livres) → also_stock", () => {
    expect(inferSupplierImportFormat("stock.txt", {
      ProductID: "supplierSku", AvailableQuantity: "stock", AvailabilityDate: "alsoAvailableNextDate",
    })).toBe("also_stock");
  });

  it("mapping genérico C.3.2 → csv (e XLSX pelo nome)", () => {
    expect(inferSupplierImportFormat("lista.csv", { skuFornecedor: "supplierSku", nome: "name", custo: "costPrice" })).toBe("csv");
    expect(inferSupplierImportFormat("lista.xlsx", {})).toBe("xlsx");
    // ProductID presente mas SEM AvailableQuantity e com chaves livres → genérico.
    expect(inferSupplierImportFormat("outro.csv", { ProductID: "supplierSku", "outra col": "name" })).toBe("csv");
  });
});

describe("C.3.4.3.1 — caminho real da UI (route POST do 'Pré-visualizar')", () => {
  it("ALSO pricelist + perfil C.3.2 guardado: parser ALSO inteiro, formato explícito, perfil não sequestra o parse", async () => {
    // Cenário de staging: o fornecedor tem um perfil genérico ("Perfil #1").
    await saveSupplierProfile(supplierId, GENERIC_PROFILE_MAPPING, ";", MANAGER.id);

    // A UI envia SEMPRE mapping:{} — é o caso real do botão.
    const { ok, status, body } = await postPreview({
      supplierId, fileName: ALSO_FILE_NAME, data: ALSO_FILE, mapping: {}, saveProfile: false,
    });
    expect({ ok, status, error: body?.error }, body?.message).toMatchObject({ ok: true, status: 200 });
    expect(body.status).toBe("preview"); // preview_only
// O contrato deve expor o formato efetivo — é o que permite à UI dizer
    // "Formato detetado: ALSO Pricelist" em vez de mostrar o mecanismo C.3.2.
    expect(body.format).toBe("also_pricelist");
    expect(body.delimiter).toBe("\t");
    expect(body.mapping["ProductID"]).toBe("supplierSku");
    expect(body.mapping["EuropeanArticleNumber"]).toBe("ean");
    expect(body.mapping["Description"]).toBe("name");
    expect(body.mapping["AvailableQuantity"]).toBe("stock");
    expect(body.mapping["NetPrice"]).toBe("costPrice");

    // 10 linhas, 0 erros, 10 novos (catálogo vazio) — NUNCA 10 erros.
    expect(body.summary.total).toBe(10);
    expect(body.summary.errors).toBe(0);
    expect(body.summary.newProducts).toBe(10);

    const first = body.lines[0];
    expect(first.supplierSku).toBe("1203387");
    expect(first.ean).toBe("4017858000003");
    expect(first.name).toBe("HP 3y PickupRtrn 324");
    expect(first.costPrice).toBe("189.99");
    expect(first.stock).toBe(120);
    expect(first.alsoManufacturerPartNumber).toBe("J2P32A");
    expect(first.alsoManufacturerName).toBe("HP");
    expect(first.alsoCategoryPath).toBe("Networking / Routers / Gaming Routers");

    // Preço de venda: autoridade do motor MDTech (189.99 × 1.20 × 1.23 → 280.90),
    // nunca o NetPrice do ficheiro.
    expect(first.computedPrice).toBe("280.90");
    expect(first.status).toBe("new_product");

    // O perfil genérico não é compatível com as colunas ALSO: é reportado
    // como inválido — mas o parse NÃO foi substituído pelo fallback genérico.
    expect(body.profileUsed).toBe("profile_invalid");

    // preview_only: nenhum produto criado, nenhum stock movement.
    const [created] = await db.select({ id: products.id }).from(products).where(sql`sku LIKE ${`${TAG}%`} OR name = 'HP 3y PickupRtrn 324'`).limit(1);
    expect(created).toBeUndefined();
    // preview_only: nenhum stock movement sobre produtos desta fixture (o
    // count GLOBAL inclui movimentos de outros testes da suite — fora de scope).
    const movRes = await db.execute(sql`SELECT count(*)::int AS n FROM stock_movements sm JOIN products p ON p.id = sm.product_id WHERE p.name = 'HP 3y PickupRtrn 324' OR p.sku LIKE ${`${TAG}%`}`);
    expect((movRes.rows[0] as any).n).toBe(0);
  });

  it("mesmo ficheiro, SEM perfil guardado: também é also_pricelist (no_profile)", async () => {
    const { ok, body } = await postPreview({
      supplierId, fileName: ALSO_FILE_NAME, data: ALSO_FILE, mapping: {}, saveProfile: false,
    });
    expect(ok).toBe(true);
    expect(body.format).toBe("also_pricelist");
    expect(body.profileUsed).toBe("no_profile");
    expect(body.summary.total).toBe(10);
    expect(body.summary.errors).toBe(0);
    expect(body.lines[0].supplierSku).toBe("1203387");
  });

  it("caixas de mapeamento C.3.2 marcadas NÃO obrigam o parser genérico num ficheiro ALSO", async () => {
    // O operador marca "SKU fornecedor/Nome/Custo/Stock" no cartão C.3.2 antes
    // de pré-visualizar (a UI envia {supplierSku:'supplierSku', name:'name', cost:'cost', stock:'stock'}).
    const { ok, body } = await postPreview({
      supplierId, fileName: ALSO_FILE_NAME, data: ALSO_FILE,
      mapping: { supplierSku: "supplierSku", name: "name", cost: "cost", stock: "stock" },
      saveProfile: false,
    });
    expect(ok).toBe(true);
    expect(body.format).toBe("also_pricelist");
    expect(body.summary.errors).toBe(0);
    expect(body.lines[0].supplierSku).toBe("1203387");
    expect(body.lines[0].name).toBe("HP 3y PickupRtrn 324");
    expect(body.lines[0].costPrice).toBe("189.99");
  });

  it("reabrir o preview persistido devolve o MESMO contrato de formato (UI única)", async () => {
    await saveSupplierProfile(supplierId, GENERIC_PROFILE_MAPPING, ";", MANAGER.id);
    const { ok, body } = await postPreview({
      supplierId, fileName: ALSO_FILE_NAME, data: ALSO_FILE, mapping: {}, saveProfile: false,
    });
    expect(ok).toBe(true);
    const importId: number = body.importId;

    const { GET: reopenGET } = await import("@/app/api/admin/supplier-import/[id]/preview/route");
    const realReq = new NextRequest(`http://localhost/api/admin/supplier-import/${importId}/preview`, {
      method: "GET", headers: { origin: "http://localhost" },
    });
    const res = await reopenGET(realReq as any, { params: Promise.resolve({ id: String(importId) }) });
    expect(res.ok).toBe(true);
    const reopened: any = await res.json();
    expect(reopened.reopened).toBe(true);
    expect(reopened.format).toBe("also_pricelist");
    expect(reopened.mapping["ProductID"]).toBe("supplierSku");
    expect(reopened.lines[0].supplierSku).toBe("1203387");
  });

  it("regressão C.3.2: CSV genérico com perfil compatível continua profile_valid (formato csv)", async () => {
    await saveSupplierProfile(supplierId, GENERIC_PROFILE_MAPPING, ";", MANAGER.id);
    const csv = "skuFornecedor;nome;custo;stock;ean\nREAL-1;Produto Real;10,00;5;5901234123457";
    const { ok, body } = await postPreview({
      supplierId, fileName: "lista-real.csv", data: csv, mapping: {}, saveProfile: false,
    });
    expect(ok).toBe(true);
    expect(body.format).toBe("csv");
    expect(body.profileUsed).toBe("profile_valid");
    expect(body.summary.total).toBe(1);
    expect(body.summary.errors).toBe(0);
    expect(body.lines[0].supplierSku).toBe("REAL-1");
  });
});
