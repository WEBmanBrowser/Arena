/**
 * C.3.4.3.1 (fix pós-PR #36) — o formato REAL do pricelist ALSO: CAMPOS ENTRE
 * ASPAS duplas, separados por TAB, sem header.
 *
 * O Branch Preview do PR #36 falhou no teste funcional real: o ficheiro
 * also-pricelist-teste.txt exportado pelo ALSO envolve TODOS os campos em
 * aspas duplas (`"1203837"\t"4017858000003"\t...`). O fixture da PR #35/#36
 * era TSV SEM aspas — por isso todos os testes automatizados passaram e o
 * parser real falhou linha a linha:
 *
 *  - parseAlsoPricelist não remove as aspas → o EAN passa com 15 caracteres
 *    (aspas incluídas) no limite de comprimento e falha no checksum
 *    (INVALID_GTIN); stock/custo falham no token numérico (INVALID_STOCK /
 *    INVALID_COST); o supplierSku fica gravado com aspas;
 *  - looksLikeAlsoPricelist rejeita células entre aspas → um pricelist ALSO
 *    real com NOME GENÉRICO (camada 2, assinatura do conteúdo) caía no
 *    parser genérico em vez do parser ALSO.
 *
 * Estes testes reproduzem o formato LITERALMENTE (aspas, TAB, CRLF, BOM,
 * 12 colunas, valores vazios entre aspas, vírgula na descrição) e invocam a
 * MESMA route do botão "Pré-visualizar" com o MESMO cenário de staging
 * (fornecedor com perfil C.3.2 guardado + mapping:{}). Contrato esperado —
 * exatamente os campos que a UI usa para decidir o que mostrar:
 *  - format === "also_pricelist" (badge "Formato detetado: ALSO Pricelist"
 *    visível; cartão C.3.2 e banner de perfil ocultos — vejam-se as
 *    asserções estáticas de UI no final);
 *  - 10 linhas válidas (0 erros) com valores LIMPOS (sem aspas);
 *  - preço apenas do motor MDTech; preview_only (nada de catálogo tocado).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { db } from "@/db";
import { suppliers, supplierImports, supplierImportRows, users, pricingRules, products } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";

const getCurrentUserMock = vi.fn();
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getCurrentUser: () => getCurrentUserMock() };
});

import { NextRequest } from "next/server";
import { POST as supplierImportPOST } from "@/app/api/admin/supplier-import/route";
import { saveSupplierProfile } from "@/lib/services/supplier-import-service";
import { parseAlsoPricelist, looksLikeAlsoPricelist } from "@/lib/supplier-import/also";
import { uploadSource } from "@/lib/supplier-import/source";

const TAG = "C343QRT";
const MANAGER = { id: 9751, email: `${TAG}@test.local`, password: "x", name: "Quoted Real", role: "manager" as const };

// ─── Fixture LITERAL do pricelist ALSO real ────────────────────────────────
// Campos entre aspas duplas, separador TAB, sem header, CRLF, 12 colunas
// (as 11+ são ignoradas pelo parser). A linha 1 tem vírgula dentro da
// descrição (entre aspas) — prova de que a vírgula nunca é separador aqui.
// A linha 4 tem o sentinel -1 entre aspas (stock desconhecido = warning, não
// erro); a linha 10 tem marca vazia entre aspas ("" → null, sem erro).
const QUOTED_ROWS: string[][] = [
  ["1203387", "4017858000003", "Networking", "Routers", "Gaming Routers", "HP 3y PickupRtrn Commercial, Gaming 324", "120", "189.99", "J2P32A", "HP", "extra", "x"],
  ["1204001", "4008321741189", "PCs", "Desktops", "All-in-One", "HP All-in-One 27 27-aa0005", "45", "349.00", "51A22EA", "HP", "extra", "x"],
  ["1204555", "4895903520108", "Audio", "Headsets", "Gaming", "HyperX Cloud II Wired Headset", "8", "129.95", "HMBS260", "HyperX", "extra", "x"],
  ["1205000", "4711234567899", "Storage", "SSDs", "M.2 NVMe", "Samsung 980 Pro 2TB", "-1", "179.90", "MZ-V8P2T0B", "Samsung", "extra", "x"],
  ["1205123", "4043677000122", "Monitors", "27 inch", "QHD", "LG UltraGear 27GP850", "33", "289.00", "27GP850-B", "LG", "extra", "x"],
  ["1206001", "4260101234568", "Keyboards", "Mechanical", "RGB", "Logitech G Pro X TKL", "17", "199.99", "910-006024", "Logitech", "extra", "x"],
  ["1206100", "4017858999994", "Networking", "Switches", "Gigabit", "HP 8-Port Gigabit Ethernet Switch", "55", "59.90", "J6V89A", "HP", "extra", "x"],
  ["1207000", "4710654891713", "Laptops", "15 inch", "Core i5", "Lenovo IdeaPad 3 15", "12", "429.00", "82M200QSPB", "Lenovo", "extra", "x"],
  ["1208000", "4017858111112", "Accessories", "Mouse", "Gaming", "Razer DeathAdder V2", "200", "69.99", "RZ03-03210100", "Razer", "extra", "x"],
  ["1209000", "4895903111221", "Chargers", "USB-C", "65W", "Anker 65W GaN Charger", "75", "45.00", "A2665", "", "extra", "x"],
];
const q = (v: string) => `"${v.replace(/"/g, '""')}"`;
const QUOTED_FILE = QUOTED_ROWS.map((r) => r.map(q).join("\t")).join("\r\n") + "\r\n";
const QUOTED_FILE_BOM = "\uFEFF" + QUOTED_FILE;
const ALSO_FILE_NAME = "also-pricelist-teste.txt";

// Contraponto SEM aspas (fixture anterior) — tem de continuar a funcionar.
const UNQUOTED_FILE = QUOTED_ROWS.map((r) => r.join("\t")).join("\r\n") + "\r\n";

// Perfil C.3.2 genérico "guardado" do fornecedor (o "Perfil #1" de staging).
const GENERIC_PROFILE_MAPPING = { skuFornecedor: "supplierSku", nome: "name", custo: "costPrice", stock: "stock" };

let supplierId = 0;

async function cleanup() {
  await db.execute(sql`DELETE FROM supplier_import_rows WHERE import_id IN (SELECT id FROM supplier_imports WHERE user_id = ${MANAGER.id})`);
  await db.execute(sql`DELETE FROM supplier_imports WHERE user_id = ${MANAGER.id}`);
  await db.execute(sql`DELETE FROM pricing_rules WHERE notes LIKE ${`${TAG}%`}`);
  await db.execute(sql`DELETE FROM supplier_import_profiles WHERE supplier_id IN (SELECT id FROM suppliers WHERE name LIKE ${`${TAG}%`})`);
  await db.execute(sql`DELETE FROM suppliers WHERE name LIKE ${`${TAG}%`}`);
  await db.execute(sql`DELETE FROM products WHERE sku LIKE ${`${TAG}%`} OR name = 'HP 3y PickupRtrn Commercial, Gaming 324'`);
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
  // Motor MDTech (C.1) — MESMA regra do cenário real: markup 20% + IVA 23%.
  await db.insert(pricingRules).values({
    scope: "supplier", supplierId, method: "markup_on_cost", ratePercent: "20",
    roundingPolicy: "auto", notes: `${TAG} engine rule`, isActive: true,
  });
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await cleanup(); });

describe("C.3.4.3.1 — parser ALSO pricelist com campos entre aspas (formato real)", () => {
  it("remove as aspas e devolve 10 linhas limpas (0 erros), preservando MPN/marca/categoria", () => {
    const parsed = parseAlsoPricelist(QUOTED_FILE);
    expect(parsed.rows).toHaveLength(10);
    for (const row of parsed.rows) {
      const errs = row.issues.filter((i) => i.severity === "error");
      expect(errs.map((e) => e.code), `linha ${row.rowNumber}: ${JSON.stringify(errs)}`).toEqual([]);
    }
    const first = parsed.rows[0];
    expect(first.supplierSku).toBe("1203387"); // sem aspas
    expect(first.ean).toBe("4017858000003"); // 13 dígitos, checksum válido
    expect(first.name).toBe("HP 3y PickupRtrn Commercial, Gaming 324"); // vírgula preservada
    expect(first.stock).toBe(120);
    expect(first.costPrice).toBe("189.99");
    expect(first.alsoManufacturerPartNumber).toBe("J2P32A");
    expect(first.alsoManufacturerName).toBe("HP");
    expect(first.alsoCategoryPath).toBe("Networking / Routers / Gaming Routers");

    // Sentinel -1 entre aspas: stock null + WARNING (não é erro).
    const line4 = parsed.rows[3];
    expect(line4.stock).toBeNull();
    expect(line4.issues.some((i) => i.code === "AVAILABLE_NEXT_QUANTITY_UNKNOWN" && i.severity === "warning")).toBe(true);
    // Marca vazia entre aspas (""): null, sem erro.
    expect(parsed.rows[9].alsoManufacturerName).toBeNull();
  });

  it("BOM UTF-8 no início do ficheiro: mesmo resultado", () => {
    const parsed = parseAlsoPricelist(QUOTED_FILE_BOM);
    expect(parsed.rows[0].supplierSku).toBe("1203387");
    expect(parsed.rows[0].ean).toBe("4017858000003");
    expect(parsed.rows.every((r) => !r.issues.some((i) => i.severity === "error"))).toBe(true);
  });

  it("regressão: TSV sem aspas (fixture anterior) continua a funcionar", () => {
    const parsed = parseAlsoPricelist(UNQUOTED_FILE);
    expect(parsed.rows).toHaveLength(10);
    expect(parsed.rows[0].supplierSku).toBe("1203387");
    expect(parsed.rows.every((r) => !r.issues.some((i) => i.severity === "error"))).toBe(true);
  });
});

describe("C.3.4.3.1 — assinatura estrutural (camada 2) com campos entre aspas", () => {
  it("pricelist real entre aspas (nome genérico) → looksLikeAlsoPricelist true", () => {
    expect(looksLikeAlsoPricelist(QUOTED_FILE, { minDataLines: 2 })).toBe(true);
    expect(looksLikeAlsoPricelist(QUOTED_FILE_BOM, { minDataLines: 2 })).toBe(true);
  });

  it("TXT/CSV arbitrários NUNCA batem na assinatura (mesmo com aspas)", () => {
    // CSV genérico com aspas e vírgulas (header + 1 linha).
    expect(looksLikeAlsoPricelist('skuFornecedor;"nome";custo;stock\n"REF-1";"Cabo, HDMI";"10,00";5', { minDataLines: 1 })).toBe(false);
    // Comma-CSV entre aspas.
    expect(looksLikeAlsoPricelist('"a","b","c","d","e","f","g","h","i","j"\n"1","2","3","4","5","6","7","8","9","10"', { minDataLines: 2 })).toBe(false);
    // Texto plano (sem tabs).
    expect(looksLikeAlsoPricelist("linha um\nlinha dois\nlinha três", { minDataLines: 2 })).toBe(false);
    // TSV com 9 colunas (abaixo do mínimo de 10).
    expect(looksLikeAlsoPricelist('"1"\t"2"\t"3"\t"4"\t"5"\t"6"\t"7"\t"8"\t"9"\n"1"\t"2"\t"3"\t"4"\t"5"\t"6"\t"7"\t"8"\t"9"', { minDataLines: 2 })).toBe(false);
    // TSV com 10 colunas mas col0 sem dígitos (não é ProductID).
    expect(looksLikeAlsoPricelist('"Produto"\t"2"\t"3"\t"4"\t"5"\t"desc"\t"6"\t"7"\t"8"\t"9"\n"Outro"\t"2"\t"3"\t"4"\t"5"\t"desc"\t"6"\t"7"\t"8"\t"9"', { minDataLines: 2 })).toBe(false);
  });
});

describe("C.3.4.3.1 — uploadSource (rota do upload): formato por nome + conteúdo", () => {
  it("NOME CANÓNICO (pricelist no .txt) + conteúdo entre aspas → also_pricelist (camada 1)", () => {
    const source = uploadSource({ fileName: ALSO_FILE_NAME, csvText: QUOTED_FILE });
    expect(source.format).toBe("also_pricelist");
  });

  it("NOME GENÉRICO + conteúdo entre aspas → also_pricelist (camada 2, assinatura do conteúdo)", () => {
    const source = uploadSource({ fileName: "exporto-also-2026-01-15.txt", csvText: QUOTED_FILE });
    expect(source.format).toBe("also_pricelist");
  });

  it("NOME GENÉRICO + conteúdo sem aspas → also_pricelist (regressão da camada 2)", () => {
    const source = uploadSource({ fileName: "exporto-also-2026-01-15.txt", csvText: UNQUOTED_FILE });
    expect(source.format).toBe("also_pricelist");
  });

  it("NOME GENÉRICO + CSV genérico entre aspas → csv (sem falso positivo)", () => {
    const source = uploadSource({
      fileName: "lista-fornecedor.csv",
      csvText: 'skuFornecedor;"nome";custo;stock\n"REF-1";"Cabo, HDMI";"10,00";5',
    });
    expect(source.format).toBe("csv");
  });
});

describe("C.3.4.3.1 — caminho REAL da UI (route POST do 'Pré-visualizar') com o ficheiro real entre aspas", () => {
  it("perfil C.3.2 guardado + mapping:{} → parser ALSO limpo, formato explícito, perfil reportado inválido", async () => {
    await saveSupplierProfile(supplierId, GENERIC_PROFILE_MAPPING, ";", MANAGER.id);

    const { ok, status, body } = await postPreview({
      supplierId, fileName: ALSO_FILE_NAME, data: QUOTED_FILE, mapping: {}, saveProfile: false,
    });
    expect({ ok, status, error: body?.error }, body?.message).toMatchObject({ ok: true, status: 200 });
    expect(body.status).toBe("preview"); // preview_only

    // O campo que a UI lê para decidir o que mostrar (setPreview(body)).
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
    expect(first.name).toBe("HP 3y PickupRtrn Commercial, Gaming 324");
    expect(first.costPrice).toBe("189.99");
    expect(first.stock).toBe(120);
    expect(first.alsoManufacturerPartNumber).toBe("J2P32A");
    expect(first.alsoManufacturerName).toBe("HP");
    expect(first.alsoCategoryPath).toBe("Networking / Routers / Gaming Routers");
    // Preço de venda: autoridade do motor MDTech (mesma regra do cenário real),
    // nunca o NetPrice do ficheiro.
    expect(first.computedPrice).toBe("280.90");
    expect(first.status).toBe("new_product");

    // O perfil genérico C.3.2 não é compatível com as colunas ALSO: é
    // reportado como inválido (é o que alimentava o banner "perfil inválido
    // — usou fallback") — mas o parse NÃO foi substituído pelo fallback genérico.
    expect(body.profileUsed).toBe("profile_invalid");
    expect(body.profileName).toMatch(/^Perfil #\d+$/);

    // preview_only: nenhum produto criado, nenhum stock movement.
    const [created] = await db.select({ id: products.id }).from(products).where(sql`sku LIKE ${`${TAG}%`} OR name = 'HP 3y PickupRtrn Commercial, Gaming 324'`).limit(1);
    expect(created).toBeUndefined();
    const movRes = await db.execute(sql`SELECT count(*)::int AS n FROM stock_movements sm JOIN products p ON p.id = sm.product_id WHERE p.name = 'HP 3y PickupRtrn Commercial, Gaming 324' OR p.sku LIKE ${`${TAG}%`}`);
    expect((movRes.rows[0] as any).n).toBe(0);
  });

  it("reabrir o preview persistido devolve o MESMO formato (UI única de reabertura)", async () => {
    await saveSupplierProfile(supplierId, GENERIC_PROFILE_MAPPING, ";", MANAGER.id);
    const { ok, body } = await postPreview({
      supplierId, fileName: ALSO_FILE_NAME, data: QUOTED_FILE, mapping: {}, saveProfile: false,
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
    expect(reopened.lines[0].supplierSku).toBe("1203387");
    expect(reopened.lines[0].ean).toBe("4017858000003");
  });
});

describe("C.3.4.3.1 — contrato UI: o campo assertido na route É o que a UI decide", () => {
  // Técnica de asserção estática de fonte (mesma de admin-import-ui.test.ts):
  // o projeto não tem harness browser/jsdom — a guarda é que o código que o
  // browser executa liga o campo `format` da resposta ao que é mostrado.
  const root = path.resolve(__dirname, "..", "..");
  const panel = fs.readFileSync(path.join(root, "src", "components", "admin", "SupplierImportPanel.tsx"), "utf8");

  it("a UI lê o `format` da resposta do preview (setPreview(body))", () => {
    expect(panel).toContain("setPreview(body as PreviewResult)");
    expect(panel).toContain('preview?.format === "also_pricelist"');
  });

  it("o cartão C.3.2 e o banner de perfil ficam OCULTOS num preview ALSO", () => {
    // O cartão de mapeamento manual só renderiza quando !isAlsoFormat.
    const cardIdx = panel.indexOf("C.3.2 — Mapeamento manual e perfil");
    expect(cardIdx).toBeGreaterThan(-1);
    expect(panel.slice(0, cardIdx).split("!isAlsoFormat &&").length - 1).toBeGreaterThan(0);
    // O banner de perfil exige explicitamente !isAlsoFormat.
    const bannerIdx = panel.indexOf("C.3.2 — Perfil utilizado:");
    expect(bannerIdx).toBeGreaterThan(-1);
    expect(panel).toMatch(/preview && preview\.profileUsed && !isAlsoFormat &&/);
  });

  it("o badge 'Formato detetado: ALSO Pricelist' mostra quando format === also_pricelist", () => {
    expect(panel).toContain("Formato detetado: ALSO Pricelist");
    expect(panel).toMatch(/preview\.format === "also_pricelist" && \(\s*<span[^>]*>[\s\S]*?Formato detetado: ALSO Pricelist/);
  });
});
