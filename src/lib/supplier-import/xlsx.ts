/**
 * C.3.3 (etapa 2) — XLSX → SupplierFileParse.
 *
 * O parser XLSX converte um ficheiro de fornecedor .xlsx no MESMO contrato
 * normalizado do CSV (SupplierFileParse → NormalizedSupplierRow) e passa pela
 * MESMA máquina de mapping (buildSupplierMapping / normalizeSupplierRow /
 * applyMapping de ./normalize.ts) — nenhum alias, regra monetária ou limite
 * de snapshot é duplicado aqui. Tudo a jusante (matching, preview, token,
 * apply, perfis) continua agnóstico ao formato de origem.
 *
 * ── Segurança: XLSX é ZIP/OOXML e é tratado como input NÃO confiável ──
 *
 *  - só `.xlsx` chega aqui (a classificação por extensão vive em ./file.ts e
 *    a rota recusa .xls/.xlsm/.xltm/.xlsb/.ods com FILE_TYPE_NOT_SUPPORTED);
 *  - o tamanho (5 MB, mesmo teto do CSV) é verificado ANTES de qualquer
 *    parsing pesado;
 *  - a assinatura é validada, nunca se confia na extensão:
 *      1. magic ZIP `PK\x03\x04`;
 *      2. audição do diretório central do ZIP (SEM descompressão) — número de
 *         entradas, tamanho declarado total descomprimido (proteção zip bomb)
 *         e presença de `[Content_Types].xml` + `xl/workbook.xml` (assunto
 *         mínimo OOXML de workbook);
 *      3. qualquer estrutura ilegível → XLSX_CORRUPT / XLSX_INVALID.
 *  - macros: `vbaProject.bin` é recusado na audição do ZIP (um .xlsm renomeado
 *    para .xlsx tem a mesma assinatura OOXML) e `bookVBA` é explicitamente
 *    false — nunca há código VBA em memória;
 *  - fórmulas: `cellFormula: false` — o texto da fórmula NUNCA é lido nem
 *    interpretado. Usa-se apenas o valor cached/armazenado (se existir);
 *    sem valor cached → célula vazia. Nada é avaliado;
 *  - hyperlinks: ficam em `ws["!links"]` como dados inertes que este parser
 *    nunca lê; a biblioteca não faz fetch/XHR no caminho de leitura (nada é
 *    resolvido — external links incluídos);
 *  - tipos inesperados (células de erro `#REF!`, `#DIV/0!`, etc.): nunca são
 *    emitidos — convertem para vazio;
 *  - limites de folha: o intervalo declarado (linhas × colunas) tem um teto
 *    duro (XLSX_MAX_SHEET_CELLS) e o número de linhas de dados mantém o limite
 *    global de 10 000 (XLSX_TOO_MANY_ROWS).
 *
 * Dependência: @e965/xlsx 0.20.3 — re-publicação no npm (reproduzível, fixa no
 * lockfile) do build oficial SheetJS Community Edition 0.20.3, que contém as
 * correções de segurança pós-0.18.5 (o `xlsx` do registry npm ficou parado em
 * 0.18.5 com CVE-2023-30533/CVE-2023-30589/CVE-2024-22363 conhecidos).
 * Apache-2.0, zero dependências, sem código nativo, build ESM isomorfo
 * (Node + Workers) sem `require` de módulos nativos no caminho de leitura.
 */
import * as XLSX from "@e965/xlsx";
import { CSV_MAX_SIZE, applyMapping } from "@/lib/csv";
import {
  SupplierCsvError,
  buildSupplierMapping,
  normalizeSupplierRow,
  type NormalizedSupplierRow,
  type SupplierFileParse,
} from "./normalize";
import { SUPPLIER_IMPORT_MAX_ROWS } from "./constants";

// ─── Limites (single source of truth para os testes) ──────

/** Teto do ficheiro em BYTES — o mesmo 5 MB do CSV (ceiling de memória). */
export const XLSX_MAX_SIZE_BYTES = CSV_MAX_SIZE;

/**
 * Tamanho total DECLARADO (no diretório central) de todos os membros do ZIP,
 * verificado ANTES de qualquer descompressão — é a proteção zip bomb:
 * 64 MB de XML já é patológico para uma lista de fornecedor de 5 MB.
 */
export const XLSX_MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;

/**
 * Relação máxima entre o tamanho declarado descomprimido e o tamanho
 * comprimido do ficheiro. Deflate raramente passa de ~100:1 em texto real;
 * um ratio de 128 bloqueia diretórios declarados inflados sem afetar um
 * workbook legítimo (tipicamente 3:1 a 30:1).
 */
export const XLSX_MAX_EXPANSION_RATIO = 128;

/** Número máximo de entradas no ZIP — um workbook tem dúzias de partes. */
export const XLSX_MAX_ZIP_ENTRIES = 1000;

/**
 * Teto duro do intervalo DECLARADO de uma folha (linhas × colunas) antes de
 * materializar células. Uma lista de fornecedor é 10 000 linhas × algumas
 * dezenas de colunas; uma folha "gigante" (Excel permite 16,7M células) é
 * recusada em vez de consumida.
 */
export const XLSX_MAX_SHEET_CELLS = 2_000_000;

// ─── Transporte browser → API (base64 estrito) ────────────

/** Base64 canónico: charset estrito, padding só no fim, comprimento múltiplo de 4. */
const STRICT_BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Decodifica base64 estritamente (o que o browser produz com `btoa`):
 * charset `[A-Za-z0-9+/]`, padding canónico `=` só no fim, comprimento
 * múltiplo de 4. Qualquer desvio → null (nada é tentado com coerção).
 *
 * O resultado são os BYTES reais do ficheiro — é sobre eles que o servidor
 * aplica o teto de 5 MB e calcula o SHA-256; a string base64 nunca serve de
 * substituto dos bytes (nem de hash, nem de tamanho).
 */
export function decodeBase64Strict(input: string): Uint8Array | null {
  if (typeof input !== "string" || input.length === 0) return null;
  if (input.length % 4 !== 0) return null;
  if (!STRICT_BASE64_RE.test(input)) return null;
  const pad = input.endsWith("==") ? 2 : input.endsWith("=") ? 1 : 0;
  const expected = (input.length * 3) / 4 - pad;
  let bin: string;
  try {
    bin = atob(input);
  } catch {
    return null;
  }
  if (bin.length !== expected) return null;
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ─── Assinatura ZIP/OOXML (antes de descompressão) ────────

/** Magic do local file header ZIP: `PK\x03\x04`. */
function isZipSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/**
 * Audição do container ZIP usando APENAS o diretório central — nenhuma
 * entrada é descomprimida aqui. Recusa:
 *  - diretório ilegível/corrompido (XLSX_CORRUPT);
 *  - número excessivo de entradas (XLSX_TOO_LARGE);
 *  - zip bomb: tamanho declarado total descomprimido acima de
 *    min(64 MB, 128 × tamanho comprimido) (XLSX_TOO_LARGE);
 *  - macros: `vbaProject.bin` em qualquer parte (XLSX_INVALID);
 *  - ausência da assinatura OOXML de workbook (XLSX_INVALID).
 */
function auditZipContainer(bytes: Uint8Array): void {
  let parsed: { FullPaths?: string[]; FileIndex?: { name?: string; size?: number }[] };
  try {
    parsed = XLSX.CFB.parse(bytes, { WTF: true }) as typeof parsed;
  } catch {
    throw new SupplierCsvError("XLSX_CORRUPT");
  }

  const paths = (parsed.FullPaths ?? []).map((p) => p.replace(/^Root Entry\//, ""));
  const entries = paths.filter((p) => p.length > 0 && p !== "/");
  // O CFB.parse antepõe "Root Entry/" a cada parte e inclui sempre um
  // marcador interno com carácter de controlo (ex.: "\u0001Sh33tJ5"). Num ZIP
  // ÍNTEGRO as partes reais (nomes sem caracteres 0x00–0x1F) acompanham o
  // marcador. Num ZIP TRUNCADO (EOCD/diretório central perdidos) o parse faz
  // fallback para o modo binário OLE2 e só "lê" o marcador — zero partes
  // reais enumeráveis: o ficheiro afirma ser ZIP mas está danificado.
  const realEntries = entries.filter((p) => !/[\u0000-\u001f]/.test(p));
  if (realEntries.length === 0) throw new SupplierCsvError("XLSX_CORRUPT");
  if (entries.length > XLSX_MAX_ZIP_ENTRIES) throw new SupplierCsvError("XLSX_TOO_LARGE");

  const declaredUncompressed = (parsed.FileIndex ?? []).reduce(
    (sum, entry) => sum + (typeof entry.size === "number" && entry.size > 0 ? entry.size : 0),
    0
  );
  const maxAllowed = Math.min(XLSX_MAX_UNCOMPRESSED_BYTES, XLSX_MAX_EXPANSION_RATIO * bytes.length);
  if (declaredUncompressed > maxAllowed) throw new SupplierCsvError("XLSX_TOO_LARGE");

  if (entries.some((p) => /(^|\/)vbaProject\.bin$/i.test(p))) {
    throw new SupplierCsvError("XLSX_INVALID");
  }

  // Assinatura mínima de workbook OOXML — sem isto, um ZIP qualquer com
  // extensão .xlsx passaria por "ficheiro Excel".
  if (!entries.includes("[Content_Types].xml") || !entries.includes("xl/workbook.xml")) {
    throw new SupplierCsvError("XLSX_INVALID");
  }
}

// ─── Célula → texto compatível com o normalizador ─────────

type DenseCell = { t?: string; v?: unknown; f?: string; e?: string; w?: string } | null | undefined;

/**
 * Uma célula → o texto que o normalizador C.3.1 irá interpretar.
 *
 * Regras de segurança:
 *  - número → `String(n)` do valor armazenado (o normalizador decide a leitura
 *    pt-PT/en-GB e reporta ambiguidade, exatamente como no CSV);
 *  - string → o texto tal como está (incluindo números escritos como texto);
 *  - boolean → "true"/"false" (o normalizador rejeita em campos numéricos);
 *  - data → ISO (um serial de data nunca passa por número "a olho nu");
 *  - fórmulas: só o valor CACHED existe nesta leitura (`cellFormula: false`
 *    impede que o texto da fórmula chegue aqui); sem cache → vazio;
 *  - erro (`t: "e"`, ex. `#DIV/0!`) e tipos desconhecidos → vazio — um código
 *    de erro Excel nunca vira chave de matching nem valor de snapshot.
 */
function cellToText(cell: DenseCell): string {
  if (!cell || typeof cell !== "object") return "";
  const v = cell.v;
  switch (cell.t) {
    case "n":
      return typeof v === "number" && Number.isFinite(v) ? String(v) : "";
    case "s":
    case "str":
      return typeof v === "string" ? v : "";
    case "b":
      return v === true ? "true" : v === false ? "false" : "";
    case "d":
      return v instanceof Date && !Number.isNaN(v.getTime()) ? v.toISOString() : "";
    case "e":
    default:
      return "";
  }
}

// ─── Folha: primeira utilizável, primeira linha útil ──────

interface UsableSheet {
  /** Sheet em modo denso (`!data`), intervalo decodificado. */
  range: { s: { r: number; c: number }; e: { r: number; c: number } };
  rows: (DenseCell[] | null)[];
}

/**
 * Encontra a PRIMEIRA worksheet não vazia (ordem do workbook) e devolve as
 * suas linhas em modo denso. Folhas sem `!ref` (ou sem qualquer célula com
 * valor) não são utilizáveis. O intervalo declarado é validado antes de
 * materializar qualquer coisa.
 */
function pickFirstUsableSheet(wb: XLSX.WorkBook): UsableSheet | null {
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws || typeof ws["!ref"] !== "string") continue;
    const range = XLSX.utils.decode_range(ws["!ref"]);
    const declaredCells = (range.e.r - range.s.r + 1) * (range.e.c - range.s.c + 1);
    if (declaredCells > XLSX_MAX_SHEET_CELLS) throw new SupplierCsvError("XLSX_TOO_LARGE");

    const dense = (ws as unknown as { "!data"?: (DenseCell[] | null)[] })["!data"];
    let hasValue = false;
    for (let R = range.s.r; R <= range.e.r && !hasValue; R += 1) {
      const row = dense?.[R];
      if (!row) continue;
      for (let C = range.s.c; C <= range.e.c; C += 1) {
        if (cellToText(row[C]).trim() !== "") { hasValue = true; break; }
      }
    }
    if (hasValue) return { range, rows: dense ?? [] };
  }
  return null;
}

/** Uma linha (índices absolutos) → o texto de cada coluna do intervalo. */
function rowToTexts(sheet: UsableSheet, R: number): string[] {
  const { s, e } = sheet.range;
  const row = sheet.rows[R];
  const out: string[] = [];
  for (let C = s.c; C <= e.c; C += 1) out.push(cellToText(row?.[C]).trim());
  return out;
}

// ─── Parser ──────────────────────────────────────────────

/**
 * Bytes XLSX → SupplierFileParse (mesmo contrato do CSV).
 *
 * `delimiter` é null: separador não se aplica a XLSX (o perfil persistido
 * guarda null, a UI não mostra separador, o pipeline a jusante nunca o lê).
 *
 * Lança SupplierCsvError com códigos seguros (ver error-messages.ts):
 * XLSX_INVALID, XLSX_CORRUPT, XLSX_TOO_LARGE, XLSX_TOO_MANY_ROWS,
 * XLSX_NO_USABLE_SHEET, XLSX_NO_DATA, CSV_MISSING_KEY_COLUMN,
 * DUPLICATE_MAPPING:*.
 */
export function parseSupplierXlsx(bytes: Uint8Array, overrides?: Record<string, string>): SupplierFileParse {
  if (!bytes || bytes.byteLength === 0) throw new SupplierCsvError("XLSX_INVALID");
  // Teto de tamanho ANTES de qualquer parsing pesado (a rota já o aplica;
  // esta verificação torna o parser seguro mesmo chamado em contexto direto).
  if (bytes.byteLength > XLSX_MAX_SIZE_BYTES) throw new SupplierCsvError("XLSX_TOO_LARGE");
  if (!isZipSignature(bytes)) throw new SupplierCsvError("XLSX_INVALID");
  auditZipContainer(bytes);

  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(bytes as unknown as ArrayBuffer, {
      type: "array",
      dense: true,
      WTF: true,
      // Segurança: nada além de valores armazenados chega ao normalizador.
      cellFormula: false, // fórmulas: nem lidas, nem avaliadas — só o valor cached
      cellStyles: false,
      cellNF: false,
      cellDates: true,    // datas → Date → ISO (nunca o serial cru)
      bookVBA: false,     // macros: recusadas na audição e nem tentadas aqui
    });
    // Hyperlinks, se existirem, ficam em ws["!links"] como dados inertes —
    // este parser nunca os lê, e a biblioteca não faz fetch/XHR no caminho
    // de leitura (nada é resolvido, external links incluídos).
  } catch {
    throw new SupplierCsvError("XLSX_CORRUPT");
  }

  const sheet = pickFirstUsableSheet(wb);
  if (!sheet) throw new SupplierCsvError("XLSX_NO_USABLE_SHEET");
  const { s, e } = sheet.range;

  // Headers = primeira linha NÃO VAZIA da folha (regra documentada da etapa).
  let headerRow = -1;
  for (let R = s.r; R <= e.r; R += 1) {
    if (rowToTexts(sheet, R).some((t) => t !== "")) { headerRow = R; break; }
  }
  if (headerRow === -1) throw new SupplierCsvError("XLSX_NO_USABLE_SHEET");

  // Colunas: as do intervalo, com os vazio-traseiros cortados (um cabeçalho
  // sem nome no fim não é uma coluna). Vazios internos mantêm o "" — a
  // máquina de mapping ignora-os, como no CSV.
  const fullHeaders = rowToTexts(sheet, headerRow);
  let colCount = fullHeaders.length;
  while (colCount > 1 && fullHeaders[colCount - 1] === "") colCount -= 1;
  const headers = fullHeaders.slice(0, colCount);

  // A MESMA máquina de mapping do CSV (aliases + overrides + DUPLICATE_MAPPING).
  const { mapping, ignoredColumns } = buildSupplierMapping(headers, overrides);
  const hasKeyColumn = Object.values(mapping).some(
    (f) => f === "supplierSku" || f === "ean" || f === "internalSku"
  );
  if (!hasKeyColumn) throw new SupplierCsvError("CSV_MISSING_KEY_COLUMN");

  // Contagem de linhas de dados (linhas totalmente vazias são saltadas, como
  // no CSV: skip_empty_lines) — antes de normalizar qualquer coisa.
  const dataRowNumbers: number[] = [];
  for (let R = headerRow + 1; R <= e.r; R += 1) {
    if (rowToTexts(sheet, R).some((t) => t !== "")) dataRowNumbers.push(R + 1); // 1-based, a linha real no Excel
  }
  if (dataRowNumbers.length === 0) throw new SupplierCsvError("XLSX_NO_DATA");
  if (dataRowNumbers.length > SUPPLIER_IMPORT_MAX_ROWS) throw new SupplierCsvError("XLSX_TOO_MANY_ROWS");

  // Mesma normalização linha a linha do CSV: valores já validados e com os
  // limites de snapshot aplicados; nada a jusante muda.
  const rows: NormalizedSupplierRow[] = dataRowNumbers.map((absRow) => {
    const texts = rowToTexts(sheet, absRow - 1);
    const record: Record<string, string> = {};
    headers.forEach((h, i) => { record[h] = texts[i] ?? ""; });
    return normalizeSupplierRow(absRow, applyMapping(record, mapping));
  });

  return { headers, delimiter: null, mapping, ignoredColumns, rows };
}
