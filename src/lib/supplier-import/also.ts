/**
 * C.3.4.3.1 — ALSO file formats: pricelist + stock.
 *
 * Both are TSV (tab-separated) but differ:
 *  - pricelist-1.txt: NO header, fixed positional columns (10+), ~15k rows.
 *  - stock.txt:       WITH header, tab-separated, header-driven, ~15 255 rows.
 *
 * Both converge to SupplierFileParse → NormalizedSupplierRow[] and reuse the
 * existing matching/pricing/preview/apply pipeline (no second engine).
 *
 * Stock-only semantics (unknown ProductID → warning/ignored, never creation,
 * never price change) are enforced by the service after parsing (see
 * supplier-import-service.ts), but the parser preserves all normalized stock
 * metadata (AvailableNextDate/AvailableNextQuantity/Availability timestamp) even
 * if the product apply does not use it yet.
 */

import { isValidGTIN } from "@/lib/validation";
import {
  SupplierCsvError,
  type SupplierFileParse,
  type NormalizedSupplierRow,
  type SupplierImportIssue,
  SNAPSHOT_LIMITS,
  byteLengthUtf8,
} from "./normalize";
import { parseInteger, parseMoney } from "./normalize";
import { SUPPLIER_IMPORT_MAX_ROWS, SNAPSHOT_INT4_MAX, SNAPSHOT_COST_MAX } from "./constants";

// ─── Helpers ─────────────────────────────────────────────────

function stripBOM(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function centsOf(value: string): bigint {
  const [intPart, fracPart = "00"] = value.split(".");
  return BigInt(intPart || "0") * BigInt(100) + BigInt((fracPart + "00").slice(0, 2));
}

function snapshotKey(raw: string, limit: number): { value: string | null; tooLong: boolean } {
  const trimmed = raw.trim();
  if (!trimmed) return { value: null, tooLong: false };
  if (trimmed.length > limit) return { value: null, tooLong: true };
  return { value: trimmed, tooLong: false };
}

function snapshotText(raw: string, max: number): { value: string; truncated: boolean } | null {
  const t = raw.trim();
  if (!t) return null;
  return t.length > max ? { value: t.slice(0, max), truncated: true } : { value: t, truncated: false };
}

function isValidDateISO(raw: string): string | null {
  const norm = raw.replace(/\//g, "-").trim();
  const m = norm.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function parseDateField(raw: string, issues: SupplierImportIssue[]): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed === "-1" || trimmed === "-1.0" || trimmed === "-1,0") {
    issues.push({ field: "alsoAvailableNextDate", value: raw, code: "AVAILABLE_NEXT_QUANTITY_UNKNOWN", message: "Data futura não especificada (-1)", severity: "warning" });
    return null;
  }
  const parsed = isValidDateISO(trimmed);
  if (!parsed) {
    issues.push({ field: "alsoAvailableNextDate", value: raw, code: "INVALID_AVAILABLE_NEXT_DATE", message: `Data futura inválida "${trimmed}" — ignorada`, severity: "warning" });
    return null;
  }
  return parsed;
}

function parseAvailabilityTimestamp(dateRaw: string, timeRaw: string, issues: SupplierImportIssue[]): string | null {
  const d = dateRaw.trim();
  const t = timeRaw.trim();
  if (!d && !t) return null;
  if (d === "-1" || t === "-1") {
    issues.push({ field: "alsoAvailabilityTimestamp", value: `${dateRaw} ${timeRaw}`.trim(), code: "INVALID_AVAILABILITY_TIMESTAMP", message: "Timestamp de disponibilidade desconhecido (-1) — ignorado", severity: "warning" });
    return null;
  }
  // If both present, validate date and time
  let datePart: string | null = null;
  let timePart: string | null = null;
  if (d) {
    const parsedDate = isValidDateISO(d);
    if (!parsedDate) {
      issues.push({ field: "alsoAvailabilityTimestamp", value: d, code: "INVALID_AVAILABILITY_TIMESTAMP", message: `Data de disponibilidade inválida "${d}" — ignorada`, severity: "warning" });
      return null;
    }
    datePart = parsedDate;
  }
  if (t) {
    // time HH:MM or HH:MM:SS
    const tm = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!tm) {
      issues.push({ field: "alsoAvailabilityTimestamp", value: t, code: "INVALID_AVAILABILITY_TIMESTAMP", message: `Hora de disponibilidade inválida "${t}" — ignorada`, severity: "warning" });
      return null;
    }
    const hh = Number(tm[1]), mm = Number(tm[2]), ss = tm[3] ? Number(tm[3]) : null;
    if (hh > 23 || mm > 59 || (ss !== null && ss > 59)) {
      issues.push({ field: "alsoAvailabilityTimestamp", value: t, code: "INVALID_AVAILABILITY_TIMESTAMP", message: `Hora de disponibilidade inválida "${t}" — ignorada`, severity: "warning" });
      return null;
    }
    if (ss !== null) timePart = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
    else timePart = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  }
  if (datePart && timePart) return `${datePart} ${timePart}`;
  if (datePart) return datePart;
  // time alone without date is not a valid timestamptz — treat as warning and null (or keep raw? spec says AvailabilityDate+Time combined)
  issues.push({ field: "alsoAvailabilityTimestamp", value: t, code: "INVALID_AVAILABILITY_TIMESTAMP", message: `Hora sem data "${t}" — ignorada`, severity: "warning" });
  return null;
}

// ─── Pricelist (no header, positional) ────────────────────────

const PRICELIST_HEADERS = [
  "ProductID",
  "EuropeanArticleNumber",
  "CategoryText1",
  "CategoryText2",
  "CategoryText3",
  "Description",
  "AvailableQuantity",
  "NetPrice",
  "ManufacturerPartNumber",
  "ManufacturerName",
] as const;

/** Pricelist TSV without header -> SupplierFileParse */
export function parseAlsoPricelist(
  rawText: string | Uint8Array,
  _overrides?: Record<string, string>
): SupplierFileParse {
  const text = typeof rawText === "string" ? rawText : new TextDecoder("utf-8").decode(rawText);
  const cleaned = stripBOM(text);
  if (!cleaned.trim()) throw new SupplierCsvError("CSV_EMPTY");

  // Split preserving empty fields, handle CRLF
  const rawLines = cleaned.split(/\r?\n/);
  // Filter out trailing empty line after final newline but keep internal empties as skip
  const lines: { idx: number; raw: string }[] = [];
  rawLines.forEach((line, i) => {
    // Keep line as is for tab split; skip if completely empty/whitespace
    if (line.trim() === "") return;
    lines.push({ idx: i + 1, raw: line });
  });

  if (lines.length === 0) throw new SupplierCsvError("CSV_NO_DATA");
  if (lines.length > SUPPLIER_IMPORT_MAX_ROWS) throw new SupplierCsvError("CSV_TOO_MANY_ROWS");

  const rows: NormalizedSupplierRow[] = [];
  const ignoredColumns: string[] = [];

  for (const { idx, raw } of lines) {
    // Pricelist: tab-separated, preserve empty, no quoting needed.
    // Using simple split is correct for ALSO TSV (no quoted tabs observed).
    const cols = raw.split("\t");
    // If fewer than 10 cols, treat missing as empty; if more, extra are ignored (11+)
    // But if cols length < 10 and the line has no tabs at all, it's malformed TSV
    // We still produce a row with error, not fail file.
    const get = (i: number) => (cols[i] ?? "").trim();

    const rawSku = get(0);
    const rawEan = get(1);
    const rawCat1 = get(2);
    const rawCat2 = get(3);
    const rawCat3 = get(4);
    const rawDesc = get(5);
    const rawQty = get(6);
    const rawPrice = get(7);
    const rawMpn = get(8);
    const rawBrand = get(9);

    // Build mapped record for normalize logic (supplierSku, ean, name, stock, costPrice)
    const issues: SupplierImportIssue[] = [];
    const error = (field: string, value: string, code: string, message: string) =>
      issues.push({ field, value, code, message, severity: "error" });
    const warning = (field: string, value: string, code: string, message: string) =>
      issues.push({ field, value, code, message, severity: "warning" });

    // supplierSku
    const skuKey = snapshotKey(rawSku, SNAPSHOT_LIMITS.sku);
    let supplierSku: string | null = skuKey.value;
    if (skuKey.tooLong) {
      error("supplierSku", rawSku.slice(0, 120), "SUPPLIER_SKU_TOO_LONG", `SKU do fornecedor com mais de ${SNAPSHOT_LIMITS.sku} caracteres — não é cortado; a linha não é aplicada`);
      supplierSku = null;
    }
    // ean
    let ean: string | null = null;
    let eanTooLong = false;
    const eanRaw = rawEan.replace(/[\s\u00a0]/g, "");
    if (eanRaw) {
      const normalized = /^\\d{12}$/.test(eanRaw) ? `0${eanRaw}` : eanRaw;
      if (normalized.length > SNAPSHOT_LIMITS.ean) {
        eanTooLong = true;
        error("ean", eanRaw, "EAN_TOO_LONG", `EAN demasiado longo (máx. ${SNAPSHOT_LIMITS.ean} caracteres) — não é gravado; a linha não é aplicada`);
      } else {
        ean = normalized;
        if (!isValidGTIN(ean)) error("ean", eanRaw, "INVALID_GTIN", "EAN/GTIN com checksum inválido");
      }
    }
    // name
    const nameSnap = snapshotText(rawDesc, SNAPSHOT_LIMITS.name);
    if (nameSnap?.truncated) warning("name", rawDesc, "NAME_TRUNCATED", `Designação limitada a ${SNAPSHOT_LIMITS.name} caracteres no snapshot`);
    const name = nameSnap?.value ?? null;

    // stock
    let stock: number | null = null;
    if (rawQty) {
      const trimmed = rawQty.trim();
      if (trimmed === "-1" || trimmed === "-1.0" || trimmed === "-1,0") {
        stock = null;
        warning("stock", rawQty, "AVAILABLE_NEXT_QUANTITY_UNKNOWN", "Quantidade desconhecida (-1) — stock não atualizado");
      } else {
        const parsed = parseInteger(rawQty);
        if (parsed.value === null) {
          error("stock", rawQty, "INVALID_STOCK", "Stock inválido (inteiro >= 0 esperado)");
        } else if (parsed.value > SNAPSHOT_INT4_MAX) {
          error("stock", rawQty, "STOCK_OUT_OF_RANGE", `Stock acima do máximo suportado (${SNAPSHOT_INT4_MAX}) — não é truncado; a linha não é aplicada`);
        } else {
          stock = parsed.value;
          if (parsed.ambiguous) warning("stock", rawQty, "AMBIGUOUS_NUMBER_FORMAT", `Stock lido como ${parsed.value}`);
        }
      }
    }
    // cost
    let costPrice: string | null = null;
    if (rawPrice) {
      const parsed = parseMoney(rawPrice);
      if (parsed.value === null) {
        error("costPrice", rawPrice, "INVALID_COST", "Preço de custo inválido (decimal >= 0 esperado)");
      } else if (centsOf(parsed.value) > centsOf(SNAPSHOT_COST_MAX)) {
        error("costPrice", rawPrice, "COST_OUT_OF_RANGE", `Custo acima do máximo suportado (${SNAPSHOT_COST_MAX} €) — não é truncado; a linha não é aplicada`);
      } else {
        costPrice = parsed.value;
        if (parsed.ambiguous) warning("costPrice", rawPrice, "AMBIGUOUS_NUMBER_FORMAT", `Custo lido como ${parsed.value}€`);
      }
    }

    if (!supplierSku && !ean && !skuKey.tooLong && !eanTooLong) {
      error("row", "", "MISSING_IDENTIFIER_KEY", "Linha sem SKU do fornecedor, EAN ou SKU interno — impossível de identificar");
    }

    // ALSO-specific metadata (preserved, not validated strictly)
    const mpn = rawMpn ? rawMpn.trim().slice(0, 100) || null : null;
    const brand = rawBrand ? rawBrand.trim().slice(0, 255) || null : null;
    const catParts = [rawCat1, rawCat2, rawCat3].map((s) => s.trim()).filter(Boolean);
    const catPath = catParts.length ? catParts.join(" / ") : null;

    // Malformed detection: if line has no tabs but we expect at least 9 tabs, warn
    if (cols.length < 10) {
      // If the line literally has no tabs, it's likely not TSV — but for pricelist we accept missing trailing cols as empty.
      // Only error if ProductID itself is present but we have <10 cols and some middle required field missing due to bad delimiter?
      // We treat as warning for incomplete row, but keep row (already errors for missing sku if needed).
      // No extra error here to avoid double-reporting; the missing fields already produce MISSING_IDENTIFIER etc.
    }

    rows.push({
      rowNumber: idx,
      supplierSku,
      ean,
      internalSku: null,
      name,
      costPrice,
      stock,
      leadTimeDays: null,
      issues,
      alsoManufacturerPartNumber: mpn,
      alsoManufacturerName: brand,
      alsoCategoryPath: catPath,
    });
  }

  // For pricelist, headers are synthetic fixed list (for display/mapping audit)
  const headers = [...PRICELIST_HEADERS];
  const mapping: Record<string, string> = {
    ProductID: "supplierSku",
    EuropeanArticleNumber: "ean",
    CategoryText1: "alsoCategoryPath",
    CategoryText2: "alsoCategoryPath",
    CategoryText3: "alsoCategoryPath",
    Description: "name",
    AvailableQuantity: "stock",
    NetPrice: "costPrice",
    ManufacturerPartNumber: "alsoManufacturerPartNumber",
    ManufacturerName: "alsoManufacturerName",
  };
  // Ignored: 11+ cols
  // Detect if any row had >10 cols, mark as ignored
  const hasExtra = lines.some((l) => l.raw.split("\t").length > 10);
  if (hasExtra) ignoredColumns.push("Colunas adicionais ALSO (11+) — ignoradas nesta fase");

  return { headers, delimiter: "\t", mapping, ignoredColumns, rows };
}

// ─── Stock (with header, tab-separated) ───────────────────────

const STOCK_REQUIRED = ["ProductID", "AvailableQuantity"] as const;

function normalizeHeaderStock(h: string): string {
  return h.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "").trim();
}

const STOCK_ALIASES: Record<string, string> = {
  productid: "supplierSku",
  availablequantity: "stock",
  availablenextdate: "alsoAvailableNextDate",
  availablenextquantity: "alsoAvailableNextQuantity",
  availabilitydate: "alsoAvailabilityDate",
  availabilitytime: "alsoAvailabilityTime",
};

export function parseAlsoStock(
  rawText: string | Uint8Array,
  _overrides?: Record<string, string>
): SupplierFileParse {
  const text = typeof rawText === "string" ? rawText : new TextDecoder("utf-8").decode(rawText);
  const cleaned = stripBOM(text);
  if (!cleaned.trim()) throw new SupplierCsvError("CSV_EMPTY");

  const rawLines = cleaned.split(/\r?\n/);
  // Find first non-empty line as header
  let headerIdx = -1;
  for (let i = 0; i < rawLines.length; i++) {
    if (rawLines[i].trim() !== "") {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) throw new SupplierCsvError("CSV_NO_DATA");

  const headerLine = rawLines[headerIdx];
  const rawHeaders = headerLine.split("\t").map((h) => h.trim());
  // Keep headers as they appear (trimmed), preserve order
  const headers = rawHeaders;
  if (headers.length === 0 || headers.every((h) => h === "")) throw new SupplierCsvError("CSV_NO_DATA");

  // Build header index map normalized
  const headerMap = new Map<string, number>();
  const seenNormalized = new Map<string, string>();
  for (let i = 0; i < headers.length; i++) {
    const norm = normalizeHeaderStock(headers[i]);
    if (!norm) continue;
    // Detect duplicate normalized header (e.g., ProductID vs productid)
    if (seenNormalized.has(norm)) {
      throw new SupplierCsvError(`DUPLICATE_MAPPING:${STOCK_ALIASES[norm] ?? norm}`);
    }
    seenNormalized.set(norm, headers[i]);
    headerMap.set(norm, i);
  }

  // Validate required columns exist
  for (const req of STOCK_REQUIRED) {
    const norm = normalizeHeaderStock(req);
    if (!headerMap.has(norm)) throw new SupplierCsvError("CSV_MISSING_KEY_COLUMN");
  }

  // Build mapping header->canonical (for audit)
  const mapping: Record<string, string> = {};
  const ignoredColumns: string[] = [];
  for (const h of headers) {
    const norm = normalizeHeaderStock(h);
    const alias = STOCK_ALIASES[norm];
    if (alias) mapping[h] = alias;
    else ignoredColumns.push(h);
  }

  // Collect data rows (skip header line)
  const dataLines: { idx: number; raw: string }[] = [];
  for (let i = headerIdx + 1; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (line.trim() === "") continue; // skip empty lines (skip_empty_lines)
    dataLines.push({ idx: i + 1, raw: line }); // rowNumber is file line number (1-based)
  }

  if (dataLines.length === 0) throw new SupplierCsvError("CSV_NO_DATA");
  if (dataLines.length > SUPPLIER_IMPORT_MAX_ROWS) throw new SupplierCsvError("CSV_TOO_MANY_ROWS");

  const rows: NormalizedSupplierRow[] = [];

  for (const { idx, raw } of dataLines) {
    const cols = raw.split("\t");
    const getNorm = (norm: string): string => {
      const pos = headerMap.get(norm);
      if (pos === undefined) return "";
      return (cols[pos] ?? "").trim();
    };

    const rawSku = getNorm("productid");
    const rawQty = getNorm("availablequantity");
    const rawNextDate = getNorm("availablenextdate");
    const rawNextQty = getNorm("availablenextquantity");
    const rawAvailDate = getNorm("availabilitydate");
    const rawAvailTime = getNorm("availabilitytime");

    const issues: SupplierImportIssue[] = [];
    const error = (field: string, value: string, code: string, message: string) =>
      issues.push({ field, value, code, message, severity: "error" });
    const warning = (field: string, value: string, code: string, message: string) =>
      issues.push({ field, value, code, message, severity: "warning" });

    // supplierSku
    const skuKey = snapshotKey(rawSku, SNAPSHOT_LIMITS.sku);
    let supplierSku: string | null = skuKey.value;
    if (skuKey.tooLong) {
      error("supplierSku", rawSku.slice(0, 120), "SUPPLIER_SKU_TOO_LONG", `SKU do fornecedor com mais de ${SNAPSHOT_LIMITS.sku} caracteres — não é cortado; a linha não é aplicada`);
      supplierSku = null;
    }
    if (!supplierSku) {
      // For stock, missing ProductID is row error (cannot link)
      error("supplierSku", rawSku, "MISSING_IDENTIFIER_KEY", "Linha sem ProductID — impossível de identificar stock");
    }

    // stock (AvailableQuantity) — -1 sentinel means unknown (desconhecida)
    let stock: number | null = null;
    if (rawQty === "") {
      error("stock", rawQty, "INVALID_STOCK", "Stock inválido (inteiro >= 0 esperado)");
    } else if (rawQty.trim() === "-1" || rawQty.trim() === "-1.0" || rawQty.trim() === "-1,0") {
      stock = null;
      warning("stock", rawQty, "AVAILABLE_NEXT_QUANTITY_UNKNOWN", "Quantidade desconhecida (-1) — stock não atualizado");
    } else {
      const parsed = parseInteger(rawQty);
      if (parsed.value === null) {
        error("stock", rawQty, "INVALID_STOCK", "Stock inválido (inteiro >= 0 esperado)");
      } else if (parsed.value > SNAPSHOT_INT4_MAX) {
        error("stock", rawQty, "STOCK_OUT_OF_RANGE", `Stock acima do máximo suportado (${SNAPSHOT_INT4_MAX}) — não é truncado; a linha não é aplicada`);
      } else {
        stock = parsed.value;
        if (parsed.ambiguous) warning("stock", rawQty, "AMBIGUOUS_NUMBER_FORMAT", `Stock lido como ${parsed.value}`);
      }
    }

    // AvailableNextDate — valida como date, -1 → null+warning, inválida → warning+null
    const alsoAvailableNextDate = parseDateField(rawNextDate, issues);

    // AvailableNextQuantity: -1 means unknown -> null, not error
    let alsoAvailableNextQuantity: number | null = null;
    if (rawNextQty) {
      const trimmed = rawNextQty.trim();
      if (trimmed === "-1" || trimmed === "-1.0" || trimmed === "-1,0") {
        // -1 sentinel → unknown, not stock negative
        alsoAvailableNextQuantity = null;
        warning("alsoAvailableNextQuantity", rawNextQty, "AVAILABLE_NEXT_QUANTITY_UNKNOWN", "Quantidade futura não especificada (-1)");
      } else {
        const parsed = parseInteger(trimmed);
        if (parsed.value === null) {
          error("alsoAvailableNextQuantity", rawNextQty, "INVALID_STOCK", "AvailableNextQuantity inválido (inteiro >=0 ou -1 esperado)");
        } else if (parsed.value > SNAPSHOT_INT4_MAX) {
          error("alsoAvailableNextQuantity", rawNextQty, "STOCK_OUT_OF_RANGE", `Quantidade futura acima do máximo suportado (${SNAPSHOT_INT4_MAX})`);
        } else {
          alsoAvailableNextQuantity = parsed.value;
          if (parsed.ambiguous) warning("alsoAvailableNextQuantity", rawNextQty, "AMBIGUOUS_NUMBER_FORMAT", `Quantidade futura lida como ${parsed.value}`);
        }
      }
    }

    // AvailabilityDate + AvailabilityTime -> timestamptz determinístico, inválido → warning+null
    let alsoAvailabilityTimestamp: string | null = parseAvailabilityTimestamp(rawAvailDate, rawAvailTime, issues);
    if (alsoAvailabilityTimestamp) alsoAvailabilityTimestamp = alsoAvailabilityTimestamp.slice(0, 255);

    // For stock, costPrice/name/ean/leadTimeDays are always null (stock-only)
    // Malformed row detection: if cols length < headers length and required fields missing due to delimiter mismatch, we already error above for sku/qty

    rows.push({
      rowNumber: idx,
      supplierSku,
      ean: null,
      internalSku: null,
      name: null,
      costPrice: null,
      stock,
      leadTimeDays: null,
      issues,
      alsoAvailableNextDate,
      alsoAvailableNextQuantity,
      alsoAvailabilityTimestamp,
    });
  }

  return { headers, delimiter: "\t", mapping, ignoredColumns, rows };
}
