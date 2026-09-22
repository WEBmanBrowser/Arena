/**
 * PAYMENT P0 (M1) — deterministic product lock ordering + locked invariant reads.
 *
 * PROBLEM
 *  The stock writers (order reservation, payment confirmation, reservation
 *  release, RMA/refund paths) each updated `products` in the order the ITEMS
 *  happened to arrive in. Two concurrent transactions touching the same two
 *  products in opposite orders can deadlock, and a deadlock inside the payment
 *  confirmation path is a financial-path failure, not a cosmetic one.
 *
 * SOLUTION
 *  Every writer that touches more than one product row goes through
 *  `lockProductsAscending()`, which acquires the row locks in ascending
 *  `products.id` order (a total order over the resource set → no deadlock
 *  cycle). The same helper performs the read UNDER the lock, so
 *  `stockBefore/stockAfter/reservedBefore/reservedAfter` written to
 *  `stock_movements`, and the amounts used in invariants, are the locked values
 *  rather than a stale pre-lock snapshot.
 *
 * SCOPE
 *  Lock ordering and locked reads only. No behavioural change to the checkout
 *  flow: the reservation path computes exactly the same rows it computed
 *  before, in a canonical order.
 */

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { products, productSuppliers, suppliers } from "@/db/schema";
import { and, asc, eq, inArray } from "drizzle-orm";

/** Minimal structural type accepted from either `db` or a `tx` handle. */
export type DbOrTx = NodePgDatabase | Parameters<Parameters<NodePgDatabase["transaction"]>[0]>[0];

export type ProductRow = typeof products.$inferSelect;

/**
 * Acquire `FOR UPDATE` row locks on every existing product, in ascending id
 * order, and return the locked rows keyed by product id.
 *
 * PostgreSQL locks rows in the order the executor produces them, so pairing
 * `ORDER BY id` with `FOR UPDATE` gives the deterministic acquisition order
 * the whole codebase relies on.
 *
 * Non-existent ids are simply absent from the map — callers keep their existing
 * "product not found" handling.
 */
export async function lockProductsAscending(
  tx: DbOrTx,
  productIds: readonly number[]
): Promise<Map<number, ProductRow>> {
  const unique = [...new Set(productIds.filter((id) => Number.isInteger(id) && id > 0))].sort((a, b) => a - b);
  const locked = new Map<number, ProductRow>();
  if (unique.length === 0) return locked;

  const rows = await tx
    .select()
    .from(products)
    .where(inArray(products.id, unique))
    .orderBy(asc(products.id))
    .for("update");

  for (const row of rows) locked.set(row.id, row);
  return locked;
}

/** Lock and read a single product row (same helper, single-element set). */
export async function lockProduct(tx: DbOrTx, productId: number): Promise<ProductRow | null> {
  const [row] = await tx
    .select()
    .from(products)
    .where(eq(products.id, productId))
    .orderBy(asc(products.id))
    .for("update")
    .limit(1);
  return row ?? null;
}


export type ProductSupplierStockRow = {
  id: number;
  productId: number;
  supplierId: number;
  supplierStock: number | null;
  supplierReservedStock: number;
  leadTimeDays: number | null;
};

/**
 * Bloqueia, em ordem determinística, as associações produto-fornecedor ativas
 * que podem fornecer stock aos produtos indicados.
 *
 * A disponibilidade do fornecedor é sempre:
 * supplierStock - supplierReservedStock
 *
 * `isPreferred` não participa nesta seleção: é uma preferência comercial de
 * custo/preço, não uma preferência de stock.
 */
export async function lockActiveProductSuppliersAscending(
  tx: DbOrTx,
  productIds: readonly number[]
): Promise<Map<number, ProductSupplierStockRow[]>> {
  const unique = [...new Set(productIds.filter((id) => Number.isInteger(id) && id > 0))]
    .sort((a, b) => a - b);

  const byProduct = new Map<number, ProductSupplierStockRow[]>();
  if (unique.length === 0) return byProduct;

  const rows = await tx
    .select({
      id: productSuppliers.id,
      productId: productSuppliers.productId,
      supplierId: productSuppliers.supplierId,
      supplierStock: productSuppliers.supplierStock,
      supplierReservedStock: productSuppliers.supplierReservedStock,
      leadTimeDays: productSuppliers.leadTimeDays,
    })
    .from(productSuppliers)
    .where(and(
      inArray(productSuppliers.productId, unique),
      inArray(
        productSuppliers.supplierId,
        tx.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.isActive, true))
      )
    ))
    .orderBy(asc(productSuppliers.id))
    .for("update");

  for (const row of rows) {
    const list = byProduct.get(row.productId) ?? [];
    list.push(row);
    byProduct.set(row.productId, list);
  }

  return byProduct;
}
