/**
 * B.7 — Commercial pricing calculator.
 *
 * Pure unit tests (no database): the calculator is deliberately dependency-free
 * so the future automatic pricing engine (supplier / brand / category rules and
 * XML imports) can reuse it server-side.
 *
 * Covers the two distinct methods, VAT handling, commercial rounding that never
 * rounds down, integer-cents accuracy, edge cases and a regression guard on the
 * existing margin-on-sale semantics.
 */
import { describe, expect, it } from "vitest";
import {
  applyCommercialRounding,
  applyVat,
  removeVat,
  netPriceFromCost,
  calculatePrice,
  analyseGrossPrice,
  marginOnSaleFromPrices,
  centsToDecimalString,
  PricingError,
  MAX_MARGIN_ON_SALE,
} from "@/lib/pricing-calculator";

describe("B.7 — the two methods are different and must not be conflated", () => {
  it("margin on sale: cost 50 with 50% yields net 100", () => {
    expect(netPriceFromCost(5000, "margin_on_sale", 50)).toBe(10000);
  });

  it("markup on cost: cost 50 with 50% yields net 75", () => {
    expect(netPriceFromCost(5000, "markup_on_cost", 50)).toBe(7500);
  });

  it("the same percentage produces different prices for each method", () => {
    const margin = netPriceFromCost(10000, "margin_on_sale", 30);
    const markup = netPriceFromCost(10000, "markup_on_cost", 30);
    expect(margin).toBe(14286); // 100 / 0.70
    expect(markup).toBe(13000); // 100 * 1.30
    expect(margin).toBeGreaterThan(markup);
  });

  it("markup is unbounded but margin on sale is capped below 100%", () => {
    expect(netPriceFromCost(1000, "markup_on_cost", 500)).toBe(6000);
    expect(() => netPriceFromCost(1000, "margin_on_sale", 100)).toThrow(PricingError);
    expect(() => netPriceFromCost(1000, "margin_on_sale", 150)).toThrow(/inferior a 100%/);
    expect(netPriceFromCost(1000, "margin_on_sale", MAX_MARGIN_ON_SALE)).toBeGreaterThan(0);
  });

  it("rejects negative rates and negative cost", () => {
    expect(() => netPriceFromCost(1000, "markup_on_cost", -5)).toThrow(PricingError);
    expect(() => netPriceFromCost(1000, "margin_on_sale", -5)).toThrow(PricingError);
    expect(() => netPriceFromCost(-1, "markup_on_cost", 10)).toThrow(PricingError);
  });
});

describe("B.7 — VAT", () => {
  it("applies and removes 23% symmetrically", () => {
    expect(applyVat(10000, 23)).toBe(12300);
    expect(removeVat(12300, 23)).toBe(10000);
  });

  it("supports the other Portuguese rates already in use", () => {
    expect(applyVat(10000, 6)).toBe(10600);
    expect(applyVat(10000, 13)).toBe(11300);
    expect(applyVat(10000, 0)).toBe(10000);
  });

  it("supports a decimal VAT rate", () => {
    expect(applyVat(10000, 23.5)).toBe(12350);
  });

  it("rejects an invalid VAT rate", () => {
    expect(() => applyVat(1000, -1)).toThrow(PricingError);
  });
});

describe("B.7 — commercial rounding never rounds down", () => {
  it("leaves the price untouched with no rounding", () => {
    expect(applyCommercialRounding(1466, "none")).toBe(1466);
  });

  it("rounds 14,66 up to 14,90 and 14,99 (the brief's example)", () => {
    expect(applyCommercialRounding(1466, "end_90")).toBe(1490);
    expect(applyCommercialRounding(1466, "end_99")).toBe(1499);
  });

  it("jumps to the next euro when the ending is already passed", () => {
    expect(applyCommercialRounding(1495, "end_90")).toBe(1590);
    expect(applyCommercialRounding(1499, "end_90")).toBe(1590);
  });

  it("keeps a price that already has the requested ending", () => {
    expect(applyCommercialRounding(1490, "end_90")).toBe(1490);
    expect(applyCommercialRounding(1499, "end_99")).toBe(1499);
  });

  it("takes ,99 for 14,95 without changing euro", () => {
    expect(applyCommercialRounding(1495, "end_99")).toBe(1499);
  });

  it("NEVER produces a price below the mathematical one (property check)", () => {
    for (let cents = 1; cents <= 3000; cents += 1) {
      expect(applyCommercialRounding(cents, "end_90")).toBeGreaterThanOrEqual(cents);
      expect(applyCommercialRounding(cents, "end_99")).toBeGreaterThanOrEqual(cents);
      expect(applyCommercialRounding(cents, "none")).toBeGreaterThanOrEqual(cents);
    }
  });

  it("handles sub-euro prices by lifting them to the ending", () => {
    expect(applyCommercialRounding(50, "end_90")).toBe(90);
    expect(applyCommercialRounding(95, "end_99")).toBe(99);
    expect(applyCommercialRounding(95, "end_90")).toBe(190);
  });
});

describe("B.7 — end-to-end calculation", () => {
  it("computes cost + margin on sale + VAT with no rounding", () => {
    const r = calculatePrice({ cost: "50.00", method: "margin_on_sale", ratePercent: 50, vatPercent: 23 });
    expect(r.netBeforeRoundingCents).toBe(10000);
    expect(r.grossBeforeRoundingCents).toBe(12300);
    expect(r.finalGrossCents).toBe(12300);
    expect(r.realMarginOnSalePercent).toBeCloseTo(50, 6);
    expect(r.realMarkupOnCostPercent).toBeCloseTo(100, 6);
    expect(r.roundingUpliftCents).toBe(0);
  });

  it("reports the REAL margin after rounding up, which is higher than requested", () => {
    // cost 10, markup 19% => net 11.90 => gross 14.637 ≈ 14.64
    const r = calculatePrice({ cost: "10.00", method: "markup_on_cost", ratePercent: 19, vatPercent: 23, rounding: "end_99" });
    expect(r.grossBeforeRoundingCents).toBe(1464);
    expect(r.finalGrossCents).toBe(1499);
    expect(r.roundingUpliftCents).toBe(35);
    // Rounding up can only improve profitability.
    expect(r.realMarginCents).toBeGreaterThan(r.netBeforeRoundingCents - r.costCents);
    expect(r.realMarkupOnCostPercent!).toBeGreaterThan(19);
  });

  it("splits the final gross into net + VAT consistently", () => {
    const r = calculatePrice({ cost: "10.00", method: "markup_on_cost", ratePercent: 19, vatPercent: 23, rounding: "end_90" });
    expect(r.finalNetCents + r.finalVatCents).toBe(r.finalGrossCents);
    expect(r.realMarginCents).toBe(r.finalNetCents - r.costCents);
  });

  it("handles margin zero — price equals cost plus VAT", () => {
    const r = calculatePrice({ cost: "20.00", method: "margin_on_sale", ratePercent: 0, vatPercent: 23 });
    expect(r.netBeforeRoundingCents).toBe(2000);
    expect(r.finalGrossCents).toBe(2460);
    expect(r.realMarginCents).toBe(0);
    expect(r.realMarginOnSalePercent).toBeCloseTo(0, 6);
  });

  it("handles markup zero the same way", () => {
    const r = calculatePrice({ cost: "20.00", method: "markup_on_cost", ratePercent: 0, vatPercent: 23 });
    expect(r.finalGrossCents).toBe(2460);
    expect(r.realMarginCents).toBe(0);
  });

  it("handles zero or missing cost without crashing", () => {
    const zero = calculatePrice({ cost: "0", method: "markup_on_cost", ratePercent: 50, vatPercent: 23 });
    expect(zero.finalGrossCents).toBe(0);
    expect(zero.realMarkupOnCostPercent).toBeNull(); // undefined over zero cost

    const missing = calculatePrice({ cost: null, method: "markup_on_cost", ratePercent: 50, vatPercent: 23 });
    expect(missing.costCents).toBe(0);
  });

  it("accepts decimal cost and decimal rate", () => {
    const r = calculatePrice({ cost: "12.34", method: "markup_on_cost", ratePercent: 17.5, vatPercent: 23 });
    expect(r.costCents).toBe(1234);
    expect(r.netBeforeRoundingCents).toBe(1450); // 12.34 * 1.175 = 14.4995
    expect(Number.isInteger(r.finalGrossCents)).toBe(true);
  });

  it("accepts a comma as decimal separator (pt-PT typing)", () => {
    const r = calculatePrice({ cost: "12,50", method: "markup_on_cost", ratePercent: 100, vatPercent: 23 });
    expect(r.costCents).toBe(1250);
    expect(r.netBeforeRoundingCents).toBe(2500);
  });

  it("returns integer cents everywhere", () => {
    const r = calculatePrice({ cost: "7.77", method: "margin_on_sale", ratePercent: 33.3, vatPercent: 23, rounding: "end_99" });
    for (const v of [r.costCents, r.netBeforeRoundingCents, r.grossBeforeRoundingCents, r.finalGrossCents, r.finalNetCents, r.finalVatCents, r.realMarginCents]) {
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it("produces a decimal string suitable for the products API", () => {
    const r = calculatePrice({ cost: "10.00", method: "markup_on_cost", ratePercent: 19, vatPercent: 23, rounding: "end_99" });
    expect(centsToDecimalString(r.finalGrossCents)).toBe("14.99");
    expect(/^\d+\.\d{2}$/.test(centsToDecimalString(r.finalGrossCents))).toBe(true);
  });

  it("rejects a negative cost and an invalid rate", () => {
    expect(() => calculatePrice({ cost: "-1", method: "markup_on_cost", ratePercent: 10, vatPercent: 23 })).toThrow(PricingError);
    expect(() => calculatePrice({ cost: "10", method: "markup_on_cost", ratePercent: "abc", vatPercent: 23 })).toThrow(PricingError);
  });
});

describe("B.7 — manual override after calculating", () => {
  it("recomputes the real margin for a hand-typed price", () => {
    const r = analyseGrossPrice({ grossPrice: "19.99", cost: "10.00", vatPercent: 23 })!;
    expect(r.finalGrossCents).toBe(1999);
    expect(r.finalNetCents).toBe(1625); // 19.99 / 1.23
    expect(r.realMarginCents).toBe(625);
    expect(r.realMarginOnSalePercent).toBeCloseTo(38.46, 1);
    expect(r.realMarkupOnCostPercent).toBeCloseTo(62.5, 1);
  });

  it("reports a negative margin when the operator prices below cost", () => {
    const r = analyseGrossPrice({ grossPrice: "5.00", cost: "10.00", vatPercent: 23 })!;
    expect(r.realMarginCents).toBeLessThan(0);
    expect(r.realMarginOnSalePercent).toBeLessThan(0);
  });

  it("returns null for an empty or zero price", () => {
    expect(analyseGrossPrice({ grossPrice: "", cost: "1", vatPercent: 23 })).toBeNull();
    expect(analyseGrossPrice({ grossPrice: "0", cost: "1", vatPercent: 23 })).toBeNull();
  });

  it("lowering a calculated price lowers the real margin accordingly", () => {
    const calculated = calculatePrice({ cost: "10.00", method: "markup_on_cost", ratePercent: 50, vatPercent: 23, rounding: "end_99" });
    const overridden = analyseGrossPrice({ grossPrice: "12.99", cost: "10.00", vatPercent: 23 })!;
    expect(overridden.finalGrossCents).toBeLessThan(calculated.finalGrossCents);
    expect(overridden.realMarginCents).toBeLessThan(calculated.realMarginCents);
  });
});

describe("B.7 — regression: existing margin-on-sale semantics are unchanged", () => {
  it("matches the formula already used in the product form", () => {
    // Previously: net = gross / (1 + vat/100); margin% = (net - cost) / net * 100
    const r = marginOnSaleFromPrices("123.00", "50.00", 23)!;
    expect(r.netCents).toBe(10000);
    expect(r.marginCents).toBe(5000);
    expect(r.marginPercent).toBeCloseTo(50, 6);
  });

  it("stays consistent with calculatePrice for the same inputs", () => {
    const forward = calculatePrice({ cost: "50.00", method: "margin_on_sale", ratePercent: 50, vatPercent: 23 });
    const backward = marginOnSaleFromPrices(centsToDecimalString(forward.finalGrossCents), "50.00", 23)!;
    expect(backward.marginPercent).toBeCloseTo(forward.realMarginOnSalePercent, 6);
  });

  it("returns null when cost is absent, as the UI expects", () => {
    expect(marginOnSaleFromPrices("123.00", null, 23)).toBeNull();
    expect(marginOnSaleFromPrices("123.00", "", 23)).toBeNull();
  });

  it("handles a negative margin (cost above net price)", () => {
    const r = marginOnSaleFromPrices("100.00", "200.00", 23)!;
    expect(r.marginCents).toBeLessThan(0);
    expect(r.marginPercent).toBeLessThan(0);
  });
});
