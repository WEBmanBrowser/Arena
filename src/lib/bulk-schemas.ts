/**
 * Shared Zod schemas for bulk pricing.
 * Used by BOTH the API route AND the tests — single source of truth.
 */
import { z } from "zod";

const noDuplicates = (ids: number[]) => new Set(ids).size === ids.length;

export const selectionTargetSchema = z.object({
  type: z.literal("selection"),
  productIds: z.array(z.number().int().min(1)).min(1).max(5000).refine(noDuplicates, "IDs duplicados"),
}).strict();

export const filtersTargetSchema = z.object({
  type: z.literal("filters"),
  filters: z.object({ q: z.string().optional(), brandId: z.number().optional(), categoryId: z.number().optional(), isActive: z.boolean().optional(), isFeatured: z.boolean().optional(), stockStatus: z.string().optional() }).optional(),
}).strict();

export const bulkTargetSchema = z.discriminatedUnion("type", [selectionTargetSchema, filtersTargetSchema]);
export type BulkTarget = z.infer<typeof bulkTargetSchema>;

export const bulkOperationSchema = z.enum(["percent_increase", "percent_decrease", "fixed_increase", "fixed_decrease"]);

export const previewSchema = z.object({
  action: z.literal("price_update"),
  mode: z.literal("preview"),
  target: bulkTargetSchema,
  operation: bulkOperationSchema,
  value: z.number().positive(),
});

export const applySchema = z.object({
  action: z.literal("price_update"),
  mode: z.literal("apply"),
  previewToken: z.string().min(1),
});

export const simpleActionSchema = z.object({
  action: z.enum(["activate", "deactivate", "set_featured", "remove_featured", "set_category", "set_brand"]),
  ids: z.array(z.number().int().min(1)).optional(),
  value: z.number().optional(),
});
