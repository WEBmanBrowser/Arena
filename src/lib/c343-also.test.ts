/**
 * C.3.4.3.1 — ALSO formats: pricelist + stock.txt (pure + source contract)
 *
 * Trava:
 *  - pricelist-1.txt TSV sem header posicional 10 colunas, BOM, empty, 20000 limite, -1 sentinel, snapshot limits;
 *  - stock.txt TSV com header por nome (não posição), BOM/CRLF/skip empty, header-driven, -1→null, AvailabilityDate+Time;
 *  - ProductID canónico = supplierSku (não confunde com internalSku / products.sku);
 *  - stock-only: desconhecido → não cria (serviço transforma new_product → error STOCK_UNKNOWN_SKU);
 *  - uploadSource/sourceFormat detectam pricelist/stock por filename e sniff header;
 *  - limites 20000 não quebram bytes (5MB guard intacto).
 */
import { describe, expect, it } from "vitest";
import { parseAlsoPricelist, parseAlsoStock } from "@/lib/supplier-import/also";
import { SupplierCsvError } from "@/lib/supplier-import/normalize";
import { SUPPLIER_IMPORT_MAX_ROWS } from "@/lib/supplier-import/constants";
import { classifySupplierFileName, parseSupplierFile } from "@/lib/supplier-import/file";
import { sourceFormat, uploadSource } from "@/lib/supplier-import/source";

// Helper to build a pricelist line (10 tab cols)
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

function stockHeader(cols: string[]): string {
  return cols.join("\t");
}

describe("C.3.4.3.1 — classifySupplierFileName detecta ALSO por filename", () => {
  it("pricelist-1.txt → also_pricelist; stock.txt → also_stock", () => {
    expect(classifySupplierFileName("pricelist-1.txt")).toBe("also_pricelist");
    expect(classifySupplierFileName("PRICELIST-1.TXT")).toBe("also_pricelist");
    expect(classifySupplierFileName("stock.txt")).toBe("also_stock");
    expect(classifySupplierFileName("my_stock_export.txt")).toBe("also_stock");
    expect(classifySupplierFileName("lista.csv")).toBe("csv");
    expect(classifySupplierFileName("lista.xlsx")).toBe("xlsx");
    expect(classifySupplierFileName("a.xls")).toBe("unsupported");
  });

  it("uploadSource usa filename pricelist/stock", () => {
    const pricelist = uploadSource({ fileName: "pricelist-1.txt", csvText: pricelistLine() });
    expect(pricelist.format).toBe("also_pricelist");
    const stockTxt = `${stockHeader(["ProductID", "AvailableQuantity", "AvailabilityDate", "AvailabilityTime"])}\nPID1\t5\t2026-09-01\t10:00`;
    const stock = uploadSource({ fileName: "stock.txt", csvText: stockTxt });
    expect(stock.format).toBe("also_stock");

    // generic .txt with stock header but non-stock filename → auto-detect via sniff
    const generic = uploadSource({ fileName: "export.txt", csvText: stockTxt });
    expect(generic.format).toBe("also_stock");

    // generic .txt without stock header → stays csv
    const genericCsv = uploadSource({ fileName: "export.txt", csvText: "sku;nome\nREF1;Produto" });
    expect(genericCsv.format).toBe("csv");
  });

  it("sourceFormat auto sniffs stock TSV header", () => {
    const stockAuto = { kind: "url" as const, label: "u", format: "auto" as const, text: `${stockHeader(["ProductID", "AvailableQuantity"])}\nPID1\t2` };
    expect(sourceFormat(stockAuto)).toBe("also_stock");
    const csvAuto = { kind: "url" as const, label: "u", format: "auto" as const, text: "sku;nome\nREF1;Produto" };
    expect(sourceFormat(csvAuto)).toBe("csv");
  });
});

describe("C.3.4.3.1 — parseAlsoPricelist (sem header, posicional)", () => {
  it("parsing normal preserva metadados ALSO", () => {
    const line = pricelistLine();
    const parsed = parseAlsoPricelist(line);
    expect(parsed.headers).toHaveLength(10);
    expect(parsed.delimiter).toBe("\t");
    expect(parsed.rows).toHaveLength(1);
    const r = parsed.rows[0];
    expect(r.supplierSku).toBe("PID123");
    expect(r.ean).toBe("5901234123457");
    expect(r.name).toBe("Produto Teste");
    expect(r.stock).toBe(5);
    expect(r.costPrice).toBe("12.50");
    expect(r.alsoManufacturerPartNumber).toBe("MPN-001");
    expect(r.alsoManufacturerName).toBe("BrandX");
    expect(r.alsoCategoryPath).toBe("Cat1 / Cat2 / Cat3");
    expect(r.alsoAvailableNextDate).toBeUndefined();
  });

  it("BOM é removido", () => {
    const parsed = parseAlsoPricelist("\uFEFF" + pricelistLine());
    expect(parsed.rows[0].supplierSku).toBe("PID123");
  });

  it("CRLF e linhas vazias são ignoradas", () => {
    const txt = pricelistLine() + "\r\n\r\n" + pricelistLine({ ProductID: "PID2" }) + "\r\n";
    const parsed = parseAlsoPricelist(txt);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[1].supplierSku).toBe("PID2");
  });

  it("linha vazia / espaço → CSV_EMPTY ou CSV_NO_DATA", () => {
    expect(() => parseAlsoPricelist("   ")).toThrow(SupplierCsvError);
    expect(() => parseAlsoPricelist("   \n   \n")).toThrow(SupplierCsvError);
  });

  it("-1 sentinel em stock → null com warning", () => {
    const line = pricelistLine({ AvailableQuantity: "-1" });
    const parsed = parseAlsoPricelist(line);
    expect(parsed.rows[0].stock).toBeNull();
    expect(parsed.rows[0].issues.some((i) => i.code === "AVAILABLE_NEXT_QUANTITY_UNKNOWN")).toBe(true);
  });

  it("custo acima do teto → error e null", () => {
    const line = pricelistLine({ NetPrice: "99999999.99" }); // at limit ok
    const parsedOk = parseAlsoPricelist(line);
    expect(parsedOk.rows[0].costPrice).toBe("99999999.99");
    const lineOver = pricelistLine({ NetPrice: "100000000.00" });
    const parsedOver = parseAlsoPricelist(lineOver);
    expect(parsedOver.rows[0].costPrice).toBeNull();
    expect(parsedOver.rows[0].issues.some((i) => i.code === "COST_OUT_OF_RANGE")).toBe(true);
  });

  it("sku >100 → error SUPPLIER_SKU_TOO_LONG e null", () => {
    const longSku = "A".repeat(101);
    const parsed = parseAlsoPricelist(pricelistLine({ ProductID: longSku }));
    expect(parsed.rows[0].supplierSku).toBeNull();
    expect(parsed.rows[0].issues.some((i) => i.code === "SUPPLIER_SKU_TOO_LONG")).toBe(true);
  });

  it("ean inválido checksum → error INVALID_GTIN", () => {
    const parsed = parseAlsoPricelist(pricelistLine({ EuropeanArticleNumber: "5901234123458" })); // bad checksum
    expect(parsed.rows[0].issues.some((i) => i.code === "INVALID_GTIN")).toBe(true);
  });

  it("nome >255 → warning NAME_TRUNCATED e truncado no snapshot compatível", () => {
    const longName = "N".repeat(300);
    const parsed = parseAlsoPricelist(pricelistLine({ Description: longName }));
    expect(parsed.rows[0].name?.length).toBe(255);
    expect(parsed.rows[0].issues.some((i) => i.code === "NAME_TRUNCATED")).toBe(true);
  });

  it("colunas 11+ → ignoredColumns", () => {
    const line = pricelistLine() + "\textraCol";
    const parsed = parseAlsoPricelist(line);
    expect(parsed.ignoredColumns.length).toBeGreaterThan(0);
  });

  it("limite 20000: 20000 ok, 20001 → CSV_TOO_MANY_ROWS", () => {
    const lines: string[] = [];
    for (let i = 0; i < 20000; i++) lines.push(pricelistLine({ ProductID: `PID${i}` }));
    const ok = parseAlsoPricelist(lines.join("\n"));
    expect(ok.rows).toHaveLength(20000);
    lines.push(pricelistLine({ ProductID: "PID_OVER" }));
    expect(() => parseAlsoPricelist(lines.join("\n"))).toThrowError(/CSV_TOO_MANY_ROWS/);
    // also via dispatcher
    expect(() => parseSupplierFile(lines.join("\n"), undefined, "also_pricelist")).toThrowError(/CSV_TOO_MANY_ROWS/);
  });

  it("MAX_ROWS constant = 20000", () => {
    expect(SUPPLIER_IMPORT_MAX_ROWS).toBe(20000);
  });
});

describe("C.3.4.3.1 — parseAlsoStock (com header, resolução por nome)", () => {
  const baseHeader = ["ProductID", "AvailableQuantity", "AvailableNextDate", "AvailableNextQuantity", "AvailabilityDate", "AvailabilityTime"];
  const baseRow = ["PID123", "10", "2026-10-01", "5", "2026-09-07", "14:30"];

  it("parsing normal header-driven", () => {
    const txt = `${stockHeader(baseHeader)}\n${baseRow.join("\t")}`;
    const parsed = parseAlsoStock(txt);
    expect(parsed.headers).toEqual(baseHeader);
    expect(parsed.delimiter).toBe("\t");
    expect(parsed.rows[0].supplierSku).toBe("PID123");
    // C.3.4.4: AvailableQuantity é stock do FORNECEDOR — o físico fica null.
    expect(parsed.rows[0].supplierStock).toBe(10);
    expect(parsed.rows[0].stock).toBeNull();
    expect(parsed.rows[0].alsoAvailableNextDate).toBe("2026-10-01");
    expect(parsed.rows[0].alsoAvailableNextQuantity).toBe(5);
    expect(parsed.rows[0].alsoAvailabilityTimestamp).toBe("2026-09-07 14:30");
    expect(parsed.rows[0].costPrice).toBeNull();
  });

  it("ordem das colunas não importa (header-driven)", () => {
    const shuffledHeader = ["AvailabilityTime", "ProductID", "AvailableQuantity", "AvailableNextDate", "AvailabilityDate", "AvailableNextQuantity"];
    const shuffledRow = ["14:30", "PID123", "10", "2026-10-01", "2026-09-07", "5"];
    const txt = `${stockHeader(shuffledHeader)}\n${shuffledRow.join("\t")}`;
    const parsed = parseAlsoStock(txt);
    expect(parsed.rows[0].supplierSku).toBe("PID123");
    expect(parsed.rows[0].supplierStock).toBe(10);
    expect(parsed.rows[0].stock).toBeNull();
    expect(parsed.rows[0].alsoAvailableNextDate).toBe("2026-10-01");
    expect(parsed.rows[0].alsoAvailableNextQuantity).toBe(5);
    expect(parsed.rows[0].alsoAvailabilityTimestamp).toBe("2026-09-07 14:30");
  });

  it("header case/space-insensitive", () => {
    const txt = `${stockHeader(["productid", "availablequantity", "availablenextdate", "availablenextquantity"])}\nPID1\t7\t2026-12-01\t-1`;
    const parsed = parseAlsoStock(txt);
    expect(parsed.rows[0].supplierSku).toBe("PID1");
    expect(parsed.rows[0].supplierStock).toBe(7);
    expect(parsed.rows[0].stock).toBeNull();
  });

  it("BOM removido no header", () => {
    const txt = "\uFEFF" + `${stockHeader(baseHeader)}\n${baseRow.join("\t")}`;
    const parsed = parseAlsoStock(txt);
    expect(parsed.rows[0].supplierSku).toBe("PID123");
  });

  it("CRLF e linhas vazias são ignoradas", () => {
    const txt = `${stockHeader(baseHeader)}\r\n${baseRow.join("\t")}\r\n\r\nPID2\t3\t\t\t2026-09-08\t09:00\r\n`;
    const parsed = parseAlsoStock(txt);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[1].supplierSku).toBe("PID2");
  });

  it("colunas extra → ignoredColumns", () => {
    const txt = `${stockHeader([...baseHeader, "UnknownCol"])}\n${[...baseRow, "extra"].join("\t")}`;
    const parsed = parseAlsoStock(txt);
    expect(parsed.ignoredColumns).toContain("UnknownCol");
  });

  it("ProductID em falta no header → CSV_MISSING_KEY_COLUMN", () => {
    const txt = `${stockHeader(["AvailableQuantity"])}\n5`;
    expect(() => parseAlsoStock(txt)).toThrowError(/CSV_MISSING_KEY_COLUMN/);
  });

  it("AvailableQuantity em falta → CSV_MISSING_KEY_COLUMN", () => {
    const txt = `${stockHeader(["ProductID"])}\nPID1`;
    expect(() => parseAlsoStock(txt)).toThrowError(/CSV_MISSING_KEY_COLUMN/);
  });

  it("header duplicado normalizado → DUPLICATE_MAPPING", () => {
    const txt = `${stockHeader(["ProductID", "productid", "AvailableQuantity"])}\nPID1\tPID2\t5`;
    expect(() => parseAlsoStock(txt)).toThrowError(/DUPLICATE_MAPPING/);
  });

  it("AvailableQuantity -1 → null com warning (desconhecida)", () => {
    const txt = `${stockHeader(["ProductID", "AvailableQuantity"])}\nPID1\t-1`;
    const parsed = parseAlsoStock(txt);
    expect(parsed.rows[0].stock).toBeNull();
    // C.3.4.4: o -1 dissolve-se em supplierStock=null (nunca -1, nunca físico).
    expect(parsed.rows[0].supplierStock).toBeNull();
    expect(parsed.rows[0].issues.some((i) => i.code === "AVAILABLE_NEXT_QUANTITY_UNKNOWN")).toBe(true);
  });

  it("AvailableNextQuantity -1 → null com warning", () => {
    const txt = `${stockHeader(baseHeader)}\nPID123\t10\t2026-10-01\t-1\t2026-09-07\t14:30`;
    const parsed = parseAlsoStock(txt);
    expect(parsed.rows[0].alsoAvailableNextQuantity).toBeNull();
    expect(parsed.rows[0].issues.some((i) => i.code === "AVAILABLE_NEXT_QUANTITY_UNKNOWN")).toBe(true);
  });

  it("AvailabilityDate+AvailabilityTime combinados", () => {
    const txt1 = `${stockHeader(["ProductID", "AvailableQuantity", "AvailabilityDate", "AvailabilityTime"])}\nPID1\t5\t2026-09-07\t14:30`;
    expect(parseAlsoStock(txt1).rows[0].alsoAvailabilityTimestamp).toBe("2026-09-07 14:30");
    const txt2 = `${stockHeader(["ProductID", "AvailableQuantity", "AvailabilityDate"])}\nPID1\t5\t2026-09-07`;
    expect(parseAlsoStock(txt2).rows[0].alsoAvailabilityTimestamp).toBe("2026-09-07");
    const txt3 = `${stockHeader(["ProductID", "AvailableQuantity", "AvailabilityTime"])}\nPID1\t5\t14:30`;
    // time-only sem data é inválido para timestamptz → warning+null (não armazena string arbitrária)
    expect(parseAlsoStock(txt3).rows[0].alsoAvailabilityTimestamp).toBeNull();
    expect(parseAlsoStock(txt3).rows[0].issues.some((i) => i.code === "INVALID_AVAILABILITY_TIMESTAMP")).toBe(true);
  });

  it("linha sem ProductID → error MISSING_IDENTIFIER_KEY", () => {
    const txt = `${stockHeader(["ProductID", "AvailableQuantity"])}\n\t5`;
    const parsed = parseAlsoStock(txt);
    expect(parsed.rows[0].issues.some((i) => i.code === "MISSING_IDENTIFIER_KEY")).toBe(true);
  });

  it("stock inválido → error INVALID_STOCK", () => {
    const txt = `${stockHeader(["ProductID", "AvailableQuantity"])}\nPID1\tabc`;
    const parsed = parseAlsoStock(txt);
    expect(parsed.rows[0].stock).toBeNull();
    expect(parsed.rows[0].supplierStock).toBeNull();
    expect(parsed.rows[0].issues.some((i) => i.code === "INVALID_STOCK")).toBe(true);
  });

  it("vazio → CSV_EMPTY / sem dados → CSV_NO_DATA", () => {
    expect(() => parseAlsoStock("   ")).toThrowError(/CSV_EMPTY/);
    expect(() => parseAlsoStock(`${stockHeader(baseHeader)}\n   \n`)).toThrowError(/CSV_NO_DATA/);
  });

  it("20000 limite: 20000 ok, 20001 → CSV_TOO_MANY_ROWS", () => {
    const header = stockHeader(["ProductID", "AvailableQuantity"]);
    const lines: string[] = [header];
    for (let i = 0; i < 20000; i++) lines.push(`PID${i}\t${i % 10}`);
    const ok = parseAlsoStock(lines.join("\n"));
    expect(ok.rows).toHaveLength(20000);
    lines.push("PID_OVER\t5");
    expect(() => parseAlsoStock(lines.join("\n"))).toThrowError(/CSV_TOO_MANY_ROWS/);
  });

  it("preserva dados normalizados mesmo quando stock é usado", () => {
    const txt = `${stockHeader(baseHeader)}\nPID1\t2\t2026-11-01\t-1\t2026-09-07\t10:00`;
    const parsed = parseAlsoStock(txt);
    const r = parsed.rows[0];
    expect(r.alsoAvailableNextDate).toBe("2026-11-01");
    expect(r.alsoAvailableNextQuantity).toBeNull();
    expect(r.alsoAvailabilityTimestamp).toBe("2026-09-07 10:00");
  });
});

describe("C.3.4.3.1 — dispatcher parseSupplierFile suporta ALSO", () => {
  it("also_pricelist via dispatcher", () => {
    const txt = pricelistLine();
    const parsed = parseSupplierFile(txt, undefined, "also_pricelist");
    expect(parsed.rows[0].supplierSku).toBe("PID123");
  });
  it("also_stock via dispatcher", () => {
    const txt = `${stockHeader(["ProductID", "AvailableQuantity"])}\nPID1\t5`;
    const parsed = parseSupplierFile(txt, undefined, "also_stock");
    expect(parsed.rows[0].supplierSku).toBe("PID1");
  });
});

describe("C.3.4.3.1 — ProductID canónico e stock-only policy", () => {
  it("ProductID mapeia para supplierSku, nunca para internalSku", () => {
    const txt = pricelistLine({ ProductID: "PID-ALSO-001" });
    const parsed = parseAlsoPricelist(txt);
    expect(parsed.rows[0].supplierSku).toBe("PID-ALSO-001");
    expect(parsed.rows[0].internalSku).toBeNull();
    // matching: supplierSku é a chave canónica que liga pricelist<->productSuppliers.supplierSku<->stock
  });

  it("stock-only: new_product → error STOCK_UNKNOWN_SKU (simula serviço)", () => {
    const stockRow = parseAlsoStock(`${stockHeader(["ProductID", "AvailableQuantity"])}\nUNKNOWN_PID\t5`).rows[0];
    let plans: any[] = [{ rowNumber: 1, status: "new_product", matchType: "none", productId: null, codes: [], message: null }];
    const isStockOnly = true;
    if (isStockOnly) {
      plans = plans.map((p, i) => {
        if (p.status === "new_product") {
          const sku = [stockRow][i].supplierSku ?? "";
          return { ...p, status: "error" as const, codes: [...p.codes, "STOCK_UNKNOWN_SKU"], message: `ProductID "${sku}" desconhecido` };
        }
        return p;
      });
    }
    expect(plans[0].status).toBe("error");
    expect(plans[0].codes).toContain("STOCK_UNKNOWN_SKU");
  });

  it("stock-only nunca altera custo/nome/ean/mpn/categoria — costPrice sempre null em stock", () => {
    const parsed = parseAlsoStock(`${stockHeader(["ProductID", "AvailableQuantity", "AvailableNextDate"])}\nPID1\t5\t2026-10-01`);
    expect(parsed.rows[0].costPrice).toBeNull();
    expect(parsed.rows[0].name).toBeNull();
    expect(parsed.rows[0].ean).toBeNull();
    expect(parsed.rows[0].alsoManufacturerPartNumber).toBeUndefined();
  });

  it("pricelist mantém catálogo/custo (não é stock-only)", () => {
    const parsed = parseAlsoPricelist(pricelistLine({ NetPrice: "99,99" }));
    expect(parsed.rows[0].costPrice).toBe("99.99");
    expect(parsed.rows[0].alsoCategoryPath).toBe("Cat1 / Cat2 / Cat3");
  });
});
