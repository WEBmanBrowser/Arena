/**
 * Bulk pricing service — extracted from route for testability.
 * The API route calls THIS. Tests call THIS. Same logic.
 */
import { db } from "@/db";
import { products } from "@/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { calculateBulkPriceChanges, createPreviewToken, verifyPreviewToken, type BulkPriceOp } from "@/lib/bulk-pricing";
import { buildAdminProductConditions, type AdminProductFilters } from "@/lib/product-filters";
import { type BulkTarget } from "@/lib/bulk-schemas";

export const BULK_LIMIT = 5000;

/** Optional query executor for testing limit logic without 5001 real rows */
type QueryFn = (limit: number) => Promise<Array<{ id: number }>>;

export async function resolveTargetIds(target: BulkTarget, queryFn?: QueryFn): Promise<number[]> {
  switch (target.type) {
    case "selection":
      return target.productIds;
    case "filters": {
      let rows: Array<{ id: number }>;
      if (queryFn) {
        rows = await queryFn(BULK_LIMIT + 1);
      } else {
        const where = buildAdminProductConditions((target.filters || {}) as AdminProductFilters);
        rows = await db.select({ id: products.id }).from(products).where(where).limit(BULK_LIMIT + 1);
      }
      if (rows.length > BULK_LIMIT) throw new Error("BULK_TOO_MANY_PRODUCTS");
      return rows.map(r => r.id);
    }
  }
}

export async function previewBulkPricing(target: BulkTarget, operation: BulkPriceOp, value: number) {
  const productIds = await resolveTargetIds(target);
  if (!productIds.length) throw new Error(target.type === "selection" ? "NO_PRODUCTS_SELECTED" : "NO_PRODUCTS_MATCH_FILTERS");
  const selected = await db.select({ id: products.id, name: products.name, sku: products.sku, price: products.price }).from(products).where(inArray(products.id, productIds));
  const results = calculateBulkPriceChanges(selected, operation, value);
  if (results.some(r => r.invalid)) throw new Error("NEGATIVE_RESULTING_PRICE");
  const previewToken = createPreviewToken(operation, value, selected.map(p => ({ id: p.id, price: p.price })));
  return { results, previewToken, productCount: results.length };
}

export async function applyBulkPricing(previewToken: string) {
  const tokenResult = verifyPreviewToken(previewToken);
  if (!tokenResult.valid) throw new Error("BULK_PREVIEW_INVALID");
  if (tokenResult.expired) throw new Error("BULK_PREVIEW_EXPIRED");
  const td = tokenResult.data!;

  const ids = td.products.map(p => p.id);
  const current = await db.select({ id: products.id, name: products.name, sku: products.sku, price: products.price }).from(products).where(inArray(products.id, ids));
  const curMap: Record<number, string> = {};
  current.forEach(p => { curMap[p.id] = p.price; });
  for (const tp of td.products) {
    if (curMap[tp.id] !== tp.price) throw new Error("BULK_PREVIEW_STALE");
  }

  const results = calculateBulkPriceChanges(current, td.op, td.val);
  if (results.some(r => r.invalid)) throw new Error("NEGATIVE_RESULTING_PRICE");

  await db.transaction(async (tx) => {
    for (const r of results) {
      const [upd] = await tx.update(products).set({ price: r.newPrice, updatedAt: new Date() }).where(and(eq(products.id, r.productId), eq(products.price, r.currentPrice))).returning();
      if (!upd) throw new Error("STALE");
    }
  });

  return { updated: results.length, changes: results.map(r => ({ id: r.productId, from: r.currentPrice, to: r.newPrice })) };
}
