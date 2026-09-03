/**
 * Product supplier service — extracted from route for testability.
 */
import { db } from "@/db";
import { productSuppliers, products } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { recalculateProductPrice, type PriceComputation } from "@/lib/services/pricing-engine-service";

/**
 * Sync the product cost from its preferred supplier and recalculate the
 * selling price in the same transaction (C.1). Removing the preferred
 * supplier clears the cost, which the engine reports as "no cost" rather than
 * pricing the product at zero.
 *
 * Exported because it is the single authoritative path from "a supplier cost
 * changed" to "the catalogue's cost and automatic price are up to date" — the
 * product UI, the legacy importer and the C.3.1 supplier import all go through
 * it, which is what keeps price_mode manual protected in one place only.
 */
export async function syncProductCost(txDb: NodePgDatabase, productId: number): Promise<PriceComputation | null> {
  const [preferred] = await txDb.select({ costPrice: productSuppliers.costPrice })
    .from(productSuppliers)
    .where(and(eq(productSuppliers.productId, productId), eq(productSuppliers.isPreferred, true)))
    .limit(1);
  await txDb.update(products).set({ costPrice: preferred ? preferred.costPrice : null, updatedAt: new Date() }).where(eq(products.id, productId));
  return recalculateProductPrice(productId, { database: txDb });
}

export async function deleteProductSupplier(productId: number, psId: number): Promise<{ deleted: boolean; priceResult: PriceComputation | null }> {
  // Verify ownership
  const [ps] = await db.select({ id: productSuppliers.id }).from(productSuppliers)
    .where(and(eq(productSuppliers.id, psId), eq(productSuppliers.productId, productId))).limit(1);
  if (!ps) throw new Error("NOT_FOUND");

  let priceResult: PriceComputation | null = null;
  await db.transaction(async (tx) => {
    await tx.delete(productSuppliers).where(and(eq(productSuppliers.id, psId), eq(productSuppliers.productId, productId)));
    priceResult = await syncProductCost(tx as unknown as NodePgDatabase, productId);
  });

  return { deleted: true, priceResult };
}
