/**
 * C.3.3 (etapa 2) — Parser XLSX (puro, sem base de dados).
 *
 * Cobre os requisitos A–L da etapa + transporte base64 + segurança
 * (assinatura ZIP/OOXML, zip bomb, macros, fórmulas, células de erro,
 * limites de tamanho/linhas/folha). As equivalências de pipeline e perfis
 * (N–T com base de dados) vivem em c33-xlsx-pipeline.test.ts.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "crypto";
import zlib from "node:zlib";
import * as XLSX from "@e965/xlsx";
import {
  parseSupplierXlsx,
  decodeBase64Strict,
  XLSX_MAX_SIZE_BYTES,
} from "@/lib/supplier-import/xlsx";
import {
  parseSupplierCsv,
  sha256Hex,
  sha256HexBytes,
  SupplierCsvError,
} from "@/lib/supplier-import/normalize";
import { parseSupplierFile } from "@/lib/supplier-import/file";
import {
  resolveSupplierFileMapping,
  type SupplierProfileRef,
} from "@/lib/supplier-import/file";
import { SUPPLIER_IMPORT_MAX_ROWS } from "@/lib/supplier-import/constants";

// ─── Fixtures ────────────────────────────────────────────

/** Gera um XLSX válido a partir de folhas { name: sheet } (modo denso/células). */
function buildXlsx(sheets: Record<string, any>): Uint8Array {
  const wb: any = { SheetNames: Object.keys(sheets), Sheets: sheets };
  return new Uint8Array(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}

/**
 * ZIP mínimo construído à mão (deflate via node:zlib) — usado para os
 * fixtures que a própria biblioteca não consegue GERAR (zip bomb com ratio
 * extremo; folha com `<dimension>` gigante — o XLSX.write materializa o
 * intervalo declarado e ficaria a escrever 16,7M células de vazio).
 */
function crc32(buf: Buffer): number {
  let c: number;
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crcv = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) crcv = table[(crcv ^ buf[i]) & 0xff] ^ (crcv >>> 8);
  return (crcv ^ 0xffffffff) >>> 0;
}

function buildZip(entries: { name: string; data: string | Uint8Array | Buffer }[]): Uint8Array {
  const parts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameB = Buffer.from(name);
    const deflated = zlib.deflateRawSync(Buffer.from(data));
    const crcv = crc32(Buffer.from(data));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crcv, 14); local.writeUInt32LE(deflated.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameB.length, 26);
    const localAll = Buffer.concat([local, nameB, deflated]);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crcv, 16); central.writeUInt32LE(deflated.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameB.length, 28); central.writeUInt32LE(offset, 42);
    centralParts.push(Buffer.concat([central, nameB]));
    parts.push(localAll);
    offset += localAll.length;
  }
  const centralAll = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralAll.length, 12); eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, centralAll, eocd]));
}

/**
 * XLSX OOXML mínimo (1 folha, 2 linhas) com `<dimension ref>` à escolha.
 * O reader do SheetJS honra o dimension para `!ref` — é assim que se simula
 * uma "folha gigante" (Excel permite declarar A1:XFD1048576 = 16,7M células).
 */
function buildXlsxWithDimension(dimensionRef: string): Uint8Array {
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="${dimensionRef}"/>
<sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="s"><v>3</v></c></row>
</sheetData>
</worksheet>`;
  const sst = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="4"><si><t>SKU</t></si><si><t>Stock</t></si><si><t>K-1</t></si><si><t>2</t></si></sst>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Lista" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const wbrels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`;
  return buildZip([
    { name: "[Content_Types].xml", data: contentTypes },
    { name: "_rels/.rels", data: rels },
    { name: "xl/workbook.xml", data: workbook },
    { name: "xl/_rels/workbook.xml.rels", data: wbrels },
    { name: "xl/worksheets/sheet1.xml", data: sheet },
    { name: "xl/sharedStrings.xml", data: sst },
  ]);
}

const STD_HEADERS = ["SKU", "EAN", "Nome", "Custo", "Stock"];
const STD_ROW1 = ["REF-001", "5901234123457", "Cabo HDMI 2m", 8.9, 12];
const STD_ROW2 = ["REF-002", "5901234123464", "Rato sem fios", 12.5, 3];

function stdSheet(extra: Record<string, any> = {}): any {
  const ws: any = {};
  STD_HEADERS.forEach((h, i) => { ws[XLSX.utils.encode_cell({ r: 0, c: i })] = { t: "s", v: h }; });
  const set = (r: number, c: number, cell: any) => { ws[XLSX.utils.encode_cell({ r, c })] = cell; };
  STD_ROW1.forEach((v, c) => set(1, c, typeof v === "number" ? { t: "n", v } : { t: "s", v }));
  STD_ROW2.forEach((v, c) => set(2, c, typeof v === "number" ? { t: "n", v } : { t: "s", v }));
  Object.assign(ws, extra);
  ws["!ref"] = "A1:E3";
  return ws;
}

/**
 * Asserta que `fn` lança SupplierCsvError com `code`. (Evita a forma
 * toThrowError(predicate) com instanceof: erros serializados entre
 * worker e processo do vitest perdem a cadeia de protótipo.)
 */
function expectSupplierError(fn: () => unknown, code: string) {
  let caught: unknown = null;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(SupplierCsvError);
  expect((caught as SupplierCsvError).code).toBe(code);
}

/** PRNG determinístico (fixture estável entre runs). */
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── A. parser simples ───────────────────────────────────

describe("C.3.3 XLSX — parser simples (A, B, F)", () => {
  it("A: parse simples produz o mesmo contrato do CSV (headers, mapping, delimiter=null)", () => {
    const parsed = parseSupplierXlsx(buildXlsx({ S: stdSheet() }));
    expect(parsed.headers).toEqual(STD_HEADERS);
    expect(parsed.mapping).toEqual({
      SKU: "supplierSku",
      EAN: "ean",
      Nome: "name",
      Custo: "costPrice",
      Stock: "stock",
    });
    expect(parsed.ignoredColumns).toEqual([]);
    expect(parsed.delimiter).toBeNull();
    expect(parsed.rows).toHaveLength(2);
  });

  it("A: valores normalizados (custo 8,90 → 8.90; 12,5 → 12.50; rowNumber = linha real do Excel)", () => {
    const parsed = parseSupplierXlsx(buildXlsx({ S: stdSheet() }));
    expect(parsed.rows[0]).toMatchObject({
      rowNumber: 2,
      supplierSku: "REF-001",
      ean: "5901234123457",
      name: "Cabo HDMI 2m",
      costPrice: "8.90",
      stock: 12,
      internalSku: null,
      issues: [],
    });
    expect(parsed.rows[1]).toMatchObject({ costPrice: "12.50", stock: 3, ean: "5901234123464" });
  });

  it("D: custo com 3 casas decimais (1234.565) → regra partilhada do normalizador (milhares ambíguo + WARNING), igual ao CSV", () => {
    const ws: any = stdSheet();
    ws["D2"] = { t: "n", v: 1234.565 };
    const parsed = parseSupplierXlsx(buildXlsx({ S: ws }));
    // "1234.565" → o normalizador C.3.1 lê o único separador com grupo de 3
    // dígitos como MILHARES (uma quantia de custo nunca tem 3 decimais) e
    // marca AMBIGUOUS_NUMBER_FORMAT para o operador ver a interpretação.
    // O mesmo texto num CSV produz exatamente o mesmo resultado.
    expect(parsed.rows[0].costPrice).toBe("1234565.00");
    expect(parsed.rows[0].issues.some((i) => i.code === "AMBIGUOUS_NUMBER_FORMAT")).toBe(true);
    const fromCsv = parseSupplierCsv("sku;custo\nK-1;1234.565");
    expect(fromCsv.rows[0].costPrice).toBe("1234565.00");
    expect(fromCsv.rows[0].issues.some((i) => i.code === "AMBIGUOUS_NUMBER_FORMAT")).toBe(true);
  });

  it("B: headers com acentos/espaços passam pela MESMA máquina de mapping do CSV", () => {
    const ws: any = {};
    const headers = ["Código", "EAN", "Designação do Produto", "Custo", "Quantidade em Stock"];
    headers.forEach((h, i) => { ws[XLSX.utils.encode_cell({ r: 0, c: i })] = { t: "s", v: h }; });
    ["X-9", "5901234123457", "Produto", 5.5, 4].forEach((v, c) =>
      ws[XLSX.utils.encode_cell({ r: 1, c })] = typeof v === "number" ? { t: "n", v } : { t: "s", v }
    );
    ws["!ref"] = "A1:E2";
    const parsed = parseSupplierXlsx(buildXlsx({ S: ws }));
    expect(parsed.mapping).toEqual({
      Código: "supplierSku",
      EAN: "ean",
      "Designação do Produto": "name",
      Custo: "costPrice",
      "Quantidade em Stock": "stock",
    });
    // O mesmo conjunto de headers num CSV dá exatamente o mesmo mapping.
    const csv = parseSupplierCsv(headers.join(";") + "\nX-9;5901234123457;Produto;5.5;4");
    expect(parsed.mapping).toEqual(csv.mapping);
  });

  it("B: colunas com header vazio no fim são cortadas; vazio interno mantém-se", () => {
    const ws: any = {};
    const headers = ["SKU", "", "Stock"];
    headers.forEach((h, i) => { ws[XLSX.utils.encode_cell({ r: 0, c: i })] = { t: "s", v: h }; });
    ws["A2"] = { t: "s", v: "K-1" }; ws["C2"] = { t: "n", v: 2 };
    ws["!ref"] = "A1:C2";
    const parsed = parseSupplierXlsx(buildXlsx({ S: ws }));
    expect(parsed.headers).toEqual(["SKU", "", "Stock"]);
    expect(parsed.mapping).toEqual({ SKU: "supplierSku", Stock: "stock" });
    expect(parsed.rows[0]).toMatchObject({ supplierSku: "K-1", stock: 2, name: null });
  });

  it("F: células vazias → campos null (nunca inventa valores)", () => {
    const ws: any = stdSheet();
    delete ws["B2"]; // EAN vazio na linha 1
    delete ws["E3"]; // Stock vazio na linha 2
    const parsed = parseSupplierXlsx(buildXlsx({ S: ws }));
    expect(parsed.rows[0].ean).toBeNull();
    expect(parsed.rows[1].stock).toBeNull();
    expect(parsed.rows[1].issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });
});

// ─── C/D/E. EAN, custo, stock ────────────────────────────

describe("C.3.3 XLSX — EAN / custo / stock (C, D, E)", () => {
  it("C: EAN como célula NUMÉRICA (Excel guarda GTIN como número) → string intacta", () => {
    const ws: any = stdSheet();
    ws["B2"] = { t: "n", v: 5901234123457 };
    // GTIN-12 (UPC-A) como número → normalizado para 13 dígitos com zero à esquerda
    ws["B3"] = { t: "n", v: 123456789012 };
    const parsed = parseSupplierXlsx(buildXlsx({ S: ws }));
    expect(parsed.rows[0].ean).toBe("5901234123457");
    expect(parsed.rows[0].issues.filter((i) => i.code === "INVALID_GTIN")).toHaveLength(0);
    expect(parsed.rows[1].ean).toBe("0123456789012");
  });

  it("C: EAN inválido (checksum) → INVALID_GTIN, como no CSV", () => {
    const ws: any = stdSheet();
    ws["B2"] = { t: "s", v: "5901234123450" };
    const parsed = parseSupplierXlsx(buildXlsx({ S: ws }));
    expect(parsed.rows[0].issues.some((i) => i.code === "INVALID_GTIN" && i.severity === "error")).toBe(true);
  });

  it("D: custo escrito como TEXTO com formato pt-PT (\"1.234,56\") → 1234.56", () => {
    const ws: any = stdSheet();
    ws["D2"] = { t: "s", v: "1.234,56" };
    const parsed = parseSupplierXlsx(buildXlsx({ S: ws }));
    expect(parsed.rows[0].costPrice).toBe("1234.56");
    expect(parsed.rows[0].issues.some((i) => i.severity === "error")).toBe(false);
  });

  it("D: custo negativo → INVALID_COST; custo acima do teto decimal(10,2) → COST_OUT_OF_RANGE", () => {
    const ws: any = stdSheet();
    ws["D2"] = { t: "n", v: -3 };
    ws["D3"] = { t: "n", v: 999999999.99 };
    const parsed = parseSupplierXlsx(buildXlsx({ S: ws }));
    expect(parsed.rows[0].issues.some((i) => i.code === "INVALID_COST")).toBe(true);
    expect(parsed.rows[1].issues.some((i) => i.code === "COST_OUT_OF_RANGE")).toBe(true);
    expect(parsed.rows[0].costPrice).toBeNull();
    expect(parsed.rows[1].costPrice).toBeNull();
  });

  it("E: stock decimal → INVALID_STOCK; stock inteiro OK; \"true\" em stock → erro (nada é inventado)", () => {
    const ws: any = stdSheet();
    ws["E2"] = { t: "s", v: "12,5" };
    ws["E3"] = { t: "b", v: true };
    const parsed = parseSupplierXlsx(buildXlsx({ S: ws }));
    expect(parsed.rows[0].issues.some((i) => i.code === "INVALID_STOCK")).toBe(true);
    expect(parsed.rows[1].issues.some((i) => i.code === "INVALID_STOCK")).toBe(true);
    expect(parsed.rows[1].stock).toBeNull();
  });
});

// ─── L. fórmulas, erros, datas ───────────────────────────

describe("C.3.3 XLSX — fórmulas, erros, datas (L + segurança de tipos)", () => {
  it("L: fórmula com valor CACHED usa apenas o cache (nunca avalia a fórmula)", () => {
    // f: "1+1" avaliada daria 2; o cache diz 42 → o resultado tem de ser 42.
    const ws: any = stdSheet();
    ws["D2"] = { t: "n", v: 42, f: "1+1" };
    const parsed = parseSupplierXlsx(buildXlsx({ S: ws }));
    expect(parsed.rows[0].costPrice).toBe("42.00");
  });

  it("L: fórmula SEM valor cached → célula vazia (a fórmula nunca é interpretada)", () => {
    const ws: any = stdSheet();
    // Sem `v`: na leitura o valor simplesmente não existe — e "1+1" NUNCA é
    // avaliado para "2": a coluna Nome fica vazia, sem erro (campo opcional).
    ws["C2"] = { t: "n", f: "1+1" };
    const parsed = parseSupplierXlsx(buildXlsx({ S: ws }));
    expect(parsed.rows[0].name).toBeNull();
    expect(parsed.rows[0].issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("célula de erro Excel (#DIV/0!) → vazia; nunca vira chave nem valor", () => {
    const ws: any = {};
    ws["A1"] = { t: "s", v: "SKU" }; ws["B1"] = { t: "s", v: "Stock" };
    ws["A2"] = { t: "e", v: "#DIV/0!" };
    ws["B2"] = { t: "n", v: 5 };
    ws["!ref"] = "A1:B2";
    const parsed = parseSupplierXlsx(buildXlsx({ S: ws }));
    expect(parsed.rows[0].supplierSku).toBeNull();
    expect(parsed.rows[0].issues.some((i) => i.code === "MISSING_IDENTIFIER_KEY")).toBe(true);
    expect(JSON.stringify(parsed.rows)).not.toContain("#DIV/0!");
  });

  it("data → ISO (o serial nunca aparece como número \"a olho nu\")", () => {
    const ws: any = {};
    ws["A1"] = { t: "s", v: "SKU" }; ws["B1"] = { t: "s", v: "Nome" }; ws["C1"] = { t: "s", v: "Custo" };
    ws["A2"] = { t: "s", v: "K-1" };
    ws["B2"] = { t: "d", v: new Date(Date.UTC(2024, 0, 15)) };
    ws["C2"] = { t: "n", v: 1 };
    ws["!ref"] = "A1:C2";
    const parsed = parseSupplierXlsx(buildXlsx({ S: ws }));
    expect(parsed.rows[0].name).toBe("2024-01-15T00:00:00.000Z");
  });
});

// ─── G/H/I. limites de linhas e tamanho ──────────────────

describe("C.3.3 XLSX — limites de linhas e tamanho (G, H, I)", () => {
  it("G: exatamente 10.000 linhas de dados → permitido", () => {
    const rows: (string | number)[][] = [["sku", "stock"]];
    for (let r = 0; r < SUPPLIER_IMPORT_MAX_ROWS; r += 1) rows.push([`R-${r}`, r % 10]);
    const parsed = parseSupplierXlsx(buildXlsx({ S: XLSX.utils.aoa_to_sheet(rows) }));
    expect(parsed.rows).toHaveLength(SUPPLIER_IMPORT_MAX_ROWS);
    expect(parsed.rows[0]).toMatchObject({ rowNumber: 2, supplierSku: "R-0" });
    expect(parsed.rows[SUPPLIER_IMPORT_MAX_ROWS - 1].supplierSku).toBe(`R-${SUPPLIER_IMPORT_MAX_ROWS - 1}`);
  });

  it("H: 10.001 linhas → XLSX_TOO_MANY_ROWS", () => {
    const rows: (string | number)[][] = [["sku", "stock"]];
    for (let r = 0; r < SUPPLIER_IMPORT_MAX_ROWS + 1; r += 1) rows.push([`R-${r}`, 1]);
    expectSupplierError(() => parseSupplierXlsx(buildXlsx({ S: XLSX.utils.aoa_to_sheet(rows) })), "XLSX_TOO_MANY_ROWS");
  });

  it("I: XLSX real >5 MB → XLSX_TOO_LARGE (recusado ANTES de parsing pesado, e antes do limite de linhas)", () => {
    // 45.000 linhas (já > 10.000) com nomes de alta entropia (mal comprimem):
    // o ficheiro final ultrapassa os 5 MB e o teto de BYTES tem de disparar
    // antes do teto de linhas.
    const rand = mulberry32(42);
    const rows: (string | number)[][] = [["sku", "nome"]];
    for (let r = 0; r < 45000; r += 1) {
      let name = `p${r}-`;
      for (let i = 0; i < 48; i += 1) name += "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(rand() * 36)];
      rows.push([`R-${r}`, name]);
    }
    const bytes = buildXlsx({ S: XLSX.utils.aoa_to_sheet(rows) });
    expect(bytes.length).toBeGreaterThan(XLSX_MAX_SIZE_BYTES);
    expectSupplierError(() => parseSupplierXlsx(bytes), "XLSX_TOO_LARGE");
  });
});

// ─── J/K. integridade do ficheiro ────────────────────────

describe("C.3.3 XLSX — integridade do ficheiro (J, K + assinatura)", () => {
  it("J: texto puro com extensão .xlsx → XLSX_INVALID (a assinatura não passa)", () => {
    const bytes = new TextEncoder().encode("isto não é um ficheiro excel, é só texto");
    expectSupplierError(() => parseSupplierXlsx(bytes), "XLSX_INVALID");
  });

  it("J: ZIP válido mas NÃO OOXML com extensão .xlsx → XLSX_INVALID", () => {
    // ZIP real (assinatura PK\x03\x04) sem as partes de um workbook.
    const bytes = buildZip([{ name: "readme.txt", data: "um zip qualquer" }]);
    expect(bytes[0]).toBe(0x50); // magic ZIP presente — e mesmo assim é recusado
    expectSupplierError(() => parseSupplierXlsx(bytes), "XLSX_INVALID");
  });

  it("K: XLSX truncado (EOCD perdida) → XLSX_CORRUPT", () => {
    const bytes = buildXlsx({ S: stdSheet() });
    const truncated = bytes.slice(0, Math.floor(bytes.length * 0.4));
    expectSupplierError(() => parseSupplierXlsx(truncated), "XLSX_CORRUPT");
  });

  it("K: OOXML íntegro na audição, conteúdo ilegível na leitura → XLSX_CORRUPT", () => {
    // O diretório central está perfeito — a audição (sem descompressão)
    // passa — mas a workbook contém lixo, só a leitura real o detecta.
    const ct = `<?xml version="1.0"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`;
    const garbage = new Uint8Array(256).fill(0xff);
    const zip = buildZip([
      { name: "[Content_Types].xml", data: ct },
      { name: "xl/workbook.xml", data: garbage },
    ]);
    expectSupplierError(() => parseSupplierXlsx(zip), "XLSX_CORRUPT");
  });

  it("bytes vazios → XLSX_INVALID", () => {
    expectSupplierError(() => parseSupplierXlsx(new Uint8Array(0)), "XLSX_INVALID");
  });

  it("macro (vbaProject.bin) → XLSX_INVALID — um .xlsm renomeado não passa", () => {
    // Um .xlsm renomeado para .xlsx é um ZIP OOXML PERFEITO (passa a
    // assinatura e a audição de estrutura) — apenas contém vbaProject.bin.
    // A audição do ZIP tem de o recusar.
    const zip = buildZip([
      { name: "[Content_Types].xml", data: "<Types/>" },
      { name: "xl/workbook.xml", data: "<workbook/>" },
      { name: "xl/vbaProject.bin", data: new Uint8Array([1, 2, 3, 4]) },
    ]);
    expect(zip[0]).toBe(0x50); // ZIP real — a recusa vem da MACRO, não da assinatura
    expectSupplierError(() => parseSupplierXlsx(zip), "XLSX_INVALID");
  });

  it("zip bomb (declaração de expansão desproporcionada) → XLSX_TOO_LARGE antes de descomprimir", () => {
    // 1 entrada deflata de 1 MB de bytes idênticos (~1 KB comprimido,
    // ratio ~900:1 — muito acima do teto XLSX_MAX_EXPANSION_RATIO). A audição
    // lê apenas o diretório central e recusa antes de qualquer descompressão.
    const content = new Uint8Array(1024 * 1024).fill(7);
    const deflated = zlib.deflateRawSync(Buffer.from(content));
    expect(deflated.length).toBeLessThan(4096); // garante o ratio alto
    const crcv = crc32(Buffer.from(content));
    const nameB = Buffer.from("big.bin");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crcv, 14); local.writeUInt32LE(deflated.length, 18); local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameB.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crcv, 16); central.writeUInt32LE(deflated.length, 20); central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameB.length, 28); central.writeUInt32LE(0, 42);
    const bytes = new Uint8Array(
      Buffer.concat([Buffer.concat([local, nameB, deflated]), Buffer.concat([central, nameB])])
    );
    // EOCD mínimo (1 entrada)
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(46 + nameB.length, 12); eocd.writeUInt32LE(30 + nameB.length + deflated.length, 16);
    const zip = new Uint8Array(Buffer.concat([bytes, eocd]));
    expect(zip.length).toBeLessThan(10 * 1024); // ficheiro TINY, declaração GRANDE
    expectSupplierError(() => parseSupplierXlsx(zip), "XLSX_TOO_LARGE");
  });

  it("folha com intervalo declarado gigante (A1:XFD1048576 = 16,7M células) → XLSX_TOO_LARGE", () => {
    const bytes = buildXlsxWithDimension("A1:XFD1048576");
    // Sanity: o reader honra o dimension (é isso que o parser audita).
    expect(bytes.length).toBeLessThan(4096); // 2 células reais, dimensão enorme
    expectSupplierError(() => parseSupplierXlsx(bytes), "XLSX_TOO_LARGE");
  });
});

// ─── M. folhas e dados ───────────────────────────────────

describe("C.3.3 XLSX — folhas e dados (M + casos de borda)", () => {
  it("M: primeira folha UTILIZÁVEL (folha 1 vazia → usa a folha 2, na ordem do workbook)", () => {
    const empty: any = {}; // sem células, sem !ref
    const wb: any = {
      SheetNames: ["Cobertura", "Dados"],
      Sheets: { Cobertura: empty, Dados: stdSheet() },
    };
    const bytes = new Uint8Array(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
    const parsed = parseSupplierXlsx(bytes);
    expect(parsed.headers).toEqual(STD_HEADERS);
    expect(parsed.rows).toHaveLength(2);
  });

  it("M: workbook sem qualquer folha com dados → XLSX_NO_USABLE_SHEET", () => {
    const empty: any = {};
    const wb: any = { SheetNames: ["A", "B"], Sheets: { A: empty, B: empty } };
    const bytes = new Uint8Array(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
    expectSupplierError(() => parseSupplierXlsx(bytes), "XLSX_NO_USABLE_SHEET");
  });

  it("somente headers, sem linhas de dados → XLSX_NO_DATA", () => {
    const ws: any = {};
    ["SKU", "Stock"].forEach((h, i) => { ws[XLSX.utils.encode_cell({ r: 0, c: i })] = { t: "s", v: h }; });
    ws["!ref"] = "A1:B1";
    expectSupplierError(() => parseSupplierXlsx(buildXlsx({ S: ws })), "XLSX_NO_DATA");
  });

  it("sem coluna de chave → CSV_MISSING_KEY_COLUMN (o mesmo código do CSV)", () => {
    const ws: any = {};
    ["Nome", "Stock"].forEach((h, i) => { ws[XLSX.utils.encode_cell({ r: 0, c: i })] = { t: "s", v: h }; });
    ws["A2"] = { t: "s", v: "Produto" }; ws["B2"] = { t: "n", v: 1 };
    ws["!ref"] = "A1:B2";
    expectSupplierError(() => parseSupplierXlsx(buildXlsx({ S: ws })), "CSV_MISSING_KEY_COLUMN");
  });

  it("duas colunas para o mesmo campo → DUPLICATE_MAPPING (regra partilhada do CSV)", () => {
    const ws: any = {};
    ["SKU", "Código", "Stock"].forEach((h, i) => { ws[XLSX.utils.encode_cell({ r: 0, c: i })] = { t: "s", v: h }; });
    ws["A2"] = { t: "s", v: "K" }; ws["B2"] = { t: "s", v: "K2" }; ws["C2"] = { t: "n", v: 1 };
    ws["!ref"] = "A1:C2";
    expectSupplierError(() => parseSupplierXlsx(buildXlsx({ S: ws })), "DUPLICATE_MAPPING:supplierSku");
  });

  it("headers na PRIMEIRA LINHA ÚTIL (linhas vazias antes do header são ignoradas)", () => {
    const ws: any = {};
    const headers = ["SKU", "Stock"];
    headers.forEach((h, i) => { ws[XLSX.utils.encode_cell({ r: 1, c: i })] = { t: "s", v: h }; }); // linha 2 do Excel
    ws["A3"] = { t: "s", v: "K-9" }; ws["B3"] = { t: "n", v: 4 };
    ws["!ref"] = "A1:B3";
    const parsed = parseSupplierXlsx(buildXlsx({ S: ws }));
    expect(parsed.headers).toEqual(headers);
    // rowNumber aponta para a linha REAL do ficheiro (linha 3 do Excel).
    expect(parsed.rows[0]).toMatchObject({ rowNumber: 3, supplierSku: "K-9", stock: 4 });
  });
});

// ─── N/O/P/Q. mapping e perfis a nível de parser ─────────

describe("C.3.3 XLSX — mapping e perfis a nível de parser (N, O, P, Q)", () => {
  const PROFILE: SupplierProfileRef = {
    id: 11,
    mapping: { SKU: "supplierSku", EAN: "ean", Nome: "name", Custo: "costPrice", Stock: "stock" },
  };
  const BAD_PROFILE: SupplierProfileRef = { id: 12, mapping: { colunaInexistente: "supplierSku" } };
  const bytes = buildXlsx({ S: stdSheet() });
  const parseOne = (m?: Record<string, string>) => parseSupplierFile("", m, "xlsx", bytes);

  it("N: sem perfil → auto mapping, no_profile (sem re-parse)", () => {
    let reparses = 0;
    const { parsed, resolution } = resolveSupplierFileMapping({
      initial: parseOne(),
      reparse: (m) => { reparses += 1; return parseOne(m); },
      manualMapping: undefined,
      profile: null,
    });
    expect(reparses).toBe(0);
    expect(resolution.type).toBe("no_profile");
    expect(parsed.mapping).toEqual(PROFILE.mapping); // auto-mapping reconhece os mesmos headers
  });

  it("P: perfil válido + headers compatíveis → re-parse com o mapping do perfil (profile_valid)", () => {
    const { parsed, resolution } = resolveSupplierFileMapping({
      initial: parseOne(),
      reparse: parseOne,
      manualMapping: undefined,
      profile: PROFILE,
    });
    expect(resolution).toEqual({ type: "profile_valid", mapping: PROFILE.mapping, profileId: 11 });
    expect(parsed.mapping).toEqual(PROFILE.mapping);
    expect(parsed.rows[0]).toMatchObject({ supplierSku: "REF-001", costPrice: "8.90" });
  });

  it("Q: perfil incompatível → fallback seguro para o parse inicial (profile_invalid)", () => {
    const initial = parseOne();
    const { parsed, resolution } = resolveSupplierFileMapping({
      initial,
      reparse: parseOne,
      manualMapping: undefined,
      profile: BAD_PROFILE,
    });
    expect(parsed).toBe(initial);
    expect(resolution.type).toBe("profile_invalid");
  });

  it("O: mapping manual não vazio tem prioridade sobre o perfil", () => {
    // O mapping manual é um OVERRIDE: a coluna EAN é forçada para
    // "internalSku" (contra o alias automático "ean") — as restantes
    // colunas continuam com o auto-mapping, exatamente como no CSV.
    const manual = { EAN: "internalSku" };
    const initial = parseOne(manual);
    const { parsed, resolution } = resolveSupplierFileMapping({
      initial,
      reparse: parseOne,
      manualMapping: manual,
      profile: PROFILE,
    });
    expect(parsed).toBe(initial);
    expect(parsed.mapping.EAN).toBe("internalSku"); // o override venceu o alias "ean"
    expect(parsed.mapping.SKU).toBe("supplierSku"); // auto-mapping preenche o resto
    expect(parsed.rows[0].internalSku).toBe("5901234123457"); // valor da coluna EAN
    expect(parsed.rows[0].ean).toBeNull(); // ean já não recebe nada
    expect(resolution.type).toBe("profile_valid"); // perfil reportado, mas o manual manda no parse
  });
});

// ─── transporte base64 + hash de bytes ───────────────────

describe("C.3.3 XLSX — transporte base64 + hash de bytes", () => {
  it("decodeBase64Strict: roundtrip canónico e bytes exatos", () => {
    const bytes = buildXlsx({ S: stdSheet() });
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const b64 = btoa(bin);
    const decoded = decodeBase64Strict(b64);
    expect(decoded).not.toBeNull();
    expect(Buffer.from(decoded!).equals(Buffer.from(bytes))).toBe(true);
  });

  it("decodeBase64Strict: rejeita base64 inválido (charset, padding, comprimento, whitespace)", () => {
    expect(decodeBase64Strict("")).toBeNull();
    expect(decodeBase64Strict("abc")).toBeNull(); // %4 !== 0
    expect(decodeBase64Strict("ab1!")).toBeNull(); // caractere inválido
    expect(decodeBase64Strict("ab=d")).toBeNull(); // padding no meio
    expect(decodeBase64Strict("a===")).toBeNull(); // 3 paddings
    expect(decodeBase64Strict("aGk=\n")).toBeNull(); // whitespace
    expect(decodeBase64Strict(" aGk=")).toBeNull(); // whitespace à esquerda
  });

  it("sha256HexBytes = SHA-256 dos BYTES originais (e ≠ hash da string base64)", () => {
    const bytes = buildXlsx({ S: stdSheet() });
    const expected = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
    expect(sha256HexBytes(bytes)).toBe(expected);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const b64 = btoa(bin);
    expect(sha256Hex(b64)).not.toBe(expected); // a string base64 daria outro hash
  });
});

// ─── T. equivalência parser CSV ↔ XLSX ───────────────────

describe("C.3.3 XLSX — equivalência parser CSV ↔ XLSX (T, nível de dados)", () => {
  it("mesmos dados: as NormalizedSupplierRow saem IGUAIS (rowNumber, chaves, custo, stock)", () => {
    const csv = [
      "sku;ean;nome;custo;stock",
      "REF-001;5901234123457;Cabo HDMI 2m;8,90;12",
      "REF-002;5901234123464;Rato sem fios;12,50;3",
      "REF-003;;Teclado mecânico;1.234,56;7",
      ";;Linha sem chave;1,00;1",
      "REF-001;5901234123457;Duplicado;9,99;2",
    ].join("\n");

    const ws: any = {};
    const headers = ["sku", "ean", "nome", "custo", "stock"];
    headers.forEach((h, i) => { ws[XLSX.utils.encode_cell({ r: 0, c: i })] = { t: "s", v: h }; });
    const data: (string | number)[][] = [
      ["REF-001", "5901234123457", "Cabo HDMI 2m", 8.9, 12],
      ["REF-002", "5901234123464", "Rato sem fios", 12.5, 3],
      ["REF-003", "", "Teclado mecânico", 1234.56, 7],
      ["", "", "Linha sem chave", 1, 1],
      ["REF-001", "5901234123457", "Duplicado", 9.99, 2],
    ];
    data.forEach((row, r) => row.forEach((v, c) => {
      if (v === "") return; // célula vazia
      ws[XLSX.utils.encode_cell({ r: r + 1, c })] = typeof v === "number" ? { t: "n", v } : { t: "s", v };
    }));
    ws["!ref"] = "A1:E6";

    const fromCsv = parseSupplierCsv(csv);
    const fromXlsx = parseSupplierXlsx(buildXlsx({ S: ws }));

    expect(fromXlsx.mapping).toEqual(fromCsv.mapping);
    expect(fromXlsx.ignoredColumns).toEqual(fromCsv.ignoredColumns);
    // As linhas normalizadas são semanticamente idênticas (o hash NÃO é
    // comparado: os bytes dos ficheiros são diferentes por definição).
    expect(fromXlsx.rows).toEqual(fromCsv.rows);
  });
});
