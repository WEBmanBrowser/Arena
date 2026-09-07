/**
 * C.3.4.2 — Deep link to the review of ONE persisted supplier import.
 *
 * Dependency-free on purpose: it is imported by client components
 * (SupplierSourcesPanel, SupplierImportPanel) and by the /admin/import page,
 * so it must not pull server-only modules.
 *
 * The URL carries ONLY the import id. The signed apply token is never part of
 * a link: the page asks GET /api/admin/supplier-import/{id}/preview for a fresh
 * one, and only after the operator has the snapshot in front of them.
 */

/** Query parameter /admin/import reads to reopen a persisted preview. */
export const IMPORT_REVIEW_QUERY_PARAM = "open";

/** `/admin/import?open=<id>` — where a persisted preview is reviewed and applied. */
export function supplierImportReviewHref(importId: number): string {
  if (!Number.isInteger(importId) || importId < 1) {
    throw new RangeError("supplierImportReviewHref: importId must be a positive integer");
  }
  return `/admin/import?${IMPORT_REVIEW_QUERY_PARAM}=${importId}`;
}

/**
 * The import id a review URL points at, or null when the parameter is absent
 * or not a positive integer (a garbage value must not become a fetch).
 */
export function parseSupplierImportReviewParam(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) return null;
  const id = Number(trimmed);
  return Number.isSafeInteger(id) ? id : null;
}
