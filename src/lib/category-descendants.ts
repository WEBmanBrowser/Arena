/**
 * Shared helper for resolving category + all descendants.
 * Uses PostgreSQL recursive CTE with UNION (not UNION ALL) for cycle safety.
 * UNION deduplicates rows, so if data contains a cycle, it terminates naturally.
 * Used by BOTH /api/products AND tests — single source of truth.
 */
import { db } from "@/db";
import { sql } from "drizzle-orm";

/**
 * Get a category ID and ALL its descendant IDs at arbitrary depth.
 * Returns array including the root categoryId itself.
 * Cycle-safe: PostgreSQL UNION prevents infinite recursion even with corrupted data.
 */
export async function getCategoryAndDescendantIds(categoryId: number): Promise<number[]> {
  const result = await db.execute(sql`
    WITH RECURSIVE cat_tree AS (
      SELECT id FROM categories WHERE id = ${categoryId}
      UNION
      SELECT c.id FROM categories c INNER JOIN cat_tree ct ON c.parent_id = ct.id
    )
    SELECT id FROM cat_tree
  `);
  return (result.rows as Array<{ id: number }>).map(r => r.id);
}
