import { productSuppliers, suppliers } from "@/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DbOrTx } from "@/lib/stock-locks";

export async function getSupplierAvailabilityByProductIds(
  db: DbOrTx,
  productIds: readonly number[]
): Promise<Map<number, number>> {
  const ids = [...new Set(productIds.filter((id) => Number.isInteger(id) && id > 0))];
  const result = new Map<number, number>();
  if (ids.length === 0) return result;

  const rows = await db
    .select({
      productId: productSuppliers.productId,
      available: sql<number>`sum(greatest(coalesce(${productSuppliers.supplierStock}, 0) - ${productSuppliers.supplierReservedStock}, 0))::int`,
    })
    .from(productSuppliers)
    .innerJoin(suppliers, eq(productSuppliers.supplierId, suppliers.id))
    .where(and(inArray(productSuppliers.productId, ids), eq(suppliers.isActive, true)))
    .groupBy(productSuppliers.productId);

  for (const row of rows) result.set(row.productId, Number(row.available || 0));
  return result;
}
