/**
 * C.3.1 — CSV → NormalizedSupplierRow.
 *
 * This is the ONLY place a supplier file is turned into typed data. Matching,
 * preview and apply all consume NormalizedSupplierRow, which is what lets
 * C.3.2 hang an XML/feed source off the same pipeline instead of writing a
 * second importer: a feed parser produces NormalizedSupplierRow rows and
 * everything downstream already exists.
 *
 * Parsing itself reuses src/lib/csv.ts (delimiter / BOM / quote handling and
 * the 10 000 row ceiling) — no second CSV engine.
 *
 * ── Ambiguity is resolved by a documented rule and then SHOWN ──
 * pt-PT files write "1.234,56", en-GB files write "1,234.56", and a lone
 * "1.234" is genuinely ambiguous. The rules live in extractNumericToken();
 * whenever a thousands/decimal reading had to be chosen, the row carries a
 * warning so the operator sees the interpretation in the preview and confirms
 * it before apply. Nothing is decided silently.
 *
 * ── A supplier list has no selling price ──
 * "Preço" in a supplier file is a COST, not the PVP. The `price` canonical
 * field (from the generic csv.ts vocabulary) is therefore never written into
 * the pipeline: it is reported as ignored, and products.price stays owned by
 * the C.1/C.2 pricing engine (or by a human, in manual mode).
 */
import { createHash } from "crypto";
import { applyMapping, autoMapHeaders, normalizeHeader, parseCSV } from "@/lib/csv";
import { isValidGTIN } from "@/lib/validation";
import { SNAPSHOT_COST_MAX, SNAPSHOT_INT4_MAX, SUPPLIER_IMPORT_MAX_ROWS } from "./constants";

/** The only canonical fields a supplier import understands. */
export const SUPPLIER_FIELDS = [
  "supplierSku", "ean", "internalSku", "name", "costPrice", "stock", "leadTimeDays",
] as const;
export type SupplierField = (typeof SUPPLIER_FIELDS)[number];

/** Max lengths, mirroring supplier_import_rows. */
export const SNAPSHOT_LIMITS = { sku: 100, ean: 50, name: 255 } as const;

/**
 * Supplier-file header aliases, layered on top of csv.ts's generic table.
 * Keys are compareHeader() values.
 *
 * ── A bare code column is the SUPPLIER's code, never our internal SKU ──
 * A supplier list labels its own article number "SKU", "Código", "Ref",
 * "Referência" or "RefSAP". Those words describe the file, not MDTech's
 * catalogue, so they map to `supplierSku` — level 1, scoped to the supplier
 * being imported. `internalSku` is products.sku, MDTech's global reference, and
 * is only ever filled by a header that says it is internal (or by the operator's
 * explicit mapping). Reading a supplier's code as a global internal SKU would
 * let supplier B match, and write cost/stock into, supplier A's product.
 */
const SUPPLIER_HEADER_ALIASES: Record<string, string> = {
  // the supplier's own article number (generic words belong to the file)
  sku: "supplierSku",
  codigo: "supplierSku",
  ref: "supplierSku",
  referencia: "supplierSku",
  refsap: "supplierSku",
  artigo: "supplierSku",
  skufornecedor: "supplierSku",
  suppliersku: "supplierSku",
  refsupplier: "supplierSku",
  refsornecedor: "supplierSku",
  referenciasupplier: "supplierSku",
  referenciafornecedor: "supplierSku",
  codigofornecedor: "supplierSku",
  codigodofornecedor: "supplierSku",
  skudofornecedor: "supplierSku",
  referenciadofornecedor: "supplierSku",
  // MDTech's catalogue SKU: only when the header says so explicitly
  internalsku: "internalSku",
  internalid: "internalSku",
  codigointerno: "internalSku",
  refinterna: "internalSku",
  referenciainterna: "internalSku",
  skuinterno: "internalSku",
  skumdtech: "internalSku",
  codigomdtech: "internalSku",
  ean: "ean",
  ean13: "ean",
  ean8: "ean",
  gtin: "ean",
  codigobarras: "ean",
  cpv: "ean",
  name: "name",
  nome: "name",
  designacao: "name",
  designacaodoproduto: "name",
  nomedoproduto: "name",
  descricao: "name",
  produto: "name",
  precocusto: "costPrice",
  precodecusto: "costPrice",
  custo: "costPrice",
  costprice: "costPrice",
  purchaseprice: "costPrice",
  pricepurchase: "costPrice",
  stock: "stock",
  quantidade: "stock",
  quantidadeemstock: "stock",
  qty: "stock",
  qtd: "stock",
  dispo: "stock",
  disponibilidade: "stock",
  prazoentrega: "leadTimeDays",
  leadtime: "leadTimeDays",
  leadtimedays: "leadTimeDays",
};

/** Header → lookup key in the alias table. */
function headerKey(header: string): string {
  return normalizeHeader(header).replace(/_+/g, "");
}

export interface SupplierImportIssue {
  field: string;
  value: string;
  /** Machine-readable and stable: surfaced in the UI, asserted in tests. */
  code: string;
  message: string;
  /** error → the row is never applied. warning → reported, row still applies. */
  severity: "error" | "warning";
}

/**
 * The canonical unit of the supplier import pipeline. Every money/number here
 * is already validated and rounded to exactly what will be written, so the
 * preview and the apply can never disagree.
 */
export interface NormalizedSupplierRow {
  /** Line number in the source file (header = line 1), so reports point at the file. */
  rowNumber: number;
  supplierSku: string | null;
  ean: string | null;
  internalSku: string | null;
  /** Snapshot of the designation as it arrived. NEVER a matching key. */
  name: string | null;
  /** Decimal string with exactly 2 fraction digits, or null when absent. */
  costPrice: string | null;
  stock: number | null;
  leadTimeDays: number | null;
  issues: SupplierImportIssue[];
}

export interface SupplierCsvParse {
  headers: string[];
  delimiter: string;
  /** CSV header → canonical supplier field. */
  mapping: Record<string, string>;
  /** Headers recognised by the generic CSV vocabulary but not applicable here. */
  ignoredColumns: string[];
  rows: NormalizedSupplierRow[];
}

/** File-level failure. `code` is what the API returns to the operator. */
export class SupplierCsvError extends Error {
  constructor(readonly code: string, readonly httpStatus = 400) {
    super(code);
    this.name = "SupplierCsvError";
  }
}

/** sha256 (hex) of the exact bytes the operator previewed. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function byteLengthUtf8(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Header → field mapping for a supplier file. The operator's own `overrides`
 * win over auto-detection, and are validated against the supplier vocabulary.
 */
export function buildSupplierMapping(
  headers: string[],
  overrides?: Record<string, string>
): { mapping: Record<string, string>; ignoredColumns: string[] } {
  const generic = autoMapHeaders(headers);
  const mapping: Record<string, string> = {};
  const ignoredColumns: string[] = [];

  for (const header of headers) {
    const requested = overrides?.[header];
    if (requested !== undefined) {
      if ((SUPPLIER_FIELDS as readonly string[]).includes(requested)) mapping[header] = requested;
      else ignoredColumns.push(header);
      continue;
    }
    const alias = SUPPLIER_HEADER_ALIASES[headerKey(header)];
    if (alias) {
      mapping[header] = alias;
      continue;
    }
    // Recognised by the generic catalogue mapper (e.g. "Preço" → price) but
    // outside the supplier vocabulary. It is carried through ONLY so each row
    // can warn about it — never applied to products.price.
    if (generic[header]) {
      ignoredColumns.push(header);
      if (generic[header] === "price") mapping[header] = "price";
    }
  }

  // Two headers mapped to the same field would make a row ambiguous.
  const claimed: Record<string, string> = {};
  for (const [header, field] of Object.entries(mapping)) {
    if (field === "price") continue; // deliberately not a supplier field
    if (claimed[field]) {
      throw new SupplierCsvError(`DUPLICATE_MAPPING:${field}`, 400);
    }
    claimed[field] = header;
  }
  return { mapping, ignoredColumns };
}

// ─── Numbers ─────────────────────────────────────────────

export interface NumericToken {
  /** Plain "digits[.digits]" string, or null when the value is unusable. */
  value: string | null;
  /** True when a thousands-vs-decimal reading had to be chosen. */
  ambiguous: boolean;
}

const NO_TOKEN: NumericToken = { value: null, ambiguous: false };

/**
 * Extract a numeric token from a free-form supplier cell.
 *
 * 1. both separators present → the LAST one is the decimal separator, the
 *    other is the thousands separator ("1.234,56" → 1234.56);
 * 2. a single separator whose groups are all exactly 3 digits ("1.234",
 *    "12.500", "1.234.567") → read as thousands, because a currency amount
 *    never legitimately has 3 decimals. A single group is ambiguous → flagged;
 * 3. otherwise the separator is the decimal separator ("12,50" → 12.50).
 */
export function extractNumericToken(raw: string | undefined | null): NumericToken {
  if (raw === null || raw === undefined) return NO_TOKEN;
  let s = String(raw)
    .replace(/\u00a0/g, "")
    .replace(/\s+/g, "")
    .replace(/(€|usd|eur)/gi, "");
  if (!s) return NO_TOKEN;
  const negative = s.startsWith("-");
  s = s.replace(/^-+/, "");
  if (!s || !/^\d[0-9.,]*$/.test(s)) return NO_TOKEN;

  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  let ambiguous = false;

  if (hasComma && hasDot) {
    const decimal = s.lastIndexOf(",") > s.lastIndexOf(".") ? "," : ".";
    const thousands = decimal === "," ? "." : ",";
    // A thousands separator after the decimal one is nonsense.
    if (s.indexOf(thousands) > s.lastIndexOf(decimal)) return NO_TOKEN;
    const parts = s.split(decimal);
    if (parts.length !== 2) return NO_TOKEN;
    const [intRaw, fracRaw] = parts;
    if (fracRaw.includes(thousands)) return NO_TOKEN;
    const groups = intRaw.split(thousands);
    if (!/^\d{1,3}$/.test(groups[0])) return NO_TOKEN;
    for (const g of groups.slice(1)) if (!/^\d{3}$/.test(g)) return NO_TOKEN;
    if (fracRaw && !/^\d+$/.test(fracRaw)) return NO_TOKEN;
    s = groups.join("") + (fracRaw ? `.${fracRaw}` : "");
  } else if (hasComma || hasDot) {
    const sep = hasComma ? "," : ".";
    const parts = s.split(sep);
    if (!/^\d+$/.test(parts[0])) return NO_TOKEN;
    const rest = parts.slice(1);
    if (rest.some((p) => !/^\d+$/.test(p))) return NO_TOKEN;
    const grouped = rest.length > 0 && rest.every((p) => p.length === 3);
    if (grouped) {
      s = parts.join("");
      ambiguous = rest.length === 1;
    } else {
      if (parts.length !== 2) return NO_TOKEN;
      s = `${parts[0]}.${parts[1]}`;
    }
  }

  if (!/^\d+(\.\d+)?$/.test(s)) return NO_TOKEN;
  return { value: negative && s.replace(".", "") !== "0" ? `-${s}` : s, ambiguous };
}

export interface MoneyResult {
  value: string | null;
  ambiguous: boolean;
}

/**
 * Money → decimal string with exactly 2 fraction digits, rounding half-up on
 * the first dropped digit using integer cents only. Negative or unparseable
 * input yields null: a cost is never invented.
 */
export function parseMoney(raw: string | undefined | null): MoneyResult {
  const token = extractNumericToken(raw);
  if (token.value === null || token.value.startsWith("-")) {
    return { value: null, ambiguous: token.ambiguous };
  }
  const [intPart, fracPart = ""] = token.value.split(".");
  const cents = Number(intPart) * 100 + Number((fracPart + "00").slice(0, 2));
  if (!Number.isSafeInteger(cents)) return { value: null, ambiguous: token.ambiguous };
  const dropped = fracPart.slice(2);
  const rounded = dropped && Number(dropped[0]) >= 5 ? cents + 1 : cents;
  if (rounded > Number.MAX_SAFE_INTEGER) return { value: null, ambiguous: token.ambiguous };
  return {
    value: `${Math.floor(rounded / 100)}.${String(rounded % 100).padStart(2, "0")}`,
    ambiguous: token.ambiguous,
  };
}

/** Non-negative integer ("12" ✓, "12.0" ✓, "12,5" ✗). */
export function parseInteger(raw: string | undefined | null): { value: number | null; ambiguous: boolean } {
  const token = extractNumericToken(raw);
  if (token.value === null || token.value.startsWith("-")) return { value: null, ambiguous: token.ambiguous };
  const [intPart, fracPart = ""] = token.value.split(".");
  if (!/^\d+$/.test(intPart)) return { value: null, ambiguous: token.ambiguous };
  if (fracPart && /[1-9]/.test(fracPart)) return { value: null, ambiguous: token.ambiguous };
  const value = Number(intPart);
  return Number.isSafeInteger(value) ? { value, ambiguous: token.ambiguous } : { value: null, ambiguous: token.ambiguous };
}

/**
 * Exact cents of a canonical "digits[.digits]" decimal string, as BigInt — so a
 * numeric(10,2) ceiling comparison never depends on floating point. parseMoney
 * output always has exactly 2 fraction digits, but a plain integer part
 * ("42") is accepted too.
 */
function centsOf(value: string): bigint {
  const [intPart, fracPart = "00"] = value.split(".");
  return BigInt(intPart || "0") * BigInt(100) + BigInt((fracPart + "00").slice(0, 2));
}

// ─── Rows ────────────────────────────────────────────────

function snapshotText(raw: string, max: number): { value: string; truncated: boolean } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? { value: trimmed.slice(0, max), truncated: true } : { value: trimmed, truncated: false };
}

/**
 * A matching key is NEVER cut to fit the column: truncating would fold two
 * different codes into one invisible key, and that key would then match (or
 * create) the wrong product. An over-long key is refused and the row is
 * reported — the same treatment an invalid EAN already gets.
 */
function snapshotKey(raw: string, limit: number): { value: string | null; tooLong: boolean } {
  const trimmed = raw.trim();
  if (!trimmed) return { value: null, tooLong: false };
  if (trimmed.length > limit) return { value: null, tooLong: true };
  return { value: trimmed, tooLong: false };
}

/**
 * One mapped CSV row → NormalizedSupplierRow. Pure: no database, no I/O.
 * `mapped` comes from applyMapping(), so it only holds canonical fields; the
 * `price` key is carried through solely to warn about it.
 *
 * ── A value that cannot fit its snapshot column is REFUSED per row ──
 * The snapshot is written to supplier_import_rows, whose columns are varchar /
 * decimal(10,2) / integer. A value beyond those ceilings must never reach the
 * INSERT: it would throw mid-preview and fail the whole file. It is rejected
 * here instead — reported with its own code and never stored — so the preview
 * keeps going and the operator fixes only the offending line. Values are never
 * truncated or silently corrected to make them fit.
 */
export function normalizeSupplierRow(rowNumber: number, mapped: Record<string, string>): NormalizedSupplierRow {
  const issues: SupplierImportIssue[] = [];
  const error = (field: string, value: string, code: string, message: string) =>
    issues.push({ field, value, code, message, severity: "error" });
  const warning = (field: string, value: string, code: string, message: string) =>
    issues.push({ field, value, code, message, severity: "warning" });
  const raw = (key: string) => (mapped[key] ?? "").trim();

  const supplierKey = snapshotKey(raw("supplierSku"), SNAPSHOT_LIMITS.sku);
  const internalKey = snapshotKey(raw("internalSku"), SNAPSHOT_LIMITS.sku);
  const supplierSku = supplierKey.value;
  const internalSku = internalKey.value;
  if (supplierKey.tooLong) {
    error("supplierSku", raw("supplierSku").slice(0, 120), "SUPPLIER_SKU_TOO_LONG",
      `SKU do fornecedor com mais de ${SNAPSHOT_LIMITS.sku} caracteres — não é cortado; a linha não é aplicada`);
  }
  if (internalKey.tooLong) {
    error("internalSku", raw("internalSku").slice(0, 120), "INTERNAL_SKU_TOO_LONG",
      `SKU interno com mais de ${SNAPSHOT_LIMITS.sku} caracteres — não é cortado; a linha não é aplicada`);
  }
  const name = snapshotText(raw("name"), SNAPSHOT_LIMITS.name);
  if (name?.truncated) {
    warning("name", raw("name"), "NAME_TRUNCATED", `Designação limitada a ${SNAPSHOT_LIMITS.name} caracteres no snapshot`);
  }

  let ean: string | null = null;
  let eanTooLong = false;
  const eanRaw = raw("ean").replace(/[\s\u00a0]/g, "");
  if (eanRaw) {
    // GTIN-12 (UPC-A) is canonically written as GTIN-13 with a leading zero.
    const normalized = /^\d{12}$/.test(eanRaw) ? `0${eanRaw}` : eanRaw;
    if (normalized.length > SNAPSHOT_LIMITS.ean) {
      // Never truncated and never stored: the varchar(50) snapshot column would
      // refuse it and sink the whole preview. The row is reported instead.
      eanTooLong = true;
      error("ean", eanRaw, "EAN_TOO_LONG",
        `EAN demasiado longo (máx. ${SNAPSHOT_LIMITS.ean} caracteres) — não é gravado; a linha não é aplicada`);
    } else {
      ean = normalized;
      if (!isValidGTIN(ean)) error("ean", eanRaw, "INVALID_GTIN", "EAN/GTIN com checksum inválido");
    }
  }

  let costPrice: string | null = null;
  const costRaw = raw("costPrice");
  if (costRaw) {
    const parsed = parseMoney(costRaw);
    if (parsed.value === null) {
      error("costPrice", costRaw, "INVALID_COST", "Preço de custo inválido (decimal >= 0 esperado)");
    } else if (centsOf(parsed.value) > centsOf(SNAPSHOT_COST_MAX)) {
      // decimal(10,2) ceiling reached from BELOW the preview — refusing beats a
      // 500 on the INSERT. Never truncated to make it fit.
      error("costPrice", costRaw, "COST_OUT_OF_RANGE",
        `Custo acima do máximo suportado (${SNAPSHOT_COST_MAX} €) — não é truncado; a linha não é aplicada`);
    } else {
      costPrice = parsed.value;
      if (parsed.ambiguous) warning("costPrice", costRaw, "AMBIGUOUS_NUMBER_FORMAT", `Custo lido como ${parsed.value}€`);
    }
  }

  let stock: number | null = null;
  const stockRaw = raw("stock");
  if (stockRaw) {
    const parsed = parseInteger(stockRaw);
    if (parsed.value === null) {
      error("stock", stockRaw, "INVALID_STOCK", "Stock inválido (inteiro >= 0 esperado)");
    } else if (parsed.value > SNAPSHOT_INT4_MAX) {
      // The snapshot column is int4; an out-of-range stock would abort the
      // preview INSERT. Refused per row instead of truncating the number.
      error("stock", stockRaw, "STOCK_OUT_OF_RANGE",
        `Stock acima do máximo suportado (${SNAPSHOT_INT4_MAX}) — não é truncado; a linha não é aplicada`);
    } else {
      stock = parsed.value;
      if (parsed.ambiguous) warning("stock", stockRaw, "AMBIGUOUS_NUMBER_FORMAT", `Stock lido como ${parsed.value}`);
    }
  }

  let leadTimeDays: number | null = null;
  const leadRaw = raw("leadTimeDays");
  if (leadRaw) {
    const parsed = parseInteger(leadRaw);
    if (parsed.value === null) {
      error("leadTimeDays", leadRaw, "INVALID_LEAD_TIME", "Prazo de entrega inválido (inteiro >= 0 esperado)");
    } else if (parsed.value > SNAPSHOT_INT4_MAX) {
      // Same int4 ceiling as stock: per-row error, never a whole-preview crash.
      error("leadTimeDays", leadRaw, "LEAD_TIME_OUT_OF_RANGE",
        `Prazo de entrega acima do máximo suportado (${SNAPSHOT_INT4_MAX}) — não é truncado; a linha não é aplicada`);
    } else {
      leadTimeDays = parsed.value;
    }
  }

  if (!supplierSku && !internalSku && !ean && !supplierKey.tooLong && !internalKey.tooLong && !eanTooLong) {
    error("row", "", "MISSING_IDENTIFIER_KEY", "Linha sem SKU do fornecedor, EAN ou SKU interno — impossível de identificar");
  }

  // A supplier list carries no selling price: never mapped, never written.
  const priceRaw = raw("price");
  if (priceRaw) {
    warning("price", priceRaw, "PRICE_COLUMN_IGNORED", "Coluna de preço ignorada: uma lista de fornecedor nunca escreve products.price");
  }

  return {
    rowNumber,
    supplierSku,
    ean,
    internalSku,
    name: name?.value ?? null,
    costPrice,
    stock,
    leadTimeDays,
    issues,
  };
}

/**
 * Whole CSV → normalized rows plus the mapping that produced them.
 * Throws SupplierCsvError for file-level problems (empty, unmappable, too big).
 */
export function parseSupplierCsv(csvText: string, overrides?: Record<string, string>): SupplierCsvParse {
  if (!csvText || !csvText.trim()) throw new SupplierCsvError("CSV_EMPTY");

  let parsed: ReturnType<typeof parseCSV>;
  try {
    parsed = parseCSV(csvText);
  } catch (e) {
    throw new SupplierCsvError(e instanceof Error ? e.message : "CSV_PARSE_ERROR");
  }

  const { mapping, ignoredColumns } = buildSupplierMapping(parsed.headers, overrides);
  const hasKeyColumn = Object.values(mapping).some((f) => f === "supplierSku" || f === "ean" || f === "internalSku");
  if (!hasKeyColumn) throw new SupplierCsvError("CSV_MISSING_KEY_COLUMN");
  if (parsed.rows.length === 0) throw new SupplierCsvError("CSV_NO_DATA");
  if (parsed.rows.length > SUPPLIER_IMPORT_MAX_ROWS) throw new SupplierCsvError("CSV_TOO_MANY_ROWS");

  // `price` is mapped only so normalizeSupplierRow can warn about it.
  const applied = parsed.rows.map((row, i) => normalizeSupplierRow(i + 2, applyMapping(row, mapping)));
  return { headers: parsed.headers, delimiter: parsed.delimiter, mapping, ignoredColumns, rows: applied };
}
