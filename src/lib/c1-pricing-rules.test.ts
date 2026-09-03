/**
 * C.1 — Rule resolution and the configurable rounding band policy.
 *
 * Pure unit tests: no database, so every priority/conflict combination can be
 * exercised exhaustively. The database-backed behaviour (cost changes, manual
 * protection, atomicity) lives in c1-pricing-engine.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  categoryAncestry,
  candidateRules,
  resolvePricingRule,
  describeRule,
  SCOPE_SPECIFICITY,
  type PricingRuleRow,
  type RuleScope,
} from "@/lib/pricing-rules";
import {
  resolveRoundingMode,
  validateRoundingPolicy,
  DEFAULT_ROUNDING_POLICY,
  calculatePrice,
  applyCommercialRounding,
  PricingError,
  type RoundingPolicy,
} from "@/lib/pricing-calculator";

let nextId = 1;
function rule(scope: RuleScope, partial: Partial<PricingRuleRow> = {}): PricingRuleRow {
  return {
    id: partial.id ?? nextId++,
    scope,
    productId: null, categoryId: null, brandId: null, supplierId: null,
    method: "markup_on_cost",
    ratePercent: "20",
    roundingPolicy: "auto",
    minMarginPercent: null,
    priority: 0,
    isActive: true,
    ...partial,
  };
}

const TARGET = { productId: 1, categoryId: 10, brandId: 20, supplierId: 30 };
// 12 (Gaming) → 11 (Portáteis) → 10 (Informática)
const TREE = [
  { id: 10, parentId: null },
  { id: 11, parentId: 10 },
  { id: 12, parentId: 11 },
];

describe("C.1 — category ancestry", () => {
  it("walks from the category up to the root", () => {
    expect(categoryAncestry(12, TREE)).toEqual([12, 11, 10]);
  });

  it("returns an empty chain for a product with no category", () => {
    expect(categoryAncestry(null, TREE)).toEqual([]);
  });

  it("survives a corrupt cyclic parent chain instead of hanging", () => {
    const cyclic = [{ id: 1, parentId: 2 }, { id: 2, parentId: 1 }];
    expect(categoryAncestry(1, cyclic)).toEqual([1, 2]);
  });

  it("stops at an unknown parent", () => {
    expect(categoryAncestry(12, [{ id: 12, parentId: 99 }])).toEqual([12]);
  });
});

describe("C.1 — natural priority: Produto > Categoria > Marca > Fornecedor > Geral", () => {
  const all = [
    rule("global", { id: 100 }),
    rule("supplier", { id: 101, supplierId: 30 }),
    rule("brand", { id: 102, brandId: 20 }),
    rule("category", { id: 103, categoryId: 10 }),
    rule("product", { id: 104, productId: 1 }),
  ];

  it("product wins over everything", () => {
    expect(resolvePricingRule(all, TARGET, TREE)!.rule.id).toBe(104);
  });

  it("category wins when there is no product rule", () => {
    expect(resolvePricingRule(all.filter(r => r.scope !== "product"), TARGET, TREE)!.rule.id).toBe(103);
  });

  it("brand wins over supplier and global", () => {
    const subset = all.filter(r => ["brand", "supplier", "global"].includes(r.scope));
    expect(resolvePricingRule(subset, TARGET, TREE)!.rule.id).toBe(102);
  });

  it("supplier wins over global", () => {
    const subset = all.filter(r => ["supplier", "global"].includes(r.scope));
    expect(resolvePricingRule(subset, TARGET, TREE)!.rule.id).toBe(101);
  });

  it("global is the last resort", () => {
    expect(resolvePricingRule([all[0]], TARGET, TREE)!.rule.id).toBe(100);
  });

  it("returns null when nothing matches and there is no global rule", () => {
    const foreign = [rule("brand", { brandId: 999 }), rule("supplier", { supplierId: 999 })];
    expect(resolvePricingRule(foreign, TARGET, TREE)).toBeNull();
  });

  it("the specificity table matches the documented order", () => {
    expect(SCOPE_SPECIFICITY.product).toBeGreaterThan(SCOPE_SPECIFICITY.category);
    expect(SCOPE_SPECIFICITY.category).toBeGreaterThan(SCOPE_SPECIFICITY.brand);
    expect(SCOPE_SPECIFICITY.brand).toBeGreaterThan(SCOPE_SPECIFICITY.supplier);
    expect(SCOPE_SPECIFICITY.supplier).toBeGreaterThan(SCOPE_SPECIFICITY.global);
  });
});

describe("C.1 — explicit priority overrides the natural order", () => {
  it("a promoted supplier rule beats a category rule", () => {
    // The real-world case: the distributor dictates the margin.
    const rules = [
      rule("category", { id: 1, categoryId: 10, priority: 0 }),
      rule("supplier", { id: 2, supplierId: 30, priority: 10 }),
    ];
    expect(resolvePricingRule(rules, TARGET, TREE)!.rule.id).toBe(2);
  });

  it("a promoted global rule can beat everything (kill switch)", () => {
    const rules = [
      rule("product", { id: 1, productId: 1, priority: 0 }),
      rule("global", { id: 2, priority: 99 }),
    ];
    expect(resolvePricingRule(rules, TARGET, TREE)!.rule.id).toBe(2);
  });

  it("equal priority falls back to specificity", () => {
    const rules = [
      rule("supplier", { id: 1, supplierId: 30, priority: 5 }),
      rule("product", { id: 2, productId: 1, priority: 5 }),
    ];
    expect(resolvePricingRule(rules, TARGET, TREE)!.rule.id).toBe(2);
  });
});

describe("C.1 — hierarchical categories: the deepest wins", () => {
  const deepTarget = { ...TARGET, categoryId: 12 };

  it("the direct category beats its parent and grandparent", () => {
    const rules = [
      rule("category", { id: 1, categoryId: 10 }),
      rule("category", { id: 2, categoryId: 11 }),
      rule("category", { id: 3, categoryId: 12 }),
    ];
    expect(resolvePricingRule(rules, deepTarget, TREE)!.rule.id).toBe(3);
  });

  it("falls back to the nearest ancestor that has a rule", () => {
    const rules = [rule("category", { id: 1, categoryId: 10 }), rule("category", { id: 2, categoryId: 11 })];
    expect(resolvePricingRule(rules, deepTarget, TREE)!.rule.id).toBe(2);
  });

  it("an unrelated branch does not match", () => {
    const rules = [rule("category", { id: 1, categoryId: 77 })];
    expect(resolvePricingRule(rules, deepTarget, TREE)).toBeNull();
  });

  it("reports the depth at which the category matched", () => {
    const resolved = resolvePricingRule([rule("category", { id: 1, categoryId: 10 })], deepTarget, TREE)!;
    expect(resolved.categoryDepth).toBe(2);
  });
});

describe("C.1 — inactive rules and determinism", () => {
  it("ignores inactive rules entirely", () => {
    const rules = [
      rule("product", { id: 1, productId: 1, isActive: false }),
      rule("global", { id: 2 }),
    ];
    expect(resolvePricingRule(rules, TARGET, TREE)!.rule.id).toBe(2);
    expect(candidateRules(rules, TARGET, TREE)).toHaveLength(1);
  });

  it("is deterministic regardless of input order", () => {
    const rules = [
      rule("global", { id: 1 }),
      rule("brand", { id: 2, brandId: 20 }),
      rule("category", { id: 3, categoryId: 10 }),
    ];
    const forward = resolvePricingRule(rules, TARGET, TREE)!.rule.id;
    const backward = resolvePricingRule([...rules].reverse(), TARGET, TREE)!.rule.id;
    expect(forward).toBe(backward);
    expect(forward).toBe(3);
  });

  it("breaks a full tie by highest id, never at random", () => {
    const rules = [rule("brand", { id: 5, brandId: 20 }), rule("brand", { id: 9, brandId: 20 })];
    expect(resolvePricingRule(rules, TARGET, TREE)!.rule.id).toBe(9);
  });

  it("a product without brand/supplier still matches category and global", () => {
    const bare = { productId: 1, categoryId: 10, brandId: null, supplierId: null };
    const rules = [rule("brand", { id: 1, brandId: 20 }), rule("category", { id: 2, categoryId: 10 })];
    expect(resolvePricingRule(rules, bare, TREE)!.rule.id).toBe(2);
  });

  it("describes the winning rule in Portuguese", () => {
    const resolved = resolvePricingRule([rule("brand", { id: 1, brandId: 20, ratePercent: "20" })], TARGET, TREE)!;
    expect(describeRule(resolved, { brand: "TP-Link" })).toBe("Marca TP-Link — Markup sobre custo 20%");
  });
});

describe("C.1 — configurable rounding bands", () => {
  it("the default policy implements the agreed bands", () => {
    // < 200 € → ,99 ; 200–999,99 € → ,90 ; >= 1000 € → ,90
    expect(resolveRoundingMode(1499, DEFAULT_ROUNDING_POLICY)).toBe("end_99");
    expect(resolveRoundingMode(19999, DEFAULT_ROUNDING_POLICY)).toBe("end_99");
    expect(resolveRoundingMode(20000, DEFAULT_ROUNDING_POLICY)).toBe("end_90");
    expect(resolveRoundingMode(99999, DEFAULT_ROUNDING_POLICY)).toBe("end_90");
    expect(resolveRoundingMode(100000, DEFAULT_ROUNDING_POLICY)).toBe("end_90");
    expect(resolveRoundingMode(500000, DEFAULT_ROUNDING_POLICY)).toBe("end_90");
  });

  it("bands are not hardcoded — a custom policy is honoured", () => {
    const custom: RoundingPolicy = {
      enabled: true,
      bands: [
        { fromCents: 0, mode: "none" },
        { fromCents: 5000, mode: "end_90" },
        { fromCents: 100000, mode: "end_99" },
      ],
    };
    expect(resolveRoundingMode(1000, custom)).toBe("none");
    expect(resolveRoundingMode(5000, custom)).toBe("end_90");
    expect(resolveRoundingMode(250000, custom)).toBe("end_99");
  });

  it("bands may be given out of order", () => {
    const messy: RoundingPolicy = {
      enabled: true,
      bands: [{ fromCents: 100000, mode: "end_90" }, { fromCents: 0, mode: "end_99" }],
    };
    expect(resolveRoundingMode(500, messy)).toBe("end_99");
    expect(resolveRoundingMode(200000, messy)).toBe("end_90");
  });

  it("a disabled policy rounds nothing", () => {
    expect(resolveRoundingMode(1466, { enabled: false, bands: DEFAULT_ROUNDING_POLICY.bands })).toBe("none");
  });

  it("validates bands and rejects bad configuration", () => {
    expect(() => validateRoundingPolicy(DEFAULT_ROUNDING_POLICY)).not.toThrow();
    expect(() => validateRoundingPolicy({ enabled: true, bands: [{ fromCents: 100, mode: "end_90" }] })).toThrow(PricingError);
    expect(() => validateRoundingPolicy({ enabled: true, bands: [{ fromCents: -1, mode: "end_90" }] })).toThrow(PricingError);
    expect(() => validateRoundingPolicy({
      enabled: true,
      bands: [{ fromCents: 0, mode: "end_90" }, { fromCents: 0, mode: "end_99" }],
    })).toThrow(/duplicadas/);
  });
});

describe("C.1 — the automatic path never rounds below the mathematical price", () => {
  it("prices the brief's example end to end: cost 10, markup 20%, VAT 23%", () => {
    const r = calculatePrice({
      cost: "10.00", method: "markup_on_cost", ratePercent: 20, vatPercent: 23,
      roundingPolicy: DEFAULT_ROUNDING_POLICY,
    });
    expect(r.netBeforeRoundingCents).toBe(1200);
    expect(r.grossBeforeRoundingCents).toBe(1476); // 14,76 €
    expect(r.finalGrossCents).toBe(1499);          // banda < 200 € → ,99
    expect(r.finalGrossCents).toBeGreaterThanOrEqual(r.grossBeforeRoundingCents);
  });

  it("uses the ,90 band for an expensive product", () => {
    const r = calculatePrice({
      cost: "800.00", method: "markup_on_cost", ratePercent: 20, vatPercent: 23,
      roundingPolicy: DEFAULT_ROUNDING_POLICY,
    });
    expect(r.grossBeforeRoundingCents).toBe(118080); // 1.180,80 €
    expect(r.finalGrossCents).toBe(118090);          // 1.180,90 €
  });

  it("a band policy overrides a fixed rounding argument", () => {
    const r = calculatePrice({
      cost: "10.00", method: "markup_on_cost", ratePercent: 20, vatPercent: 23,
      rounding: "none", roundingPolicy: DEFAULT_ROUNDING_POLICY,
    });
    expect(r.finalGrossCents).toBe(1499);
  });

  it("the real margin after automatic rounding is never below the target", () => {
    for (let cost = 100; cost <= 200000; cost += 977) {
      const r = calculatePrice({
        cost: cost / 100, method: "markup_on_cost", ratePercent: 20, vatPercent: 23,
        roundingPolicy: DEFAULT_ROUNDING_POLICY,
      });
      expect(r.finalGrossCents).toBeGreaterThanOrEqual(r.grossBeforeRoundingCents);
      expect(r.realMarkupOnCostPercent!).toBeGreaterThanOrEqual(20);
    }
  });

  it("margin_on_sale rules also never lose margin to rounding", () => {
    for (let cost = 100; cost <= 100000; cost += 733) {
      const r = calculatePrice({
        cost: cost / 100, method: "margin_on_sale", ratePercent: 35, vatPercent: 23,
        roundingPolicy: DEFAULT_ROUNDING_POLICY,
      });
      expect(r.realMarginOnSalePercent).toBeGreaterThanOrEqual(35 - 1e-9);
    }
  });

  it("keeps the B.7 fixed-ending behaviour untouched", () => {
    expect(applyCommercialRounding(1466, "end_90")).toBe(1490);
    expect(applyCommercialRounding(1466, "end_99")).toBe(1499);
    expect(applyCommercialRounding(1466, "none")).toBe(1466);
  });
});
