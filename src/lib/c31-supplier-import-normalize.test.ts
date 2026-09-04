/**
 * C.3.1 — CSV → NormalizedSupplierRow (pure, no database).
 *
 * The normalizer is the single place a supplier file becomes typed data, so its
 * money/EAN/stock decisions are locked here: an ambiguous number is resolved by
 * the documented rule AND flagged, an invalid value blocks the row instead of
 * being coerced, and a supplier file's price column is never interpreted as a
 * selling price.
 */
import { describe, expect, it } from "vitest";
import {
  buildSupplierMapping,
  byteLengthUtf8,
  extractNumericToken,
  normalizeSupplierRow,
  parseInteger,
  parseMoney,
  parseSupplierCsv,
  sha256Hex,
  SupplierCsvError,
} from "@/lib/supplier-import/normalize";

describe("C.3.1 — numeric parsing of supplier files", () => {
  it("reads pt-PT money with both separators", () => {
    expect(parseMoney("1.234,56")).toEqual({ value: "1234.56", ambiguous: false });
    expect(parseMoney("12,50")).toEqual({ value: "12.50", ambiguous: false });
    expect(parseMoney("12.50")).toEqual({ value: "12.50", ambiguous: false });
  });

  it("reads en-GB money with thousands", () => {
    expect(parseMoney("1,234.56")).toEqual({ value: "1234.56", ambiguous: false });
  });

  it("strips currency symbols, spaces and NBSP", () => {
    expect(parseMoney(" 12,50 € ")).toEqual({ value: "12.50", ambiguous: false });
    expect(parseMoney("1 234,56")).toEqual({ value: "1234.56", ambiguous: false });
  });

  it("rounds half-up to cents, because prices are decimal(10,2)", () => {
    expect(parseMoney("10,0050").value).toBe("10.01");
    expect(parseMoney("10,0049").value).toBe("10.00");
    expect(parseMoney("10,00").value).toBe("10.00");
    // 4-decimal supplier costs are common in trade files; the rounding is the
    // value the preview shows and the value that gets written.
    expect(parseMoney("1.2345").value).toBe("1.23");
    expect(parseMoney("1.2350").value).toBe("1.24");
  });

  it("applies the thousands rule before the decimal rule (documented trade-off)", () => {
    // Exactly 3 digits after a single separator cannot be a currency amount,
    // so "10,005" is 10 005 € — flagged as an interpretation the operator sees.
    expect(parseMoney("10,005")).toEqual({ value: "10005.00", ambiguous: true });
  });

  it("flags a lone 3-digit group as an interpreted ambiguity", () => {
    expect(parseMoney("1.234")).toEqual({ value: "1234.00", ambiguous: true });
    expect(parseMoney("1.234.567")).toEqual({ value: "1234567.00", ambiguous: false });
    // 2 digits after a single separator is unambiguously a decimal part.
    expect(parseMoney("1.234")).not.toEqual({ value: "1.23", ambiguous: false });
  });

  it("refuses negatives, text and nonsense instead of guessing", () => {
    expect(parseMoney("-5,00").value).toBeNull();
    expect(parseMoney("abc").value).toBeNull();
    expect(parseMoney("12,5abc").value).toBeNull();
    expect(parseMoney("").value).toBeNull();
    expect(parseMoney("1..2").value).toBeNull();
  });

  it("parses integers strictly", () => {
    expect(parseInteger("12")).toEqual({ value: 12, ambiguous: false });
    expect(parseInteger("12.0").value).toBe(12);
    expect(parseInteger("12,5").value).toBeNull();
    expect(parseInteger("-3").value).toBeNull();
    expect(parseInteger("").value).toBeNull();
  });

  it("normalizes numeric tokens", () => {
    expect(extractNumericToken("1.234,50").value).toBe("1234.50");
    expect(extractNumericToken("1,2,3").value).toBeNull();
    expect(extractNumericToken("1.2.3.4.5").value).toBeNull();
  });
});

describe("C.3.1 — normalization of one row", () => {
  const codes = (row: ReturnType<typeof normalizeSupplierRow>) => row.issues.map((i) => i.code);

  it("maps the supplier vocabulary and keeps every snapshot value", () => {
    const row = normalizeSupplierRow(2, {
      supplierSku: "SUP-1", internalSku: "INT-1", ean: "4006381333931",
      name: " Cabo  ", costPrice: "12,50", stock: "7", leadTimeDays: "3",
    });
    expect(row).toMatchObject({
      rowNumber: 2, supplierSku: "SUP-1", internalSku: "INT-1", ean: "4006381333931",
      name: "Cabo", costPrice: "12.50", stock: 7, leadTimeDays: 3,
    });
    expect(row.issues).toEqual([]);
  });

  it("canonicalises a 12-digit UPC to GTIN-13", () => {
    const row = normalizeSupplierRow(2, { supplierSku: "S1", ean: "012345678905" });
    expect(row.ean).toBe("0012345678905");
    expect(row.issues).toHaveLength(0);
  });

  it("blocks a row with a bad checksum EAN — never matched on a typo", () => {
    const row = normalizeSupplierRow(2, { supplierSku: "S1", ean: "4006381333932" });
    expect(codes(row)).toContain("INVALID_GTIN");
  });

  it("blocks a row with no identifying key", () => {
    const row = normalizeSupplierRow(2, { name: "Só o nome" });
    expect(codes(row)).toContain("MISSING_IDENTIFIER_KEY");
  });

  it("never uses the name as a key and truncates the snapshot with a warning", () => {
    const long = "X".repeat(300);
    const row = normalizeSupplierRow(2, { supplierSku: "S1", name: long });
    expect(row.name).toHaveLength(255);
    expect(codes(row)).toContain("NAME_TRUNCATED");
    expect(row.issues.find((i) => i.code === "NAME_TRUNCATED")?.severity).toBe("warning");
  });

  it("refuses an over-long supplier code instead of cutting it to a 100-char key", () => {
    const row = normalizeSupplierRow(2, { supplierSku: "S".repeat(120), name: "Cabo" });
    expect(row.supplierSku).toBeNull();
    const issue = row.issues.find((i) => i.code === "SUPPLIER_SKU_TOO_LONG");
    expect(issue?.severity).toBe("error");
    // The length error already explains the row: no second, misleading complaint.
    expect(codes(row)).not.toContain("MISSING_IDENTIFIER_KEY");
    // A key at the documented limit is kept whole.
    expect(normalizeSupplierRow(3, { supplierSku: "S".repeat(100) }).supplierSku).toHaveLength(100);
  });

  it("never folds two different over-long codes into one truncated key", () => {
    const base = "X".repeat(110);
    const a = normalizeSupplierRow(2, { supplierSku: `${base}AAA` });
    const b = normalizeSupplierRow(3, { supplierSku: `${base}BBB` });
    expect([a.supplierSku, b.supplierSku]).toEqual([null, null]);
    expect(codes(a)).toContain("SUPPLIER_SKU_TOO_LONG");
    expect(codes(b)).toContain("SUPPLIER_SKU_TOO_LONG");
    expect(a.supplierSku).toEqual(b.supplierSku); // no invisible "S…S" collision
  });

  it("refuses an over-long internal SKU too — a global key is never invented from a cut", () => {
    const row = normalizeSupplierRow(2, { supplierSku: "S1", internalSku: "I".repeat(101) });
    expect(row.internalSku).toBeNull();
    expect(row.issues.find((i) => i.code === "INTERNAL_SKU_TOO_LONG")?.severity).toBe("error");
  });

  it("warns that a price column is ignored, instead of treating it as cost or PVP", () => {
    const row = normalizeSupplierRow(2, { supplierSku: "S1", price: "29,99" });
    const issue = row.issues.find((i) => i.code === "PRICE_COLUMN_IGNORED");
    expect(issue?.severity).toBe("warning");
    expect(row.costPrice).toBeNull();
    expect(row.issues.some((i) => i.severity === "error")).toBe(false);
  });

  it("reports an unusable cost or stock as an error", () => {
    expect(codes(normalizeSupplierRow(2, { supplierSku: "S1", costPrice: "custo grátis" }))).toContain("INVALID_COST");
    expect(codes(normalizeSupplierRow(2, { supplierSku: "S1", stock: "muitos" }))).toContain("INVALID_STOCK");
  });
});

describe("C.3.1 — header mapping", () => {
  it("auto-detects the supplier vocabulary", () => {
    const { mapping } = buildSupplierMapping(["Código do Fornecedor", "EAN", "Designação", "Custo", "Qtd"]);
    expect(mapping).toEqual({
      "Código do Fornecedor": "supplierSku",
      EAN: "ean",
      Designação: "name",
      Custo: "costPrice",
      Qtd: "stock",
    });
  });

  it("treats a bare SKU/Código/Ref column as the SUPPLIER's code, never as our internal SKU", () => {
    // A supplier list calls its own article number "SKU". products.sku is
    // MDTech's global reference, so the generic word belongs to the file.
    expect(buildSupplierMapping(["SKU"]).mapping).toEqual({ SKU: "supplierSku" });
    for (const header of ["Código", "Ref", "Referência", "RefSAP", "Artigo"]) {
      expect(buildSupplierMapping([header]).mapping[header]).toBe("supplierSku");
    }
  });

  it("only reads internalSku from a header that says it is internal", () => {
    for (const header of ["internalSku", "Código Interno", "Ref Interna", "Referência Interna", "SKU MDTech"]) {
      expect(buildSupplierMapping([header]).mapping[header]).toBe("internalSku");
    }
    // and the operator can always map it explicitly
    expect(buildSupplierMapping(["Código"], { Código: "internalSku" }).mapping).toEqual({ Código: "internalSku" });
  });

  it("lets the operator's own mapping win, and drops unknown targets", () => {
    const { mapping, ignoredColumns } = buildSupplierMapping(["Preço", "Código"], { Preço: "costPrice", Código: "supplierSku" });
    expect(mapping).toEqual({ Preço: "costPrice", Código: "supplierSku" });
    expect(ignoredColumns).toEqual([]);
  });

  it("reports a catalogue price column as ignored rather than mapping it", () => {
    const { mapping, ignoredColumns } = buildSupplierMapping(["SKU", "Preço"]);
    expect(ignoredColumns).toContain("Preço");
    expect(mapping.SKU).toBe("supplierSku");
    // Carried through only so each row can warn about it.
    expect(mapping["Preço"]).toBe("price");
  });

  it("refuses two columns fighting for the same field", () => {
    expect(() => buildSupplierMapping(["SKU", "Código"], { SKU: "internalSku", Código: "internalSku" }))
      .toThrow(SupplierCsvError);
  });
});

describe("C.3.1 — file level guards", () => {
  const header = "skuFornecedor,nome,custo,stock";

  it("parses a whole file into normalized rows with file line numbers", () => {
    const parsed = parseSupplierCsv(`${header}\nSUP-1,Cabo,12.50,1\n`);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toMatchObject({ rowNumber: 2, supplierSku: "SUP-1", costPrice: "12.50", stock: 1 });
    expect(parsed.rows[0].issues).toEqual([]);
    expect(parsed.mapping).toBeTruthy();
  });

  it("rejects an empty file and a file without any key column", () => {
    expect(() => parseSupplierCsv("")).toThrow(/CSV_EMPTY/);
    expect(() => parseSupplierCsv("nome,custo\nCabo,1")).toThrow(/CSV_MISSING_KEY_COLUMN/);
  });

  it("rejects 10 001 data rows — the legacy 10 000 line ceiling still holds", () => {
    const rows = Array.from({ length: 10001 }, (_, i) => `SUP-${i},linha,1,1`).join("\n");
    expect(() => parseSupplierCsv(`${header}\n${rows}`)).toThrow(/CSV_TOO_MANY_ROWS/);
  });

  it("accepts exactly 10 000 rows", () => {
    const rows = Array.from({ length: 10000 }, (_, i) => `SUP-${i},linha,1,1`).join("\n");
    expect(parseSupplierCsv(`${header}\n${rows}`).rows).toHaveLength(10000);
  });

  it("hashes the exact bytes and counts them in UTF-8", () => {
    expect(sha256Hex("a")).toBe("ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb");
    expect(sha256Hex("€")).toHaveLength(64);
    expect(byteLengthUtf8("€")).toBe(3);
  });
});

describe("C.3.1 — per-row column-ceiling refusals (never a whole-preview failure)", () => {
  const codes = (row: ReturnType<typeof normalizeSupplierRow>) => row.issues.map((i) => i.code);
  const issue = (row: ReturnType<typeof normalizeSupplierRow>, code: string) =>
    row.issues.find((i) => i.code === code);

  it("rejects an EAN longer than the varchar(50) snapshot column and never stores it", () => {
    const row = normalizeSupplierRow(2, { supplierSku: "S1", ean: "5".repeat(55) });
    expect(codes(row)).toContain("EAN_TOO_LONG");
    expect(issue(row, "EAN_TOO_LONG")?.severity).toBe("error");
    expect(row.ean).toBeNull(); // the value that does not fit is not recorded
    // A valid GTIN at the other end of the same rule is kept whole.
    expect(normalizeSupplierRow(3, { supplierSku: "S1", ean: "4006381333931" }).ean).toBe("4006381333931");
  });

  it("does not complain about a missing key when the only key was an over-long EAN", () => {
    const row = normalizeSupplierRow(2, { ean: "1".repeat(60) });
    expect(codes(row)).toContain("EAN_TOO_LONG");
    expect(codes(row)).not.toContain("MISSING_IDENTIFIER_KEY");
  });

  it("rejects a cost beyond numeric(10,2) instead of truncating or recording it", () => {
    const row = normalizeSupplierRow(2, { supplierSku: "S1", costPrice: "100000000.00" });
    expect(codes(row)).toContain("COST_OUT_OF_RANGE");
    expect(issue(row, "COST_OUT_OF_RANGE")?.severity).toBe("error");
    expect(row.costPrice).toBeNull();
    // It parsed fine as money — only the column ceiling refused it.
    expect(codes(row)).not.toContain("INVALID_COST");
  });

  it("accepts the exact numeric(10,2) ceiling", () => {
    const row = normalizeSupplierRow(2, { supplierSku: "S1", costPrice: "99999999.99" });
    expect(row.issues).toEqual([]);
    expect(row.costPrice).toBe("99999999.99");
  });

  it("rejects stock above the int4 ceiling and never records it", () => {
    const row = normalizeSupplierRow(2, { supplierSku: "S1", stock: "2147483648" });
    expect(codes(row)).toContain("STOCK_OUT_OF_RANGE");
    expect(issue(row, "STOCK_OUT_OF_RANGE")?.severity).toBe("error");
    expect(row.stock).toBeNull();
  });

  it("accepts stock exactly at the int4 ceiling", () => {
    const row = normalizeSupplierRow(2, { supplierSku: "S1", stock: "2147483647" });
    expect(row.issues).toEqual([]);
    expect(row.stock).toBe(2147483647);
  });

  it("rejects a lead time above the int4 ceiling and accepts the exact ceiling", () => {
    const over = normalizeSupplierRow(2, { supplierSku: "S1", leadTimeDays: "9999999999" });
    expect(codes(over)).toContain("LEAD_TIME_OUT_OF_RANGE");
    expect(issue(over, "LEAD_TIME_OUT_OF_RANGE")?.severity).toBe("error");
    expect(over.leadTimeDays).toBeNull();

    const atMax = normalizeSupplierRow(3, { supplierSku: "S1", leadTimeDays: "2147483647" });
    expect(atMax.issues).toEqual([]);
    expect(atMax.leadTimeDays).toBe(2147483647);
  });

  it("rejects an out-of-range stock inside a whole file as a row error, keeping the rest", () => {
    const parsed = parseSupplierCsv([
      "skuFornecedor;nome;custo;stock",
      "SUP-1;Cabo bom;10,00;5",
      "SUP-2;Stock impossível;10,00;99999999999",
      "SUP-3;Outro cabo;20,00;7",
    ].join("\n"));
    expect(parsed.rows).toHaveLength(3);
    expect(codes(parsed.rows[0])).toEqual([]);
    expect(codes(parsed.rows[1])).toEqual(["STOCK_OUT_OF_RANGE"]);
    expect(parsed.rows[1].stock).toBeNull();
    expect(codes(parsed.rows[2])).toEqual([]);
  });
});
