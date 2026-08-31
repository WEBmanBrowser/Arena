/**
 * B.3.1 — Provider money boundary.
 *
 * Canonical internal representation: INTEGER CENTS, currency EUR (ISO 4217).
 *
 * External providers exchange decimal strings ("12.34"). Conversion is
 * deterministic integer/string arithmetic — floating point (`parseFloat(v) * 100`)
 * is NEVER used, because it silently loses precision (e.g. 1.005 * 100).
 *
 * This module is pure: no database, no network, no provider SDK.
 */

import { ProviderError } from "./errors";

/** ISO 4217 currency used by the whole shop. */
export const PROVIDER_CURRENCY = "EUR" as const;
export type ProviderCurrency = typeof PROVIDER_CURRENCY;

/**
 * Upper bound for a single provider amount, in cents.
 *
 * Aligned with the DATABASE domain: `payment_attempts.amount_cents` is a
 * PostgreSQL `integer` (int4), so 2_147_483_647 cents (≈ 21.474.836,47 EUR) is
 * the largest value that can actually be persisted. Keeping the application
 * boundary at the same limit means oversized amounts are rejected by
 * normalized validation instead of surfacing as a raw PostgreSQL numeric
 * overflow (SQLSTATE 22003) from deep inside the driver.
 *
 * This ceiling is orders of magnitude above any realistic order total for this
 * shop, so widening the column to bigint is not justified in B.3.1.
 */
export const MAX_PROVIDER_AMOUNT_CENTS = 2_147_483_647; // int4 max — see payment_attempts.amount_cents

/** Strictly: optional sign, 1..12 integer digits, optional 1..2 decimals. */
const DECIMAL_RE = /^(-)?(\d{1,12})(?:\.(\d{1,2}))?$/;

export interface DecimalParseOptions {
  /** Allow negative amounts (e.g. credit notes / refunds). Default: false. */
  allowNegative?: boolean;
}

function invalid(detail: string): never {
  throw new ProviderError("INVALID_PROVIDER_RESPONSE", { internalDetail: detail });
}

/**
 * Decimal provider string -> integer cents.
 *
 *   "0.00"      -> 0
 *   "0.01"      -> 1
 *   "1.00"      -> 100
 *   "123.45"    -> 12345
 *   "999999.99" -> 99999999
 *
 * Rejects: "", "abc", "1.001", " 1.00", "1,00", NaN/Infinity, values above
 * MAX_PROVIDER_AMOUNT_CENTS, and (by default) negative amounts.
 */
export function parseDecimalToCents(value: string, options: DecimalParseOptions = {}): number {
  if (typeof value !== "string") invalid("amount is not a string");
  if (value.length === 0 || value.length > 20) invalid("amount length out of range");

  const match = DECIMAL_RE.exec(value);
  if (!match) invalid("amount does not match decimal format");

  const [, sign, whole, fraction = ""] = match;
  const negative = sign === "-";
  if (negative && !options.allowNegative) invalid("negative amount not allowed");

  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) invalid("amount is not a safe integer");
  if (cents > MAX_PROVIDER_AMOUNT_CENTS) invalid("amount exceeds maximum");
  if (negative && cents === 0) return 0; // normalize "-0.00"
  return negative ? -cents : cents;
}

/**
 * Integer cents -> canonical decimal string with exactly 2 decimals.
 *
 *   0     -> "0.00"
 *   1     -> "0.01"
 *   100   -> "1.00"     (NOT "100.00")
 *   12345 -> "123.45"
 */
export function formatCentsToDecimal(cents: number): string {
  if (typeof cents !== "number" || !Number.isInteger(cents) || !Number.isSafeInteger(cents)) {
    invalid("cents is not a safe integer");
  }
  if (Math.abs(cents) > MAX_PROVIDER_AMOUNT_CENTS) invalid("cents exceeds maximum");

  const negative = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.trunc(abs / 100);
  const fraction = abs % 100;
  return `${negative ? "-" : ""}${whole}.${String(fraction).padStart(2, "0")}`;
}

/** True when the value round-trips exactly through the money boundary. */
export function isCanonicalDecimalAmount(value: string): boolean {
  try {
    return formatCentsToDecimal(parseDecimalToCents(value, { allowNegative: true })) === value;
  } catch {
    return false;
  }
}

/**
 * Validate that a currency code is the supported ISO 4217 currency (EUR).
 * Throws a normalized provider error otherwise.
 */
export function assertSupportedCurrency(currency: string): ProviderCurrency {
  if (currency !== PROVIDER_CURRENCY) {
    throw new ProviderError("INVALID_PROVIDER_RESPONSE", {
      internalDetail: `unsupported currency: ${String(currency).slice(0, 16)}`,
    });
  }
  return PROVIDER_CURRENCY;
}
