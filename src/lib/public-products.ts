/**
 * Shared public product projection.
 * Used by /api/products, /api/products/[slug], and tests.
 * NEVER include: costPrice, lastCostPrice, supplierSku, storageKey, or any internal data.
 */
import { db } from "@/db";
import { products, productImages } from "@/db/schema";
import { eq, and, asc, sql, inArray } from "drizzle-orm";

export const publicProductSelect = {
  id: products.id,
  name: products.name,
  slug: products.slug,
  sku: products.sku,
  ean: products.ean,
  price: products.price,
  comparePrice: products.comparePrice,
  shortDescription: products.shortDescription,
  description: products.description,
  images: products.images, // legacy fallback
  stock: products.stock,
  reservedStock: products.reservedStock, // needed to compute availableStock server-side
  allowPreorder: products.allowPreorder,
  isFeatured: products.isFeatured,
  isService: products.isService,
  attributes: products.attributes,
  tags: products.tags,
  brandId: products.brandId,
  categoryId: products.categoryId,
  storeStock: products.storeStock,
  vatRate: products.vatRate,
  metaTitle: products.metaTitle,
  metaDescription: products.metaDescription,
} as const;

/** List select — fewer fields for performance */
export const publicProductListSelect = {
  id: products.id,
  name: products.name,
  slug: products.slug,
  sku: products.sku,
  price: products.price,
  comparePrice: products.comparePrice,
  shortDescription: products.shortDescription,
  images: products.images,
  stock: products.stock,
  reservedStock: products.reservedStock,
  allowPreorder: products.allowPreorder,
  isFeatured: products.isFeatured,
  isService: products.isService,
  attributes: products.attributes,
  tags: products.tags,
  brandId: products.brandId,
  categoryId: products.categoryId,
  storeStock: products.storeStock,
} as const;

/** Strip internal fields and add availableStock for public response */
export function sanitizeForPublic<T extends { stock: number; reservedStock: number }>(
  product: T
): Omit<T, "reservedStock" | "costPrice"> & { availableStock: number } {
  const { reservedStock, costPrice, ...rest } = product as T & { costPrice?: unknown };
  return { ...rest, availableStock: Math.max(0, product.stock - reservedStock) } as Omit<T, "reservedStock" | "costPrice"> & { availableStock: number };
}

/** Get sanitized public images for a product (no storageKey) */
export async function getPublicProductImages(productId: number) {
  const imgs = await db.select({
    id: productImages.id,
    url: productImages.publicUrl,
    altText: productImages.altText,
    sortOrder: productImages.sortOrder,
    isPrimary: productImages.isPrimary,
  }).from(productImages).where(eq(productImages.productId, productId)).orderBy(asc(productImages.sortOrder));
  return imgs;
}

/** Get primary image URLs for multiple products efficiently (no N+1) */
export async function getPrimaryImageUrls(productIds: number[]): Promise<Record<number, string | null>> {
  if (!productIds.length) return {};
  const imgs = await db.select({
    productId: productImages.productId,
    url: productImages.publicUrl,
  }).from(productImages).where(
    and(eq(productImages.isPrimary, true), inArray(productImages.productId, productIds))
  );
  const map: Record<number, string | null> = {};
  imgs.forEach(i => { map[i.productId] = i.url; });
  return map;
}
