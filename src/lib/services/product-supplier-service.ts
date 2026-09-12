/**
 * Product supplier service â€” extracted from route for testability.
 */
import { db } from "@/db";
import { productSuppliers, products } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { recalculateProductPrice, type PriceComputation, type ProductPricingContext, type loadPricingContext } from "@/lib/services/pricing-engine-service";

/**
 * Sync the product cost from its preferred supplier and recalculate the
 * selling price in the same transaction (C.1). Removing the preferred
 * supplier clears the cost, which the engine reports as "no cost" rather than
 * pricing the product at zero.
 *
 * Exported because it is the single authoritative path from "a supplier cost
 * changed" to "the catalogue's cost and automatic price are up to date" â€” the
 * product UI, the legacy importer and the C.3.1 supplier import all go through
 * it, which is what keeps price_mode manual protected in one place only.
 */
export async function syncProductCost(
  txDb: NodePgDatabase,
  productId: number,
  pricingContext?: Awaited<ReturnType<typeof loadPricingContext>>,
  hints: {
    preferredCost?: string | null;
    productSnapshot?: ProductPricingContext;
    preferredSupplierId?: number | null;
  } = {}
): Promise<PriceComputation | null> {
  let preferredCost: string | null;
  if ("preferredCost" in hints) {
    preferredCost = hints.preferredCost ?? null;
  } else {
    const [preferred] = await txDb
      .select({ costPrice: productSuppliers.costPrice })
      .from(productSuppliers)
      .where(and(eq(productSuppliers.productId, productId), eq(productSuppliers.isPreferred, true)))
      .limit(1);
    preferredCost = preferred ? preferred.costPrice : null;
  }

  let productSnapshot = hints.productSnapshot
    ? { ...hints.productSnapshot, costPrice: preferredCost }
    : undefined;

  // persist:false means the pricing engine must see the new preferred cost
  // through its snapshot; otherwise it could price from the old DB cost.
  if (!productSnapshot) {
    const [currentProduct] = await txDb
      .select({
        id: products.id,
        price: products.price,
        costPrice: products.costPrice,
        vatRate: products.vatRate,
        categoryId: products.categoryId,
        brandId: products.brandId,
        priceMode: products.priceMode,
      })
      .from(products)
      .where(eq(products.id, productId))
      .limit(1);

    if (currentProduct) {
      productSnapshot = { ...currentProduct, costPrice: preferredCost };
    }
  }

  const result = await recalculateProductPrice(productId, {
    database: txDb,
    pricingContext,
    ...(productSnapshot ? { productSnapshot } : {}),
    ...("preferredSupplierId" in hints
      ? { preferredSupplierId: hints.preferredSupplierId ?? null }
      : {}),
    persist: false,
  });

  const now = new Date();

  if (result.priced && result.changed && result.newPrice) {
    await txDb
      .update(products)
      .set({
        costPrice: preferredCost,
        price: result.newPrice,
        priceRuleId: result.rule?.rule.id ?? null,
        priceCalculatedAt: now,
        updatedAt: now,
      })
      .where(eq(products.id, productId));
  } else if (result.priced) {
    await txDb
      .update(products)
      .set({
        costPrice: preferredCost,
        priceRuleId: result.rule?.rule.id ?? null,
        priceCalculatedAt: now,
        updatedAt: now,
      })
      .where(eq(products.id, productId));
  } else {
    await txDb
      .update(products)
      .set({
        costPrice: preferredCost,
        updatedAt: now,
      })
      .where(eq(products.id, productId));
  }

  return result;
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
