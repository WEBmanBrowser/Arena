/**
 * Product image service — extracted from route for testability.
 */
import { db } from "@/db";
import { productImages } from "@/db/schema";
import { eq, and, asc, sql } from "drizzle-orm";
import type { StorageProvider } from "@/lib/storage/types";

export interface ReorderItem { imageId: number; sortOrder: number; }

export async function reorderImages(productId: number, items: ReorderItem[], storage?: StorageProvider | null) {
  const imgIds = items.map(i => i.imageId);
  if (new Set(imgIds).size !== imgIds.length) throw new Error("VALIDATION:imageId duplicado");
  const sorts = items.map(i => i.sortOrder);
  if (new Set(sorts).size !== sorts.length) throw new Error("VALIDATION:sortOrder duplicado");
  if (items.some(i => i.sortOrder < 0)) throw new Error("VALIDATION:sortOrder negativo");

  await db.transaction(async (tx) => {
    for (const item of items) {
      const [img] = await tx.select({ productId: productImages.productId }).from(productImages).where(eq(productImages.id, item.imageId)).limit(1);
      if (!img || img.productId !== productId) throw new Error("OWNERSHIP");
      await tx.update(productImages).set({ sortOrder: item.sortOrder, updatedAt: new Date() }).where(eq(productImages.id, item.imageId));
    }
  });
}

export async function deleteImage(productId: number, imageId: number, storage: StorageProvider | null) {
  const [img] = await db.select().from(productImages).where(and(eq(productImages.id, imageId), eq(productImages.productId, productId))).limit(1);
  if (!img) throw new Error("NOT_FOUND");

  if (!storage) throw new Error("STORAGE_NOT_CONFIGURED");

  try { await storage.delete(img.storageKey); }
  catch { throw new Error("STORAGE_DELETE_FAILED"); }

  await db.transaction(async (tx) => {
    await tx.delete(productImages).where(eq(productImages.id, imageId));
    if (img.isPrimary) {
      const [next] = await tx.select().from(productImages).where(eq(productImages.productId, productId)).orderBy(asc(productImages.sortOrder)).limit(1);
      if (next) await tx.update(productImages).set({ isPrimary: true, updatedAt: new Date() }).where(eq(productImages.id, next.id));
    }
  });
}

export async function updateAlt(productId: number, imageId: number, newAlt: string | null): Promise<{ changed: boolean; oldAlt: string | null }> {
  const [img] = await db.select().from(productImages).where(and(eq(productImages.id, imageId), eq(productImages.productId, productId))).limit(1);
  if (!img) throw new Error("NOT_FOUND");
  if (img.altText === newAlt) return { changed: false, oldAlt: img.altText };
  await db.update(productImages).set({ altText: newAlt, updatedAt: new Date() }).where(eq(productImages.id, imageId));
  return { changed: true, oldAlt: img.altText };
}
