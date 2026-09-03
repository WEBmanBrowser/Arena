/**
 * C.3.1 — Supplier-specific matching.
 *
 * Mandatory order, and it matters: the supplier's own SKU is the strongest
 * claim because it is scoped to the supplier being imported, EAN is global and
 * unambiguous *when present*, and the internal SKU is the last resort.
 *
 *   1. supplier SKU  (product_suppliers.supplier_sku for THIS supplier)
 *   2. EAN           (products.ean)
 *   3. internal SKU  (products.sku)
 *
 * The product name is never a matching key — a supplier renaming a line must
 * not silently retarget a catalogue product.
 *
 * ── Conflict rules ──
 *  - a key resolving to several products            → conflict;
 *  - two levels resolving to different products     → conflict;
 *  - the same key repeated inside the file          → conflict;
 *  - two rows resolving to the same product         → conflict.
 * A conflict row is never applied and never resolved "by preference": silently
 * picking one product is how a supplier list destroys a catalogue. This is also
 * why a duplicated supplier_sku has no UNIQUE index at this stage — the file is
 * allowed to be ambiguous, the import just refuses to guess.
 *
 * Pure module: it consumes an index built by the service, so every rule below
 * is testable without a database.
 */
import type { NormalizedSupplierRow } from "./normalize";

export const MATCH_LEVELS = ["supplier_sku", "ean", "internal_sku"] as const;
export type MatchLevel = (typeof MATCH_LEVELS)[number];
export type MatchType = MatchLevel | "none";

export type SupplierImportRowStatus = "ready" | "new_product" | "conflict" | "error";

/** product ids per key, per level. Several ids = ambiguous key. */
export interface ProductMatchIndex {
  supplierSku: Map<string, number[]>;
  ean: Map<string, number[]>;
  internalSku: Map<string, number[]>;
}

export function emptyMatchIndex(): ProductMatchIndex {
  return { supplierSku: new Map(), ean: new Map(), internalSku: new Map() };
}

function push(map: Map<string, number[]>, key: string | null | undefined, productId: number): void {
  if (!key) return;
  const list = map.get(key);
  if (!list) map.set(key, [productId]);
  else if (!list.includes(productId)) list.push(productId);
}

export interface IndexSeedRow {
  productId: number;
  supplierSku?: string | null;
  ean?: string | null;
  internalSku?: string | null;
}

/** Build the index from whatever the service loaded (chunked key lookups). */
export function buildMatchIndex(rows: IndexSeedRow[]): ProductMatchIndex {
  const index = emptyMatchIndex();
  for (const row of rows) {
    push(index.supplierSku, row.supplierSku, row.productId);
    push(index.ean, row.ean, row.productId);
    push(index.internalSku, row.internalSku, row.productId);
  }
  return index;
}

export interface SupplierImportRowPlan {
  rowNumber: number;
  status: SupplierImportRowStatus;
  /** Which level decided it (`none` for a row that will create a product). */
  matchType: MatchType;
  productId: number | null;
  /** Machine-readable conflict/error codes, in detection order. */
  codes: string[];
  message: string | null;
  /** Levels seen and what each one resolved to — for the preview table. */
  evidence: { level: MatchLevel; key: string; productIds: number[] }[];
}

const LEVEL_FIELD: Record<MatchLevel, keyof NormalizedSupplierRow> = {
  supplier_sku: "supplierSku",
  ean: "ean",
  internal_sku: "internalSku",
};

const AMBIGUOUS_CODE: Record<MatchLevel, string> = {
  supplier_sku: "AMBIGUOUS_SUPPLIER_SKU",
  ean: "AMBIGUOUS_EAN",
  internal_sku: "AMBIGUOUS_INTERNAL_SKU",
};

const DUPLICATE_CODE: Record<MatchLevel, string> = {
  supplier_sku: "DUPLICATE_SUPPLIER_SKU_IN_FILE",
  ean: "DUPLICATE_EAN_IN_FILE",
  internal_sku: "DUPLICATE_INTERNAL_SKU_IN_FILE",
};

function keyOf(row: NormalizedSupplierRow, level: MatchLevel): string | null {
  const value = row[LEVEL_FIELD[level]];
  return typeof value === "string" && value.length ? value : null;
}

const INDEX_KEY: Record<MatchLevel, keyof ProductMatchIndex> = {
  supplier_sku: "supplierSku",
  ean: "ean",
  internal_sku: "internalSku",
};

function indexFor(index: ProductMatchIndex, level: MatchLevel): Map<string, number[]> {
  return index[INDEX_KEY[level]];
}

function messageFrom(issues: { message: string }[]): string {
  return issues.map((i) => i.message).join("; ").slice(0, 500);
}

/**
 * Plan every row: resolve, then flag ambiguity — both inside the catalogue and
 * inside the file itself.
 */
export function planSupplierRows(rows: NormalizedSupplierRow[], index: ProductMatchIndex): SupplierImportRowPlan[] {
  // Cross-row key usage (only rows that are otherwise usable can collide).
  const keyUsage = new Map<string, number>();
  for (const row of rows) {
    if (row.issues.some((i) => i.severity === "error")) continue;
    for (const level of MATCH_LEVELS) {
      const key = keyOf(row, level);
      if (!key) continue;
      const composite = `${level}\u0000${key}`;
      keyUsage.set(composite, (keyUsage.get(composite) ?? 0) + 1);
    }
  }

  const provisional = rows.map((row) => resolveRow(row, index, keyUsage));

  // Two rows pointing at the same product is the same class of ambiguity.
  const targetUsage = new Map<number, number>();
  for (const plan of provisional) {
    if (plan.status !== "ready" || plan.productId === null) continue;
    targetUsage.set(plan.productId, (targetUsage.get(plan.productId) ?? 0) + 1);
  }

  return provisional.map((plan) => {
    const dupTarget = plan.status === "ready" && plan.productId !== null ? targetUsage.get(plan.productId) ?? 0 : 0;
    if (dupTarget <= 1) return plan;
    return {
      ...plan,
      status: "conflict" as SupplierImportRowStatus,
      codes: [...plan.codes, "DUPLICATE_TARGET"],
      message: `Várias linhas do ficheiro apontam para o mesmo produto #${plan.productId} — ambiguidade não é resolvida silenciosamente`.slice(0, 500),
    };
  });
}

function resolveRow(
  row: NormalizedSupplierRow,
  index: ProductMatchIndex,
  keyUsage: Map<string, number>
): SupplierImportRowPlan {
  const base: SupplierImportRowPlan = {
    rowNumber: row.rowNumber,
    status: "error",
    matchType: "none",
    productId: null,
    codes: [],
    message: null,
    evidence: [],
  };

  // Row-level format errors win: nothing is matched, nothing is written.
  const errors = row.issues.filter((i) => i.severity === "error");
  if (errors.length) {
    return { ...base, codes: errors.map((e) => e.code), message: messageFrom(errors) };
  }

  const evidence: { level: MatchLevel; key: string; productIds: number[] }[] = [];
  const codes: string[] = [];
  const matches: { level: MatchLevel; productId: number }[] = [];

  for (const level of MATCH_LEVELS) {
    const key = keyOf(row, level);
    if (!key) continue;
    if ((keyUsage.get(`${level}\u0000${key}`) ?? 0) > 1) {
      codes.push(DUPLICATE_CODE[level]);
    }
    const productIds = indexFor(index, level).get(key) ?? [];
    evidence.push({ level, key, productIds });
    if (productIds.length > 1) {
      codes.push(AMBIGUOUS_CODE[level]);
      continue;
    }
    if (productIds.length === 1) matches.push({ level, productId: productIds[0] });
  }

  const distinctTargets = [...new Set(matches.map((m) => m.productId))];
  if (distinctTargets.length > 1) {
    codes.push("MATCH_MISMATCH");
  }

  if (codes.length) {
    const detail = distinctTargets.length > 1
      ? ` — os níveis resolvem produtos diferentes (${matches.map((m) => `${m.level}→#${m.productId}`).join(", ")})`
      : evidence.filter((e) => e.productIds.length > 1).map((e) => `${e.level} ${e.key} resolve ${e.productIds.length} produtos`).join("; ");
    const label = codes[0].startsWith("DUPLICATE") ? "Chave repetida no mesmo ficheiro" : "Correspondência ambígua";
    return {
      ...base,
      status: "conflict",
      codes,
      message: `${label}${detail ? `: ${detail}` : ""} — a linha não é aplicada`.slice(0, 500),
      evidence,
    };
  }

  if (distinctTargets.length === 1) {
    return {
      ...base,
      status: "ready",
      matchType: matches[0].level,
      productId: distinctTargets[0],
      codes: [],
      message: warningsOf(row),
      evidence,
    };
  }

  // Nothing matched: a new product is only possible with a stable code of our
  // own (supplier SKU or internal SKU). An EAN alone is never enough — the
  // catalogue key would be invented from a barcode.
  if (!row.supplierSku && !row.internalSku) {
    return {
      ...base,
      codes: ["NO_CREATION_KEY"],
      message: "Sem correspondência e sem SKU do fornecedor/interno para criar o produto",
      evidence,
    };
  }

  return {
    ...base,
    status: "new_product",
    matchType: "none",
    productId: null,
    codes: [],
    message: warningsOf(row),
    evidence,
  };
}

/** Warnings are surfaced in the row message but never block the apply. */
function warningsOf(row: NormalizedSupplierRow): string | null {
  const warnings = row.issues.filter((i) => i.severity === "warning");
  return warnings.length ? messageFrom(warnings) : null;
}

export interface PlanSummary {
  total: number;
  ready: number;
  newProducts: number;
  conflicts: number;
  errors: number;
  matchedBy: Record<MatchType, number>;
  withCost: number;
  withStock: number;
}

export function summarizePlan(rows: NormalizedSupplierRow[], plans: SupplierImportRowPlan[]): PlanSummary {
  const summary: PlanSummary = {
    total: plans.length, ready: 0, newProducts: 0, conflicts: 0, errors: 0,
    matchedBy: { supplier_sku: 0, ean: 0, internal_sku: 0, none: 0 },
    withCost: 0, withStock: 0,
  };
  plans.forEach((plan, i) => {
    if (plan.status === "ready") summary.ready += 1;
    else if (plan.status === "new_product") summary.newProducts += 1;
    else if (plan.status === "conflict") summary.conflicts += 1;
    else summary.errors += 1;
    summary.matchedBy[plan.matchType] += 1;
    if (rows[i]?.costPrice) summary.withCost += 1;
    if (rows[i]?.stock !== null && rows[i]?.stock !== undefined) summary.withStock += 1;
  });
  return summary;
}
