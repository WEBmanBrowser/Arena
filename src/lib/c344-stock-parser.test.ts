/**
 * C.3.4.4 — GRUPO A: parser REAL do /stock.txt (6 colunas, header-driven).
 *
 * Trava o formato observado em produção (não o formato imaginado):
 *  - TSV com header: ProductID, AvailableQuantity, AvailableNextDate,
 *    AvailableNextQuantity, AvailabilityDate, AvailabilityTime;
 *  - datas compactas YYYYMMDD + horas HHMMSS (normalizadas para ISO/UTC);
 *  - AvailableQuantity é stock do FORNECEDOR: viaja em `supplierStock` e o
 *    `stock` físico fica SEMPRE null (autoridade de stock §8);
 *  - sentinel -1 = desconhecido → null + warning, NUNCA -1, NUNCA limpa;
 *  - header-driven (ordem irrelevante), BOM/CRLF/linhas vazias, limites.
 */
import { describe, expect, it } from "vitest";
import { parseAlsoStock } from "@/lib/supplier-import/also";
import { SupplierCsvError } from "@/lib/supplier-import/normalize";

const HEADER_6 = [
  "ProductID",
  "AvailableQuantity",
  "AvailableNextDate",
  "AvailableNextQuantity",
  "AvailabilityDate",
  "AvailabilityTime",
];

function stockTxt(header: string[], rows: string[][]): string {
  return [header.join("\t"), ...rows.map((r) => r.join("\t"))].join("\n");
}

describe("C.3.4.4 [A] — stock.txt REAL: 6 colunas + YYYYMMDD/HHMMSS", () => {
  it("linha real completa: datas compactas normalizadas, stock em supplierStock", () => {
    const txt = stockTxt(HEADER_6, [
      ["1203837", "24", "20260930", "100", "20260907", "134950"],
    ]);
    const parsed = parseAlsoStock(txt);
    expect(parsed.rows).toHaveLength(1);
    const r = parsed.rows[0];
    expect(r.supplierSku).toBe("1203837");
    expect(r.supplierStock).toBe(24);
    expect(r.stock).toBeNull();
    expect(r.alsoAvailableNextDate).toBe("2026-09-30");
    expect(r.alsoAvailableNextQuantity).toBe(100);
    expect(r.alsoAvailabilityTimestamp).toBe("2026-09-07 13:49:50");
    expect(r.costPrice).toBeNull();
    expect(r.name).toBeNull();
    expect(r.ean).toBeNull();
  });

  it("datas ISO com separadores continuam aceites (compat)", () => {
    const txt = stockTxt(HEADER_6, [
      ["PID1", "5", "2026-10-01", "7", "2026-09-07", "14:30"],
    ]);
    const r = parseAlsoStock(txt).rows[0];
    expect(r.alsoAvailableNextDate).toBe("2026-10-01");
    expect(r.alsoAvailabilityTimestamp).toBe("2026-09-07 14:30");
  });

  it("data compacta inválida (mês 13) → warning + null, sem quebrar a linha", () => {
    const txt = stockTxt(HEADER_6, [["PID1", "5", "20261301", "", "20260230", "120000"]]);
    const r = parseAlsoStock(txt).rows[0];
    expect(r.alsoAvailableNextDate).toBeNull();
    expect(r.alsoAvailabilityTimestamp).toBeNull();
    expect(r.issues.some((i) => i.code === "INVALID_AVAILABLE_NEXT_DATE")).toBe(true);
    expect(r.issues.some((i) => i.code === "INVALID_AVAILABILITY_TIMESTAMP")).toBe(true);
    // O stock continua válido: uma data má não deita fora a quantidade.
    expect(r.supplierStock).toBe(5);
  });

  it("hora HHMMSS inválida (25:61:61) → warning + null", () => {
    const txt = stockTxt(["ProductID", "AvailableQuantity", "AvailabilityDate", "AvailabilityTime"], [
      ["PID1", "5", "20260907", "256161"],
    ]);
    const r = parseAlsoStock(txt).rows[0];
    expect(r.alsoAvailabilityTimestamp).toBeNull();
    expect(r.issues.some((i) => i.code === "INVALID_AVAILABILITY_TIMESTAMP")).toBe(true);
  });
});

describe("C.3.4.4 [A] — sentinel -1 = desconhecido (nunca -1, nunca físico)", () => {
  it("AvailableQuantity -1 → supplierStock null + warning", () => {
    const txt = stockTxt(["ProductID", "AvailableQuantity"], [["PID1", "-1"]]);
    const r = parseAlsoStock(txt).rows[0];
    expect(r.supplierStock).toBeNull();
    expect(r.stock).toBeNull();
    expect(r.issues.some((i) => i.code === "AVAILABLE_NEXT_QUANTITY_UNKNOWN" && i.severity === "warning")).toBe(true);
  });

  it("AvailableNextQuantity -1 → null + warning", () => {
    const txt = stockTxt(HEADER_6, [["PID1", "9", "", "-1", "", ""]]);
    const r = parseAlsoStock(txt).rows[0];
    expect(r.alsoAvailableNextQuantity).toBeNull();
    expect(r.supplierStock).toBe(9);
    expect(r.issues.some((i) => i.code === "AVAILABLE_NEXT_QUANTITY_UNKNOWN")).toBe(true);
  });

  it("AvailableNextDate -1 → null + warning", () => {
    const txt = stockTxt(HEADER_6, [["PID1", "9", "-1", "", "", ""]]);
    const r = parseAlsoStock(txt).rows[0];
    expect(r.alsoAvailableNextDate).toBeNull();
    expect(r.issues.some((i) => i.code === "AVAILABLE_NEXT_QUANTITY_UNKNOWN")).toBe(true);
  });

  it("AvailabilityDate/Time -1 → timestamp null + warning", () => {
    const txt = stockTxt(HEADER_6, [["PID1", "9", "", "", "-1", "-1"]]);
    const r = parseAlsoStock(txt).rows[0];
    expect(r.alsoAvailabilityTimestamp).toBeNull();
    expect(r.issues.some((i) => i.code === "INVALID_AVAILABILITY_TIMESTAMP" && i.severity === "warning")).toBe(true);
  });
});

describe("C.3.4.4 [A] — estrutura: header-driven, BOM, limites", () => {
  it("ordem das colunas irrelevante; mapping AvailableQuantity → supplierStock", () => {
    const txt = stockTxt(["AvailabilityTime", "AvailableQuantity", "ProductID"], [["120000", "11", "PID9"]]);
    const parsed = parseAlsoStock(txt);
    expect(parsed.rows[0].supplierSku).toBe("PID9");
    expect(parsed.rows[0].supplierStock).toBe(11);
    expect(parsed.mapping["AvailableQuantity"]).toBe("supplierStock");
  });

  it("mapping de auditoria: quantidade nunca aponta para o físico", () => {
    const parsed = parseAlsoStock(stockTxt(HEADER_6, [["PID1", "1", "", "", "", ""]]));
    expect(Object.values(parsed.mapping)).not.toContain("stock");
    expect(parsed.mapping["ProductID"]).toBe("supplierSku");
  });

  it("BOM + CRLF + linhas vazias", () => {
    const txt = "\uFEFF" + HEADER_6.join("\t") + "\r\nPID1\t3\t\t\t\t\r\n\r\nPID2\t4\t\t\t\t\r\n";
    const parsed = parseAlsoStock(txt);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0].supplierStock).toBe(3);
    expect(parsed.rows[1].supplierStock).toBe(4);
  });

  it("coluna em falta (AvailableQuantity) → CSV_MISSING_KEY_COLUMN", () => {
    expect(() => parseAlsoStock(stockTxt(["ProductID"], [["PID1"]]))).toThrowError(/CSV_MISSING_KEY_COLUMN/);
  });

  it("header duplicado normalizado → DUPLICATE_MAPPING", () => {
    expect(() =>
      parseAlsoStock(stockTxt(["ProductID", "productid", "AvailableQuantity"], [["A", "B", "1"]]))
    ).toThrowError(/DUPLICATE_MAPPING/);
  });

  it("vazio → CSV_EMPTY; só header → CSV_NO_DATA", () => {
    expect(() => parseAlsoStock("   ")).toThrowError(/CSV_EMPTY/);
    expect(() => parseAlsoStock(stockTxt(HEADER_6, []))).toThrowError(/CSV_NO_DATA/);
  });

  it("limite 20000 linhas", () => {
    const rows: string[][] = [];
    for (let i = 0; i < 20000; i++) rows.push([`PID${i}`, "1", "", "", "", ""]);
    expect(parseAlsoStock(stockTxt(HEADER_6, rows)).rows).toHaveLength(20000);
    rows.push(["PID_OVER", "1", "", "", "", ""]);
    expect(() => parseAlsoStock(stockTxt(HEADER_6, rows))).toThrowError(/CSV_TOO_MANY_ROWS/);
  });

  it("quantidade não-numérica → INVALID_STOCK (error) + nulls", () => {
    const r = parseAlsoStock(stockTxt(["ProductID", "AvailableQuantity"], [["PID1", "abc"]])).rows[0];
    expect(r.supplierStock).toBeNull();
    expect(r.stock).toBeNull();
    expect(r.issues.some((i) => i.code === "INVALID_STOCK" && i.severity === "error")).toBe(true);
  });

  it("linha sem ProductID → MISSING_IDENTIFIER_KEY", () => {
    const r = parseAlsoStock(stockTxt(["ProductID", "AvailableQuantity"], [["", "5"]])).rows[0];
    expect(r.issues.some((i) => i.code === "MISSING_IDENTIFIER_KEY")).toBe(true);
  });

  it("erros de ficheiro são SupplierCsvError (contrato do dispatcher)", () => {
    expect(() => parseAlsoStock("")).toThrow(SupplierCsvError);
  });
});
