/**
 * C.3.1 — matching rules (pure, no database).
 *
 * Locks the mandatory order supplier SKU → EAN → internal SKU, the absolute
 * ban on name matching, and every conflict shape the engine refuses to resolve
 * silently: an ambiguous key, levels disagreeing, a key repeated inside the
 * file, or two rows landing on the same product.
 */
import { describe, expect, it } from "vitest";
import { buildMatchIndex, planSupplierRows, summarizePlan, type ProductMatchIndex } from "@/lib/supplier-import/match";
import { normalizeSupplierRow } from "@/lib/supplier-import/normalize";

/** Catalogue fixture: product ids 1..4 with their keys per level. */
function index(seed: { id: number; supplierSku?: string; ean?: string; sku?: string }[]): ProductMatchIndex {
  return buildMatchIndex(seed.map((p) => ({
    productId: p.id,
    supplierSku: p.supplierSku ?? null,
    ean: p.ean ?? null,
    internalSku: p.sku ?? null,
  })));
}

const PLAN = index([
  { id: 1, supplierSku: "SUP-1", ean: "4006381333931", sku: "INT-1" },
  { id: 2, supplierSku: "SUP-2", ean: "5901234123457", sku: "INT-2" },
  // Same EAN on two products: globally ambiguous.
  { id: 3, supplierSku: "SUP-3", ean: "5012345678900", sku: "INT-3" },
  { id: 4, supplierSku: "SUP-4", ean: "5012345678900", sku: "INT-4" },
]);

function plan(rows: ReturnType<typeof normalizeSupplierRow>[], against = PLAN) {
  return planSupplierRows(rows, against);
}

const row = (line: number, fields: Record<string, string>) => normalizeSupplierRow(line, fields);

describe("C.3.1 — matching order", () => {
  it("level 1: the supplier's own SKU matches first", () => {
    const [p] = plan([row(2, { supplierSku: "SUP-2", ean: "5901234123457", internalSku: "INT-2" })]);
    expect(p.status).toBe("ready");
    expect(p.matchType).toBe("supplier_sku");
    expect(p.productId).toBe(2);
    // Every level that agreed is recorded, so the preview can show its work.
    expect(p.evidence.map((e) => e.level)).toEqual(["supplier_sku", "ean", "internal_sku"]);
  });

  it("level 2: with no supplier SKU, the EAN decides", () => {
    const [p] = plan([row(2, { ean: "5901234123457", name: "Qualquer coisa" })]);
    expect(p).toMatchObject({ status: "ready", matchType: "ean", productId: 2 });
  });

  it("level 3: the internal SKU is the last resort", () => {
    const [p] = plan([row(2, { internalSku: "INT-1" })]);
    expect(p).toMatchObject({ status: "ready", matchType: "internal_sku", productId: 1 });
  });

  it("an unknown key on all three levels is a new product, not a fuzzy guess", () => {
    const [p] = plan([row(2, { supplierSku: "SUP-NOVA", name: "Cabo HDMI 2m" })]);
    expect(p).toMatchObject({ status: "new_product", matchType: "none", productId: null });
  });

  it("a supplier code equal to another product's internal SKU is never a match", () => {
    // "INT-1" is product 1's MDTech reference, not this supplier's. Level 3 only
    // ever consumes the internalSku column, so supplier B cannot be pointed at
    // supplier A's product just because the strings happen to match.
    const [p] = plan([row(2, { supplierSku: "INT-1", name: "Cabo de outro fornecedor" })]);
    expect(p).toMatchObject({ status: "new_product", matchType: "none", productId: null });
    expect(p.codes).toEqual([]);
    // while the same value mapped as an internal SKU does match, explicitly
    expect(plan([row(3, { internalSku: "INT-1" })])[0]).toMatchObject({ status: "ready", productId: 1 });
  });

  it("never matches on the name, even when it is identical", () => {
    const [p] = plan([row(2, { name: "SUP-1" })], index([{ id: 9, sku: "INT-9" }]));
    // Only the absent keys can match; the name is not even looked at.
    expect(p.status).toBe("error");
    expect(p.codes).toContain("MISSING_IDENTIFIER_KEY");
  });
});

describe("C.3.1 — conflicts are never resolved silently", () => {
  it("an EAN shared by two products blocks the row", () => {
    const [p] = plan([row(2, { ean: "5012345678900" })]);
    expect(p.status).toBe("conflict");
    expect(p.codes).toContain("AMBIGUOUS_EAN");
    expect(p.productId).toBeNull();
    expect(p.message).toContain("não é aplicada");
  });

  it("a supplier SKU linked to two products of the same supplier blocks the row", () => {
    const duplicated = index([
      { id: 1, supplierSku: "SAME" },
      { id: 2, supplierSku: "SAME" },
    ]);
    const [p] = plan([row(2, { supplierSku: "SAME" })], duplicated);
    expect(p.status).toBe("conflict");
    expect(p.codes).toContain("AMBIGUOUS_SUPPLIER_SKU");
  });

  it("supplier SKU and EAN pointing at different products is a conflict", () => {
    const [p] = plan([row(2, { supplierSku: "SUP-1", ean: "5901234123457" })]);
    expect(p.status).toBe("conflict");
    expect(p.codes).toContain("MATCH_MISMATCH");
    expect(p.message).toContain("produtos diferentes");
  });

  it("a supplier SKU repeated inside the file conflicts on both lines", () => {
    const plans = plan([
      row(2, { supplierSku: "SUP-1", costPrice: "10,00" }),
      row(3, { supplierSku: "SUP-1", costPrice: "12,00" }),
    ]);
    expect(plans.map((p) => p.status)).toEqual(["conflict", "conflict"]);
    expect(plans[0].codes).toContain("DUPLICATE_SUPPLIER_SKU_IN_FILE");
  });

  it("two rows that would both land on the same product conflict", () => {
    const plans = plan([
      row(2, { supplierSku: "SUP-1" }),
      row(3, { internalSku: "INT-1" }),
    ]);
    expect(plans.map((p) => p.status)).toEqual(["conflict", "conflict"]);
    expect(plans[1].codes).toContain("DUPLICATE_TARGET");
  });

  it("no UNIQUE index on supplier_sku is deliberate: ambiguity is a conflict, not a violation", () => {
    // A file may legitimately carry the same supplier SKU twice; the engine
    // refuses to pick one, which is exactly why the schema has no unique
    // constraint on supplier_sku.
    const plans = plan([row(2, { supplierSku: "SUP-1" }), row(3, { supplierSku: "SUP-1" })]);
    expect(plans.every((p) => p.status === "conflict")).toBe(true);
    expect(plans.some((p) => p.productId !== null)).toBe(false);
  });

  it("an invalid row is reported as an error even if its keys would conflict", () => {
    const [p] = plan([row(2, { supplierSku: "SUP-1", ean: "4006381333932" })]);
    expect(p.status).toBe("error");
    expect(p.codes).toContain("INVALID_GTIN");
  });

  it("a row that only has an EAN is never used to invent a catalogue key", () => {
    const [p] = plan([row(2, { ean: "9999999999994", name: "Novo" })], index([{ id: 1, sku: "INT-1" }]));
    expect(p.status).toBe("error");
    expect(p.codes).toContain("NO_CREATION_KEY");
  });
});

describe("C.3.1 — plan summary", () => {
  it("counts each outcome and each matching level", () => {
    const rows = [
      row(2, { supplierSku: "SUP-1" }),
      row(3, { ean: "5901234123457", costPrice: "5,00" }),
      row(4, { internalSku: "INT-3" }),
      row(5, { supplierSku: "SUP-NOVA", costPrice: "1,00", stock: "3" }),
      row(6, { ean: "5012345678900" }),
      row(7, { name: "sem chave" }),
    ];
    const plans = plan(rows);
    const summary = summarizePlan(rows, plans);
    expect(summary).toMatchObject({
      total: 6, ready: 3, newProducts: 1, conflicts: 1, errors: 1, withCost: 2, withStock: 1,
    });
    expect(summary.matchedBy).toEqual({ supplier_sku: 1, ean: 1, internal_sku: 1, none: 3 });
  });
});
