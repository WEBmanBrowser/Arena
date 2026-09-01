/**
 * Money utilities for safe financial calculations.
 *
 * CONVENTION: All product prices are GROSS (IVA included).
 * Standard for B2C e-commerce in Portugal.
 *
 * All monetary operations use integer cents to avoid floating-point errors.
 */

/** Convert euros to cents */
export function toCents(euros: number | string): number {
  const n = typeof euros === "string" ? parseFloat(euros) : euros;
  return Math.round(n * 100);
}

/**
 * B.3.5 — Deterministic decimal-string → integer cents conversion.
 *
 * Used for authoritative financial amounts (payments.amount etc.). Unlike
 * toCents() this NEVER touches binary floating-point: the string is parsed
 * with a strict regex and combined with integer arithmetic only. Returns
 * null for anything that is not a plain non-negative decimal with 1–2
 * fraction digits (e.g. "127.90", "100", "0.05").
 */
export function decimalToCents(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!m) return null;
  const whole = Number(m[1]);
  const frac = Number((m[2] ?? "").padEnd(2, "0"));
  return whole * 100 + frac;
}

/** Convert cents to euros string with 2 decimal places */
export function toEuros(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * Calculate VAT from a gross (IVA-included) price in cents.
 * gross = net + vat; net = gross / (1 + rate); vat = gross - net
 */
export function calcVatFromGross(grossCents: number, vatRatePercent: number): { netCents: number; vatCents: number } {
  const rate = vatRatePercent / 100;
  const netCents = Math.round(grossCents / (1 + rate));
  const vatCents = grossCents - netCents;
  return { netCents, vatCents };
}

/** Unit price net from unit price gross */
export function unitPriceNet(unitGrossCents: number, vatRatePercent: number): number {
  return calcVatFromGross(unitGrossCents, vatRatePercent).netCents;
}

/** Line total in cents */
export function lineTotal(unitPriceCents: number, quantity: number): number {
  return unitPriceCents * quantity;
}

/**
 * Distribute a global discount (in cents) across order lines proportionally.
 * Ensures: sum(allocations) === totalDiscountCents exactly.
 * Remainder cents go to the last line (deterministic).
 */
export function allocateDiscount(
  lines: Array<{ lineTotalCents: number }>,
  totalDiscountCents: number
): number[] {
  if (totalDiscountCents <= 0 || lines.length === 0) return lines.map(() => 0);
  const totalGross = lines.reduce((s, l) => s + l.lineTotalCents, 0);
  if (totalGross <= 0) return lines.map(() => 0);

  const alloc: number[] = [];
  let allocated = 0;
  for (let i = 0; i < lines.length; i++) {
    if (i === lines.length - 1) {
      // Last line gets the remainder to ensure exact sum
      alloc.push(totalDiscountCents - allocated);
    } else {
      const share = Math.round((lines[i].lineTotalCents / totalGross) * totalDiscountCents);
      alloc.push(share);
      allocated += share;
    }
  }
  return alloc;
}

/** Format cents to Portuguese currency string */
export function formatCents(cents: number): string {
  return new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR" }).format(cents / 100);
}

/** Reservation duration from env or default */
export function getReservationMinutes(): number {
  const v = Number(process.env.ORDER_RESERVATION_MINUTES);
  return v > 0 ? v : 60;
}
