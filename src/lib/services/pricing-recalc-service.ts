/**
 * C.2 — Impact preview and safe mass application of automatic prices.
 *
 * Saving a rule NEVER moves prices. The operator asks for an impact analysis,
 * sees exactly what would change, and only then applies. This service owns
 * that two-step flow.
 *
 * Security model (reused from bulk-pricing):
 *  - the preview issues an HMAC-signed token binding every line, its OLD price
 *    and its NEW price, so the browser cannot apply prices it was never shown;
 *  - the apply re-reads the products and refuses if anything moved meanwhile;
 *  - each UPDATE is conditioned on the old price, so a concurrent edit cannot
 *    be silently overwritten.
 *
 * The calculation itself is NOT reimplemented: computeAutomaticPrice from the
 * C.1 engine produces every line, so preview and apply and the product page
 * can never disagree.
 */
import { db } from "@/db";
import { products, brands, categories, suppliers } from "@/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  computeAutomaticPrice,
  loadPricingContext,
  type PriceComputation,
} from "@/lib/services/pricing-engine-service";
import { describeRule, type PricingRuleRow, type RuleScope } from "@/lib/pricing-rules";
import { createRecalcToken, verifyRecalcToken, type RecalcTokenLine } from "@/lib/bulk-pricing";
import { createAuditLog } from "@/lib/audit";

/** Hard ceiling, mirroring BULK_LIMIT so one action cannot touch the world. */
export const RECALC_LIMIT = 5000;
/** Applied in batches so a huge catalogue never holds locks for minutes. */
export const RECALC_BATCH_SIZE = 500;

export interface RecalcLine {
  productId: number;
  name: string;
  sku: string | null;
  costPrice: string | null;
  currentPrice: string;
  mathematicalPrice: string | null;
  newPrice: string | null;
  diffCents: number;
  diffPercent: number | null;
  realMarginPercent: number | null;
  realMarkupPercent: number | null;
  /** Which rule won, and why — e.g. "Categoria Routers". */
  ruleLabel: string | null;
  ruleId: number | null;
  status: "up" | "down" | "same" | "manual" | "no_cost" | "no_rule" | "error";
  message?: string;
}

export interface RecalcSummary {
  affected: number;
  up: number;
  down: number;
  same: number;
  manual: number;
  noCost: number;
  noRule: number;
  errors: number;
  totalScanned: number;
}

export interface RecalcPreview {
  lines: RecalcLine[];
  summary: RecalcSummary;
  /** Null when nothing would change — there is nothing to apply. */
  previewToken: string | null;
  requiresDecreaseConfirmation: boolean;
}

export interface RecalcTarget {
  ruleId?: number;
  scope?: RuleScope;
  productId?: number;
  categoryId?: number;
  brandId?: number;
  supplierId?: number;
}

function statusFor(result: PriceComputation): RecalcLine["status"] {
  if (result.priced) {
    if (!result.changed) return "same";
    return Number(result.newPrice) > Number(result.currentPrice) ? "up" : "down";
  }
  switch (result.skipReason) {
    case "manual_price": return "manual";
    case "no_cost": return "no_cost";
    case "no_rule": return "no_rule";
    default: return "error";
  }
}

/**
 * Which products should be analysed.
 *
 * Scoped by the rule's own target so "what does this brand rule change?" only
 * scans that brand instead of the whole catalogue. A rule can still lose to a
 * more specific one — that shows up in the preview as "same" with the winning
 * rule named, which is exactly the diagnostic the operator needs.
 */
async function resolveTargetProductIds(target: RecalcTarget): Promise<number[]> {
  const conditions = [];
  if (target.productId) conditions.push(eq(products.id, target.productId));
  if (target.categoryId) {
    // Include descendant categories: a rule on a parent affects the subtree.
    conditions.push(sql`${products.categoryId} IN (
      WITH RECURSIVE tree AS (
        SELECT id FROM categories WHERE id = ${target.categoryId}
        UNION ALL
        SELECT c.id FROM categories c JOIN tree t ON c.parent_id = t.id
      ) SELECT id FROM tree
    )`);
  }
  if (target.brandId) conditions.push(eq(products.brandId, target.brandId));
  if (target.supplierId) {
    conditions.push(sql`EXISTS (
      SELECT 1 FROM product_suppliers ps
      WHERE ps.product_id = ${products.id} AND ps.supplier_id = ${target.supplierId} AND ps.is_preferred = true
    )`);
  }

  const rows = await db
    .select({ id: products.id })
    .from(products)
    .where(conditions.length ? and(...conditions) : undefined)
    .limit(RECALC_LIMIT + 1);

  if (rows.length > RECALC_LIMIT) throw new Error("RECALC_TOO_MANY_PRODUCTS");
  return rows.map((r) => r.id);
}

/** Resolve the rule target from a stored rule, so the caller can pass just ruleId. */
async function targetFromRule(ruleId: number): Promise<RecalcTarget> {
  const { pricingRules } = await import("@/db/schema");
  const [rule] = await db.select().from(pricingRules).where(eq(pricingRules.id, ruleId)).limit(1);
  if (!rule) throw new Error("RULE_NOT_FOUND");
  return {
    ruleId,
    scope: rule.scope as RuleScope,
    productId: rule.productId ?? undefined,
    categoryId: rule.categoryId ?? undefined,
    brandId: rule.brandId ?? undefined,
    supplierId: rule.supplierId ?? undefined,
  };
}

/** Build the impact analysis. Reads only — nothing is written. */
export async function previewRecalculation(target: RecalcTarget): Promise<RecalcPreview> {
  const effective = target.ruleId ? await targetFromRule(target.ruleId) : target;
  const productIds = await resolveTargetProductIds(effective);

  const summary: RecalcSummary = {
    affected: 0, up: 0, down: 0, same: 0, manual: 0,
    noCost: 0, noRule: 0, errors: 0, totalScanned: productIds.length,
  };
  if (productIds.length === 0) {
    return { lines: [], summary, previewToken: null, requiresDecreaseConfirmation: false };
  }

  const rows = await db
    .select({
      id: products.id, name: products.name, sku: products.sku,
      price: products.price, costPrice: products.costPrice, vatRate: products.vatRate,
      categoryId: products.categoryId, brandId: products.brandId, priceMode: products.priceMode,
      supplierId: sql<number | null>`(
        select ps.supplier_id from product_suppliers ps
        where ps.product_id = ${products.id} and ps.is_preferred = true limit 1
      )`,
    })
    .from(products)
    .where(inArray(products.id, productIds));

  const ctx = await loadPricingContext();
  const names = await loadTargetNames(ctx.rules);

  const lines: RecalcLine[] = [];
  const tokenLines: RecalcTokenLine[] = [];

  for (const row of rows) {
    const result = computeAutomaticPrice(row, row.supplierId ?? null, ctx.rules, ctx.categoryTree, ctx.policy);
    const status = statusFor(result);

    const diffCents = result.newPrice
      ? Math.round(Number(result.newPrice) * 100) - Math.round(Number(row.price) * 100)
      : 0;
    const currentCents = Math.round(Number(row.price) * 100);

    lines.push({
      productId: row.id, name: row.name, sku: row.sku,
      costPrice: row.costPrice, currentPrice: row.price,
      mathematicalPrice: result.breakdown ? (result.breakdown.grossBeforeRoundingCents / 100).toFixed(2) : null,
      newPrice: result.newPrice ?? null,
      diffCents,
      diffPercent: currentCents > 0 && result.newPrice ? (diffCents / currentCents) * 100 : null,
      realMarginPercent: result.breakdown?.realMarginOnSalePercent ?? null,
      realMarkupPercent: result.breakdown?.realMarkupOnCostPercent ?? null,
      ruleLabel: result.rule ? describeRule(result.rule, names[result.rule.rule.id] ?? {}) : null,
      ruleId: result.rule?.rule.id ?? null,
      status,
      message: result.message,
    });

    switch (status) {
      case "up": summary.up += 1; summary.affected += 1; break;
      case "down": summary.down += 1; summary.affected += 1; break;
      case "same": summary.same += 1; break;
      case "manual": summary.manual += 1; break;
      case "no_cost": summary.noCost += 1; break;
      case "no_rule": summary.noRule += 1; break;
      default: summary.errors += 1; break;
    }

    if ((status === "up" || status === "down") && result.newPrice) {
      tokenLines.push({ i: row.id, o: row.price, n: result.newPrice, r: result.rule?.rule.id ?? null });
    }
  }

  // Show the biggest movements first — that is where mistakes are visible.
  lines.sort((a, b) => Math.abs(b.diffCents) - Math.abs(a.diffCents));

  return {
    lines,
    summary,
    previewToken: tokenLines.length ? createRecalcToken(tokenLines, summary.down) : null,
    requiresDecreaseConfirmation: summary.down > 0,
  };
}

/** Human names for the rule targets, so the preview can say WHY a rule won. */
async function loadTargetNames(rules: PricingRuleRow[]) {
  const out: Record<number, { category?: string | null; brand?: string | null; supplier?: string | null }> = {};
  const catIds = rules.map((r) => r.categoryId).filter((v): v is number => v != null);
  const brandIds = rules.map((r) => r.brandId).filter((v): v is number => v != null);
  const supIds = rules.map((r) => r.supplierId).filter((v): v is number => v != null);

  const [cats, brs, sups] = await Promise.all([
    catIds.length ? db.select({ id: categories.id, name: categories.name }).from(categories).where(inArray(categories.id, catIds)) : [],
    brandIds.length ? db.select({ id: brands.id, name: brands.name }).from(brands).where(inArray(brands.id, brandIds)) : [],
    supIds.length ? db.select({ id: suppliers.id, name: suppliers.name }).from(suppliers).where(inArray(suppliers.id, supIds)) : [],
  ]);
  const catMap = new Map(cats.map((c) => [c.id, c.name]));
  const brandMap = new Map(brs.map((b) => [b.id, b.name]));
  const supMap = new Map(sups.map((s) => [s.id, s.name]));

  for (const r of rules) {
    out[r.id] = {
      category: r.categoryId != null ? catMap.get(r.categoryId) ?? null : null,
      brand: r.brandId != null ? brandMap.get(r.brandId) ?? null : null,
      supplier: r.supplierId != null ? supMap.get(r.supplierId) ?? null : null,
    };
  }
  return out;
}

export interface RecalcApplyResult {
  updated: number;
  up: number;
  down: number;
}

/**
 * Apply a previously previewed recalculation.
 *
 * Refuses when: the token is forged, expired or of the wrong kind; any product
 * moved since the preview; or the preview contained price decreases and the
 * operator did not explicitly confirm them.
 */
export async function applyRecalculation(
  previewToken: string,
  options: { userId: number | null; confirmDecreases?: boolean }
): Promise<RecalcApplyResult> {
  const verified = verifyRecalcToken(previewToken);
  if (!verified.valid) throw new Error("RECALC_PREVIEW_INVALID");
  if (verified.expired) throw new Error("RECALC_PREVIEW_EXPIRED");
  const payload = verified.data!;

  // The decrease count comes from the SIGNED token, not from the client.
  if (payload.down > 0 && options.confirmDecreases !== true) {
    throw new Error("RECALC_DECREASES_NOT_CONFIRMED");
  }
  if (payload.lines.length === 0) throw new Error("RECALC_NOTHING_TO_APPLY");

  const ids = payload.lines.map((l) => l.i);
  const current = await db
    .select({ id: products.id, price: products.price, priceMode: products.priceMode })
    .from(products)
    .where(inArray(products.id, ids));
  const currentMap = new Map(current.map((p) => [p.id, p]));

  for (const line of payload.lines) {
    const row = currentMap.get(line.i);
    if (!row) throw new Error("RECALC_PREVIEW_STALE");
    if (row.price !== line.o) throw new Error("RECALC_PREVIEW_STALE");
    // A product switched to manual after the preview must not be repriced.
    if (row.priceMode !== "auto") throw new Error("RECALC_PREVIEW_STALE");
  }

  let up = 0;
  let down = 0;
  const now = new Date();

  for (let i = 0; i < payload.lines.length; i += RECALC_BATCH_SIZE) {
    const batch = payload.lines.slice(i, i + RECALC_BATCH_SIZE);
    await db.transaction(async (tx) => {
      for (const line of batch) {
        const [updated] = await tx
          .update(products)
          .set({ price: line.n, priceRuleId: line.r, priceCalculatedAt: now, updatedAt: now })
          .where(and(
            eq(products.id, line.i),
            eq(products.price, line.o),
            eq(products.priceMode, "auto"),
          ))
          .returning({ id: products.id });
        if (!updated) throw new Error("RECALC_PREVIEW_STALE");
        if (Number(line.n) > Number(line.o)) up += 1;
        else down += 1;
      }
    });
  }

  await createAuditLog({
    userId: options.userId,
    action: "pricing.mass_recalculated",
    entity: "products",
    details: { updated: payload.lines.length, up, down, confirmedDecreases: !!options.confirmDecreases },
  });

  return { updated: payload.lines.length, up, down };
}
