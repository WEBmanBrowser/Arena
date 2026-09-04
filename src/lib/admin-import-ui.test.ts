/**
 * Admin → Importar/Exportar UI regression.
 *
 * /admin/import must expose exactly ONE importer — the C.3.1 Supplier Import
 * Engine — and no legacy "Importar Catálogo CSV" surface:
 *
 *  A. the page no longer renders the legacy card, textarea, mode selector,
 *     legacy preview or "Executar Importação", and no longer calls the legacy
 *     endpoint (which stays alive server-side);
 *  B. the page renders the SupplierImportPanel;
 *  C. the panel demands a supplier before a preview can run;
 *  D. the "SKU do fornecedor ≠ SKU MDTech" guidance (incl. the automatic
 *     MD-xxxxxx SKU rule) is shown next to the supplier picker.
 *
 * These are static source assertions, the same technique the repo already
 * uses in import-error-text.test.ts: this project has no browser/jsdom test
 * harness, so the guard is that the code the browser will run cannot contain
 * the forbidden UI or drop the required texts.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

const page = read("src/app/admin/import/page.tsx");
const panel = read("src/components/admin/SupplierImportPanel.tsx");

describe("A — /admin/import exposes only the C.3.1 supplier import engine", () => {
  it("removes the legacy catalogue importer card and its controls", () => {
    expect(page).not.toContain("Importar Catálogo CSV");
    expect(page).not.toContain("Executar Importação");
    // Legacy textarea, mode selector and legacy preview are gone from the page.
    expect(page).not.toContain("<textarea");
    expect(page).not.toContain("importMode");
    expect(page).not.toContain("create_update");
    expect(page).not.toContain("Apenas criar novos");
  });

  it("no longer invokes the legacy import endpoint from the page", () => {
    expect(page).not.toContain("/api/admin/import");
    expect(page).not.toContain("doExecute");
    expect(page).not.toContain("doPreview");
  });
});

describe("B — /admin/import presents the SupplierImportPanel", () => {
  it("imports and renders the panel as the only importer", () => {
    expect(page).toContain("SupplierImportPanel");
    expect(page).toContain("from \"@/components/admin/SupplierImportPanel\"");
    expect(page).toContain("<SupplierImportPanel");
  });

  it("carries the C.3.1-only page title, description and the preserved export button", () => {
    expect(page).toContain("Importar lista de fornecedor");
    expect(page).toContain(
      "Importe preços, stock e produtos através de uma lista fornecida pelo fornecedor. A referência do fornecedor é mantida separada do SKU interno MDTech."
    );
    expect(page).toContain("Exportar catálogo CSV");
    expect(page).toContain("/api/admin/export");
  });
});

describe("C — SupplierImportPanel requires a supplier before preview", () => {
  it("marks the supplier as required and disables preview without it", () => {
    expect(panel).toContain("Fornecedor *");
    // Preview button disabled while no supplier and/or no CSV text.
    expect(panel).toMatch(/disabled=\{busy \|\| !csvText\.trim\(\) \|\| !supplierId\}/);
    // Server round-trip guard: never even send a preview without a supplier.
    expect(panel).toContain("if (!supplierId || !csvText.trim()) return;");
  });
});

describe("D — supplier-SKU guidance is shown next to the supplier picker", () => {
  it("renders the 'SKU do fornecedor ≠ SKU MDTech' heading and the MD-xxxxxx rule", () => {
    const supplierLabelIdx = panel.indexOf("Fornecedor *");
    const headingIdx = panel.indexOf("SKU do fornecedor ≠ SKU MDTech");
    const ruleIdx = panel.indexOf(
      "Quando o produto é novo e a lista não contém um SKU interno MDTech explícito, será criado automaticamente um SKU MD-xxxxxx."
    );
    const textareaIdx = panel.indexOf("<textarea");

    // Both texts exist.
    expect(headingIdx).toBeGreaterThan(-1);
    expect(ruleIdx).toBeGreaterThan(-1);
    // They sit next to the supplier selection area (after the picker, before
    // the CSV entry surface), not buried in the preview/history sections.
    expect(headingIdx).toBeGreaterThan(supplierLabelIdx);
    expect(ruleIdx).toBeGreaterThan(headingIdx);
    expect(textareaIdx).toBeGreaterThan(ruleIdx);
  });
});
