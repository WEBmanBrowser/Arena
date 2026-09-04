/**
 * C.2 — Pricing rule administration.
 *
 * CRUD over the pricing_rules table created in migration 0009, plus the
 * catalogue coverage indicators that tell the operator whether the catalogue
 * is ready for automatic import (C.3).
 *
 * Deliberately does NOT reprice anything: saving a rule must never move prices
 * on its own. Recalculation is a separate, explicit preview→apply flow in
 * pricing-recalc-service.ts.
 */
import { db } from "@/db";
import { pricingRules, products, brands, categories, suppliers, productSuppliers } from "@/db/schema";
import { and, eq, sql, desc, asc } from "drizzle-orm";
import { createAuditLog } from "@/lib/audit";
import { SCOPE_SPECIFICITY, type RuleScope } from "@/lib/pricing-rules";

export interface PricingRuleInput {
  scope: RuleScope;
  productId?: number | null;
  categoryId?: number | null;
  brandId?: number | null;
  supplierId?: number | null;
  method: "markup_on_cost" | "margin_on_sale";
  ratePercent: number;
  roundingPolicy: "auto" | "none" | "end_90" | "end_99";
  minMarginPercent?: number | null;
  priority?: number;
  isActive: boolean;
  notes?: string | null;
}

export interface PricingRuleListItem {
  id: number;
  scope: RuleScope;
  targetId: number | null;
  targetName: string | null;
  method: string;
  ratePercent: string;
  roundingPolicy: string;
  minMarginPercent: string | null;
  priority: number;
  isActive: boolean;
  notes: string | null;
  updatedAt: Date;
}

/** Postgres error codes we translate into business errors. */
function mapConstraintError(e: unknown): Error | null {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur instanceof Error; i += 1) {
    parts.push(cur.message);
    cur = (cur as Error).cause;
  }
  const msg = parts.join(" | ");
  if (msg.includes("pricing_rules_active_") && msg.includes("unique")) {
    return new Error("RULE_ALREADY_EXISTS");
  }
  if (msg.includes("pricing_rules_target_matches_scope")) return new Error("INVALID_RULE_TARGET");
  if (msg.includes("pricing_rules_margin_below_100")) return new Error("MARGIN_TOO_HIGH");
  if (msg.includes("pricing_rules_rate_non_negative")) return new Error("INVALID_RATE");
  if (msg.includes("violates foreign key")) return new Error("TARGET_NOT_FOUND");
  return null;
}

/**
 * List every rule with its target resolved to a human name.
 *
 * Ordered the way the engine reasons about them — most specific first, then by
 * priority — so the table reads like the resolution order itself.
 */
export async function listPricingRules(): Promise<PricingRuleListItem[]> {
  const rows = await db
    .select({
      id: pricingRules.id,
      scope: pricingRules.scope,
      productId: pricingRules.productId,
      categoryId: pricingRules.categoryId,
      brandId: pricingRules.brandId,
      supplierId: pricingRules.supplierId,
      method: pricingRules.method,
      ratePercent: pricingRules.ratePercent,
      roundingPolicy: pricingRules.roundingPolicy,
      minMarginPercent: pricingRules.minMarginPercent,
      priority: pricingRules.priority,
      isActive: pricingRules.isActive,
      notes: pricingRules.notes,
      updatedAt: pricingRules.updatedAt,
      productName: products.name,
      categoryName: categories.name,
      brandName: brands.name,
      supplierName: suppliers.name,
    })
    .from(pricingRules)
    .leftJoin(products, eq(pricingRules.productId, products.id))
    .leftJoin(categories, eq(pricingRules.categoryId, categories.id))
    .leftJoin(brands, eq(pricingRules.brandId, brands.id))
    .leftJoin(suppliers, eq(pricingRules.supplierId, suppliers.id))
    .orderBy(desc(pricingRules.priority), asc(pricingRules.id));

  const items = rows.map((r) => {
    const scope = r.scope as RuleScope;
    const targetName =
      scope === "product" ? r.productName
      : scope === "category" ? r.categoryName
      : scope === "brand" ? r.brandName
      : scope === "supplier" ? r.supplierName
      : "Todos os produtos";
    const targetId =
      scope === "product" ? r.productId
      : scope === "category" ? r.categoryId
      : scope === "brand" ? r.brandId
      : scope === "supplier" ? r.supplierId
      : null;
    return {
      id: r.id, scope, targetId, targetName,
      method: r.method, ratePercent: r.ratePercent, roundingPolicy: r.roundingPolicy,
      minMarginPercent: r.minMarginPercent, priority: r.priority,
      isActive: r.isActive, notes: r.notes, updatedAt: r.updatedAt,
    };
  });

  return items.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    const spec = SCOPE_SPECIFICITY[b.scope] - SCOPE_SPECIFICITY[a.scope];
    if (spec !== 0) return spec;
    return a.id - b.id;
  });
}

function normalise(input: PricingRuleInput) {
  return {
    scope: input.scope,
    productId: input.scope === "product" ? input.productId ?? null : null,
    categoryId: input.scope === "category" ? input.categoryId ?? null : null,
    brandId: input.scope === "brand" ? input.brandId ?? null : null,
    supplierId: input.scope === "supplier" ? input.supplierId ?? null : null,
    method: input.method,
    ratePercent: String(input.ratePercent),
    roundingPolicy: input.roundingPolicy,
    minMarginPercent: input.minMarginPercent == null ? null : String(input.minMarginPercent),
    // Priority is an advanced option; the normal form omits it entirely.
    priority: input.priority ?? 0,
    isActive: input.isActive,
    notes: input.notes?.trim() || null,
  };
}

export async function createPricingRule(input: PricingRuleInput, userId: number | null) {
  try {
    const [row] = await db.insert(pricingRules).values(normalise(input)).returning();
    await createAuditLog({
      userId, action: "pricing_rule.created", entity: "pricing_rule", entityId: row.id,
      details: { scope: row.scope, method: row.method, rate: row.ratePercent, priority: row.priority },
    });
    return row;
  } catch (e) {
    const mapped = mapConstraintError(e);
    if (mapped) throw mapped;
    throw e;
  }
}

export async function updatePricingRule(id: number, input: PricingRuleInput, userId: number | null) {
  const [existing] = await db.select().from(pricingRules).where(eq(pricingRules.id, id)).limit(1);
  if (!existing) throw new Error("RULE_NOT_FOUND");
  try {
    const [row] = await db
      .update(pricingRules)
      .set({ ...normalise(input), updatedAt: new Date() })
      .where(eq(pricingRules.id, id))
      .returning();
    await createAuditLog({
      userId, action: "pricing_rule.updated", entity: "pricing_rule", entityId: id,
      details: {
        rateFrom: existing.ratePercent, rateTo: row.ratePercent,
        methodFrom: existing.method, methodTo: row.method,
      },
    });
    return row;
  } catch (e) {
    const mapped = mapConstraintError(e);
    if (mapped) throw mapped;
    throw e;
  }
}

/**
 * Toggle a rule.
 *
 * Deactivating never touches prices — products keep the price they have until
 * an explicit recalculation is applied.
 */
export async function togglePricingRule(id: number, isActive: boolean, userId: number | null) {
  const [existing] = await db.select().from(pricingRules).where(eq(pricingRules.id, id)).limit(1);
  if (!existing) throw new Error("RULE_NOT_FOUND");
  try {
    const [row] = await db
      .update(pricingRules)
      .set({ isActive, updatedAt: new Date() })
      .where(eq(pricingRules.id, id))
      .returning();
    await createAuditLog({
      userId, action: "pricing_rule.toggled", entity: "pricing_rule", entityId: id,
      details: { isActive },
    });
    return row;
  } catch (e) {
    const mapped = mapConstraintError(e);
    if (mapped) throw mapped;
    throw e;
  }
}

export async function deletePricingRule(id: number, userId: number | null) {
  const [existing] = await db.select().from(pricingRules).where(eq(pricingRules.id, id)).limit(1);
  if (!existing) throw new Error("RULE_NOT_FOUND");
  // products.price_rule_id is ON DELETE SET NULL, so deleting a rule never
  // blocks and never rewrites a price.
  await db.delete(pricingRules).where(eq(pricingRules.id, id));
  await createAuditLog({
    userId, action: "pricing_rule.deleted", entity: "pricing_rule", entityId: id,
    details: { scope: existing.scope },
  });
  return { deleted: true };
}

export interface CatalogueCoverage {
  total: number;
  automatic: number;
  manual: number;
  withoutCost: number;
  /** Automatic products with a cost that still resolve to no rule. */
  withoutRule: number;
  /** Automatic + has cost + a rule resolves — ready for automatic pricing. */
  ready: number;
  hasGlobalRule: boolean;
  activeRules: number;
}

/**
 * Catalogue readiness indicators.
 *
 * Answers the question "is this catalogue ready for an automatic import?".
 * `withoutRule` is computed with the real resolver rather than SQL guesswork,
 * so it accounts for category ancestry and the global fallback.
 */
export async function getCatalogueCoverage(): Promise<CatalogueCoverage> {
  const { loadPricingContext } = await import("@/lib/services/pricing-engine-service");
  const { resolvePricingRule } = await import("@/lib/pricing-rules");

  const [counts] = await db
    .select({
      total: sql<number>`count(*)::int`,
      automatic: sql<number>`count(*) filter (where ${products.priceMode} = 'auto')::int`,
      manual: sql<number>`count(*) filter (where ${products.priceMode} = 'manual')::int`,
      withoutCost: sql<number>`count(*) filter (where ${products.priceMode} = 'auto' and (${products.costPrice} is null or ${products.costPrice}::numeric <= 0))::int`,
    })
    .from(products);

  const ctx = await loadPricingContext();
  const hasGlobalRule = ctx.rules.some((r) => r.scope === "global" && r.isActive);

  // Only automatic products WITH a cost can be missing a rule.
  // Use an explicitly qualified LEFT JOIN instead of a correlational subquery,
  // so the supplier reference never resolves to a wrong column.
  const candidates = await db
    .select({
      id: products.id,
      categoryId: products.categoryId,
      brandId: products.brandId,
      supplierId: productSuppliers.supplierId,
    })
    .from(products)
    .leftJoin(
      productSuppliers,
      and(
        eq(productSuppliers.productId, products.id),
        eq(productSuppliers.isPreferred, true)
      )
    )
    .where(sql`${products.priceMode} = 'auto' and ${products.costPrice} is not null and ${products.costPrice}::numeric > 0`);

  let withoutRule = 0;
  for (const c of candidates) {
    const resolved = resolvePricingRule(
      ctx.rules,
      { productId: c.id, categoryId: c.categoryId, brandId: c.brandId, supplierId: c.supplierId ?? null },
      ctx.categoryTree
    );
    if (!resolved) withoutRule += 1;
  }

  return {
    total: counts?.total ?? 0,
    automatic: counts?.automatic ?? 0,
    manual: counts?.manual ?? 0,
    withoutCost: counts?.withoutCost ?? 0,
    withoutRule,
    ready: candidates.length - withoutRule,
    hasGlobalRule,
    activeRules: ctx.rules.length,
  };
}
