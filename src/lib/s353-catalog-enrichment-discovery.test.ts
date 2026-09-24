import { describe, expect, it } from "vitest";
import fs from "node:fs"; import path from "node:path";
const read=(p:string)=>fs.readFileSync(path.join(process.cwd(),p),"utf8");
describe("S35.3 catalog enrichment discovery",()=>{
  it("keeps the commercial TXT boundary read-only",()=>{ const s=read("src/lib/catalog-enrichment/discovery-service.ts"); for(const forbidden of ["costPrice:","price:","supplierStock:","stock:","supplierCategoryPath:","gpsrManufacturerName:"]) expect(s).not.toContain(forbidden); expect(s).toContain("stageCatalogSnapshot"); });
  it("uses exact EAN matching and no fuzzy product-name matching",()=>{ const s=read("src/lib/catalog-enrichment/providers/upcitemdb.ts"); expect(s).toContain("NO_EXACT_EAN_MATCH"); expect(s).toContain("clean(i.ean)"); expect(s).not.toContain("similarity"); expect(s).not.toContain("levenshtein"); });
  it("does not scrape the authenticated ALSO portal",()=>{ const files=["src/lib/catalog-enrichment/discovery-service.ts","src/lib/catalog-enrichment/providers/upcitemdb.ts"].map(read).join("\n"); expect(files).not.toContain("ProductDetailData.do"); expect(files).not.toContain("also.com"); expect(files).not.toContain("cookie"); });
  it("records discovery attempts and requires explicit apply through S35.2",()=>{ const s=read("src/lib/catalog-enrichment/discovery-service.ts"); const ui=read("src/components/admin/ProductCatalogEnrichment.tsx"); expect(s).toContain("catalogEnrichmentAttempts"); expect(ui).toContain("não são publicados automaticamente"); expect(ui).toContain('apply("description")'); });
});
