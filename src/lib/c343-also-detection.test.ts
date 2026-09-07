/**
 * C.3.4.3.1 — Deteção estrutural do ALSO pricelist no upload manual (fix de staging)
 *
 * BUG (staging): o upload manual de um pricelist ALSO real (TSV sem header)
 * caía no parser genérico CSV/TXT porque a decisão de formato era feita só
 * pelo NOME do ficheiro. Sem o conteúdo a confirmar, qualquer nome sem a
 * palavra "pricelist" ia para o parser genérico — que não importa este
 * formato (campos concatenados, erros INVALID_GTIN/INVALID_STOCK/INVALID_COST
 * ou CSV_MISSING_KEY_COLUMN no preview).
 *
 * FIX (duas camadas em uploadSource):
 *  1. Nome canónico ALSO ("pricelist*" / "stock*" num .txt): contrato
 *     C.3.4.3.1, inalterado — o nome decide e o parser valida a estrutura
 *     linha a linha;
 *  2. Nome genérico: a decisão passa a ser pela ASSINATURA ESTRUTURAL do
 *     conteúdo (looksLikeAlsoPricelist em ./also — TSV, ≥ 10 colunas,
 *     ProductID plausível, EAN, descrição textual, stock/preço numéricos,
 *     estrutura compatível em várias linhas). É isto que apanha o bug de
 *     staging: um pricelist ALSO real com nome genérico deixava de ser
 *     importado. Um TXT arbitrário nunca bate na assinatura e mantém o
 *     caminho genérico — e o parser genérico CSV/TXT/XLSX e os perfis C.3.2
 *     ficam inalterados (regressão travada abaixo).
 *
 * Estes testes são puros (sem BD): travam a decisão de formato e o contrato
 * SupplierFileParse que alimenta o preview.
 */
import { describe, expect, it } from "vitest";
import { parseSupplierCsv } from "@/lib/supplier-import/normalize";
import { classifySupplierFileName, parseSupplierFile } from "@/lib/supplier-import/file";
import {
  ALSO_PRICELIST_MIN_COLUMNS,
  looksLikeAlsoPricelist,
  looksLikeAlsoStock,
} from "@/lib/supplier-import/also";
import { sourceFormat, uploadSource } from "@/lib/supplier-import/source";

// ─── Fixture de staging: pricelist ALSO real, TSV sem header, 10 linhas ───
// Cols: 0 ProductID, 1 EAN, 2-4 CategoryText, 5 Description, 6 AvailableQuantity,
//       7 NetPrice, 8 ManufacturerPartNumber, 9 ManufacturerName.
// EANs com checksum válido (o parser valida o GTIN por linha).
const STAGING_ROWS: string[][] = [
  ["1203387", "4017858000003", "Networking", "Routers", "Gaming Routers", "HP 3y PickupRtrn 324", "120", "189.99", "J2P32A", "HP"],
  ["1204001", "4008321741189", "PCs", "Desktops", "All-in-One", "HP All-in-One 27 27-aa0005", "45", "349.00", "51A22EA", "HP"],
  ["1204555", "4895903520108", "Audio", "Headsets", "Gaming", "HyperX Cloud II Wired Headset", "8", "129.95", "HMBS260", "HyperX"],
  ["1205000", "4711234567899", "Storage", "SSDs", "M.2 NVMe", "Samsung 980 Pro 2TB", "-1", "179.90", "MZ-V8P2T0B", "Samsung"],
  ["1205123", "4043677000122", "Monitors", "27 inch", "QHD", "LG UltraGear 27GP850", "33", "289.00", "27GP850-B", "LG"],
  ["1206001", "4260101234568", "Keyboards", "Mechanical", "RGB", "Logitech G Pro X TKL", "17", "199.99", "910-006024", "Logitech"],
  ["1206100", "4017858999994", "Networking", "Switches", "Gigabit", "HP 8-Port Gigabit Ethernet Switch", "55", "59.90", "J6V89A", "HP"],
  ["1207000", "4710654891713", "Laptops", "15 inch", "Core i5", "Lenovo IdeaPad 3 15", "12", "429.00", "82M200QSPB", "Lenovo"],
  ["1208000", "4017858111112", "Accessories", "Mouse", "Gaming", "Razer DeathAdder V2", "200", "69.99", "RZ03-03210100", "Razer"],
  ["1209000", "4895903111221", "Chargers", "USB-C", "65W", "Anker 65W GaN Charger", "75", "45.00", "A2665", "Anker"],
];
const STAGING_FILE = STAGING_ROWS.map((r) => r.join("\t")).join("\r\n") + "\r\n";

/** Linha de pricelist com 10 colunas e overrides opcionais. */
function pricelistLine(overrides: Partial<Record<string, string>> = {}): string {
  const cols = [
    overrides.ProductID ?? "PID123",
    overrides.EuropeanArticleNumber ?? "5901234123457",
    overrides.CategoryText1 ?? "Cat1",
    overrides.CategoryText2 ?? "Cat2",
    overrides.CategoryText3 ?? "Cat3",
    overrides.Description ?? "Produto Teste",
    overrides.AvailableQuantity ?? "5",
    overrides.NetPrice ?? "12,50",
    overrides.ManufacturerPartNumber ?? "MPN-001",
    overrides.ManufacturerName ?? "BrandX",
  ];
  return cols.join("\t");
}

describe("C.3.4.3.1 — staging: linha real ALSO sem header", () => {
  it("ANTES: sem deteção por conteúdo, o nome era o único sinal e o parser genérico não importa o ficheiro", () => {
    // O classificador por nome manda estes nomes (sem "pricelist"/"stock") para o ramo genérico:
    for (const name of ["also-export.txt", "download.txt", "supplier-list.csv"]) {
      expect(classifySupplierFileName(name)).toBe("csv");
    }
    // ...e o parser genérico (para onde o ficheiro ia antes do fix) falha no
    // ficheiro de staging: header fantasma = linha 1 inteira, sem coluna de chave.
    expect(() => parseSupplierCsv(STAGING_FILE)).toThrowError(/CSV_MISSING_KEY_COLUMN/);
  });

  it("DEPOIS: o conteúdo decide — também com nome genérico, é also_pricelist", () => {
    // O nome exato do staging + nomes genéricos (incl. o default da textarea sem ficheiro):
    for (const fileName of ["also-pricelist-teste.txt", "also-export.txt", "download.txt", "supplier-list.csv", ""]) {
      const payload = uploadSource({ fileName, csvText: STAGING_FILE });
      expect(payload.format, fileName || "(vazio)").toBe("also_pricelist");
      expect(sourceFormat(payload)).toBe("also_pricelist");
    }
  });

  it("preview (SupplierFileParse) mostra supplierSku, nome, custo e stock corretos — parser ALSO reutilizado, sem segundo parser", () => {
    const payload = uploadSource({ fileName: "also-pricelist-teste.txt", csvText: STAGING_FILE });
    const parsed = parseSupplierFile(payload.text ?? "", undefined, sourceFormat(payload));

    // Sem fallback C.3.2: o mapping é o do próprio formato ALSO (posicional).
    expect(parsed.mapping["ProductID"]).toBe("supplierSku");
    expect(parsed.mapping["EuropeanArticleNumber"]).toBe("ean");
    expect(parsed.mapping["Description"]).toBe("name");
    expect(parsed.mapping["AvailableQuantity"]).toBe("stock");
    expect(parsed.mapping["NetPrice"]).toBe("costPrice");
    expect(parsed.delimiter).toBe("\t");
    expect(parsed.headers).toHaveLength(10);

    expect(parsed.rows).toHaveLength(10);
    const first = parsed.rows[0];
    expect(first.supplierSku).toBe("1203387");
    expect(first.ean).toBe("4017858000003");
    expect(first.name).toBe("HP 3y PickupRtrn 324");
    expect(first.stock).toBe(120);
    expect(first.costPrice).toBe("189.99");
    expect(first.internalSku).toBeNull(); // ProductID nunca vira SKU interno
    expect(first.issues.filter((i) => i.severity === "error")).toHaveLength(0);
    // Metadados ALSO preservados (MPN/marca/categoria)
    expect(first.alsoManufacturerPartNumber).toBe("J2P32A");
    expect(first.alsoManufacturerName).toBe("HP");
    expect(first.alsoCategoryPath).toBe("Networking / Routers / Gaming Routers");

    // Sentinela -1 na linha 4: stock nulo com warning, custo íntegro — a linha
    // continua utilizável (o parser aplica as regras estritas, linha a linha).
    const fourth = parsed.rows[3];
    expect(fourth.supplierSku).toBe("1205000");
    expect(fourth.stock).toBeNull();
    expect(fourth.issues.some((i) => i.code === "AVAILABLE_NEXT_QUANTITY_UNKNOWN")).toBe(true);
    expect(fourth.costPrice).toBe("179.90");
    expect(fourth.issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });
});

describe("C.3.4.3.1 — regra de deteção estrutural (looksLikeAlsoPricelist)", () => {
  it("aceita o formato real: CRLF, BOM, 11+ colunas, -1, células vazias", () => {
    expect(looksLikeAlsoPricelist(STAGING_FILE)).toBe(true);
    expect(looksLikeAlsoPricelist("\uFEFF" + STAGING_FILE)).toBe(true);
    const lf = STAGING_ROWS.map((r) => r.join("\t")).join("\n");
    expect(looksLikeAlsoPricelist(lf)).toBe(true);
    const withExtras = STAGING_ROWS.map((r) => [...r, "extra11", "extra12"].join("\t")).join("\n");
    expect(looksLikeAlsoPricelist(withExtras)).toBe(true);
    const emptyCells = [pricelistLine({ AvailableQuantity: "", NetPrice: "" }), pricelistLine({ ProductID: "PID9", AvailableQuantity: "-1" })].join("\n");
    expect(looksLikeAlsoPricelist(emptyCells)).toBe(true);
  });

  it("exige a estrutura TSV em TODAS as linhas (mínimo de colunas, vários dados)", () => {
    expect(ALSO_PRICELIST_MIN_COLUMNS).toBe(10);
    // Menos de 10 colunas (TSV genérico de 5 colunas)
    expect(looksLikeAlsoPricelist("sku\tname\tcost\tstock\ta\nX1\tProd\t10\t2\tb")).toBe(false);
    // Uma linha só, sem nome a confirmar (a consistência exige várias linhas)
    expect(looksLikeAlsoPricelist(pricelistLine())).toBe(false);
    expect(looksLikeAlsoPricelist(pricelistLine(), { minDataLines: 1 })).toBe(true);
    // Linhas vazias intercaladas são ignoradas, como no parser
    expect(looksLikeAlsoPricelist(pricelistLine() + "\n\n  \n" + pricelistLine({ ProductID: "PID2" }))).toBe(true);
    // Vazio
    expect(looksLikeAlsoPricelist("")).toBe(false);
    expect(looksLikeAlsoPricelist("   \n  \n")).toBe(false);
  });

  it("rejeita CSV/separator genérico (o TSV é parte da assinatura)", () => {
    expect(looksLikeAlsoPricelist("skuFornecedor;nome;custo;stock\nREF-1;Produto;10,00;5")).toBe(false);
    expect(looksLikeAlsoPricelist("skuFornecedor,nome,custo,stock\nREF-1,Produto,10.00,5")).toBe(false);
    expect(looksLikeAlsoPricelist("Ref  Produto  Custo  Stock\nA1  Cabo  10  5\nA2  Fita  8  3")).toBe(false);
  });

  it("rejeita header e colunas inconsistentes com a assinatura", () => {
    // Linha de header (ProductID sem dígitos na coluna 0 + palavras nas numéricas)
    const header = ["ProductID", "EuropeanArticleNumber", "CategoryText1", "CategoryText2", "CategoryText3", "Description", "AvailableQuantity", "NetPrice", "ManufacturerPartNumber", "ManufacturerName"].join("\t");
    expect(looksLikeAlsoPricelist(header + "\n" + pricelistLine())).toBe(false);
    // ProductID sem dígitos (tokens puramente textuais)
    expect(looksLikeAlsoPricelist([pricelistLine({ ProductID: "ABC" }), pricelistLine({ ProductID: "DEF" })].join("\n"))).toBe(false);
    // ProductID com espaços (não é um token)
    expect(looksLikeAlsoPricelist([pricelistLine({ ProductID: "A 1" }), pricelistLine({ ProductID: "B 2" })].join("\n"))).toBe(false);
    // EAN com texto na coluna 1
    expect(looksLikeAlsoPricelist([pricelistLine({ EuropeanArticleNumber: "sem ean" }), pricelistLine({ ProductID: "P2", EuropeanArticleNumber: "nenhum" })].join("\n"))).toBe(false);
    // Descrição sem letras na coluna 5
    expect(looksLikeAlsoPricelist([pricelistLine({ Description: "12345" }), pricelistLine({ ProductID: "P2", Description: "67890" })].join("\n"))).toBe(false);
    // Stock com texto livre na coluna 6
    expect(looksLikeAlsoPricelist([pricelistLine({ AvailableQuantity: "em stock" }), pricelistLine({ ProductID: "P2", AvailableQuantity: "N/A" })].join("\n"))).toBe(false);
    // Preço com texto livre na coluna 7
    expect(looksLikeAlsoPricelist([pricelistLine({ NetPrice: "sob consulta" }), pricelistLine({ ProductID: "P2", NetPrice: "s/n" })].join("\n"))).toBe(false);
  });

  it("aceita números com separadores pt/en (o parser decide a interpretação por linha)", () => {
    const mixed = [
      pricelistLine({ AvailableQuantity: "12.0", NetPrice: "1.234,56" }),
      pricelistLine({ ProductID: "P2", AvailableQuantity: "8", NetPrice: "99,99" }),
    ].join("\n");
    expect(looksLikeAlsoPricelist(mixed)).toBe(true);
  });
});

describe("C.3.4.3.1 — NUNCA classificar um TXT arbitrário como ALSO", () => {
  it("CSV normal (C.3.1/C.3.2) continua no caminho genérico", () => {
    const csv = "skuFornecedor;nome;custo;stock;ean\nFORN-1;Produto A;10,00;5;5901234123457\nFORN-2;Produto B;8,00;2;";
    for (const fileName of ["lista.csv", "lista.TXT", "export-also.csv", ""]) {
      const payload = uploadSource({ fileName, csvText: csv });
      expect(payload.format).toBe("csv");
      expect(sourceFormat(payload)).toBe("csv");
    }
    // E o parser genérico continua a tratá-lo como antes (mapping intacto)
    const parsed = parseSupplierCsv(csv);
    expect(parsed.mapping["skuFornecedor"]).toBe("supplierSku");
    expect(parsed.rows).toHaveLength(2);
  });

  it("TXT genérico (sem tabs / TSV curto / texto livre) continua no caminho genérico", () => {
    const genericTxt = "Ref  Produto  Custo\nA1  Cabo HDMI  10,00\nA2  Fita  8,00";
    const shortTsv = "sku\tnome\tcusto\tstock\nX1\tProd\t10\t2\nX2\tOutro\t5\t9";
    // 10 colunas COM header, mas cabeçalhos genéricos (nem ProductID+AvailableQuantity,
    // nem a estrutura posicional): header rejeita a assinatura do pricelist
    const tenColHeaderTsv = [
      "ID\tCode\tC1\tC2\tC3\tNome\tQtd\tPreco\tRef\tMarca",
      "777\t1234567890128\tA\tB\tC\tCoisa\t5\t10\tM\tB",
      "778\t1234567890129\tA\tB\tC\tCoisa\t5\t10\tM\tB",
    ].join("\n");
    for (const [fileName, text] of [
      ["notas.txt", genericTxt],
      ["export.txt", shortTsv],
      ["big-export.txt", tenColHeaderTsv],
      ["qualquer.txt", "texto livre\nsem estrutura\nalguma"],
    ] as const) {
      const payload = uploadSource({ fileName, csvText: text });
      expect(payload.format, fileName).toBe("csv");
      expect(looksLikeAlsoPricelist(text)).toBe(false);
    }
  });

  it("TSV com header ProductID+AvailableQuantity é o formato STOCK (header-driven) — rota correta, nunca pricelist", () => {
    const stockLikeHeader = [
      "ProductID\tEuropeanArticleNumber\tCat1\tCat2\tCat3\tDescription\tAvailableQuantity\tNetPrice\tMPN\tBrand",
      "777\t1234567890128\tA\tB\tC\tCoisa\t5\t10\tM\tB",
      "778\t1234567890129\tA\tB\tC\tCoisa\t5\t10\tM\tB",
    ].join("\n");
    expect(looksLikeAlsoStock(stockLikeHeader)).toBe(true);
    expect(looksLikeAlsoPricelist(stockLikeHeader)).toBe(false);
    const payload = uploadSource({ fileName: "big-export.txt", csvText: stockLikeHeader });
    expect(payload.format).toBe("also_stock");
  });

  it("XLSX e unsupported mantêm o comportamento (bytes/extensão)", () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
    const xlsx = uploadSource({ fileName: "lista.xlsx", xlsxBytes: zip });
    expect(xlsx.format).toBe("xlsx");
    expect(sourceFormat({ kind: "url", label: "u", format: "auto", bytes: zip })).toBe("xlsx");
    // XLSX com bytes nunca é detetado como pricelist (o ramo binário ganha)
    expect(uploadSource({ fileName: "pricelist-1.xlsx", xlsxBytes: zip }).format).toBe("xlsx");
  });
});

describe("C.3.4.3.1 — nome canónico decide (contrato C.3.4.3.1); nome genérico → conteúdo", () => {
  it("nome canónico 'pricelist*.txt' decide (1 linha chega; o parser valida a estrutura)", () => {
    // O contrato C.3.4.3.1 (em produção) manda o nome canónico para o parser
    // ALSO mesmo com 1 linha ou estrutura imperfeita (ex.: ProductID "PID"):
    const payload = uploadSource({ fileName: "pricelist-1.txt", csvText: pricelistLine() });
    expect(payload.format).toBe("also_pricelist");
    const imperfect = uploadSource({ fileName: "pricelist-1.txt", csvText: "PID\t5901234123457\tC1\tC2\tC3\tDesc\t5\t10,00\tMPN\tBrand" });
    expect(imperfect.format).toBe("also_pricelist");
    // E o mesmo conteúdo com nome genérico é apanhado pela assinatura (≥ 2 linhas):
    expect(uploadSource({ fileName: "export.txt", csvText: pricelistLine() }).format).toBe("csv");
    expect(uploadSource({ fileName: "export.txt", csvText: [pricelistLine(), pricelistLine({ ProductID: "PID2" })].join("\n") }).format).toBe("also_pricelist");
  });

  it("nome canónico 'stock*.txt' decide (parser também valida o header)", () => {
    const stockTxt = "ProductID\tAvailableQuantity\tAvailabilityDate\tAvailabilityTime\nPID1\t5\t2026-09-01\t10:00";
    expect(uploadSource({ fileName: "stock.txt", csvText: stockTxt }).format).toBe("also_stock");
    // Sem o nome canónico, o MESMO conteúdo é apanhado pelo sniff header-driven:
    expect(uploadSource({ fileName: "export.txt", csvText: stockTxt }).format).toBe("also_stock");
    expect(looksLikeAlsoStock(stockTxt)).toBe(true);
    // E conteúdo sem header ALSO + nome 'stock' segue o nome (contrato C.3.4.3.1):
    const generic = "skuFornecedor;nome;custo;stock\nREF-1;Produto A;10,00;5";
    expect(uploadSource({ fileName: "stock-report.txt", csvText: generic }).format).toBe("also_stock");
    expect(looksLikeAlsoStock(generic)).toBe(false);
  });

  it("nome genérico + conteúdo genérico → caminho genérico intacto (C.3.1/C.3.2)", () => {
    const genericCsv = "skuFornecedor;nome;custo;stock\nREF-1;Produto A;10,00;5\nREF-2;Produto B;8,00;2";
    const payload = uploadSource({ fileName: "de-outro-fornecedor.csv", csvText: genericCsv });
    expect(payload.format).toBe("csv");
    const parsed = parseSupplierCsv(genericCsv);
    expect(parsed.mapping["skuFornecedor"]).toBe("supplierSku");
  });
});

describe("C.3.4.3.1 — sourceFormat auto aplica as MESMAS regras (payloads sem formato)", () => {
  it("auto: pricelist por conteúdo; stock por header; senão csv", () => {
    const auto = (text: string) => sourceFormat({ kind: "url", label: "u", format: "auto", text });
    expect(auto(STAGING_FILE)).toBe("also_pricelist");
    expect(auto("ProductID\tAvailableQuantity\nPID1\t2")).toBe("also_stock");
    expect(auto("sku;nome\nean;REF1;Produto")).toBe("csv");
    expect(auto(pricelistLine())).toBe("csv"); // 1 linha sozinha não prova a estrutura
  });
});
