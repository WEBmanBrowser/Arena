// B.3.1 — Money boundary tests (pure, no DB)
// Imports the REAL production module.

import { describe, it, expect } from "vitest";
import {
  parseDecimalToCents,
  formatCentsToDecimal,
  isCanonicalDecimalAmount,
  assertSupportedCurrency,
  PROVIDER_CURRENCY,
  MAX_PROVIDER_AMOUNT_CENTS,
} from "@/lib/providers/money-boundary";
import { ProviderError } from "@/lib/providers/errors";

describe("B.3.1 — money boundary: decimal → cents", () => {
  it("converts canonical decimal strings to integer cents", () => {
    expect(parseDecimalToCents("0.00")).toBe(0);
    expect(parseDecimalToCents("0.01")).toBe(1);
    expect(parseDecimalToCents("1.00")).toBe(100);
    expect(parseDecimalToCents("123.45")).toBe(12345);
    expect(parseDecimalToCents("999999.99")).toBe(99999999);
  });

  it("accepts values with a single decimal digit or no decimals", () => {
    expect(parseDecimalToCents("1")).toBe(100);
    expect(parseDecimalToCents("1.5")).toBe(150);
    expect(parseDecimalToCents("0.1")).toBe(10);
  });

  it("is exact where floating point is not (no parseFloat * 100)", () => {
    // parseFloat("1.15") * 100 === 114.99999999999999
    expect(parseDecimalToCents("1.15")).toBe(115);
    expect(parseDecimalToCents("8.20")).toBe(820);
    expect(parseDecimalToCents("1234567.89")).toBe(123456789);
  });

  it("rejects malformed values", () => {
    for (const bad of ["", "abc", "1.001", "1,00", " 1.00", "1.00 ", "1..0", "+1.00", "1e3", "NaN", "Infinity"]) {
      expect(() => parseDecimalToCents(bad)).toThrow(ProviderError);
    }
  });

  it("rejects negative amounts by default and allows them explicitly", () => {
    expect(() => parseDecimalToCents("-1.00")).toThrow(ProviderError);
    expect(parseDecimalToCents("-1.00", { allowNegative: true })).toBe(-100);
    expect(parseDecimalToCents("-0.00", { allowNegative: true })).toBe(0);
  });

  it("rejects unsafe / oversized amounts", () => {
    expect(() => parseDecimalToCents("999999999999.99")).toThrow(ProviderError);
    expect(() => parseDecimalToCents("9007199254740991.00")).toThrow(ProviderError);
  });

  it("throws normalized INVALID_PROVIDER_RESPONSE without leaking internals", () => {
    try {
      parseDecimalToCents("abc");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError);
      const safe = (e as ProviderError).toCustomerSafeJSON();
      expect(safe.error).toBe("INVALID_PROVIDER_RESPONSE");
      expect(JSON.stringify(safe)).not.toContain("abc");
    }
  });
});

describe("B.3.1 — money boundary: cents → decimal", () => {
  it("formats integer cents as canonical decimal strings", () => {
    expect(formatCentsToDecimal(0)).toBe("0.00");
    expect(formatCentsToDecimal(1)).toBe("0.01");
    expect(formatCentsToDecimal(100)).toBe("1.00");
    expect(formatCentsToDecimal(12345)).toBe("123.45");
    expect(formatCentsToDecimal(99999999)).toBe("999999.99");
  });

  it("regression: 100 cents is 1.00 euros, never 100.00", () => {
    expect(formatCentsToDecimal(100)).toBe("1.00");
    expect(formatCentsToDecimal(100)).not.toBe("100.00");
    expect(formatCentsToDecimal(10000)).toBe("100.00");
  });

  it("formats negative cents (credit notes / refunds)", () => {
    expect(formatCentsToDecimal(-1)).toBe("-0.01");
    expect(formatCentsToDecimal(-12345)).toBe("-123.45");
  });

  it("rejects non-integer, unsafe and oversized cent values", () => {
    for (const bad of [1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER]) {
      expect(() => formatCentsToDecimal(bad)).toThrow(ProviderError);
    }
    expect(() => formatCentsToDecimal(MAX_PROVIDER_AMOUNT_CENTS + 1)).toThrow(ProviderError);
  });

  it("round-trips deterministically", () => {
    for (const cents of [0, 1, 7, 100, 999, 12345, 99999999, MAX_PROVIDER_AMOUNT_CENTS]) {
      expect(parseDecimalToCents(formatCentsToDecimal(cents))).toBe(cents);
    }
    expect(isCanonicalDecimalAmount("1.00")).toBe(true);
    expect(isCanonicalDecimalAmount("1.0")).toBe(false);
    expect(isCanonicalDecimalAmount("abc")).toBe(false);
  });
});

describe("B.3.1 — money boundary: currency", () => {
  it("only accepts EUR (ISO 4217)", () => {
    expect(PROVIDER_CURRENCY).toBe("EUR");
    expect(assertSupportedCurrency("EUR")).toBe("EUR");
    expect(() => assertSupportedCurrency("USD")).toThrow(ProviderError);
    expect(() => assertSupportedCurrency("eur")).toThrow(ProviderError);
  });
});
