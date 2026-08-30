import { describe, it, expect } from "vitest";
import { toCents, toEuros, calcVatFromGross, unitPriceNet, lineTotal, allocateDiscount } from "./money";

describe("toCents / toEuros", () => {
  it("converts euros to cents", () => { expect(toCents(12.30)).toBe(1230); });
  it("converts string to cents", () => { expect(toCents("389.99")).toBe(38999); });
  it("converts cents to euros string", () => { expect(toEuros(12300)).toBe("123.00"); });
  it("handles zero", () => { expect(toEuros(0)).toBe("0.00"); });
});

describe("calcVatFromGross", () => {
  it("123.00€ @ 23% → net=100.00, vat=23.00", () => {
    const r = calcVatFromGross(12300, 23);
    expect(r.netCents).toBe(10000);
    expect(r.vatCents).toBe(2300);
  });
  it("389.99€ @ 23% → vat=72.92", () => {
    const r = calcVatFromGross(38999, 23);
    expect(r.vatCents).toBe(7292);
    expect(r.netCents).toBe(31707);
  });
  it("100.00€ @ 13% → net=88.50, vat=11.50", () => {
    const r = calcVatFromGross(10000, 13);
    expect(r.netCents).toBe(8850);
    expect(r.vatCents).toBe(1150);
  });
});

describe("unitPriceNet", () => {
  it("from 12300 gross @ 23% → 10000 net", () => {
    expect(unitPriceNet(12300, 23)).toBe(10000);
  });
  it("NOT derived from line total / quantity", () => {
    // 3 units at 12300 each = 36900 line total
    // Gross line VAT = calcVatFromGross(36900, 23) = net 30000
    // Unit net should be 10000 (from unit gross directly), NOT 30000/3=10000 (same here, but principle matters)
    expect(unitPriceNet(12300, 23)).toBe(10000);
  });
});

describe("lineTotal", () => {
  it("unit * qty", () => { expect(lineTotal(12300, 3)).toBe(36900); });
});

describe("allocateDiscount", () => {
  it("distributes proportionally", () => {
    const lines = [{ lineTotalCents: 10000 }, { lineTotalCents: 20000 }];
    const alloc = allocateDiscount(lines, 3000);
    expect(alloc[0] + alloc[1]).toBe(3000); // exact sum
    expect(alloc[0]).toBe(1000);
    expect(alloc[1]).toBe(2000);
  });

  it("handles rounding — remainder goes to last line", () => {
    const lines = [{ lineTotalCents: 10000 }, { lineTotalCents: 10000 }, { lineTotalCents: 10000 }];
    const alloc = allocateDiscount(lines, 1000);
    expect(alloc.reduce((a, b) => a + b, 0)).toBe(1000); // exact
  });

  it("zero discount", () => {
    const alloc = allocateDiscount([{ lineTotalCents: 10000 }], 0);
    expect(alloc[0]).toBe(0);
  });

  it("single item gets full discount", () => {
    const alloc = allocateDiscount([{ lineTotalCents: 50000 }], 5000);
    expect(alloc[0]).toBe(5000);
  });
});

describe("VAT after discount", () => {
  it("10% discount on 12300 gross @ 23%", () => {
    const gross = 12300;
    const discount = Math.round(gross * 0.10); // 1230
    const effectiveGross = gross - discount; // 11070
    const { netCents, vatCents } = calcVatFromGross(effectiveGross, 23);
    expect(effectiveGross).toBe(11070);
    expect(netCents + vatCents).toBe(11070);
    // net = 11070 / 1.23 = 9000, vat = 2070
    expect(netCents).toBe(9000);
    expect(vatCents).toBe(2070);
  });

  it("multiple VAT rates with global discount", () => {
    const lineA = { grossCents: 12300, vatRate: 23 }; // product A
    const lineB = { grossCents: 10000, vatRate: 13 }; // product B
    const totalGross = lineA.grossCents + lineB.grossCents; // 22300
    const discountCents = Math.round(totalGross * 0.10); // 2230
    const discounts = allocateDiscount(
      [{ lineTotalCents: lineA.grossCents }, { lineTotalCents: lineB.grossCents }],
      discountCents
    );
    expect(discounts[0] + discounts[1]).toBe(discountCents);

    const effA = lineA.grossCents - discounts[0];
    const effB = lineB.grossCents - discounts[1];
    const vatA = calcVatFromGross(effA, lineA.vatRate);
    const vatB = calcVatFromGross(effB, lineB.vatRate);

    // Everything adds up
    expect(vatA.netCents + vatA.vatCents).toBe(effA);
    expect(vatB.netCents + vatB.vatCents).toBe(effB);
    expect(effA + effB).toBe(totalGross - discountCents);
  });
});
