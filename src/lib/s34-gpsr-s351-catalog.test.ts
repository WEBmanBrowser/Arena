import { describe, expect, it } from "vitest";
import fs from "node:fs";
const read = (p: string) => fs.readFileSync(p, "utf8");
describe("S34 GPSR + S35.1 compact catalogue", () => {
 it("adds dedicated GPSR fields",()=>{const s=read("src/db/schema.ts"); expect(s).toContain("gpsrManufacturerName"); expect(s).toContain("gpsrResponsibleName");});
 it("exposes GPSR on product detail",()=>{expect(read("src/lib/public-products.ts")).toContain("gpsrSafetyInformation"); expect(read("src/app/(store)/produto/[slug]/page.tsx")).toContain("Segurança e conformidade do produto");});
 it("adds admin GPSR editor",()=>expect(read("src/app/admin/products/page.tsx")).toContain("Segurança / GPSR"));
 it("compacts catalogue",()=>{expect(read("src/app/(store)/page.tsx")).toContain("xl:grid-cols-6"); expect(read("src/components/ProductCard.tsx")).toContain("xl:h-40");});
});
