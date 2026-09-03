/**
 * C.1 — Deterministic pricing rule resolution.
 *
 * Given a product (its category, brand and preferred supplier), decide WHICH
 * rule prices it. Pure functions: the caller loads the rows, so this is fully
 * testable and reusable by the future import pipeline (C.3) without a database.
 */
import type { PricingMethod, RoundingMode } from "@/lib/pricing-calculator";

export type RuleScope = "product" | "category" | "brand" | "supplier" | "global";

/** Natural specificity, most specific first. Used when `priority` ties. */
export const SCOPE_SPECIFICITY: Record<RuleScope, number> = {
  product: 5,
  category: 4,
  brand: 3,
  supplier: 2,
  global: 1,
};

export interface PricingRuleRow {
  id: number;
  scope: RuleScope;
  productId: number | null;
  categoryId: number | null;
  brandId: number | null;
  supplierId: number | null;
  method: PricingMethod;
  ratePercent: string;
  roundingPolicy: "auto" | RoundingMode;
  minMarginPercent: string | null;
  priority: number;
  isActive: boolean;
}

export interface RuleTarget {
  productId: number;
  categoryId: number | null;
  brandId: number | null;
  /** Preferred supplier — the same one that owns products.costPrice. */
  supplierId: number | null;
}

export interface CategoryNode {
  id: number;
  parentId: number | null;
}

export interface ResolvedRule {
  rule: PricingRuleRow;
  /** Why this rule won — surfaced in the UI and in the audit log. */
  matchedScope: RuleScope;
  /** For category matches: how far up the tree we had to walk (0 = direct). */
  categoryDepth: number;
}

/**
 * Walk a category and its ancestors, nearest first.
 *
 * Categories are hierarchical (`categories.parentId`), so a rule on
 * "Portáteis Gaming" must beat a rule on its parent "Portáteis". Cycle-safe:
 * a corrupt parent chain terminates instead of hanging.
 */
export function categoryAncestry(categoryId: number | null, categories: CategoryNode[]): number[] {
  if (categoryId === null) return [];
  const byId = new Map(categories.map((c) => [c.id, c]));
  const chain: number[] = [];
  const seen = new Set<number>();
  let current: number | null = categoryId;
  while (current !== null && !seen.has(current)) {
    const node = byId.get(current);
    // Unknown id → stop WITHOUT recording it. A dangling parent cannot own a
    // rule, and keeping it would put a phantom category in the chain.
    if (!node) break;
    seen.add(current);
    chain.push(current);
    current = node.parentId ?? null;
  }
  return chain;
}

/**
 * Collect every rule that could apply to the target, each with the reason it
 * matched. Inactive rules are ignored entirely.
 */
export function candidateRules(
  rules: PricingRuleRow[],
  target: RuleTarget,
  categories: CategoryNode[]
): ResolvedRule[] {
  const ancestry = categoryAncestry(target.categoryId, categories);
  const out: ResolvedRule[] = [];

  for (const rule of rules) {
    if (!rule.isActive) continue;
    switch (rule.scope) {
      case "product":
        if (rule.productId === target.productId) out.push({ rule, matchedScope: "product", categoryDepth: 0 });
        break;
      case "category": {
        if (rule.categoryId === null) break;
        const depth = ancestry.indexOf(rule.categoryId);
        if (depth >= 0) out.push({ rule, matchedScope: "category", categoryDepth: depth });
        break;
      }
      case "brand":
        if (rule.brandId !== null && rule.brandId === target.brandId) {
          out.push({ rule, matchedScope: "brand", categoryDepth: 0 });
        }
        break;
      case "supplier":
        if (rule.supplierId !== null && rule.supplierId === target.supplierId) {
          out.push({ rule, matchedScope: "supplier", categoryDepth: 0 });
        }
        break;
      case "global":
        out.push({ rule, matchedScope: "global", categoryDepth: 0 });
        break;
    }
  }
  return out;
}

/**
 * Pick the winning rule. Deterministic, in this order:
 *
 *   1. Highest `priority`      — explicit operator override. Lets a supplier
 *                                rule outrank a broad category rule without
 *                                changing the model.
 *   2. Most specific scope     — Produto > Categoria > Marca > Fornecedor > Geral.
 *   3. Nearest category        — the deepest category in the tree wins.
 *   4. Highest rule id         — last tiebreaker; never leaves it to chance.
 *
 * Returns null when nothing applies (no global rule configured).
 */
export function resolvePricingRule(
  rules: PricingRuleRow[],
  target: RuleTarget,
  categories: CategoryNode[]
): ResolvedRule | null {
  const candidates = candidateRules(rules, target, categories);
  if (candidates.length === 0) return null;

  return candidates.reduce((best, current) => (compareRules(current, best) < 0 ? current : best));
}

/** Negative when `a` should win over `b`. */
function compareRules(a: ResolvedRule, b: ResolvedRule): number {
  if (a.rule.priority !== b.rule.priority) return b.rule.priority - a.rule.priority;

  const specA = SCOPE_SPECIFICITY[a.matchedScope];
  const specB = SCOPE_SPECIFICITY[b.matchedScope];
  if (specA !== specB) return specB - specA;

  if (a.matchedScope === "category" && a.categoryDepth !== b.categoryDepth) {
    return a.categoryDepth - b.categoryDepth;
  }
  return b.rule.id - a.rule.id;
}

/** Human-readable label for the UI and the audit trail. */
export function describeRule(
  resolved: ResolvedRule,
  names: { category?: string | null; brand?: string | null; supplier?: string | null } = {}
): string {
  const { rule, matchedScope } = resolved;
  const rate = `${Number(rule.ratePercent)}%`;
  const method = rule.method === "markup_on_cost" ? "Markup sobre custo" : "Margem sobre venda";
  const scopeLabel: Record<RuleScope, string> = {
    product: "Produto",
    category: `Categoria${names.category ? ` ${names.category}` : ""}`,
    brand: `Marca${names.brand ? ` ${names.brand}` : ""}`,
    supplier: `Fornecedor${names.supplier ? ` ${names.supplier}` : ""}`,
    global: "Regra geral",
  };
  return `${scopeLabel[matchedScope]} — ${method} ${rate}`;
}
