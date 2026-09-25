import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
const read=(p:string)=>fs.readFileSync(path.join(process.cwd(),p),"utf8");

describe("S35.4 catalog enrichment identity",()=>{
  it("keeps EAN exact lookup as the first strategy",()=>{
    const s=read("src/lib/catalog-enrichment/providers/upcitemdb.ts");
    expect(s).toContain("prod/trial/lookup?upc=");
    expect(s).toContain('"ean_exact"');
    expect(s.indexOf("prod/trial/lookup?upc=")).toBeLessThan(s.indexOf("prod/trial/search?"));
  });
  it("allows only exact manufacturer plus MPN fallback",()=>{
    const s=read("src/lib/catalog-enrichment/providers/upcitemdb.ts");
    expect(s).toContain("normalizedIdentity(item.model) === expectedMpn");
    expect(s).toContain("normalizedIdentity(item.brand) === expectedManufacturer");
    expect(s).toContain("AMBIGUOUS_EXACT_MANUFACTURER_MPN_MATCH");
    expect(s).not.toContain("similarity");
    expect(s).not.toContain("levenshtein");
  });
  it("can discover products with EAN or MPN without changing protected commercial fields",()=>{
    const s=read("src/lib/catalog-enrichment/discovery-service.ts");
    expect(s).toContain("or(isNotNull(products.ean), isNotNull(productSuppliers.manufacturerPartNumber))");
    for(const forbidden of ["costPrice:","price:","supplierStock:","stock:","supplierCategoryPath:","gpsrManufacturerName:"]) expect(s).not.toContain(forbidden);
  });
  it("keeps discovery as snapshot-only and explicit apply",()=>{
    const service=read("src/lib/catalog-enrichment/discovery-service.ts");
    const ui=read("src/components/admin/ProductCatalogEnrichment.tsx");
    expect(service).toContain("stageCatalogSnapshot");
    expect(ui).toContain("não são publicados automaticamente");
    expect(ui).toContain('apply("description")');
  });
});
