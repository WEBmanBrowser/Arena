/**
 * Product supplier service — extracted from route for testability.
 */
import { db } from "@/db";
import { productSuppliers, products } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

async function syncProductCost(txDb: NodePgDatabase, productId: number) {
  const [preferred] = await txDb.select({ costPrice: productSuppliers.costPrice })
    .from(productSuppliers)
    .where(and(eq(productSuppliers.productId, productId), eq(productSuppliers.isPreferred, true)))
    .limit(1);
  await txDb.update(products).set({ costPrice: preferred ? preferred.costPrice : null, updatedAt: new Date() }).where(eq(products.id, productId));
}

export async function deleteProductSupplier(productId: number, psId: number): Promise<{ deleted: boolean }> {
  // Verify ownership
  const [ps] = await db.select({ id: productSuppliers.id }).from(productSuppliers)
    .where(and(eq(productSuppliers.id, psId), eq(productSuppliers.productId, productId))).limit(1);
  if (!ps) throw new Error("NOT_FOUND");

  await db.transaction(async (tx) => {
    await tx.delete(productSuppliers).where(and(eq(productSuppliers.id, psId), eq(productSuppliers.productId, productId)));
    await syncProductCost(tx as unknown as NodePgDatabase, productId);
  });

  return { deleted: true };
}
