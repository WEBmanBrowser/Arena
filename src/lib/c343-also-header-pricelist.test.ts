import { describe, expect, it } from "vitest";
import { parseAlsoPricelist } from "@/lib/supplier-import/also";

const HEADERS = [
  "ProductID",
  "EuropeanArticleNumber",
  "ManufacturerPartNumber",
  "ManufacturerName",
  "Description",
  "CategoryText1",
  "CategoryText2",
  "CategoryText3",
  "NetPrice",
  "NetRetailPrice",
  "AvailableQuantity",
];

function headerPricelist(values: Record<string, string> = {}): string {
  const defaults: Record<string, string> = {
    ProductID: "PID-H1",
    EuropeanArticleNumber: "5901234123457",
    ManufacturerPartNumber: "MPN-H1",
    ManufacturerName: "Brand H",
    Description: "Produto Header",
    CategoryText1: "Informatica",
    CategoryText2: "Componentes",
    CategoryText3: "Memorias",
    NetPrice: "25.50",
    NetRetailPrice: "39.99",
    AvailableQuantity: "17",
  };

  const row = HEADERS.map((h) => values[h] ?? defaults[h] ?? "");
  return HEADERS.join("\t") + "\n" + row.join("\t");
}

describe("ALSO pricelist header-driven", () => {
  it("le o novo formato pelo nome dos headers sem transportar stock fisico", () => {
    const parsed = parseAlsoPricelist(headerPricelist());

    expect(parsed.headers).toEqual(HEADERS);
    expect(parsed.rows).toHaveLength(1);

    const row = parsed.rows[0];

    expect(row.supplierSku).toBe("PID-H1");
    expect(row.ean).toBe("5901234123457");
    expect(row.name).toBe("Produto Header");
    expect(row.costPrice).toBe("25.50");
    expect(row.stock).toBeNull();
    expect(row.supplierStock ?? null).toBeNull();
    expect(row.alsoManufacturerPartNumber).toBe("MPN-H1");
    expect(row.alsoManufacturerName).toBe("Brand H");
    expect(row.alsoCategoryPath).toBe("Informatica / Componentes / Memorias");
    expect(parsed.ignoredColumns).toContain("NetRetailPrice");
  });

  it("resolve por nome mesmo com headers em ordem diferente", () => {
    const headers = [...HEADERS].reverse();

    const values: Record<string, string> = {
      ProductID: "PID-H2",
      EuropeanArticleNumber: "5901234123457",
      ManufacturerPartNumber: "MPN-H2",
      ManufacturerName: "Brand 2",
      Description: "Produto Reordenado",
      CategoryText1: "Cat1",
      CategoryText2: "Cat2",
      CategoryText3: "",
      NetPrice: "18.75",
      NetRetailPrice: "30.00",
      AvailableQuantity: "9",
    };

    const txt =
      headers.join("\t") +
      "\n" +
      headers.map((h) => values[h] ?? "").join("\t");

    const parsed = parseAlsoPricelist(txt);

    expect(parsed.rows[0].supplierSku).toBe("PID-H2");
    expect(parsed.rows[0].costPrice).toBe("18.75");
    expect(parsed.rows[0].name).toBe("Produto Reordenado");
    expect(parsed.rows[0].stock).toBeNull();
  });

  it("aceita exatamente o formato real ALSO recebido em 2026-09-15", () => {
    const txt = [
      "ProductID\tEuropeanArticleNumber\tManufacturerPartNumber\tDescription\tCategoryText1\tCategoryText2\tCategoryText3\tNetPrice\tNetRetailPrice\tAvailableQuantity",
      "1009318\t010343812031\tC13S041068\tEPSON S041068 Photo paper inkjet 104g/m2 A3 100 sheets 1-pack\tImpress?o, Digitaliza??o e Consum?veis\tConsum?veis - Papel\tPap?is de Escrit?rio e Fotogr?ficos\t37.46\t\t0",
    ].join("\n");

    const parsed = parseAlsoPricelist(txt);

    expect(parsed.headers).toHaveLength(10);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].supplierSku).toBe("1009318");
    expect(parsed.rows[0].ean).toBe("0010343812031");
    expect(parsed.rows[0].alsoManufacturerPartNumber).toBe("C13S041068");
    expect(parsed.rows[0].alsoManufacturerName ?? null).toBeNull();
    expect(parsed.rows[0].name).toBe(
      "EPSON S041068 Photo paper inkjet 104g/m2 A3 100 sheets 1-pack"
    );
    expect(parsed.rows[0].costPrice).toBe("37.46");
    expect(parsed.rows[0].stock).toBeNull();
    expect(parsed.rows[0].supplierStock ?? null).toBeNull();
    expect(parsed.rows[0].alsoCategoryPath).toBe(
      "Impress?o, Digitaliza??o e Consum?veis / Consum?veis - Papel / Pap?is de Escrit?rio e Fotogr?ficos"
    );
    expect(parsed.ignoredColumns).toContain("NetRetailPrice");
    expect(parsed.ignoredColumns).toContain("AvailableQuantity");
  });

});
