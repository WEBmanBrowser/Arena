/**
 * C.3.1 — Supplier import engine.
 *
 * Official pipeline (C.3.2 will hang XML/feed sources off the same
 * NormalizedSupplierRow, so there must be exactly one of these):
 *
 *   CSV → NormalizedSupplierRow → matching → preview persistido → apply em batches
 *
 * ── Why the preview is persisted ──
 * Preview writes supplier_imports + supplier_import_rows and returns a signed
 * token. Apply reads the SNAPSHOT BACK FROM THE DATABASE: cost, stock and price
 * are never accepted from the browser again. Truncating the preview response
 * therefore never truncates the work.
 *
 * ── Why apply is idempotent ──
 * Every batch runs in ONE transaction that (a) claims pending rows with an
 * atomic `UPDATE … WHERE applied = false … RETURNING` and (b) performs all the
 * effects of those rows. A committed line can never fire twice — no second
 * product, no second cost write, no second stock movement — because a re-run
 * finds nothing to claim. A crash rolls the claim back together with the
 * effects, so the rows become pending again and resume continues where it
 * stopped.
 *
 * ── Liveness ──
 * `heartbeat_at` (never started_at) decides abandonment, through the single
 * IMPORT_HEARTBEAT_TTL_MS constant: refreshed on claim and after every
 * committed batch. Reclaim is a conditional UPDATE, so with two workers exactly
 * one wins and a fresh heartbeat cannot be stolen.
 *
 * ── Price ownership (absolute) ──
 * A supplier list never writes products.price directly. The only writer is the
 * C.1/C.2 engine, reached through syncProductCost / recalculateProductPrice,
 * which refuse manual products themselves — so the protection lives in one
 * place and formulas are never duplicated here.
 */
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  productSuppliers,
  products,
  stockMovements,
  suppliers,
  supplierImportRows,
  supplierImports,
} from "@/db/schema";
import { syncProductCost } from "@/lib/services/product-supplier-service";
import { computeAutomaticPrice, loadPricingContext } from "@/lib/services/pricing-engine-service";
import { createAuditLog } from "@/lib/audit";
import { slugify } from "@/lib/utils";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  IMPORT_HEARTBEAT_TTL_MS,
  MDTECH_SKU_ALLOC_ATTEMPTS,
  MDTECH_SKU_DIGITS,
  MDTECH_SKU_PREFIX,
  MDTECH_SKU_SEQUENCE,
  SUPPLIER_IMPORT_BATCH_SIZE,
  SUPPLIER_IMPORT_KEY_CHUNK,
  SUPPLIER_IMPORT_MISSING_LIMIT,
  SUPPLIER_IMPORT_PREVIEW_LIMIT,
} from "@/lib/supplier-import/constants";
import {
  parseSupplierCsv,
  sha256Hex,
  byteLengthUtf8,
  type NormalizedSupplierRow,
  type SupplierImportIssue,
} from "@/lib/supplier-import/normalize";
import {
  planSupplierRows,
  summarizePlan,
  buildMatchIndex,
  type ProductMatchIndex,
  type SupplierImportRowPlan,
} from "@/lib/supplier-import/match";
import {
  createSupplierImportToken,
  tokenMatchesImport,
  verifySupplierImportToken,
} from "@/lib/supplier-import/token";
import {
  classifyImportStorageFailure,
  supplierImportErrorMessage,
} from "@/lib/supplier-import/error-messages";

/** Error carrying the code the API surfaces. */
export class SupplierImportError extends Error {
  constructor(readonly code: string, readonly httpStatus = 400, readonly detail?: string) {
    super(code);
    this.name = "SupplierImportError";
  }
}

function rowsOf<T = Record<string, any>>(result: unknown): T[] {
  const r = result as { rows?: T[] } | T[];
  return Array.isArray(r) ? r : (r.rows ?? []);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Postgres-side staleness test — the browser never computes this. */
function staleHeartbeatCondition() {
  return sql`(
    ${supplierImports.heartbeatAt} IS NULL
    OR ${supplierImports.heartbeatAt} < now() - make_interval(secs => ${IMPORT_HEARTBEAT_TTL_MS / 1000})
  )`;
}

// ─── Matching index ──────────────────────────────────────

interface IndexSeed {
  productId: number;
  supplierSku?: string | null;
  ean?: string | null;
  internalSku?: string | null;
}

/**
 * Load only the catalogue keys this file actually contains: a 10 000-line
 * supplier list must not cost 10 000 queries, nor a full catalogue scan. Level 1
 * is filtered by supplier on purpose — a supplier's own SKU only means
 * something inside that supplier.
 */
async function buildIndexForRows(rows: NormalizedSupplierRow[], supplierId: number): Promise<ProductMatchIndex> {
  const supplierSkus = [...new Set(rows.map((r) => r.supplierSku).filter((v): v is string => !!v))];
  const eans = [...new Set(rows.map((r) => r.ean).filter((v): v is string => !!v))];
  const internalSkus = [...new Set(rows.map((r) => r.internalSku).filter((v): v is string => !!v))];

  const seeds: IndexSeed[] = [];

  for (const group of chunk(supplierSkus, SUPPLIER_IMPORT_KEY_CHUNK)) {
    const found = await db.select({ productId: productSuppliers.productId, supplierSku: productSuppliers.supplierSku })
      .from(productSuppliers)
      .where(and(eq(productSuppliers.supplierId, supplierId), inArray(productSuppliers.supplierSku, group)));
    for (const f of found) seeds.push({ productId: f.productId, supplierSku: f.supplierSku });
  }
  for (const group of chunk(eans, SUPPLIER_IMPORT_KEY_CHUNK)) {
    const found = await db.select({ id: products.id, ean: products.ean }).from(products).where(inArray(products.ean, group));
    for (const f of found) seeds.push({ productId: f.id, ean: f.ean });
  }
  for (const group of chunk(internalSkus, SUPPLIER_IMPORT_KEY_CHUNK)) {
    const found = await db.select({ id: products.id, sku: products.sku }).from(products).where(inArray(products.sku, group));
    for (const f of found) seeds.push({ productId: f.id, internalSku: f.sku });
  }

  // Merge seeds describing the same product so the index sees complete rows.
  const merged = new Map<number, IndexSeed>();
  for (const seed of seeds) {
    const current = merged.get(seed.productId) ?? { productId: seed.productId };
    merged.set(seed.productId, {
      productId: seed.productId,
      supplierSku: seed.supplierSku ?? current.supplierSku,
      ean: seed.ean ?? current.ean,
      internalSku: seed.internalSku ?? current.internalSku,
    });
  }
  return buildMatchIndex([...merged.values()]);
}

/**
 * Products whose internal SKU (`products.sku`) equals a code the supplier's file
 * uses for itself.
 *
 * These are never matches: level 3 only ever consumes the `internalSku` column
 * the operator mapped explicitly. The collision is reported in the preview so a
 * new product is created knowingly instead of a supplier's code quietly becoming
 * MDTech's global reference.
 */
async function findInternalSkuOwners(supplierSkus: (string | null)[]): Promise<Map<string, number>> {
  const owners = new Map<string, number>();
  const keys = [...new Set(supplierSkus.filter((v): v is string => !!v))];
  for (const group of chunk(keys, SUPPLIER_IMPORT_KEY_CHUNK)) {
    const found = await db.select({ sku: products.sku, productId: products.id })
      .from(products).where(inArray(products.sku, group));
    for (const f of found) if (f.sku) owners.set(f.sku, f.productId);
  }
  return owners;
}

// ─── Preview types ───────────────────────────────────────

export interface SupplierImportPreviewLine {
  rowNumber: number;
  supplierSku: string | null;
  ean: string | null;
  internalSku: string | null;
  name: string | null;
  status: SupplierImportRowPlan["status"];
  matchType: SupplierImportRowPlan["matchType"];
  codes: string[];
  message: string | null;
  issues: SupplierImportIssue[];
  costPrice: string | null;
  costBefore: string | null;
  stock: number | null;
  stockBefore: number | null;
  reservedStock: number | null;
  leadTimeDays: number | null;
  productId: number | null;
  productSku: string | null;
  productName: string | null;
  currentPrice: string | null;
  computedPrice: string | null;
  priceMode: "auto" | "manual" | null;
  priceMessage: string | null;
  isPreferredSupplier: boolean;
}

export interface MissingProductsReport {
  /** Deliberately: this phase never deletes, deactivates or restocks. */
  action: "none";
  comparedToImportId: number | null;
  comparedToFinishedAt: string | null;
  count: number;
  /** Lines that are not evidence of anything (missing or repeated key). */
  ambiguous: number;
  skippedReason: string | null;
  items: { supplierSku: string; productId: number; name: string | null }[];
}

export interface SupplierImportPreview {
  importId: number;
  supplierId: number;
  supplierName: string;
  fileName: string;
  fileHash: string;
  fileSizeBytes: number;
  delimiter: string;
  headers: string[];
  mapping: Record<string, string>;
  ignoredColumns: string[];
  status: string;
  summary: Record<string, unknown>;
  lines: SupplierImportPreviewLine[];
  truncated: boolean;
  missingProducts: MissingProductsReport;
  previewToken: string;
  batchesTotal: number;
  batchSize: number;
}

// ─── Missing products (detection only) ───────────────────

/**
 * Compare ONLY with the last COMPLETED import of the SAME supplier, keyed on
 * supplierSku. A line whose supplier SKU is absent or repeated in that import
 * proves nothing, so it is never reported as disappeared. Reporting is the
 * whole of the behaviour at this phase.
 */
async function detectMissingProducts(
  supplierId: number,
  rows: { supplierSku: string | null }[]
): Promise<MissingProductsReport> {
  const empty: MissingProductsReport = {
    action: "none", comparedToImportId: null, comparedToFinishedAt: null,
    count: 0, ambiguous: 0, skippedReason: null, items: [],
  };
  if (!rows.some((r) => r.supplierSku)) return { ...empty, skippedReason: "NO_SUPPLIER_SKU_IN_FILE" };

  const [previous] = await db
    .select({ id: supplierImports.id, finishedAt: supplierImports.finishedAt })
    .from(supplierImports)
    .where(and(eq(supplierImports.supplierId, supplierId), eq(supplierImports.status, "completed")))
    .orderBy(desc(supplierImports.finishedAt), desc(supplierImports.id))
    .limit(1);
  if (!previous) return { ...empty, skippedReason: "NO_PREVIOUS_COMPLETED_IMPORT" };

  // Every key present in the new file counts as seen — including rows that ended
  // in conflict or error. A duplicated reference still proves the supplier lists
  // the article, so it must never be reported as a disappearance: ambiguity is
  // reported as ambiguity, "gone" is reserved for keys that are really absent.
  const seenHere = new Set(rows.map((r) => r.supplierSku).filter((v): v is string => !!v));

  const before = await db
    .select({ supplierSku: supplierImportRows.supplierSku, productId: supplierImportRows.productId, name: supplierImportRows.name })
    .from(supplierImportRows)
    .where(and(eq(supplierImportRows.importId, previous.id), eq(supplierImportRows.applied, true)));

  const occurrences = new Map<string, number>();
  for (const row of before) {
    if (!row.supplierSku) continue;
    occurrences.set(row.supplierSku, (occurrences.get(row.supplierSku) ?? 0) + 1);
  }

  const items: MissingProductsReport["items"] = [];
  let ambiguous = 0;
  const seenMissing = new Set<number>();
  for (const row of before) {
    const key = row.supplierSku;
    // Absent key, repeated key, or no product behind it → not evidence.
    if (!key || (occurrences.get(key) ?? 0) > 1 || row.productId === null) { ambiguous += 1; continue; }
    if (seenHere.has(key)) continue;
    if (seenMissing.has(row.productId)) continue;
    seenMissing.add(row.productId);
    items.push({ supplierSku: key, productId: row.productId, name: row.name });
  }

  return {
    action: "none",
    comparedToImportId: previous.id,
    comparedToFinishedAt: previous.finishedAt ? previous.finishedAt.toISOString() : null,
    count: items.length,
    ambiguous,
    skippedReason: null,
    items: items.slice(0, SUPPLIER_IMPORT_MISSING_LIMIT),
  };
}

// ─── Preview ─────────────────────────────────────────────

export interface PreviewInput {
  supplierId: number;
  fileName: string;
  csvText: string;
  mapping?: Record<string, string>;
  userId: number;
}

interface ProductInfo {
  id: number; name: string; sku: string | null; ean: string | null; price: string;
  costPrice: string | null; vatRate: string; stock: number; reservedStock: number;
  priceMode: string; categoryId: number | null; brandId: number | null;
}

/**
 * Parse + match + persist the snapshot.
 * Writes ONLY supplier_imports and supplier_import_rows — never products,
 * product_suppliers, prices or stock.
 */
export async function previewSupplierImport(input: PreviewInput): Promise<SupplierImportPreview> {
  const [supplier] = await db
    .select({ id: suppliers.id, name: suppliers.name, isActive: suppliers.isActive })
    .from(suppliers).where(eq(suppliers.id, input.supplierId)).limit(1);
  if (!supplier) throw new SupplierImportError("SUPPLIER_NOT_FOUND", 404);
  if (!supplier.isActive) throw new SupplierImportError("SUPPLIER_INACTIVE", 400);

  const parsed = parseSupplierCsv(input.csvText, input.mapping);
  const fileHash = sha256Hex(input.csvText);
  const fileSizeBytes = byteLengthUtf8(input.csvText);

  const index = await buildIndexForRows(parsed.rows, supplier.id);
  const plans = planSupplierRows(parsed.rows, index);
  const skuOwners = await findInternalSkuOwners(parsed.rows.map((r) => r.supplierSku));

  const matchedIds = [...new Set(plans.filter((p) => p.productId !== null).map((p) => p.productId as number))];
  const productInfo = new Map<number, ProductInfo>();
  const preferredByProduct = new Map<number, number>();
  const linkCost = new Map<number, string | null>();

  if (matchedIds.length) {
    for (const group of chunk(matchedIds, SUPPLIER_IMPORT_KEY_CHUNK)) {
      const found = await db.select({
        id: products.id, name: products.name, sku: products.sku, ean: products.ean, price: products.price,
        costPrice: products.costPrice, vatRate: products.vatRate, stock: products.stock,
        reservedStock: products.reservedStock, priceMode: products.priceMode,
        categoryId: products.categoryId, brandId: products.brandId,
      }).from(products).where(inArray(products.id, group));
      for (const p of found) productInfo.set(p.id, p);
    }
    const links = await db.select({
      productId: productSuppliers.productId, supplierId: productSuppliers.supplierId,
      isPreferred: productSuppliers.isPreferred, costPrice: productSuppliers.costPrice,
    }).from(productSuppliers).where(inArray(productSuppliers.productId, matchedIds));
    for (const link of links) {
      if (link.isPreferred) preferredByProduct.set(link.productId, link.supplierId);
      if (link.supplierId === supplier.id) linkCost.set(link.productId, link.costPrice);
    }
  }

  const pricing = await loadPricingContext();
  const lines: SupplierImportPreviewLine[] = [];

  parsed.rows.forEach((row, i) => {
    const plan = plans[i];
    const product = plan.productId !== null ? productInfo.get(plan.productId) : undefined;
    const isPreferred = product ? preferredByProduct.get(product.id) === supplier.id : false;

    // A supplier's code that happens to equal another product's internal SKU is
    // reported, never used as a match: the two references are separate concepts.
    const skuClash = plan.status === "new_product" && row.supplierSku
      ? skuOwners.get(row.supplierSku) ?? null
      : null;
    const clashIssue: SupplierImportIssue | null = skuClash !== null && row.supplierSku
      ? {
          field: "supplierSku",
          value: row.supplierSku,
          code: "SUPPLIER_SKU_IS_FOREIGN_INTERNAL_SKU",
          message: `O código do fornecedor "${row.supplierSku}" já é o SKU interno do produto #${skuClash}; não é usado para o identificar — será criado um produto novo com SKU interno próprio`,
          severity: "warning",
        }
      : null;

    // The cost the engine would see after this import. A non-preferred
    // supplier's cost never becomes authoritative for products.costPrice.
    const effectiveCost = row.costPrice === null
      ? product?.costPrice ?? null
      : isPreferred || !product ? row.costPrice : product.costPrice;

    let computedPrice: string | null = null;
    let priceMessage: string | null = null;
    if (product) {
      const computation = computeAutomaticPrice(
        {
          id: product.id, price: product.price, costPrice: effectiveCost, vatRate: product.vatRate,
          categoryId: product.categoryId, brandId: product.brandId, priceMode: product.priceMode,
        },
        preferredByProduct.get(product.id) ?? null,
        pricing.rules, pricing.categoryTree, pricing.policy
      );
      computedPrice = computation.priced ? computation.newPrice ?? null : null;
      priceMessage = computation.priced ? null : computation.message ?? null;
    } else if (row.costPrice && plan.status === "new_product") {
      // A line that will create a product is previewed exactly as the apply
      // will produce it: cost from the file, price from the engine only.
      const computation = computeAutomaticPrice(
        {
          id: 0, price: "0.00", costPrice: row.costPrice, vatRate: "23.00",
          categoryId: null, brandId: null, priceMode: "auto",
        },
        supplier.id, pricing.rules, pricing.categoryTree, pricing.policy
      );
      computedPrice = computation.priced ? computation.newPrice ?? null : null;
      priceMessage = computation.priced ? null : computation.message ?? null;
    }

    lines.push({
      rowNumber: row.rowNumber,
      supplierSku: row.supplierSku,
      ean: row.ean,
      internalSku: row.internalSku,
      name: row.name,
      status: plan.status,
      matchType: plan.matchType,
      codes: plan.codes,
      message: [clashIssue?.message, plan.message, priceMessage].filter(Boolean).join(" · ") || null,
      issues: clashIssue ? [...row.issues, clashIssue] : row.issues,
      costPrice: row.costPrice,
      costBefore: product ? linkCost.get(product.id) ?? null : null,
      stock: row.stock,
      stockBefore: product?.stock ?? null,
      reservedStock: product?.reservedStock ?? null,
      leadTimeDays: row.leadTimeDays,
      productId: plan.productId,
      productSku: product?.sku ?? null,
      productName: product?.name ?? null,
      currentPrice: product?.price ?? null,
      computedPrice,
      priceMode: product ? (product.priceMode as "auto" | "manual") : plan.status === "new_product" ? "auto" : null,
      priceMessage,
      isPreferredSupplier: isPreferred,
    });
  });

  const planSummary = summarizePlan(parsed.rows, plans);
  const actionable = planSummary.ready + planSummary.newProducts;
  const batchesTotal = Math.ceil(actionable / SUPPLIER_IMPORT_BATCH_SIZE);
  const missing = await detectMissingProducts(supplier.id, lines);

  // ── The snapshot is persisted atomically ──
  // Header and rows commit together or not at all: a preview that died halfway
  // must not leave a `preview` import whose rows are a subset of the file,
  // because that subset is exactly what apply would otherwise consume.
  const importRow = await db.transaction(async (tx) => {
    const [created] = await tx.insert(supplierImports).values({
      supplierId: supplier.id,
      fileName: input.fileName.slice(0, 255),
      fileHash,
      fileSizeBytes,
      rowCount: parsed.rows.length,
      status: "preview",
      mapping: parsed.mapping,
      summary: { ...planSummary, actionable, batchesTotal, ignoredColumns: parsed.ignoredColumns, missingProducts: missing },
      batchesTotal,
      batchesDone: 0,
      userId: input.userId,
    }).returning();

    for (const group of chunk(lines, SUPPLIER_IMPORT_BATCH_SIZE)) {
      await tx.insert(supplierImportRows).values(group.map((line) => ({
        importId: created.id,
        rowNumber: line.rowNumber,
        supplierSku: line.supplierSku,
        ean: line.ean,
        internalSku: line.internalSku,
        name: line.name,
        productId: line.productId,
        matchType: line.matchType,
        status: line.status,
        costPrice: line.costPrice,
        stock: line.stock,
        leadTimeDays: line.leadTimeDays,
        message: line.message ? line.message.slice(0, 500) : null,
        currentPrice: line.currentPrice,
        computedPrice: line.computedPrice,
        priceMode: line.priceMode,
        // price_message is varchar(255): a message longer than the column must
        // not sink the preview INSERT the way an out-of-range value used to.
        priceMessage: line.priceMessage ? line.priceMessage.slice(0, 255) : null,
        isPreferredSupplier: line.isPreferredSupplier,
      })));
    }
    return created;
  });

  await createAuditLog({
    userId: input.userId,
    action: "supplier_import.previewed",
    entity: "supplier_import",
    entityId: importRow.id,
    details: {
      supplierId: supplier.id, fileName: importRow.fileName, rowCount: parsed.rows.length,
      ready: planSummary.ready, newProducts: planSummary.newProducts,
      conflicts: planSummary.conflicts, errors: planSummary.errors,
    },
  });

  return {
    importId: importRow.id,
    supplierId: supplier.id,
    supplierName: supplier.name,
    fileName: importRow.fileName,
    fileHash,
    fileSizeBytes,
    delimiter: parsed.delimiter,
    headers: parsed.headers,
    mapping: parsed.mapping,
    ignoredColumns: parsed.ignoredColumns,
    status: importRow.status,
    summary: (importRow.summary as Record<string, unknown>) ?? {},
    lines: lines.slice(0, SUPPLIER_IMPORT_PREVIEW_LIMIT),
    truncated: lines.length > SUPPLIER_IMPORT_PREVIEW_LIMIT,
    missingProducts: missing,
    previewToken: createSupplierImportToken({
      importId: importRow.id, supplierId: supplier.id, fileHash, rowCount: parsed.rows.length,
    }),
    batchesTotal,
    batchSize: SUPPLIER_IMPORT_BATCH_SIZE,
  };
}

// ─── Apply ───────────────────────────────────────────────

interface ImportSnapshot {
  id: number;
  supplierId: number;
  fileHash: string;
  rowCount: number;
  status: string;
  fileName: string;
  batchesTotal: number;
  batchesDone: number;
}

async function loadImport(importId: number): Promise<ImportSnapshot | null> {
  const [row] = await db.select().from(supplierImports).where(eq(supplierImports.id, importId)).limit(1);
  if (!row) return null;
  return {
    id: row.id, supplierId: row.supplierId, fileHash: row.fileHash, rowCount: row.rowCount,
    status: row.status, fileName: row.fileName, batchesTotal: row.batchesTotal, batchesDone: row.batchesDone,
  };
}

/**
 * Atomically take ownership of an import.
 *
 * First apply: from `preview` only, and only with a token matching the snapshot.
 * Resume: from `partial`, or from an `applying` whose heartbeat is stale — a
 * running import cannot be stolen, and two racing reclaimers cannot both win
 * because the loser re-reads the updated row version.
 */
async function claimImport(importId: number, mode: "first" | "resume"): Promise<boolean> {
  const predicate = mode === "first"
    ? sql`${supplierImports.status} = 'preview'`
    : sql`(${supplierImports.status} = 'partial' OR (${supplierImports.status} = 'applying' AND ${staleHeartbeatCondition()}))`;

  const result = await db.execute(sql`
    UPDATE ${supplierImports}
       SET status = 'applying',
           started_at = COALESCE(${supplierImports.startedAt}, now()),
           heartbeat_at = now()
     WHERE ${predicate} AND ${supplierImports.id} = ${importId}
    RETURNING id
  `);
  return rowsOf(result).length > 0;
}

/** A row of the persisted snapshot, as RETURNING gives it back (snake_case). */
interface ClaimedRow {
  id: number;
  row_number: number;
  status: string;
  product_id: number | null;
  cost_price: string | null;
  stock: number | null;
  lead_time_days: number | null;
  supplier_sku: string | null;
  internal_sku: string | null;
  ean: string | null;
  name: string | null;
}

interface ApplyContext {
  importId: number;
  supplierId: number;
  supplierName: string;
  userId: number;
}

type RowEffect = "created" | "updated" | "repriced" | "skipped";

async function markRow(tx: NodePgDatabase, rowId: number, status: string, message: string): Promise<void> {
  await tx.update(supplierImportRows).set({ status, message: message.slice(0, 500) }).where(eq(supplierImportRows.id, rowId));
}

/**
 * Re-resolve a `new_product` row at apply time, in the same level order as the
 * preview. If a product appeared for one of its keys between preview and apply
 * the row is applied against that product instead of duplicating it; if the
 * levels disagree, it stays unapplied. Silence is not an option either way.
 */
async function resolveAtApply(
  tx: NodePgDatabase,
  row: ClaimedRow,
  context: ApplyContext
): Promise<{ productId: number | null; ambiguous: boolean }> {
  const bySupplierSku: number[] = [];
  if (row.supplier_sku) {
    const links = await tx.select({ productId: productSuppliers.productId }).from(productSuppliers)
      .where(and(eq(productSuppliers.supplierId, context.supplierId), eq(productSuppliers.supplierSku, row.supplier_sku)));
    bySupplierSku.push(...new Set(links.map((l) => l.productId)));
  }
  const byEan: number[] = [];
  if (row.ean) {
    const found = await tx.select({ id: products.id }).from(products).where(eq(products.ean, row.ean));
    byEan.push(...found.map((p) => p.id));
  }
  const byInternalSku: number[] = [];
  if (row.internal_sku) {
    const found = await tx.select({ id: products.id }).from(products).where(eq(products.sku, row.internal_sku));
    byInternalSku.push(...found.map((p) => p.id));
  }

  const resolved = [
    bySupplierSku.length === 1 ? bySupplierSku[0] : null,
    byEan.length === 1 ? byEan[0] : null,
    byInternalSku.length === 1 ? byInternalSku[0] : null,
  ].filter((v): v is number => v !== null);
  const ambiguous = bySupplierSku.length > 1 || byEan.length > 1 || byInternalSku.length > 1 || new Set(resolved).size > 1;

  if (ambiguous) return { productId: null, ambiguous: true };
  return { productId: resolved[0] ?? null, ambiguous: false };
}

async function isPreferredSupplier(tx: NodePgDatabase, productId: number, supplierId: number): Promise<boolean> {
  const [link] = await tx.select({ id: productSuppliers.id }).from(productSuppliers)
    .where(and(eq(productSuppliers.productId, productId), eq(productSuppliers.supplierId, supplierId), eq(productSuppliers.isPreferred, true)))
    .limit(1);
  return !!link;
}

/**
 * Upsert this supplier's own link.
 *
 * Policy:
 * - If the association exists:
 *   - Preserve `isPreferred = true` if already preferred.
 *   - If `isPreferred = false` and NO other supplier is preferred for this
 *     product (`productSuppliers.isPreferred = true` with a different
 *     supplier), promote to `true` so the import's supplier becomes the
 *     preferred authority.
 *   - If another preferred supplier already exists (`isPreferred = true`
 *     for a different supplier), keep `false` (do not override).
 * - If the association does NOT exist:
 *   - Create with `isPreferred = true` only when no other preferred supplier
 *     exists for the product; otherwise `false`.
 */
async function upsertSupplierLink(
  tx: NodePgDatabase,
  productId: number,
  row: ClaimedRow,
  context: ApplyContext,
  preferredForNewProduct: boolean
): Promise<void> {
  const [existing] = await tx.select().from(productSuppliers)
    .where(and(eq(productSuppliers.productId, productId), eq(productSuppliers.supplierId, context.supplierId)))
    .limit(1);

  // Check whether there is ANY preferred supplier for this product
  // (excluding the current association when it exists).
  const preferredForProductQuery = existing
    ? and(
        eq(productSuppliers.productId, productId),
        eq(productSuppliers.isPreferred, true),
        sql`${productSuppliers.id} != ${existing.id}`
      )
    : and(eq(productSuppliers.productId, productId), eq(productSuppliers.isPreferred, true));

  const [otherPreferred] = await tx.select({ id: productSuppliers.id })
    .from(productSuppliers)
    .where(preferredForProductQuery)
    .limit(1);

  if (existing) {
    const newCost = row.cost_price ?? existing.costPrice;
    const shouldBePreferred = existing.isPreferred ? true : !otherPreferred;
    await tx.update(productSuppliers).set({
      supplierSku: row.supplier_sku ?? existing.supplierSku,
      costPrice: newCost,
      lastCostPrice: newCost !== existing.costPrice ? existing.costPrice : existing.lastCostPrice,
      leadTimeDays: row.lead_time_days ?? existing.leadTimeDays,
      isPreferred: shouldBePreferred,
      updatedAt: new Date(),
    }).where(eq(productSuppliers.id, existing.id));
    return;
  }

  await tx.insert(productSuppliers).values({
    productId,
    supplierId: context.supplierId,
    supplierSku: row.supplier_sku,
    costPrice: row.cost_price,
    lastCostPrice: null,
    leadTimeDays: row.lead_time_days,
    isPreferred: !otherPreferred,
  });
}

/**
 * MDTech's next catalogue reference: `MD-000001`, `MD-000002`, …
 *
 * The number comes from `nextval()`, so it is handed out atomically — two
 * concurrent imports (two batches, two requests, two workers) can never receive
 * the same one. A sequence is deliberately not transactional: a batch that rolls
 * back leaves a gap in the numbering, never a reused value.
 */
async function nextInternalSku(tx: NodePgDatabase): Promise<string | null> {
  const [row] = rowsOf<{ nextval: string | number | null }>(
    await tx.execute(sql`SELECT nextval(${sql.raw(`'${MDTECH_SKU_SEQUENCE}'::regclass`)}) AS nextval`)
  );
  const value = Number(row?.nextval);
  if (!Number.isSafeInteger(value) || value < 1) return null;
  return `${MDTECH_SKU_PREFIX}${String(value).padStart(MDTECH_SKU_DIGITS, "0")}`;
}

interface CreatedProduct {
  productId: number | null;
  /** The SKU the product was created with, for the row message. */
  sku: string | null;
  /** Set instead of throwing: a collision is a row outcome, never a batch one. */
  failure: { code: string; message: string } | null;
}

/**
 * Create the product the file describes. The engine owns its price.
 *
 * ── The internal SKU is MDTech's, never the supplier's ──
 * `products.sku` is the catalogue's global reference; `product_suppliers.supplier_sku`
 * is one supplier's code for the same article. Copying a supplier's code into
 * products.sku would let a second supplier's file collide with it (the unique
 * index aborting the whole 500-row batch, permanently) or, worse, match against
 * the first supplier's product and write cost/stock into it. So:
 *  - an explicit `internal_sku` column is honoured — the operator mapped it as
 *    MDTech's own reference — and is never rewritten;
 *  - otherwise the SKU is minted from the sequence.
 * Every attempt is `ON CONFLICT (sku) DO NOTHING`: a value already taken by
 * hand-written data costs a fresh sequence number, not a rolled back batch.
 */
async function createProductFromRow(tx: NodePgDatabase, row: ClaimedRow, context: ApplyContext): Promise<CreatedProduct> {
  const label = (row.name ?? row.supplier_sku ?? `Produto importado ${context.importId}-${row.row_number}`).slice(0, 500);
  // Deterministic slug: no Date.now(), so a resumed batch cannot fork names.
  const slug = `${slugify(label)}-${context.importId}-${row.row_number}`.slice(0, 500);

  const insertWith = async (sku: string): Promise<number | null> => {
    const [created] = await tx.insert(products).values({
      name: label,
      slug,
      sku,
      ean: row.ean,
      // Placeholder only: never taken from the file, and replaced by the engine
      // below whenever a rule applies.
      price: "0.00",
      vatRate: "23.00",
      priceMode: "auto",
      stock: row.stock ?? 0,
      isActive: true,
    }).onConflictDoNothing({ target: products.sku }).returning({ id: products.id });
    return created?.id ?? null;
  };

  // An explicitly mapped internal SKU is the operator's own statement about the
  // catalogue: it is used as given. If it is already taken, the row reports it —
  // products.sku is never silently renamed to make room.
  if (row.internal_sku) {
    const productId = await insertWith(row.internal_sku);
    return productId === null
      ? {
          productId: null, sku: row.internal_sku,
          failure: { code: "INTERNAL_SKU_TAKEN", message: `O SKU interno "${row.internal_sku}" já pertence a outro produto — a linha não foi aplicada` },
        }
      : { productId, sku: row.internal_sku, failure: null };
  }

  for (let attempt = 0; attempt < MDTECH_SKU_ALLOC_ATTEMPTS; attempt += 1) {
    const sku = await nextInternalSku(tx);
    if (sku === null) break;
    const productId = await insertWith(sku);
    if (productId !== null) return { productId, sku, failure: null };
  }

  return {
    productId: null, sku: null,
    failure: {
      code: "SKU_GENERATION_FAILED",
      message: `Não foi possível atribuir um SKU interno em ${MDTECH_SKU_ALLOC_ATTEMPTS} tentativas — a linha não foi aplicada`,
    },
  };
}

/**
 * Apply one claimed row. The claim already flipped `applied`, so every branch
 * here runs exactly once per row for the life of the import.
 */
async function applyRow(tx: NodePgDatabase, row: ClaimedRow, context: ApplyContext): Promise<RowEffect> {
  let productId = row.product_id;
  let createdProduct = false;

  if (row.status === "new_product") {
    const resolved = await resolveAtApply(tx, row, context);
    if (resolved.ambiguous) {
      await markRow(tx, row.id, "error", "Correspondência ambígua detetada ao aplicar — linha não aplicada");
      return "skipped";
    }
    if (resolved.productId === null) {
      const created = await createProductFromRow(tx, row, context);
      if (created.productId === null) {
        await markRow(tx, row.id, "error", created.failure?.message ?? "Falha ao criar o produto");
        return "skipped";
      }
      productId = created.productId;
      createdProduct = true;
      // The row now points at a real product: record it (history + traceability).
      // When the internal SKU had to be minted, the number is written into the
      // row's message so the operator can find it after the import.
      await tx.update(supplierImportRows).set(row.internal_sku
        ? { status: "ready", productId }
        : { status: "ready", productId, message: `Produto criado com SKU interno ${created.sku}`.slice(0, 500) }
      ).where(eq(supplierImportRows.id, row.id));
    } else {
      // Another import created it meanwhile → apply against it, never a copy.
      productId = resolved.productId;
      await tx.update(supplierImportRows).set({ status: "ready", productId }).where(eq(supplierImportRows.id, row.id));
    }
  }

  if (productId === null) {
    await markRow(tx, row.id, "error", "Produto não encontrado ao aplicar");
    return "skipped";
  }

  const [product] = await tx.select({
    id: products.id, price: products.price, costPrice: products.costPrice, stock: products.stock,
    reservedStock: products.reservedStock, priceMode: products.priceMode,
  }).from(products).where(eq(products.id, productId)).limit(1);
  if (!product) {
    await markRow(tx, row.id, "error", "O produto foi eliminado entretanto");
    return "skipped";
  }

  await upsertSupplierLink(tx, productId, row, context, createdProduct);

  // The preferred supplier is the authority for products.costPrice, and only a
  // cost change may reprice. A non-preferred supplier therefore updates its own
  // link and stops there: no cost sync, no automatic repricing through it.
  const syncCost = row.cost_price !== null && (createdProduct || await isPreferredSupplier(tx, productId, context.supplierId));
  const priceResult = syncCost ? await syncProductCost(tx as unknown as NodePgDatabase, productId) : null;

  if (createdProduct) {
    // Initial stock arrives with the product, so it is booked as one entry.
    if (row.stock && row.stock > 0) {
      await tx.insert(stockMovements).values({
        productId, type: "entry", quantity: row.stock, stockBefore: 0, stockAfter: row.stock,
        reservedBefore: 0, reservedAfter: 0,
        reason: `Entrada inicial · importação fornecedor ${context.supplierName}`,
        referenceType: "supplier_import", referenceId: context.importId, userId: context.userId,
      });
    }
    return "created";
  }

  if (row.stock !== null && row.stock !== product.stock) {
    if (row.stock < product.reservedStock) {
      await markRow(tx, row.id, "error", `Stock ${row.stock} inferior a reservas (${product.reservedStock}) — linha não aplicada`);
      return "skipped";
    }
    await tx.update(products).set({ stock: row.stock, updatedAt: new Date() }).where(eq(products.id, productId));
    await tx.insert(stockMovements).values({
      productId, type: "import", quantity: row.stock - product.stock,
      stockBefore: product.stock, stockAfter: row.stock,
      reservedBefore: product.reservedStock, reservedAfter: product.reservedStock,
      reason: `Importação fornecedor ${context.supplierName} · linha ${row.row_number}`,
      referenceType: "supplier_import", referenceId: context.importId, userId: context.userId,
    });
  }

  return priceResult?.priced && priceResult.changed ? "repriced" : "updated";
}

export interface RowCounts {
  total: number;
  applied: number;
  pending: number;
  conflicts: number;
  errors: number;
  newProducts: number;
  ready: number;
}

/** Counts come from the real rows, never from what a caller reported. */
export async function countRows(importId: number): Promise<RowCounts> {
  const [row] = await db.select({
    total: sql<string>`count(*)`,
    applied: sql<string>`count(*) FILTER (WHERE applied)`,
    pending: sql<string>`count(*) FILTER (WHERE applied = false AND status IN ('ready','new_product'))`,
    conflicts: sql<string>`count(*) FILTER (WHERE status = 'conflict')`,
    errors: sql<string>`count(*) FILTER (WHERE status = 'error')`,
    newProducts: sql<string>`count(*) FILTER (WHERE status = 'new_product')`,
    ready: sql<string>`count(*) FILTER (WHERE status = 'ready')`,
  }).from(supplierImportRows).where(eq(supplierImportRows.importId, importId));
  return {
    total: Number(row?.total ?? 0), applied: Number(row?.applied ?? 0), pending: Number(row?.pending ?? 0),
    conflicts: Number(row?.conflicts ?? 0), errors: Number(row?.errors ?? 0),
    newProducts: Number(row?.newProducts ?? 0), ready: Number(row?.ready ?? 0),
  };
}

export interface ApplyOutcome {
  importId: number;
  status: string;
  /** Effects of THIS call. `applied` remains the import's running total. */
  appliedNow: number;
  applied: number;
  created: number;
  updated: number;
  repriced: number;
  skipped: number;
  conflicts: number;
  errors: number;
  pending: number;
  batchesDone: number;
  batchesTotal: number;
  idempotent: boolean;
  resumed: boolean;
  error?: { code: string; message: string };
}

export interface ApplyInput {
  importId: number;
  previewToken?: string;
  userId: number;
}

async function outcomeFor(importId: number, totals: Partial<ApplyOutcome> = {}): Promise<ApplyOutcome> {
  const snapshot = await loadImport(importId);
  const counts = await countRows(importId);
  return {
    importId,
    status: snapshot?.status ?? "preview",
    appliedNow: 0, applied: counts.applied, created: 0, updated: 0, repriced: 0, skipped: 0,
    conflicts: counts.conflicts, errors: counts.errors, pending: counts.pending,
    batchesDone: snapshot?.batchesDone ?? 0, batchesTotal: snapshot?.batchesTotal ?? 0,
    idempotent: false, resumed: false,
    ...totals,
  };
}

/**
 * Apply — or resume — a persisted snapshot in batches of
 * SUPPLIER_IMPORT_BATCH_SIZE rows, one transaction per batch.
 */
export async function applySupplierImport(input: ApplyInput): Promise<ApplyOutcome> {
  const snapshot = await loadImport(input.importId);
  if (!snapshot) throw new SupplierImportError("IMPORT_NOT_FOUND", 404);

  // completed + retry → the same answer, and nothing re-applied.
  if (snapshot.status === "completed") {
    return outcomeFor(snapshot.id, { idempotent: true });
  }
  if (snapshot.status === "failed") {
    throw new SupplierImportError("IMPORT_FAILED", 409, "Importação marcada como falhada — é preciso novo preview");
  }

  const fromPreview = snapshot.status === "preview";
  if (fromPreview) {
    if (!input.previewToken) throw new SupplierImportError("PREVIEW_TOKEN_REQUIRED", 403);
    const check = verifySupplierImportToken(input.previewToken);
    if (!check.valid) throw new SupplierImportError(check.expired ? "PREVIEW_EXPIRED" : "PREVIEW_TOKEN_INVALID", 403);
    if (!tokenMatchesImport(check.payload!, snapshot)) throw new SupplierImportError("PREVIEW_TOKEN_MISMATCH", 403);
  } else if (input.previewToken) {
    // A resume may carry the token along; if it does, it must be genuine.
    const check = verifySupplierImportToken(input.previewToken);
    if (!check.valid && !check.expired) throw new SupplierImportError("PREVIEW_TOKEN_INVALID", 403);
  }

  if (!(await claimImport(snapshot.id, fromPreview ? "first" : "resume"))) {
    throw new SupplierImportError("IMPORT_IN_PROGRESS", 409, "Outra importação está a decorrer com heartbeat ativo");
  }

  const [supplier] = await db.select({ id: suppliers.id, name: suppliers.name }).from(suppliers)
    .where(eq(suppliers.id, snapshot.supplierId)).limit(1);
  if (!supplier) {
    await db.update(supplierImports).set({
      status: "failed", finishedAt: new Date(),
      errorSummary: { code: "SUPPLIER_NOT_FOUND", message: "O fornecedor deixou de existir" },
    }).where(eq(supplierImports.id, snapshot.id));
    throw new SupplierImportError("SUPPLIER_NOT_FOUND", 409);
  }

  const context: ApplyContext = {
    importId: snapshot.id, supplierId: supplier.id, supplierName: supplier.name, userId: input.userId,
  };
  const totals = { appliedNow: 0, created: 0, updated: 0, repriced: 0, skipped: 0 };
  let lastError: { code: string; message: string } | null = null;

  for (let guard = 0; ; guard += 1) {
    // No unbounded loop, whatever the data does.
    if (guard > snapshot.rowCount + 1) {
      lastError = { code: "APPLY_STALLED", message: "O apply não progrediu; importação interrompida" };
      break;
    }
    try {
      const batch = await db.transaction(async (tx) => {
        const claimed = rowsOf<ClaimedRow>(await tx.execute(sql`
          WITH picked AS (
            SELECT id FROM ${supplierImportRows}
             WHERE import_id = ${snapshot.id}
               AND applied = false
               AND status IN ('ready','new_product')
             ORDER BY row_number
             LIMIT ${SUPPLIER_IMPORT_BATCH_SIZE}
             FOR UPDATE SKIP LOCKED
          )
          UPDATE ${supplierImportRows} AS r
             SET applied = true, applied_at = now()
           FROM picked
          WHERE r.id = picked.id
          RETURNING r.id, r.row_number, r.status, r.product_id, r.cost_price, r.stock,
                    r.lead_time_days, r.supplier_sku, r.internal_sku, r.ean, r.name
        `));
        if (claimed.length === 0) return { claimed: 0, effects: [] as RowEffect[] };

        const effects: RowEffect[] = [];
        for (const row of claimed) effects.push(await applyRow(tx, row, context));

        // Progress + heartbeat in the same transaction as the effects: a
        // committed batch is always a visible batch. LEAST() keeps the
        // batches_done <= batches_total invariant even if a reclaimed worker
        // races with the one that took over.
        await tx.execute(sql`
          UPDATE ${supplierImports}
             SET heartbeat_at = now(),
                 batches_done = LEAST(batches_done + 1, batches_total),
                 summary = COALESCE(summary, '{}'::jsonb)
                   || jsonb_build_object('lastBatchAt', now()::text, 'lastBatchRows', ${claimed.length}::int)
           WHERE id = ${snapshot.id} AND status = 'applying'
        `);
        return { claimed: claimed.length, effects };
      });

      if (batch.claimed === 0) break;
      totals.appliedNow += batch.claimed;
      for (const effect of batch.effects) {
        if (effect === "created") totals.created += 1;
        else if (effect === "updated") totals.updated += 1;
        else if (effect === "repriced") totals.repriced += 1;
        else totals.skipped += 1;
      }
      if (batch.claimed < SUPPLIER_IMPORT_BATCH_SIZE) break;
    } catch (e) {
      // The full technical error belongs in the server log only. A real
      // database/storage failure is classified into a safe category — never
      // SQL, query, params or a stack trace. Anything else keeps its
      // (human-authored) message under APPLY_BATCH_FAILED, which is what the
      // recovery tests assert a killed worker reports.
      console.error(`supplier import apply batch (import ${snapshot.id}):`, e);
      const storage = classifyImportStorageFailure(e);
      if (storage) {
        lastError = { code: storage.code, message: storage.message };
      } else {
        lastError = {
          code: "APPLY_BATCH_FAILED",
          message: e instanceof Error && e.message.trim()
            ? e.message.trim()
            : supplierImportErrorMessage("APPLY_BATCH_FAILED"),
        };
      }
      break;
    }
  }

  const counts = await countRows(snapshot.id);
  if (lastError) {
    // Some batches committed and the rest did not: resumable, not lost.
    await db.update(supplierImports).set({
      status: "partial",
      heartbeatAt: new Date(),
      errorSummary: { ...lastError, at: new Date().toISOString(), applied: counts.applied, pending: counts.pending },
    }).where(and(eq(supplierImports.id, snapshot.id), eq(supplierImports.status, "applying")));
    return outcomeFor(snapshot.id, { ...totals, resumed: !fromPreview, error: lastError });
  }

  // ── `completed` is only reachable with nothing pending ──
  // `pending` is exactly what a claim would still take, so it is the honest
  // definition of "nothing left to do". Closing an import that still has pending
  // rows would strand them permanently (completed is not resumable), and a late
  // worker resuming after a reclaim must not be able to do it. The NOT EXISTS
  // re-checks the rows inside the UPDATE, so completion is never decided from a
  // count that went stale between the two statements.
  const closed = rowsOf(await db.execute(sql`
    UPDATE ${supplierImports}
       SET status = 'completed',
           finished_at = now(),
           heartbeat_at = now(),
           summary = COALESCE(summary, '{}'::jsonb) || ${JSON.stringify({ finished: counts, completedAt: new Date().toISOString() })}::jsonb
     WHERE id = ${snapshot.id} AND status = 'applying'
       AND NOT EXISTS (
         SELECT 1 FROM ${supplierImportRows} pending_row
          WHERE pending_row.import_id = ${snapshot.id}
            AND pending_row.applied = false
            AND pending_row.status IN ('ready','new_product')
       )
    RETURNING id
  `));
  if (closed.length === 0) {
    const final = counts.pending > 0 ? counts : await countRows(snapshot.id);
    if (final.pending > 0) {
      const error = { code: "PENDING_ROWS_REMAIN", message: "Terminou com linhas por aplicar — retomar para concluir" };
      await db.update(supplierImports).set({
        status: "partial",
        heartbeatAt: new Date(),
        errorSummary: { ...error, at: new Date().toISOString(), applied: final.applied, pending: final.pending },
      }).where(and(eq(supplierImports.id, snapshot.id), eq(supplierImports.status, "applying")));
      return outcomeFor(snapshot.id, { ...totals, resumed: !fromPreview, error });
    }
    // Another worker closed the import while this run was finishing: nothing to
    // report as an error, and nothing here may undo what it committed.
    return outcomeFor(snapshot.id, { ...totals, resumed: !fromPreview, idempotent: true });
  }

  await createAuditLog({
    userId: input.userId, action: "supplier_import.applied", entity: "supplier_import", entityId: snapshot.id,
    details: {
      fileName: snapshot.fileName, resumed: !fromPreview, appliedNow: totals.appliedNow,
      created: totals.created, updated: totals.updated, repriced: totals.repriced, skipped: totals.skipped,
      conflicts: counts.conflicts, errors: counts.errors,
    },
  });
  return outcomeFor(snapshot.id, { ...totals, resumed: !fromPreview });
}

// ─── Progress ────────────────────────────────────────────

export interface ImportProgress {
  importId: number;
  status: string;
  supplierId: number;
  supplierName: string | null;
  fileName: string;
  total: number;
  applied: number;
  pending: number;
  errors: number;
  conflicts: number;
  batchesDone: number;
  batchesTotal: number;
  startedAt: string | null;
  completedAt: string | null;
  heartbeatAt: string | null;
  /** Server-side decision: partial, or applying whose heartbeat is stale. */
  canResume: boolean;
  stale: boolean;
  heartbeatTtlMs: number;
}

export async function getImportProgress(importId: number): Promise<ImportProgress | null> {
  const [row] = await db
    .select({
      id: supplierImports.id,
      status: supplierImports.status,
      supplierId: supplierImports.supplierId,
      supplierName: suppliers.name,
      fileName: supplierImports.fileName,
      startedAt: supplierImports.startedAt,
      finishedAt: supplierImports.finishedAt,
      heartbeatAt: supplierImports.heartbeatAt,
      batchesDone: supplierImports.batchesDone,
      batchesTotal: supplierImports.batchesTotal,
      stale: sql<boolean>`${staleHeartbeatCondition()} AND ${supplierImports.status} = 'applying'`,
    })
    .from(supplierImports)
    .leftJoin(suppliers, eq(suppliers.id, supplierImports.supplierId))
    .where(eq(supplierImports.id, importId))
    .limit(1);
  if (!row) return null;

  const counts = await countRows(importId);
  return {
    importId: row.id,
    status: row.status,
    supplierId: row.supplierId,
    supplierName: row.supplierName,
    fileName: row.fileName,
    total: counts.total,
    applied: counts.applied,
    pending: counts.pending,
    errors: counts.errors,
    conflicts: counts.conflicts,
    batchesDone: row.batchesDone,
    batchesTotal: row.batchesTotal,
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    completedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    heartbeatAt: row.heartbeatAt ? row.heartbeatAt.toISOString() : null,
    canResume: row.status === "partial" || (row.status === "applying" && !!row.stale),
    stale: !!row.stale,
    heartbeatTtlMs: IMPORT_HEARTBEAT_TTL_MS,
  };
}

/** Rows of a persisted snapshot — lets a reloaded page show the preview again. */
export async function getImportLines(importId: number, limit = SUPPLIER_IMPORT_PREVIEW_LIMIT) {
  return db.select().from(supplierImportRows)
    .where(eq(supplierImportRows.importId, importId))
    .orderBy(asc(supplierImportRows.rowNumber))
    .limit(limit);
}

// ─── History ─────────────────────────────────────────────

export interface SupplierImportHistoryItem {
  id: number;
  supplierId: number;
  supplierName: string | null;
  fileName: string;
  fileHash: string;
  rowCount: number;
  status: string;
  batchesDone: number;
  batchesTotal: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  summary: Record<string, unknown> | null;
}

export async function listSupplierImports(
  options: { supplierId?: number; limit?: number } = {}
): Promise<SupplierImportHistoryItem[]> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const rows = await db
    .select({
      id: supplierImports.id,
      supplierId: supplierImports.supplierId,
      supplierName: suppliers.name,
      fileName: supplierImports.fileName,
      fileHash: supplierImports.fileHash,
      rowCount: supplierImports.rowCount,
      status: supplierImports.status,
      batchesDone: supplierImports.batchesDone,
      batchesTotal: supplierImports.batchesTotal,
      createdAt: supplierImports.createdAt,
      startedAt: supplierImports.startedAt,
      finishedAt: supplierImports.finishedAt,
      summary: supplierImports.summary,
    })
    .from(supplierImports)
    .leftJoin(suppliers, eq(suppliers.id, supplierImports.supplierId))
    .where(options.supplierId ? eq(supplierImports.supplierId, options.supplierId) : undefined)
    .orderBy(desc(supplierImports.id))
    .limit(limit);

  return rows.map((r) => ({
    ...r,
    createdAt: r.createdAt.toISOString(),
    startedAt: r.startedAt ? r.startedAt.toISOString() : null,
    finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
    summary: (r.summary as Record<string, unknown> | null) ?? null,
  }));
}
