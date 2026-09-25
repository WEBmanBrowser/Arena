import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

describe("S36.1 storefront content", () => {
  it("publishes the official MDTech social links in the footer", () => {
    const footer = read("src/components/Footer.tsx");
    expect(footer).toContain("https://www.facebook.com/MDtech.pt/");
    expect(footer).toContain("https://www.instagram.com/mdtech.pt/");
  });

  it("keeps returns distinct from warranty and does not invent a blanket opened-box exclusion", () => {
    const migration = read("drizzle/0026_storefront_content_s36_1.sql");
    expect(migration).toContain("Uma devolução por livre resolução é diferente de um pedido de garantia");
    expect(migration).toContain("A mera abertura de uma embalagem de um componente informático não elimina automaticamente");
  });

  it("documents consumer warranty and RMA without reducing statutory rights", () => {
    const migration = read("drizzle/0026_storefront_content_s36_1.sql");
    expect(migration).toContain("três anos a contar da entrega");
    expect(migration).toContain("RMA / Assistência");
    expect(migration).toContain("não são reduzidos por garantias comerciais");
  });

  it("adds a substantive About Us page for MDTech", () => {
    const migration = read("drizzle/0026_storefront_content_s36_1.sql");
    expect(migration).toContain("Tecnologia com acompanhamento próximo");
    expect(migration).toContain("MDTech — mais tecnologia, menos complicação.");
  });
});
