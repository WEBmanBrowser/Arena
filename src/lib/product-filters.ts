/**
 * Shared admin product filter builder.
 * Used by BOTH product listing and bulk pricing to guarantee consistency.
 */
import { products } from "@/db/schema";
import { eq, and, ilike, sql, gte, lte, type SQL } from "drizzle-orm";

export interface AdminProductFilters {
  q?: string;
  brandId?: number;
  categoryId?: number;
  isActive?: boolean;
  isFeatured?: boolean;
  stockStatus?: string; // in_stock, low_stock, out_of_stock
  priceMin?: string;
  priceMax?: string;
}

/** Build WHERE conditions from admin filters. Returns undefined if no filters. */
export function buildAdminProductConditions(f: AdminProductFilters): SQL | undefined {
  const conds: SQL[] = [];
  if (f.q) conds.push(ilike(products.name, `%${f.q}%`));
  if (f.brandId !== undefined) conds.push(eq(products.brandId, f.brandId));
  if (f.categoryId !== undefined) conds.push(eq(products.categoryId, f.categoryId));
  if (f.isActive === true) conds.push(eq(products.isActive, true));
  if (f.isActive === false) conds.push(eq(products.isActive, false));
  if (f.isFeatured === true) conds.push(eq(products.isFeatured, true));
  if (f.isFeatured === false) conds.push(eq(products.isFeatured, false));
  if (f.stockStatus === "out_of_stock") conds.push(sql`${products.stock} - ${products.reservedStock} <= 0`);
  if (f.stockStatus === "low_stock") conds.push(sql`${products.stock} - ${products.reservedStock} > 0 AND ${products.stock} - ${products.reservedStock} <= ${products.minStock}`);
  if (f.stockStatus === "in_stock") conds.push(sql`${products.stock} - ${products.reservedStock} > 0`);
  if (f.priceMin) conds.push(gte(products.price, f.priceMin));
  if (f.priceMax) conds.push(lte(products.price, f.priceMax));
  return conds.length ? and(...conds) : undefined;
}
