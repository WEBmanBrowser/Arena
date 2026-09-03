/**
 * B.7 — Reusable commercial pricing calculator.
 *
 * Pure, dependency-light functions (integer cents only) shared by:
 *  - the admin product form (Preços tab), today;
 *  - future automatic pricing rules per supplier / brand / category and XML
 *    imports, later. Nothing here reads the request, the session or the
 *    database, so a rule engine can call it server-side unchanged.
 *
 * ── Two DIFFERENT pricing methods, deliberately never both called "margem" ──
 *
 *   1. MARGIN ON SALE  ("margem sobre venda")  — profitability indicator.
 *        margin% = (net - cost) / net * 100         (share of revenue kept)
 *        net     = cost / (1 - margin%/100)
 *      This is the existing semantics already displayed in the product form
 *      and is the authoritative measure of a product's profitability.
 *      Mathematically capped below 100%.
 *
 *   2. MARKUP ON COST  ("markup sobre custo")  — commercial rule.
 *        markup% = (net - cost) / cost * 100        (uplift over purchase)
 *        net     = cost * (1 + markup%/100)
 *      Convenient for supplier-driven rules ("cost + 35%"). Unbounded.
 *
 * Both produce a NET price; VAT is then applied, then commercial rounding.
 * Whatever method built the price, the REAL margin on sale is always
 * recomputed from the final price so the operator sees true profitability.
 *
 * ── Money convention ──
 * Product prices are stored GROSS (VAT included) as decimal strings; see
 * src/lib/money.ts. Every computation here is done in integer cents and only
 * converted back at the edges. This module never persists anything: the value
 * actually saved still goes through the existing server-side validation.
 */

import { toCents, toEuros } from "./money";

/** How the target price is derived from cost. */
export type PricingMethod = "margin_on_sale" | "markup_on_cost";

/** Commercial (psychological) price ending applied after VAT. */
export type RoundingMode = "none" | "end_90" | "end_99";

export const PRICING_METHODS: PricingMethod[] = ["margin_on_sale", "markup_on_cost"];
export const ROUNDING_MODES: RoundingMode[] = ["none", "end_90", "end_99"];

/** Margin on sale is undefined at 100% (division by zero) and absurd beyond. */
export const MAX_MARGIN_ON_SALE = 99.99;

export type PricingErrorCode =
  | "INVALID_COST"
  | "INVALID_VAT"
  | "INVALID_RATE"
  | "MARGIN_TOO_HIGH";

export interface PricingBreakdown {
  /** Purchase cost, in cents. */
  costCents: number;
  /** Method used to derive the price. */
  method: PricingMethod;
  /** The requested margin-on-sale % or markup-on-cost %, as typed. */
  ratePercent: number;
  /** VAT rate applied, e.g. 23. */
  vatPercent: number;
  /** Net price before commercial rounding, in cents. */
  netBeforeRoundingCents: number;
  /** Gross price before commercial rounding, in cents (the "mathematical" price). */
  grossBeforeRoundingCents: number;
  /** Rounding rule requested. */
  rounding: RoundingMode;
  /** Final gross price after commercial rounding, in cents. Never below gross-before. */
  finalGrossCents: number;
  /** Net value implied by the final gross price, in cents. */
  finalNetCents: number;
  /** VAT amount contained in the final gross price, in cents. */
  finalVatCents: number;
  /** Profit in cents on the final price (finalNet - cost). */
  realMarginCents: number;
  /** REAL margin on sale (%) after rounding — the profitability indicator. */
  realMarginOnSalePercent: number;
  /** REAL markup on cost (%) after rounding. Null when cost is 0 (undefined). */
  realMarkupOnCostPercent: number | null;
  /** Cents added by the commercial rounding (always >= 0). */
  roundingUpliftCents: number;
}

export class PricingError extends Error {
  code: PricingErrorCode;
  constructor(code: PricingErrorCode, message: string) {
    super(message);
    this.name = "PricingError";
    this.code = code;
  }
}

/** Parse a user-typed number; returns null when not a finite number. */
function parseNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "string" ? parseFloat(value.replace(",", ".")) : value;
  return Number.isFinite(n) ? n : null;
}

/**
 * Ceil to whole cents, tolerating binary floating point noise.
 *
 * Plain Math.ceil would turn an exact 12000.0000000001 into 12001; the epsilon
 * keeps exact results exact while still rounding genuine fractions up.
 */
function ceilCents(value: number): number {
  const rounded = Math.round(value);
  return Math.abs(value - rounded) < 1e-6 ? rounded : Math.ceil(value);
}

/**
 * Parse a money value into integer cents, or null when absent/invalid.
 *
 * Unlike `toCents` this never throws, so the automatic engine can treat a
 * missing or malformed cost as "cannot price" instead of crashing a batch.
 */
export function toCentsSafe(value: number | string | null | undefined): number | null {
  const n = parseNumber(value);
  if (n === null || n < 0) return null;
  return toCents(n);
}

/**
 * Net price (cents) required to reach `ratePercent` under `method`.
 *
 * Rounds half-up to the nearest cent; the caller applies VAT afterwards.
 */
export function netPriceFromCost(costCents: number, method: PricingMethod, ratePercent: number): number {
  if (!Number.isFinite(costCents) || costCents < 0) throw new PricingError("INVALID_COST", "Custo inválido");
  if (!Number.isFinite(ratePercent)) throw new PricingError("INVALID_RATE", "Percentagem inválida");

  if (method === "markup_on_cost") {
    if (ratePercent < 0) throw new PricingError("INVALID_RATE", "O markup não pode ser negativo");
    // CEIL, not round: rounding the net price down would shave a fraction of a
    // cent off the requested rate (cost 59,62 € at 20% gave 19,993%). The
    // engine's contract is that the result never falls below the target.
    return ceilCents(costCents * (1 + ratePercent / 100));
  }

  // margin_on_sale
  if (ratePercent < 0) throw new PricingError("INVALID_RATE", "A margem não pode ser negativa");
  if (ratePercent > MAX_MARGIN_ON_SALE) {
    throw new PricingError("MARGIN_TOO_HIGH", "A margem sobre venda tem de ser inferior a 100%");
  }
  return ceilCents(costCents / (1 - ratePercent / 100));
}

/** Add VAT to a net amount in cents. */
export function applyVat(netCents: number, vatPercent: number): number {
  if (!Number.isFinite(vatPercent) || vatPercent < 0) throw new PricingError("INVALID_VAT", "Taxa de IVA inválida");
  return Math.round(netCents * (1 + vatPercent / 100));
}

/** Remove VAT from a gross amount in cents. */
export function removeVat(grossCents: number, vatPercent: number): number {
  if (!Number.isFinite(vatPercent) || vatPercent < 0) throw new PricingError("INVALID_VAT", "Taxa de IVA inválida");
  return Math.round(grossCents / (1 + vatPercent / 100));
}

/**
 * Apply a commercial ending to a gross price, in cents.
 *
 * ALWAYS ROUNDS UP: the result is the smallest price with the requested
 * ending that is greater than or equal to `grossCents`. Rounding down could
 * silently eat into the operator's intended margin, so it never happens.
 *
 *   14,66 → ,90 = 14,90   |  14,66 → ,99 = 14,99
 *   14,95 → ,90 = 15,90   |  14,95 → ,99 = 14,99
 *   14,90 → ,90 = 14,90   (already valid, unchanged)
 */
export function applyCommercialRounding(grossCents: number, mode: RoundingMode): number {
  if (!Number.isFinite(grossCents) || grossCents < 0) throw new PricingError("INVALID_COST", "Preço inválido");
  if (mode === "none") return Math.round(grossCents);

  const ending = mode === "end_90" ? 90 : 99;
  const euros = Math.floor(grossCents / 100);
  const candidate = euros * 100 + ending;
  // Already at or above the target ending for this euro → go to the next euro.
  return candidate >= grossCents ? candidate : (euros + 1) * 100 + ending;
}

// ── C.1: configurable rounding band policy ────────────────
// The automatic engine must not ask the operator to pick ,90 or ,99 per
// product. Instead a policy maps a gross price to an ending. The bands are
// CONFIGURABLE (stored in settings, see src/lib/rounding-policy.ts); nothing
// here is hardcoded except the fallback default.

/** One band: applies to gross prices >= fromCents (ordered, first match from the top). */
export interface RoundingBand {
  fromCents: number;
  mode: RoundingMode;
}

export interface RoundingPolicy {
  enabled: boolean;
  bands: RoundingBand[];
}

/**
 * Default policy agreed for MDTech retail:
 *   < 200 €        → ,99
 *   200 – 999,99 € → ,90
 *   >= 1.000 €     → ,90
 *
 * The two upper bands are kept SEPARATE on purpose even though they currently
 * share ,90: the 1.000 € boundary is the one most likely to be retuned later
 * (e.g. to ,00), and keeping the band avoids a schema/config change to do it.
 */
export const DEFAULT_ROUNDING_POLICY: RoundingPolicy = {
  enabled: true,
  bands: [
    { fromCents: 0, mode: "end_99" },
    { fromCents: 20000, mode: "end_90" },
    { fromCents: 100000, mode: "end_90" },
  ],
};

/**
 * Pick the ending for a given gross price.
 *
 * Bands are matched on the MATHEMATICAL gross price (before rounding), so the
 * choice is stable and does not depend on the rounding it is about to apply.
 */
export function resolveRoundingMode(grossCents: number, policy: RoundingPolicy): RoundingMode {
  if (!policy.enabled || policy.bands.length === 0) return "none";
  const ordered = [...policy.bands].sort((a, b) => a.fromCents - b.fromCents);
  let mode: RoundingMode = "none";
  for (const band of ordered) {
    if (grossCents >= band.fromCents) mode = band.mode;
    else break;
  }
  return mode;
}

/** Validate a policy coming from configuration. Throws PricingError. */
export function validateRoundingPolicy(policy: RoundingPolicy): void {
  if (!Array.isArray(policy.bands)) throw new PricingError("INVALID_RATE", "Faixas inválidas");
  const seen = new Set<number>();
  for (const b of policy.bands) {
    if (!Number.isInteger(b.fromCents) || b.fromCents < 0) {
      throw new PricingError("INVALID_RATE", "Início de faixa inválido");
    }
    if (seen.has(b.fromCents)) throw new PricingError("INVALID_RATE", "Faixas duplicadas");
    seen.add(b.fromCents);
    if (!ROUNDING_MODES.includes(b.mode)) throw new PricingError("INVALID_RATE", "Terminação inválida");
  }
  if (policy.enabled && policy.bands.length > 0 && !seen.has(0)) {
    throw new PricingError("INVALID_RATE", "É necessária uma faixa a começar em 0");
  }
}

/**
 * Full calculation: cost + rate → net → VAT → commercial rounding → real margin.
 *
 * The returned breakdown is what the UI renders and what a future automatic
 * pricing rule would log. All amounts are integer cents.
 */
export function calculatePrice(input: {
  cost: number | string | null | undefined;
  method: PricingMethod;
  ratePercent: number | string;
  vatPercent: number | string;
  /** Fixed ending. Ignored when `roundingPolicy` is supplied. */
  rounding?: RoundingMode;
  /** Band policy — the automatic engine passes this instead of `rounding`. */
  roundingPolicy?: RoundingPolicy;
}): PricingBreakdown {
  const costEuros = parseNumber(input.cost) ?? 0;
  if (costEuros < 0) throw new PricingError("INVALID_COST", "O custo não pode ser negativo");

  const rate = parseNumber(input.ratePercent);
  if (rate === null) throw new PricingError("INVALID_RATE", "Percentagem inválida");

  const vat = parseNumber(input.vatPercent);
  if (vat === null || vat < 0) throw new PricingError("INVALID_VAT", "Taxa de IVA inválida");

  const costCents = toCents(costEuros);

  const netBeforeRoundingCents = netPriceFromCost(costCents, input.method, rate);
  const grossBeforeRoundingCents = applyVat(netBeforeRoundingCents, vat);
  // A band policy wins over a fixed ending: that is the automatic path.
  const rounding = input.roundingPolicy
    ? resolveRoundingMode(grossBeforeRoundingCents, input.roundingPolicy)
    : (input.rounding ?? "none");
  const finalGrossCents = applyCommercialRounding(grossBeforeRoundingCents, rounding);

  return buildBreakdown({
    costCents,
    method: input.method,
    ratePercent: rate,
    vatPercent: vat,
    netBeforeRoundingCents,
    grossBeforeRoundingCents,
    rounding,
    finalGrossCents,
  });
}

/**
 * Recompute the breakdown for a gross price the operator typed or edited by
 * hand, keeping the same cost/VAT context. Used when the final price is
 * overridden manually after a calculation.
 */
export function analyseGrossPrice(input: {
  grossPrice: number | string | null | undefined;
  cost: number | string | null | undefined;
  vatPercent: number | string;
  method?: PricingMethod;
  ratePercent?: number | string;
  rounding?: RoundingMode;
}): PricingBreakdown | null {
  const grossEuros = parseNumber(input.grossPrice);
  if (grossEuros === null || grossEuros <= 0) return null;

  const vat = parseNumber(input.vatPercent);
  if (vat === null || vat < 0) throw new PricingError("INVALID_VAT", "Taxa de IVA inválida");

  const costCents = toCents(parseNumber(input.cost) ?? 0);
  const finalGrossCents = toCents(grossEuros);
  const netBeforeRoundingCents = removeVat(finalGrossCents, vat);

  return buildBreakdown({
    costCents,
    method: input.method ?? "margin_on_sale",
    ratePercent: parseNumber(input.ratePercent) ?? 0,
    vatPercent: vat,
    netBeforeRoundingCents,
    grossBeforeRoundingCents: finalGrossCents,
    rounding: input.rounding ?? "none",
    finalGrossCents,
  });
}

function buildBreakdown(base: {
  costCents: number;
  method: PricingMethod;
  ratePercent: number;
  vatPercent: number;
  netBeforeRoundingCents: number;
  grossBeforeRoundingCents: number;
  rounding: RoundingMode;
  finalGrossCents: number;
}): PricingBreakdown {
  const finalNetCents = removeVat(base.finalGrossCents, base.vatPercent);
  const finalVatCents = base.finalGrossCents - finalNetCents;
  const realMarginCents = finalNetCents - base.costCents;

  return {
    ...base,
    finalNetCents,
    finalVatCents,
    realMarginCents,
    realMarginOnSalePercent: finalNetCents > 0 ? (realMarginCents / finalNetCents) * 100 : 0,
    realMarkupOnCostPercent: base.costCents > 0 ? (realMarginCents / base.costCents) * 100 : null,
    roundingUpliftCents: base.finalGrossCents - base.grossBeforeRoundingCents,
  };
}

/**
 * Margin on sale for an already-priced product — the profitability indicator
 * shown next to every product. Returns null when it cannot be computed.
 */
export function marginOnSaleFromPrices(
  grossPrice: number | string | null | undefined,
  cost: number | string | null | undefined,
  vatPercent: number | string,
): { netCents: number; costCents: number; marginCents: number; marginPercent: number } | null {
  const gross = parseNumber(grossPrice);
  const costValue = parseNumber(cost);
  const vat = parseNumber(vatPercent) ?? 0;
  if (gross === null || gross <= 0 || costValue === null) return null;

  const netCents = removeVat(toCents(gross), vat);
  const costCents = toCents(costValue);
  const marginCents = netCents - costCents;
  return {
    netCents,
    costCents,
    marginCents,
    marginPercent: netCents > 0 ? (marginCents / netCents) * 100 : 0,
  };
}

/** Format cents as a pt-PT euro string, e.g. "14,99 €". */
export function formatCents(cents: number): string {
  return (cents / 100).toLocaleString("pt-PT", { style: "currency", currency: "EUR" });
}

/** Decimal string (e.g. "14.99") for a cents amount, ready for the API. */
export function centsToDecimalString(cents: number): string {
  return toEuros(cents);
}
