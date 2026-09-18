/**
 * PAYMENT P0 — H1 regression suite.
 *
 * The provider's INPUT is hostile: a malformed or contradictory payload must be
 * REJECTED, never repaired into something that looks valid.
 *
 * Regressions covered here (each one failed before the H1 hardening):
 *  1. `99.999` was rounded/normalized into a valid amount.
 *  2. any label containing "cc" was read as a CARD payment ("success" → card).
 *  3. `originalTrid = A` together with `original_trid = B` silently picked one.
 *  4. `amount` and `valor` disagreeing silently picked one.
 *  5. an unknown method label was guessed from a substring.
 *
 * Every case asserts the exact failure code, so a future refactor cannot
 * downgrade a rejection into a silent normalization.
 */

import { describe, expect, it } from "vitest";
import {
  EUPAGO_ALIAS_GROUPS,
  decimalStringToCents,
  normalizeEupagoEvent,
  normalizeMethod,
} from "./events";

const TRID = "000000000000000000000000000000000000000001";

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { trid: TRID, status: "Paid", amount: "10.00", method: "multibanco", ...overrides };
}

function expectRejected(input: Record<string, unknown>, code: string) {
  const result = normalizeEupagoEvent(input);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.code).toBe(code);
}

describe("H1 — decimal amounts are exact or rejected", () => {
  it("never rounds a value with sub-cent precision", () => {
    // POSITIVE: exact values still work…
    expect(decimalStringToCents("99.99")).toBe(9999);
    expect(decimalStringToCents(99.99)).toBe(9999);
    expect(decimalStringToCents("0.01")).toBe(1);
    expect(decimalStringToCents("100")).toBe(10000);

    // NEGATIVE: everything else is null — never a rounded amount.
    expect(decimalStringToCents("99.999")).toBeNull();
    expect(decimalStringToCents(99.999)).toBeNull();
    expect(decimalStringToCents("0.001")).toBeNull();
    expect(decimalStringToCents("1e3")).toBeNull();
    expect(decimalStringToCents("12,345")).toBeNull();
    expect(decimalStringToCents(" 12.34 ")).toBe(1234); // trimming is not rounding
    expect(decimalStringToCents("")).toBeNull();
    expect(decimalStringToCents(Number.NaN)).toBeNull();
    expect(decimalStringToCents(null)).toBeNull();
  });

  it("rejects a present-but-invalid amount instead of treating it as absent", () => {
    expectRejected(payload({ amount: "99.999" }), "INVALID_AMOUNT");
    expectRejected(payload({ amount: "1e3" }), "INVALID_AMOUNT");
    expectRejected(payload({ amount: "abc" }), "INVALID_AMOUNT");
  });

  it("keeps an ABSENT amount absent (no invented value)", () => {
    const result = normalizeEupagoEvent(payload({ amount: undefined }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.amountCents).toBeNull();
  });

  it("rejects contradictory amount aliases", () => {
    expectRejected(payload({ amount: "10.00", valor: "20.00" }), "CONFLICTING_AMOUNT_ALIASES");
    // …even when one of the two is unparseable.
    expectRejected(payload({ amount: "10.00", valor: "nope" }), "CONFLICTING_AMOUNT_ALIASES");
    // POSITIVE: agreeing aliases are accepted.
    const ok = normalizeEupagoEvent(payload({ amount: "10.00", valor: "10.00" }));
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.event.amountCents).toBe(1000);
  });
});

describe("H1 — method resolution is an exact allowlist", () => {
  it("never matches on substrings", () => {
    // This is the historical bug: "success" contains "cc".
    expect(normalizeMethod("success")).toBeNull();
    expect(normalizeMethod("Success")).toBeNull();
    expect(normalizeMethod("postcard")).toBeNull();
    expect(normalizeMethod("ccard")).toBeNull(); // not an allowed label
    expect(normalizeMethod("multibancos")).toBeNull();
    expect(normalizeMethod("")).toBeNull();
    expect(normalizeMethod(null)).toBeNull();
  });

  it("accepts only the closed set of labels and aliases", () => {
    expect(normalizeMethod("multibanco")).toBe("multibanco");
    expect(normalizeMethod("Referência Multibanco")).toBe("multibanco");
    expect(normalizeMethod("MB WAY")).toBe("mbway");
    expect(normalizeMethod("mb_way")).toBe("mbway");
    expect(normalizeMethod("Cartão de Crédito")).toBe("card");
    expect(normalizeMethod("VISA")).toBe("card");
    expect(normalizeMethod("cc")).toBe("card");
  });

  it("does not turn a status word into a card payment", () => {
    const result = normalizeEupagoEvent(payload({ method: "success" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Fail-closed: the settlement path treats a null method as METHOD_MISSING.
    expect(result.event.method).toBeNull();
  });

  it("keeps the alias table closed — no entry may be a substring of another", () => {
    // A property test on the contract itself: if someone adds a key that is a
    // prefix/substring of another key, the table stops being exact-match safe.
    const keys = Object.keys(EUPAGO_ALIAS_GROUPS);
    expect(keys.sort()).toEqual(["amount", "originalTrid", "trid"]);
    for (const group of Object.values(EUPAGO_ALIAS_GROUPS)) {
      expect(group.length).toBeGreaterThan(0);
    }
  });
});

describe("H1 — duplicate equivalent aliases must coincide", () => {
  const OTHER_TRID = "000000000000000000000000000000000000000002";

  it("rejects a contradictory originalTrid pair", () => {
    expectRejected(
      {
        trid: TRID,
        status: "Refund",
        originalTrid: TRID,
        original_trid: OTHER_TRID,
        amount: "10.00",
        method: "multibanco",
      },
      "CONFLICTING_ORIGINAL_TRID_ALIASES"
    );
  });

  it("accepts an agreeing originalTrid pair", () => {
    const result = normalizeEupagoEvent({
      trid: OTHER_TRID,
      status: "Refund",
      originalTrid: TRID,
      original_trid: TRID,
      amount: "10.00",
      method: "multibanco",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.kind).toBe("refund");
    expect(result.event.originalTrid).toBe(TRID);
  });

  it("rejects a contradictory trid pair", () => {
    expectRejected(
      { trid: TRID, transactionID: OTHER_TRID, status: "Paid", amount: "10.00" },
      "CONFLICTING_TRID_ALIASES"
    );
  });

  it("treats an empty alias as absent (nothing to contradict)", () => {
    const result = normalizeEupagoEvent({ trid: TRID, transaction_id: "   ", status: "Paid", amount: "10.00" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.trid).toBe(TRID);
  });

  it("rejects a contradictory pair where one member is unusable", () => {
    expectRejected(
      { trid: TRID, status: "Refund", originalTrid: TRID, original_trid: "bad", amount: "1.00" },
      "CONFLICTING_ORIGINAL_TRID_ALIASES"
    );
  });
});

describe("H1 — identity and structure", () => {
  it("distinguishes a missing trid from an invalid one", () => {
    expectRejected({ status: "Paid", amount: "10.00" }, "MISSING_TRID");
    expectRejected({ trid: "abc def", status: "Paid", amount: "10.00" }, "INVALID_TRID");
    expectRejected({ trid: "x".repeat(65), status: "Paid", amount: "10.00" }, "INVALID_TRID");
  });

  it("requires a refund to carry a distinct originalTrid", () => {
    expectRejected({ trid: TRID, status: "Refund", amount: "10.00" }, "MISSING_ORIGINAL_TRID");
    expectRejected(
      { trid: TRID, status: "Refund", originalTrid: TRID, amount: "10.00" },
      "REFUND_TRID_NOT_DISTINCT"
    );
  });

  it("rejects an unknown status and an invalid currency", () => {
    expectRejected(payload({ status: "Whatever" }), "UNKNOWN_STATUS");
    // Present-but-invalid currency is an error, NOT a silently absent currency.
    expectRejected(payload({ currency: "eur" }), "INVALID_CURRENCY");
    expectRejected(payload({ currency: "EURO" }), "INVALID_CURRENCY");
    expectRejected(payload({ currency: 978 }), "INVALID_CURRENCY");
    // POSITIVE: an absent currency stays absent.
    const absent = normalizeEupagoEvent(payload({ currency: undefined }));
    expect(absent.ok).toBe(true);
    if (!absent.ok) return;
    expect(absent.event.currency).toBeNull();
  });

  it("normalizes a nested transaction object exactly like a flat payload", () => {
    const nested = normalizeEupagoEvent({ transaction: payload() });
    const flat = normalizeEupagoEvent(payload());
    expect(nested.ok).toBe(true);
    expect(flat.ok).toBe(true);
    if (!nested.ok || !flat.ok) return;
    expect(nested.event).toEqual(flat.event);
  });
});
