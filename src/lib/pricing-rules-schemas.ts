/**
 * C.2 — Zod schemas for pricing rule administration.
 *
 * Single source of truth shared by the API routes and the tests, matching the
 * pattern already used by bulk-schemas.ts.
 *
 * The database (migration 0009) enforces the same invariants with CHECK
 * constraints and partial unique indexes; these schemas exist so the API
 * answers 400 with a useful message instead of leaking a 500 from the driver.
 */
import { z } from "zod";
import { MAX_MARGIN_ON_SALE } from "@/lib/pricing-calculator";

export const ruleScopeSchema = z.enum(["product", "category", "brand", "supplier", "global"]);
export const ruleMethodSchema = z.enum(["markup_on_cost", "margin_on_sale"]);
export const ruleRoundingSchema = z.enum(["auto", "none", "end_90", "end_99"]);

/** Priority is an ADVANCED option; the normal form never sends it (defaults to 0). */
const prioritySchema = z.number().int().min(0).max(1000).optional();

const baseRuleFields = {
  scope: ruleScopeSchema,
  productId: z.number().int().positive().nullable().optional(),
  categoryId: z.number().int().positive().nullable().optional(),
  brandId: z.number().int().positive().nullable().optional(),
  supplierId: z.number().int().positive().nullable().optional(),
  method: ruleMethodSchema,
  ratePercent: z.number().min(0).max(100000),
  roundingPolicy: ruleRoundingSchema.default("auto"),
  minMarginPercent: z.number().min(0).max(100).nullable().optional(),
  priority: prioritySchema,
  isActive: z.boolean().default(true),
  notes: z.string().max(1000).nullable().optional(),
};

/**
 * Exactly one target must match the declared scope.
 *
 * Mirrors the `pricing_rules_target_matches_scope` CHECK so an ambiguous rule
 * is rejected before it ever reaches the database.
 */
function targetMatchesScope(v: {
  scope: string;
  productId?: number | null;
  categoryId?: number | null;
  brandId?: number | null;
  supplierId?: number | null;
}): boolean {
  const filled = {
    product: v.productId != null,
    category: v.categoryId != null,
    brand: v.brandId != null,
    supplier: v.supplierId != null,
  };
  const count = Object.values(filled).filter(Boolean).length;
  if (v.scope === "global") return count === 0;
  return count === 1 && filled[v.scope as keyof typeof filled] === true;
}

/** margin_on_sale is undefined at 100% and absurd above it. */
function rateWithinMethodLimits(v: { method: string; ratePercent: number }): boolean {
  if (v.method !== "margin_on_sale") return true;
  return v.ratePercent <= MAX_MARGIN_ON_SALE;
}

export const createPricingRuleSchema = z
  .object(baseRuleFields)
  .strict()
  .refine(targetMatchesScope, {
    message: "O alvo da regra não corresponde ao âmbito selecionado",
    path: ["scope"],
  })
  .refine(rateWithinMethodLimits, {
    message: "A margem sobre venda tem de ser inferior a 100%",
    path: ["ratePercent"],
  });

export const updatePricingRuleSchema = z
  .object({ id: z.number().int().positive(), ...baseRuleFields })
  .strict()
  .refine(targetMatchesScope, {
    message: "O alvo da regra não corresponde ao âmbito selecionado",
    path: ["scope"],
  })
  .refine(rateWithinMethodLimits, {
    message: "A margem sobre venda tem de ser inferior a 100%",
    path: ["ratePercent"],
  });

export const deletePricingRuleSchema = z.object({ id: z.number().int().positive() }).strict();

/** Toggle without resending the whole rule. */
export const togglePricingRuleSchema = z
  .object({ id: z.number().int().positive(), isActive: z.boolean() })
  .strict();

// ── Rounding policy ───────────────────────────────────────
// The UI edits UPPER BOUNDS only ("até 199,99 € → ,99"), which makes gaps and
// overlaps structurally impossible: each band starts where the previous ended.

export const roundingBandSchema = z
  .object({
    fromCents: z.number().int().min(0),
    mode: z.enum(["none", "end_90", "end_99"]),
  })
  .strict();

export const roundingPolicySchema = z
  .object({
    enabled: z.boolean(),
    bands: z.array(roundingBandSchema).min(1).max(10),
  })
  .strict()
  .refine((p) => p.bands.some((b) => b.fromCents === 0), {
    message: "É necessária uma faixa a começar em 0 €",
    path: ["bands"],
  })
  .refine((p) => new Set(p.bands.map((b) => b.fromCents)).size === p.bands.length, {
    message: "Existem faixas duplicadas",
    path: ["bands"],
  })
  .refine(
    (p) => {
      const sorted = [...p.bands].sort((a, b) => a.fromCents - b.fromCents);
      return sorted.every((b, i) => i === 0 || b.fromCents > sorted[i - 1].fromCents);
    },
    { message: "As faixas têm de ser crescentes e sem sobreposição", path: ["bands"] }
  );

// ── Recalculation preview / apply ─────────────────────────

export const recalcPreviewSchema = z
  .object({
    mode: z.literal("preview"),
    /** Limit the impact analysis to the products a given rule would price. */
    ruleId: z.number().int().positive().optional(),
    scope: ruleScopeSchema.optional(),
    productId: z.number().int().positive().optional(),
    categoryId: z.number().int().positive().optional(),
    brandId: z.number().int().positive().optional(),
    supplierId: z.number().int().positive().optional(),
  })
  .strict();

export const recalcApplySchema = z
  .object({
    mode: z.literal("apply"),
    previewToken: z.string().min(1),
    /**
     * Must be true when the preview reported price decreases. The server
     * re-checks the decrease count from the token, so a client that omits this
     * cannot sneak a silent price drop through.
     */
    confirmDecreases: z.boolean().optional(),
  })
  .strict();

export const recalcRequestSchema = z.discriminatedUnion("mode", [recalcPreviewSchema, recalcApplySchema]);
