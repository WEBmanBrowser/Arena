/**
 * CSV parsing utilities using csv-parse/sync.
 * Supports: comma, semicolon, quoted fields, BOM, CRLF.
 */
import { parse } from "csv-parse/sync";

export const CSV_MAX_SIZE = 5 * 1024 * 1024; // 5 MB
export const CSV_MAX_ROWS = 10000;

/** Detect delimiter from first line */
function detectDelimiter(firstLine: string): string {
  const semicolons = (firstLine.match(/;/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  return semicolons > commas ? ";" : ",";
}

/** Strip UTF-8 BOM */
function stripBOM(text: string): string {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

export interface ParsedCSV {
  headers: string[];
  rows: Record<string, string>[];
  delimiter: string;
}

/** Parse CSV text into structured records */
export function parseCSV(text: string): ParsedCSV {
  const cleaned = stripBOM(text.trim());
  if (!cleaned) throw new Error("CSV_EMPTY");

  const firstLine = cleaned.split(/\r?\n/)[0];
  const delimiter = detectDelimiter(firstLine);

  const records: string[][] = parse(cleaned, {
    delimiter,
    relax_column_count: true,
    skip_empty_lines: true,
    trim: true,
    relax_quotes: true,
  });

  if (records.length < 2) throw new Error("CSV_NO_DATA");
  if (records.length - 1 > CSV_MAX_ROWS) throw new Error("CSV_TOO_MANY_ROWS");

  const headers = records[0].map(h => h.replace(/^['"]|['"]$/g, "").trim());
  const rows = records.slice(1).map(row => {
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => { obj[h] = (row[i] || "").trim(); });
    return obj;
  });

  return { headers, rows, delimiter };
}

/** Normalize header for mapping: lowercase, strip accents, trim */
export function normalizeHeader(h: string): string {
  return h.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "").trim();
}

/** Known header aliases → canonical field name */
const HEADER_ALIASES: Record<string, string> = {
  sku: "sku", codigo: "sku", ref: "sku", referencia: "sku",
  ean: "ean", ean13: "ean", gtin: "ean", codigobarras: "ean",
  nome: "name", name: "name", descricao: "name", produto: "name",
  marca: "brand", brand: "brand",
  categoria: "category", category: "category", familia: "category",
  preco: "price", price: "price", pvp: "price",
  iva: "vatRate", vatrate: "vatRate", taxa: "vatRate",
  stock: "stock", quantidade: "stock", qty: "stock", qtd: "stock",
  stockminimo: "minStock", minstock: "minStock", minimumstock: "minStock",
  fornecedor: "supplier", supplier: "supplier",
  skufornecedor: "supplierSku", suppliersku: "supplierSku",
  precocusto: "costPrice", costprice: "costPrice", custo: "costPrice",
  leadtime: "leadTimeDays", leadtimedays: "leadTimeDays", prazo: "leadTimeDays",
};

/** Auto-map CSV headers to canonical fields */
export function autoMapHeaders(headers: string[]): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const h of headers) {
    const normalized = normalizeHeader(h);
    if (HEADER_ALIASES[normalized]) {
      mapping[h] = HEADER_ALIASES[normalized];
    }
  }
  return mapping;
}

/** Apply mapping to a row */
export function applyMapping(row: Record<string, string>, mapping: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [csvHeader, canonicalField] of Object.entries(mapping)) {
    if (row[csvHeader] !== undefined) {
      result[canonicalField] = row[csvHeader];
    }
  }
  return result;
}
