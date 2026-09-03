/**
 * C.1 — Automatic pricing engine.
 *
 * Single entry point that turns a product's COST into its selling PRICE:
 *
 *   cost → applicable rule → net price → VAT → commercial rounding → price
 *
 * Design constraints:
 *  - Manual products are NEVER repriced. The guard lives here, in the service,
 *    not in the UI, so it also protects the future XML import (C.3) and any
 *    bulk recalculation (C.2).
 *  - All money is integer cents inside pricing-calculator.ts; only the final
 *    value is written back as the existing decimal(10,2) string.
 *  - Nothing about checkout, VAT, order snapshots or stock is touched. This
 *    only ever writes products.price / price_rule_id / price_calculated_at.
 */
import { db } from "@/db";
import { products, pricingRules, categories, productSuppliers } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  calculatePrice,
  centsToDecimalString,
  toCentsSafe,
  PricingError,
  type PricingBreakdown,
  type RoundingMode,
  type RoundingPolicy,
} from "@/lib/pricing-calculator";
import { getRoundingPolicy } from "@/lib/rounding-policy";
import {
  resolvePricingRule,
  describeRule,
  type PricingRuleRow,
  type ResolvedRule,
} from "@/lib/pricing-rules";
import { createAuditLog } from "@/lib/audit";

type QueryDb = NodePgDatabase | typeof db;

/** Why a product could not be priced automatically. */
export type PricingSkipReason =
  | "manual_price"
  | "no_cost"
  | "no_rule"
  | "below_min_margin"
  | "calculation_error";

export interface PriceComputation {
  productId: number;
  /** True when a new price was (or would be) produced. */
  priced: boolean;
  skipReason?: PricingSkipReason;
  message?: string;
  rule?: ResolvedRule;
  ruleLabel?: string;
  breakdown?: PricingBreakdown;
  currentPrice: string;
  newPrice?: string;
  changed: boolean;
}

interface ProductPricingContext {
  id: number;
  price: string;
  costPrice: string | null;
  vatRate: string;
  categoryId: number | null;
  brandId: number | null;
  priceMode: string;
}

/**
 * Compute (without writing) the automatic price for one product.
 *
 * Exported so previews can show exactly what an apply would do — the same
 * function produces both, which is what makes the preview trustworthy.
 */
export function computeAutomaticPrice(
  product: ProductPricingContext,
  supplierId: number | null,
  rules: PricingRuleRow[],
  categoryTree: { id: number; parentId: number | null }[],
  policy: RoundingPolicy
): PriceComputation {
  const base = { productId: product.id, currentPrice: product.price, changed: false };

  // 1. Manual products are untouchable. Checked first, before anything else.
  if (product.priceMode === "manual") {
    return { ...base, priced: false, skipReason: "manual_price", message: "Preço manual — não recalculado" };
  }

  // 2. No cost → no calculation. We never invent a price.
  const costCents = toCentsSafe(product.costPrice);
  if (costCents === null || costCents <= 0) {
    return { ...base, priced: false, skipReason: "no_cost", message: "Sem preço de custo" };
  }

  // 3. Resolve the rule.
  const resolved = resolvePricingRule(
    rules,
    { productId: product.id, categoryId: product.categoryId, brandId: product.brandId, supplierId },
    categoryTree
  );
  if (!resolved) {
    return { ...base, priced: false, skipReason: "no_rule", message: "Nenhuma regra aplicável" };
  }

  // 4. Calculate.
  let breakdown: PricingBreakdown;
  try {
    const fixed = resolved.rule.roundingPolicy;
    breakdown = calculatePrice({
      cost: product.costPrice,
      method: resolved.rule.method,
      ratePercent: resolved.rule.ratePercent,
      vatPercent: product.vatRate,
      ...(fixed === "auto"
        ? { roundingPolicy: policy }
        : { rounding: fixed as RoundingMode }),
    });
  } catch (e) {
    return {
      ...base,
      priced: false,
      skipReason: "calculation_error",
      message: e instanceof PricingError ? e.message : "Erro de cálculo",
      rule: resolved,
    };
  }

  // 5. Safety floor: never silently price below the configured minimum margin.
  const floor = resolved.rule.minMarginPercent === null ? null : Number(resolved.rule.minMarginPercent);
  if (floor !== null && Number.isFinite(floor) && breakdown.realMarginOnSalePercent < floor) {
    return {
      ...base,
      priced: false,
      skipReason: "below_min_margin",
      message: `Margem resultante ${breakdown.realMarginOnSalePercent.toFixed(2)}% abaixo do mínimo ${floor}%`,
      rule: resolved,
      breakdown,
    };
  }

  const newPrice = centsToDecimalString(breakdown.finalGrossCents);
  return {
    productId: product.id,
    priced: true,
    rule: resolved,
    ruleLabel: describeRule(resolved),
    breakdown,
    currentPrice: product.price,
    newPrice,
    changed: newPrice !== product.price,
  };
}

/** Load the shared reference data once — rules, category tree, rounding policy. */
export async function loadPricingContext(database: QueryDb = db): Promise<{
  rules: PricingRuleRow[];
  categoryTree: { id: number; parentId: number | null }[];
  policy: RoundingPolicy;
}> {
  const d = database as typeof db;
  const [ruleRows, catRows, policy] = await Promise.all([
    d.select().from(pricingRules).where(eq(pricingRules.isActive, true)),
    d.select({ id: categories.id, parentId: categories.parentId }).from(categories),
    getRoundingPolicy(database),
  ]);
  return {
    rules: ruleRows as unknown as PricingRuleRow[],
    categoryTree: catRows,
    policy,
  };
}

/**
 * Recalculate and PERSIST the price of one product.
 *
 * Safe to call inside an existing transaction (pass `tx`), which is how a cost
 * change and its resulting price change stay atomic: the catalogue is never
 * left with a new cost and a stale price.
 *
 * Returns the computation so callers can audit or surface it. Never throws for
 * business reasons (no cost, no rule, manual) — those come back as skips.
 */
export async function recalculateProductPrice(
  productId: number,
  options: { database?: QueryDb; userId?: number | null; reason?: string } = {}
): Promise<PriceComputation> {
  const database = options.database ?? db;
  const d = database as typeof db;

  const [product] = await d
    .select({
      id: products.id,
      price: products.price,
      costPrice: products.costPrice,
      vatRate: products.vatRate,
      categoryId: products.categoryId,
      brandId: products.brandId,
      priceMode: products.priceMode,
    })
    .from(products)
    .where(eq(products.id, productId))
    .limit(1);

  if (!product) {
    return { productId, priced: false, skipReason: "calculation_error", message: "Produto não encontrado", currentPrice: "0.00", changed: false };
  }

  const [preferred] = await d
    .select({ supplierId: productSuppliers.supplierId })
    .from(productSuppliers)
    .where(and(eq(productSuppliers.productId, productId), eq(productSuppliers.isPreferred, true)))
    .limit(1);

  const { rules, categoryTree, policy } = await loadPricingContext(database);
  const result = computeAutomaticPrice(product, preferred?.supplierId ?? null, rules, categoryTree, policy);

  if (result.priced && result.changed && result.newPrice) {
    await d
      .update(products)
      .set({
        price: result.newPrice,
        priceRuleId: result.rule?.rule.id ?? null,
        priceCalculatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(products.id, productId));
  } else if (result.priced && !result.changed) {
    // Price unchanged, but record that the engine ran and which rule applied.
    await d
      .update(products)
      .set({ priceRuleId: result.rule?.rule.id ?? null, priceCalculatedAt: new Date() })
      .where(eq(products.id, productId));
  }

  return result;
}

/**
 * Audit a price recalculation. Call AFTER the transaction commits, matching
 * the convention in src/lib/audit.ts (a failed audit must not roll back a
 * successful price change).
 */
export async function auditRecalculation(
  result: PriceComputation,
  userId: number | null,
  reason: string
): Promise<void> {
  if (!result.priced || !result.changed) return;
  await createAuditLog({
    userId,
    action: "product.price_recalculated",
    entity: "product",
    entityId: result.productId,
    details: {
      reason,
      priceFrom: result.currentPrice,
      priceTo: result.newPrice,
      ruleId: result.rule?.rule.id ?? null,
      rule: result.ruleLabel ?? null,
      marginPercent: result.breakdown ? Number(result.breakdown.realMarginOnSalePercent.toFixed(2)) : null,
    },
  });
}

/**
 * Switch a product between automatic and manual pricing.
 *
 * Turning automation back ON immediately recalculates, so the operator is not
 * left with a stale manual price silently labelled "automatic".
 */
export async function setPriceMode(
  productId: number,
  mode: "auto" | "manual",
  userId: number | null
): Promise<PriceComputation | null> {
  await db.update(products).set({ priceMode: mode, updatedAt: new Date() }).where(eq(products.id, productId));
  await createAuditLog({
    userId,
    action: "product.price_mode_changed",
    entity: "product",
    entityId: productId,
    details: { mode },
  });
  if (mode !== "auto") return null;
  const result = await recalculateProductPrice(productId, { userId, reason: "price_mode_auto" });
  await auditRecalculation(result, userId, "price_mode_auto");
  return result;
}
