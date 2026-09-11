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
  supplierImportProfiles,
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
  type NormalizedSupplierRow,
  type SupplierImportIssue,
} from "@/lib/supplier-import/normalize";
import {
  assertSourcePayload,
  sourceByteLength,
  sourceFormat,
  sourceSha256Hex,
  type SourcePayload,
} from "@/lib/supplier-import/source";
import { type SupplierFileFormat } from "@/lib/supplier-import/file";
// C.3.3 (etapa 1) — o serviço já não chama o parser CSV diretamente: passa pelo
// dispatcher de formatos e pelo resolvedor puro de mapping/perfil (C.3.2).
import {
  inferSupplierImportFormat,
  isProfileCompatibleWithHeaders,
  parseSupplierFile,
  resolveSupplierFileMapping,
} from "@/lib/supplier-import/file";
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
  /**
   * C.3.4.4 — stock do FORNECEDOR (só linhas ALSO stock-only; null no resto).
   * `stock` NUNCA transporta stock ALSO: products.stock é o stock físico MDTech.
   */
  supplierStock?: number | null;
  supplierStockBefore?: number | null;
  /**
   * C.3.4.4 — diff incremental persistido (só ALSO stock-only; null no resto).
   * new/changed/unchanged/error; changedFields lista os campos de fornecedor
   * efetivamente diferentes (auditoria do preview).
   */
  diffStatus?: "new" | "changed" | "unchanged" | "error" | null;
  changedFields?: string[] | null;
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
  // C.3.4.3.1 ALSO metadata (optional)
  alsoManufacturerPartNumber?: string | null;
  alsoManufacturerName?: string | null;
  alsoCategoryPath?: string | null;
  alsoAvailableNextDate?: string | null;
  alsoAvailableNextQuantity?: number | null;
  alsoAvailabilityTimestamp?: string | null;
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
  /** C.3.4.1 — fonte configurada que produziu o snapshot (NULL no upload manual). */
  sourceId: number | null;
  /** Snapshot do nome da fonte no momento do preview (sobrevive a rename). */
  sourceLabel: string | null;
  fileHash: string;
  fileSizeBytes: number;
  /**
   * C.3.4.3.1 — formato EFETIVO do parser que produziu este preview
   * (also_pricelist/also_stock/csv/xlsx). É o que a UI usa para mostrar o
   * mecanismo real e NUNCA induzir o mapeamento C.3.2 num ficheiro ALSO.
   */
  format: SupplierFileFormat;
  /** CSV: separador detetado. XLSX (C.3.3 etapa 2): null — não se aplica. */
  delimiter: string | null;
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
  profileUsed?: string;
  profileName?: string;
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
  /**
   * C.3.4.1 — FONTE única de conteúdo (contrato SourcePayload). O upload
   * CSV/XLSX chega aqui via `uploadSource()` (./supplier-import/source) e o
   * serviço já não conhece `csvText` nem `xlsxBytes`: só o contrato da fonte.
   * `label` alimenta supplier_imports.file_name + source_label; `text`/`bytes`
   * alimentam o dispatcher de formatos (SupplierFileParse nunca muda).
   */
  source: SourcePayload;
  /**
   * Mapeamento manual header→campo. Vazio ({}) conta como AUSENTE: nesse caso,
   * um perfil válido guardado para o fornecedor tem prioridade e o CSV é
   * parseado com o mapping do perfil.
   */
  mapping?: Record<string, string>;
  userId: number;
  /**
   * C.3.2 — quando true e o mapping efetivamente usado for válido, o perfil do
   * fornecedor é gravado durante o próprio PREVIEW (e reutilizado no seguinte).
   */
  saveProfile?: boolean;
  /**
   * C.3.4.2 — id da `supplier_sources` que produziu este payload (runSource).
   * Persistido em `supplier_imports.source_id` para o histórico ligar a fonte.
   * Upload manual continua a não passar nada → NULL (comportamento inalterado).
   */
  sourceId?: number | null;
}

interface ProductInfo {
  id: number; name: string; sku: string | null; ean: string | null; price: string;
  costPrice: string | null; vatRate: string; stock: number; reservedStock: number;
  priceMode: string; categoryId: number | null; brandId: number | null;
}

// ─── C.3.4.4: diff incremental ALSO stock-only ─────────────

/** Normaliza date (Date|string) para 'YYYY-MM-DD' (ou null). */
function toISODate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  const s = String(value).trim();
  return s ? s.slice(0, 10) : null;
}

/**
 * Epoch (ms) de um timestamp ALSO — a MESMA conversão do snapshot (UTC).
 * Formatos observados: Date (drizzle select), 'YYYY-MM-DD HH:MM[:SS]' (ALSO,
 * UTC), 'YYYY-MM-DD' (UTC meia-noite), ISO com T/Z/offset e o texto do pg
 * 'YYYY-MM-DD HH:MM:SS+00' (leituras raw do claim). Null quando ausente ou
 * inválido. Sem offset explícito assume-se SEMPRE UTC (nunca hora local).
 */
function alsoTimestampEpoch(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  const s = String(value).trim();
  if (!s) return null;
  if (s.includes("T") || s.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(s) || /[+-]\d{2}$/.test(s)) {
    // ISO ou texto do pg: direto (o V8 não aceita offset "+00" sem minutos).
    const d = new Date(s.replace(" ", "T").replace(/\+00$/, "+00:00").replace(/-00$/, "-00:00"));
    return Number.isNaN(d.getTime()) ? null : d.getTime();
  }
  const t = s.replace(" ", "T");
  const d = new Date(t.includes("T") ? `${t}Z` : `${t}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

interface AlsoLinkState {
  supplierStock: number | null;
  availableNextDate: string | Date | null;
  availableNextQuantity: number | null;
  availabilityTimestamp: Date | string | null;
}

/**
 * Compara UMA linha ALSO normalizada com o estado atual do link.
 *
 * Regras (§8–§9): incoming null (incl. sentinel -1 → null) significa
 * "desconhecido / não atualizar" — é EXCLUÍDO da comparação e nunca gera
 * changedField. Ordem estável dos campos.
 */
export function diffAlsoStockRow(
  row: NormalizedSupplierRow,
  link: AlsoLinkState | undefined
): { diffStatus: "new" | "changed" | "unchanged" | "error"; changedFields: string[] | null } {
  const changed: string[] = [];
  const incomingStock = row.supplierStock ?? null;
  if (incomingStock !== null && (!link || link.supplierStock !== incomingStock)) {
    changed.push("supplierStock");
  }
  const incomingNextDate = row.alsoAvailableNextDate ?? null;
  if (incomingNextDate !== null && (!link || toISODate(link.availableNextDate) !== toISODate(incomingNextDate))) {
    changed.push("availableNextDate");
  }
  const incomingNextQty = row.alsoAvailableNextQuantity ?? null;
  if (incomingNextQty !== null && (!link || link.availableNextQuantity !== incomingNextQty)) {
    changed.push("availableNextQuantity");
  }
  const incomingTs = row.alsoAvailabilityTimestamp ?? null;
  if (incomingTs !== null) {
    const incomingEpoch = alsoTimestampEpoch(incomingTs);
    const linkEpoch = link ? alsoTimestampEpoch(link.availabilityTimestamp) : null;
    if (incomingEpoch !== null && (!link || linkEpoch !== incomingEpoch)) {
      changed.push("availabilityTimestamp");
    }
  }
  if (changed.length === 0) return { diffStatus: "unchanged", changedFields: null };
  return { diffStatus: "changed", changedFields: changed };
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

  // C.3.2 — Perfil de importação por fornecedor.
  // Primeiro parse (auto ou manual) para obter headers; depois verifica perfil.
  // Mapping manual VAZIO é tratado como ausente: a UI envia sempre mapping:{},
  // e um objeto vazio não pode esconder um perfil guardado válido.
  //
  // C.3.3 (etapa 1) — o parse passa pelo dispatcher parseSupplierFile e a
  // resolução perfil/mapping vive em resolveSupplierFileMapping
  // (./supplier-import/file), com a MESMA semântica C.3.2: a ordem de
  // execução mantém-se — parse inicial ANTES de carregar o perfil da base de
  // dados, re-parse com o perfil só quando aplicável.
  //
  // C.3.4.1 — o conteúdo vem sempre de um SourcePayload (contrato único SOURCE
  // → FORMATO → SupplierFileParse). O formato é resolvido pelo payload
  // (explícito na rota/upload; "auto" deteta bytes/texto) e o hash/tamanho são
  // calculados sobre o conteúdo exato (UTF-8 para texto; bytes originais para
  // XLSX — NUNCA sobre o base64 de transporte).
  assertSourcePayload(input.source);
  const source = input.source;
  const format = sourceFormat(source);
  const parseOne = (overrides?: Record<string, string>) =>
    parseSupplierFile(source.text ?? "", overrides, format, source.bytes);

  const manualMapping = hasManualMappingEntries(input.mapping) ? input.mapping : undefined;
  const initialParsed = parseOne(manualMapping);
  const fileHash = sourceSha256Hex(source);
  const fileSizeBytes = sourceByteLength(source);
  const sourceLabel = source.label;

  const profile = await loadSupplierProfile(supplier.id);
  let { parsed, resolution } = resolveSupplierFileMapping({
    initial: initialParsed,
    reparse: parseOne,
    manualMapping,
    profile,
  });

  // C.3.2 — Guardar perfil durante o preview.
  // O mapping guardado é exatamente o mapping efetivamente usado neste preview
  // (o mesmo snapshot que fica em supplier_imports.mapping), pelo que um
  // segundo preview reutiliza o perfil sem alterar o histórico já persistido.
  if (input.saveProfile) {
    const mappingToSave = parsed.mapping;
    const validMapping =
      isStringRecord(mappingToSave) &&
      Object.keys(mappingToSave).length > 0 &&
      isProfileCompatibleWithHeaders(mappingToSave, parsed.headers);
    if (validMapping) {
      await saveSupplierProfile(supplier.id, mappingToSave, parsed.delimiter, input.userId);
      // O retorno do save não é prova de sucesso: profile_valid só é reportado
      // depois de uma RELEITURA (loadSupplierProfile) confirmar que o perfil
      // gravado é legível. Sem confirmação, mantém-se a resolução anterior.
      const reread = await loadSupplierProfile(supplier.id);
      if (reread) {
        resolution = { type: "profile_valid", mapping: reread.mapping, profileId: reread.id };
      }
    }
  }

  const index = await buildIndexForRows(parsed.rows, supplier.id);
  let plans = planSupplierRows(parsed.rows, index);
  // C.3.4.3.1 stock-only: nunca cria produtos; ProductID desconhecido -> erro
  const isStockOnly = format === "also_stock";
  if (isStockOnly) {
    plans = plans.map((p, i) => {
      if (p.status === "new_product") {
        const sku = parsed.rows[i]?.supplierSku ?? "";
        return {
          ...p,
          status: "error" as const,
          codes: [...p.codes, "STOCK_UNKNOWN_SKU"],
          message: `ProductID "${sku}" desconhecido — stock não atualizado (stock-only nunca cria produto)`.slice(0, 500),
        };
      }
      return p;
    });
  }
  const skuOwners = await findInternalSkuOwners(parsed.rows.map((r) => r.supplierSku));

  const matchedIds = [...new Set(plans.filter((p) => p.productId !== null).map((p) => p.productId as number))];
  const productInfo = new Map<number, ProductInfo>();
  const preferredByProduct = new Map<number, number>();
  const linkCost = new Map<number, string | null>();
  // C.3.4.4: estado de fornecedor por produto (diff incremental ALSO stock).
  const linkSupplierState = new Map<number, {
    supplierStock: number | null;
    availableNextDate: string | Date | null;
    availableNextQuantity: number | null;
    availabilityTimestamp: Date | string | null;
  }>();

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
      // C.3.4.4: estado de fornecedor para o diff incremental (só ALSO stock).
      supplierStock: productSuppliers.supplierStock,
      availableNextDate: productSuppliers.availableNextDate,
      availableNextQuantity: productSuppliers.availableNextQuantity,
      availabilityTimestamp: productSuppliers.availabilityTimestamp,
    }).from(productSuppliers).where(inArray(productSuppliers.productId, matchedIds));
    for (const link of links) {
      if (link.isPreferred) preferredByProduct.set(link.productId, link.supplierId);
      if (link.supplierId === supplier.id) {
        linkCost.set(link.productId, link.costPrice);
        linkSupplierState.set(link.productId, {
          supplierStock: link.supplierStock,
          availableNextDate: link.availableNextDate,
          availableNextQuantity: link.availableNextQuantity,
          availabilityTimestamp: link.availabilityTimestamp,
        });
      }
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

    // C.3.4.4 — diff incremental: SÓ linhas ALSO stock-only ganham diffStatus
    // (NULL em tudo o resto — imports genéricos inalterados). ready compara
    // com o link; conflict/error mapeiam para error; new_product (impossível
    // em stock-only após a reescrita acima) mapeia para new.
    let supplierStock: number | null = null;
    let supplierStockBefore: number | null = null;
    let diffStatus: "new" | "changed" | "unchanged" | "error" | null = null;
    let changedFields: string[] | null = null;
    if (isStockOnly) {
      supplierStock = row.supplierStock ?? null;
      if (plan.status === "ready" && plan.productId !== null) {
        const link = linkSupplierState.get(plan.productId);
        supplierStockBefore = link?.supplierStock ?? null;
        const diff = diffAlsoStockRow(row, link);
        diffStatus = diff.diffStatus;
        changedFields = diff.changedFields;
      } else if (plan.status === "new_product") {
        diffStatus = "new";
      } else {
        diffStatus = "error";
      }
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
      // Em stock-only o `stock` físico é sempre null (não transporta ALSO) e
      // o "antes" físico não é mostrado (evita sugerir uma escrita física).
      stockBefore: isStockOnly ? null : (product?.stock ?? null),
      supplierStock,
      supplierStockBefore,
      diffStatus,
      changedFields,
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
      alsoManufacturerPartNumber: (row as any).alsoManufacturerPartNumber ?? null,
      alsoManufacturerName: (row as any).alsoManufacturerName ?? null,
      alsoCategoryPath: (row as any).alsoCategoryPath ?? null,
      alsoAvailableNextDate: (row as any).alsoAvailableNextDate ?? null,
      alsoAvailableNextQuantity: (row as any).alsoAvailableNextQuantity ?? null,
      alsoAvailabilityTimestamp: (row as any).alsoAvailabilityTimestamp ?? null,
    });
  });

  const planSummary = summarizePlan(parsed.rows, plans);
  // C.3.4.4: linhas UNCHANGED nunca são claimed/applied — saem do actionable
  // (0 em imports genéricos: comportamento idêntico ao anterior).
  const unchangedCount = lines.filter((l) => l.diffStatus === "unchanged").length;
  const changedCount = lines.filter((l) => l.diffStatus === "changed").length;
  const actionable = planSummary.ready + planSummary.newProducts - unchangedCount;
  const batchesTotal = Math.ceil(actionable / SUPPLIER_IMPORT_BATCH_SIZE);
  const missing = await detectMissingProducts(supplier.id, lines);

  // ── The snapshot is persisted atomically ──
  // Header and rows commit together or not at all: a preview that died halfway
  // must not leave a `preview` import whose rows are a subset of the file,
  // because that subset is exactly what apply would otherwise consume.
  const importRow = await db.transaction(async (tx) => {
    const [created] = await tx.insert(supplierImports).values({
      supplierId: supplier.id,
      fileName: sourceLabel.slice(0, 255),
      // C.3.4.1 — a fonte configurada (supplier_sources) nasce na gestão de
      // fontes; um upload manual não tem linha de fonte (source_id NULL).
      // C.3.4.2 — quando o preview vem de um runSource, o id da fonte é
      // passado explicitamente; o motor (matching/pricing/snapshot) é o mesmo.
      // O label é persistido como snapshot para o histórico sobreviver a
      // renome/delete; os validadores HTTP ficam NULL no upload.
      sourceId: input.sourceId ?? null,
      sourceLabel: sourceLabel.slice(0, 255),
      httpEtag: source.etag ?? null,
      httpLastModified: source.lastModified ?? null,
      fileHash,
      fileSizeBytes,
      rowCount: parsed.rows.length,
      status: "preview",
      mapping: parsed.mapping,
      summary: {
        ...planSummary, actionable, batchesTotal, ignoredColumns: parsed.ignoredColumns, missingProducts: missing,
        // C.3.4.4: contagens do diff — SÓ em also_stock (genéricos inalterados).
        ...(isStockOnly ? { diffChanged: changedCount, diffUnchanged: unchangedCount } : {}),
      },
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
        // C.3.4.4: snapshot do stock de fornecedor + diff (null fora de ALSO stock).
        supplierStock: line.supplierStock ?? null,
        diffStatus: line.diffStatus ?? null,
        changedFields: line.changedFields ?? null,
        leadTimeDays: line.leadTimeDays,
        message: line.message ? line.message.slice(0, 500) : null,
        currentPrice: line.currentPrice,
        computedPrice: line.computedPrice,
        priceMode: line.priceMode,
        // price_message is varchar(255): a message longer than the column must
        // not sink the preview INSERT the way an out-of-range value used to.
        priceMessage: line.priceMessage ? line.priceMessage.slice(0, 255) : null,
        isPreferredSupplier: line.isPreferredSupplier,
        // C.3.4.3.1 snapshot histórico genérico — preserva exatamente o normalizado
        manufacturerPartNumber: (line as any).alsoManufacturerPartNumber ?? null,
        manufacturerName: (line as any).alsoManufacturerName ?? null,
        supplierCategoryPath: (line as any).alsoCategoryPath ?? null,
        availableNextDate: (line as any).alsoAvailableNextDate ? (line as any).alsoAvailableNextDate : null,
        availableNextQuantity: (line as any).alsoAvailableNextQuantity ?? null,
        availabilityTimestamp: (() => {
          const raw: any = (line as any).alsoAvailabilityTimestamp;
          if (!raw || typeof raw !== "string") return null;
          const s = String(raw).trim();
          if (!s) return null;
          let iso = s.replace(" ", "T");
          if (!iso.endsWith("Z") && !iso.includes("+") && iso.includes("T")) iso += "Z";
          else if (!iso.includes("T")) iso += "T00:00:00Z";
          const d = new Date(iso);
          return isNaN(d.getTime()) ? null : d;
        })(),
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
    sourceId: importRow.sourceId,
    sourceLabel: importRow.sourceLabel,
    fileHash,
    fileSizeBytes,
    format,
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
    profileUsed: resolution.type,
    profileName: resolution.profileId ? `Perfil #${resolution.profileId}` : undefined,
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
  supplier_stock: number | null;
  diff_status: "new" | "changed" | "unchanged" | "error" | null;
  changed_fields: string[] | null;
  lead_time_days: number | null;
  supplier_sku: string | null;
  internal_sku: string | null;
  ean: string | null;
  name: string | null;
  manufacturer_part_number: string | null;
  manufacturer_name: string | null;
  supplier_category_path: string | null;
  available_next_date: string | null;
  available_next_quantity: number | null;
  availability_timestamp: string | null;
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

  // ALSO generic: preparar valores para product_suppliers
  // availableNextDate é date (YYYY-MM-DD string), availabilityTimestamp é timestamptz (Date)
  let availTsDate: Date | null = null;
  if ((row as any).availability_timestamp) {
    const rawTs: any = (row as any).availability_timestamp;
    if (rawTs instanceof Date) availTsDate = isNaN(rawTs.getTime()) ? null : rawTs;
    else if (typeof rawTs === "string") {
      const s = String(rawTs).trim();
      if (s) {
        // pg pode devolver "2026-09-18 11:00:00+00" ou ISO; tenta Date direto primeiro
        let d = new Date(s);
        if (isNaN(d.getTime())) {
          let iso = s.replace(" ", "T");
          if (!iso.endsWith("Z") && !iso.includes("+") && iso.includes("T")) iso += "Z";
          else if (!iso.includes("T")) iso += "T00:00:00Z";
          // normaliza +00 → +00:00 para JS
          iso = iso.replace(/\+00$/, "+00:00").replace(/-00$/, "-00:00");
          d = new Date(iso);
        }
        if (!isNaN(d.getTime())) availTsDate = d;
      }
    }
  }
  const nextDateVal: string | null = (row as any).available_next_date ?? null;
  const nextQtyVal: number | null = (row as any).available_next_quantity ?? null;
  const mpnVal: string | null = (row as any).manufacturer_part_number ?? null;
  const catPathVal: string | null = (row as any).supplier_category_path ?? null;

  const now = new Date();

  if (existing) {
    const newCost = row.cost_price ?? existing.costPrice;
    // Stock-only (cost null) nunca altera preferred — mantém o existente
    const isStockRow = row.cost_price === null;
    const shouldBePreferred = isStockRow ? existing.isPreferred : (existing.isPreferred ? true : !otherPreferred);
    await tx.update(productSuppliers).set({
      supplierSku: row.supplier_sku ?? existing.supplierSku,
      costPrice: newCost,
      lastCostPrice: newCost !== existing.costPrice ? existing.costPrice : existing.lastCostPrice,
      leadTimeDays: row.lead_time_days ?? existing.leadTimeDays,
      isPreferred: shouldBePreferred,
      // C.3.4.3.1 generic — pricelist vs stock: só sobrescreve se snapshot trouxe valor
      manufacturerPartNumber: mpnVal ?? (existing as any).manufacturerPartNumber,
      supplierCategoryPath: catPathVal ?? (existing as any).supplierCategoryPath,
      availableNextDate: nextDateVal ?? (existing as any).availableNextDate,
      availableNextQuantity: nextQtyVal ?? (existing as any).availableNextQuantity,
      availabilityTimestamp: availTsDate ?? (existing as any).availabilityTimestamp,
      lastSyncAt: now,
      updatedAt: now,
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
    manufacturerPartNumber: mpnVal,
    supplierCategoryPath: catPathVal,
    availableNextDate: nextDateVal as any,
    availableNextQuantity: nextQtyVal,
    availabilityTimestamp: availTsDate,
    lastSyncAt: now,
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
 * C.3.4.4 — aplica UMA linha ALSO stock-only (diff_status não-nulo).
 *
 * Autoridade ABSOLUTA de stock: esta função NUNCA escreve products.stock,
 * NUNCA cria stock movements, NUNCA altera custo/preço/preferred e NUNCA cria
 * links. Só escreve na associação existente os campos de fornecedor com valor
 * não-nulo no snapshot E diferente do estado atual (+ lastSyncAt/updatedAt).
 * Snapshot null (incl. sentinel -1) = "desconhecido / não atualizar".
 */
async function applyAlsoStockRow(tx: NodePgDatabase, row: ClaimedRow, context: ApplyContext): Promise<RowEffect> {
  if (row.product_id === null) {
    await markRow(tx, row.id, "error", "Produto não encontrado ao aplicar");
    return "skipped";
  }
  if (row.diff_status === "unchanged") {
    // Defesa em profundidade: o claim exclui-as, mas se alguma chegar aqui
    // (corrida antiga/nova) consome-se sem NENHUM write.
    return "skipped";
  }
  const [link] = await tx.select().from(productSuppliers)
    .where(and(eq(productSuppliers.productId, row.product_id), eq(productSuppliers.supplierId, context.supplierId)))
    .limit(1);
  if (!link) {
    // Stock-only nunca cria associações: se o link desapareceu entre o
    // preview e o apply, a linha é recusada em vez de o recriar.
    await markRow(tx, row.id, "error", "A associação produto-fornecedor foi removida entretanto — linha não aplicada");
    return "skipped";
  }

  // O delta é recomputado contra o estado ATUAL do link (não se confia
  // cegamente no changedFields do preview: outra importação pode ter
  // convergido entretanto — nesse caso: zero writes).
  const patch: {
    supplierStock?: number;
    availableNextDate?: string;
    availableNextQuantity?: number;
    availabilityTimestamp?: Date;
  } = {};
  if (row.supplier_stock !== null && row.supplier_stock !== undefined && row.supplier_stock !== link.supplierStock) {
    patch.supplierStock = row.supplier_stock;
  }
  const snapNextDate = toISODate(row.available_next_date);
  if (snapNextDate !== null && snapNextDate !== toISODate(link.availableNextDate)) {
    patch.availableNextDate = snapNextDate;
  }
  if (row.available_next_quantity !== null && row.available_next_quantity !== undefined && row.available_next_quantity !== link.availableNextQuantity) {
    patch.availableNextQuantity = row.available_next_quantity;
  }
  const snapEpoch = alsoTimestampEpoch(row.availability_timestamp);
  if (snapEpoch !== null && snapEpoch !== alsoTimestampEpoch(link.availabilityTimestamp)) {
    patch.availabilityTimestamp = new Date(snapEpoch);
  }

  if (Object.keys(patch).length === 0) return "updated";
  const now = new Date();
  await tx.update(productSuppliers).set({ ...patch, lastSyncAt: now, updatedAt: now }).where(eq(productSuppliers.id, link.id));
  return "updated";
}

/**
 * Apply one claimed row. The claim already flipped `applied`, so every branch
 * here runs exactly once per row for the life of the import.
 */
async function applyRow(tx: NodePgDatabase, row: ClaimedRow, context: ApplyContext): Promise<RowEffect> {
  // C.3.4.4: linhas ALSO stock-only (diff_status não-nulo) seguem o ramo
  // separado — o caminho genérico abaixo (stock físico, movimentos, pricing)
  // nunca as vê.
  if (row.diff_status !== null && row.diff_status !== undefined) {
    return applyAlsoStockRow(tx, row, context);
  }
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
    // C.3.4.4: UNCHANGED nunca é claimed — também não conta como pending
    // (senão a importação nunca fecharia como completed).
    pending: sql<string>`count(*) FILTER (WHERE applied = false AND status IN ('ready','new_product') AND (diff_status IS NULL OR diff_status <> 'unchanged'))`,
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
               AND (diff_status IS NULL OR diff_status <> 'unchanged')
             ORDER BY row_number
             LIMIT ${SUPPLIER_IMPORT_BATCH_SIZE}
             FOR UPDATE SKIP LOCKED
          )
          UPDATE ${supplierImportRows} AS r
             SET applied = true, applied_at = now()
           FROM picked
          WHERE r.id = picked.id
          RETURNING r.id, r.row_number, r.status, r.product_id, r.cost_price, r.stock,
                    r.supplier_stock, r.diff_status, r.changed_fields,
                    r.lead_time_days, r.supplier_sku, r.internal_sku, r.ean, r.name,
                    r.manufacturer_part_number, r.manufacturer_name, r.supplier_category_path,
                    r.available_next_date, r.available_next_quantity, r.availability_timestamp
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
            AND (pending_row.diff_status IS NULL OR pending_row.diff_status <> 'unchanged')
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

// ─── C.3.4.2 — Reopen a persisted preview ────────────────

/**
 * A persisted preview handed back to the operator for manual review, with a
 * FRESH signed token. Shape-compatible with `SupplierImportPreview` so the
 * panel renders it through the same card and applies it through the same
 * button; `reopened` only tells the UI where it came from.
 */
export interface SupplierImportReopenedPreview extends SupplierImportPreview {
  reopened: true;
}

/**
 * Reopen a persisted `preview` so a human can review and apply it — the
 * missing step between "Sync Now created import #N" and the C.3.1 Apply.
 *
 * ── Why this exists ──
 * The apply token is deliberately never persisted: it is the proof that THIS
 * snapshot was shown to an operator, and it only ever lives in the response of
 * the preview call. So a preview produced by a remote sync (or a manual upload
 * followed by a reload) had no way back to the Apply button. This function
 * re-shows exactly the persisted snapshot and re-issues a token bound to it —
 * same HMAC module, same TTL, same `kind`, same binding
 * (importId + supplierId + fileHash + rowCount). Apply then verifies it the
 * way it verifies any first-apply token.
 *
 * ── What it never does ──
 * No parsing, no matching, no pricing, no snapshot rewrite, no status change,
 * no products/product_suppliers/stock touched. Everything the operator sees
 * comes from supplier_imports + supplier_import_rows as persisted. The product
 * SKU/name are LEFT JOINed for display only — apply keeps reading the rows.
 *
 * ── State machine ──
 *  - preview           → reopened (this function);
 *  - completed         → 409 IMPORT_NOT_REOPENABLE (nothing to apply; the
 *                        apply route already answers idempotently);
 *  - applying/partial  → 409 IMPORT_NOT_REOPENABLE — a first-apply token
 *                        would be meaningless: the resume flow (apply without
 *                        token, gated by the heartbeat) already owns them;
 *  - failed            → 409 IMPORT_FAILED (existing safe error);
 *  - unknown id        → 404 IMPORT_NOT_FOUND.
 */
export async function reopenSupplierImportPreview(importId: number): Promise<SupplierImportReopenedPreview> {
  const [row] = await db
    .select({
      id: supplierImports.id,
      supplierId: supplierImports.supplierId,
      supplierName: suppliers.name,
      fileName: supplierImports.fileName,
      sourceId: supplierImports.sourceId,
      sourceLabel: supplierImports.sourceLabel,
      fileHash: supplierImports.fileHash,
      fileSizeBytes: supplierImports.fileSizeBytes,
      rowCount: supplierImports.rowCount,
      status: supplierImports.status,
      mapping: supplierImports.mapping,
      summary: supplierImports.summary,
      batchesTotal: supplierImports.batchesTotal,
    })
    .from(supplierImports)
    .leftJoin(suppliers, eq(suppliers.id, supplierImports.supplierId))
    .where(eq(supplierImports.id, importId))
    .limit(1);
  if (!row) throw new SupplierImportError("IMPORT_NOT_FOUND", 404);

  if (row.status === "failed") {
    throw new SupplierImportError("IMPORT_FAILED", 409, "Importação marcada como falhada — é preciso novo preview");
  }
  if (row.status !== "preview") {
    // completed: nothing left to apply. applying/partial: owned by the resume
    // flow — never re-issue a first-apply token for an import already claimed.
    throw new SupplierImportError("IMPORT_NOT_REOPENABLE", 409);
  }

  // The visible window is the same as a fresh preview; one extra row decides
  // `truncated` without counting the whole snapshot.
  const persisted = await db
    .select({
      rowNumber: supplierImportRows.rowNumber,
      supplierSku: supplierImportRows.supplierSku,
      ean: supplierImportRows.ean,
      internalSku: supplierImportRows.internalSku,
      name: supplierImportRows.name,
      productId: supplierImportRows.productId,
      matchType: supplierImportRows.matchType,
      status: supplierImportRows.status,
      costPrice: supplierImportRows.costPrice,
      stock: supplierImportRows.stock,
      supplierStock: supplierImportRows.supplierStock,
      diffStatus: supplierImportRows.diffStatus,
      changedFields: supplierImportRows.changedFields,
      leadTimeDays: supplierImportRows.leadTimeDays,
      message: supplierImportRows.message,
      currentPrice: supplierImportRows.currentPrice,
      computedPrice: supplierImportRows.computedPrice,
      priceMode: supplierImportRows.priceMode,
      priceMessage: supplierImportRows.priceMessage,
      isPreferredSupplier: supplierImportRows.isPreferredSupplier,
      manufacturerPartNumber: supplierImportRows.manufacturerPartNumber,
      manufacturerName: supplierImportRows.manufacturerName,
      supplierCategoryPath: supplierImportRows.supplierCategoryPath,
      availableNextDate: supplierImportRows.availableNextDate,
      availableNextQuantity: supplierImportRows.availableNextQuantity,
      availabilityTimestamp: supplierImportRows.availabilityTimestamp,
      // Display only (LEFT JOIN): a product deleted since the preview simply
      // shows without a SKU — the row keeps its own persisted values.
      productSku: products.sku,
      productName: products.name,
    })
    .from(supplierImportRows)
    .leftJoin(products, eq(products.id, supplierImportRows.productId))
    .where(eq(supplierImportRows.importId, row.id))
    .orderBy(asc(supplierImportRows.rowNumber))
    .limit(SUPPLIER_IMPORT_PREVIEW_LIMIT + 1);

  const truncated = persisted.length > SUPPLIER_IMPORT_PREVIEW_LIMIT;
  const visible = truncated ? persisted.slice(0, SUPPLIER_IMPORT_PREVIEW_LIMIT) : persisted;

  const lines: SupplierImportPreviewLine[] = visible.map((r) => ({
    rowNumber: r.rowNumber,
    supplierSku: r.supplierSku,
    ean: r.ean,
    internalSku: r.internalSku,
    name: r.name,
    status: r.status as SupplierImportPreviewLine["status"],
    matchType: r.matchType as SupplierImportPreviewLine["matchType"],
    alsoManufacturerPartNumber: (r as any).manufacturerPartNumber ?? null,
    alsoManufacturerName: (r as any).manufacturerName ?? null,
    alsoCategoryPath: (r as any).supplierCategoryPath ?? null,
    alsoAvailableNextDate: (r as any).availableNextDate ? String((r as any).availableNextDate).slice(0, 10) : null,
    alsoAvailableNextQuantity: (r as any).availableNextQuantity ?? null,
    alsoAvailabilityTimestamp: (r as any).availabilityTimestamp ? ( (r as any).availabilityTimestamp instanceof Date ? (r as any).availabilityTimestamp.toISOString() : String((r as any).availabilityTimestamp)) : null,
    // Not persisted per row: the snapshot keeps the human message instead.
    codes: [],
    message: r.message,
    issues: [],
    costPrice: r.costPrice,
    // "Before" values were read live at preview time and are not part of the
    // snapshot; the panel already guards on null.
    costBefore: null,
    stock: r.stock,
    stockBefore: null,
    // C.3.4.4: o snapshot ALSO é reaberto tal como persistido (stock de
    // fornecedor + diff); o "antes" não faz parte do snapshot.
    supplierStock: r.supplierStock,
    supplierStockBefore: null,
    diffStatus: (r.diffStatus as SupplierImportPreviewLine["diffStatus"]) ?? null,
    changedFields: (r.changedFields as string[] | null) ?? null,
    reservedStock: null,
    leadTimeDays: r.leadTimeDays,
    productId: r.productId,
    productSku: r.productSku ?? null,
    productName: r.productName ?? null,
    currentPrice: r.currentPrice,
    computedPrice: r.computedPrice,
    priceMode: r.priceMode === "auto" || r.priceMode === "manual" ? r.priceMode : null,
    priceMessage: r.priceMessage,
    isPreferredSupplier: r.isPreferredSupplier,
  }));

  const mapping = isStringRecord(row.mapping) ? row.mapping : {};
  const summary = (row.summary as Record<string, unknown> | null) ?? {};
  const ignoredColumns = Array.isArray(summary.ignoredColumns)
    ? (summary.ignoredColumns as unknown[]).filter((c): c is string => typeof c === "string")
    : [];
  const missingProducts = isMissingProductsReport(summary.missingProducts)
    ? summary.missingProducts
    : {
        action: "none" as const, comparedToImportId: null, comparedToFinishedAt: null,
        count: 0, ambiguous: 0, skippedReason: "NOT_PERSISTED", items: [],
      };

  return {
    importId: row.id,
    supplierId: row.supplierId,
    supplierName: row.supplierName ?? "",
    fileName: row.fileName,
    sourceId: row.sourceId,
    sourceLabel: row.sourceLabel,
    fileHash: row.fileHash,
    fileSizeBytes: row.fileSizeBytes,
    // C.3.4.3.1 — o formato efetivo é rederivado do snapshot (o conteúdo do
    // ficheiro não é persistido): assinatura do mapping + nome do ficheiro.
    // A UI reaberta mostra o MESMO mecanismo do preview original — nunca o
    // mapeamento C.3.2 num snapshot ALSO.
    format: inferSupplierImportFormat(row.fileName, mapping),
    // Headers/delimiter are not part of the snapshot: only the mapping is.
    // The panel already treats `delimiter: null` as "not applicable".
    delimiter: null,
    headers: Object.keys(mapping),
    mapping,
    ignoredColumns,
    status: row.status,
    summary,
    lines,
    truncated,
    missingProducts,
    // Same module, same secret, same TTL/kind and the same four-field binding
    // as the token the original preview issued — apply cannot tell them apart,
    // and this one is just as useless against any other import.
    previewToken: createSupplierImportToken({
      importId: row.id, supplierId: row.supplierId, fileHash: row.fileHash, rowCount: row.rowCount,
    }),
    batchesTotal: row.batchesTotal,
    batchSize: SUPPLIER_IMPORT_BATCH_SIZE,
    reopened: true,
  };
}

/** Shape guard for the missing-products report persisted inside `summary`. */
function isMissingProductsReport(value: unknown): value is MissingProductsReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return v.action === "none" && typeof v.count === "number" && Array.isArray(v.items);
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

// ─── C.3.2 — Perfil de importação por fornecedor ──
export interface SupplierImportProfile {
  id: number;
  supplierId: number;
  mapping: Record<string, string>;
  delimiter?: string | null;
  createdBy?: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Type guard for JSONB mapping returned from the database. */
function isStringRecord(value: unknown): value is Record<string, string> {
  if (value === null || value === undefined) return false;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  for (const [k, v] of Object.entries(value)) {
    if (typeof k !== "string") return false;
    if (typeof v !== "string") return false;
  }
  return true;
}

/**
 * C.3.2 — o JSONB `mapping` pode chegar como STRING JSON (dupla codificação,
 * ex.: "{\"nome\":\"name\",…}" — a forma exata encontrada em staging). Aceita:
 *  - objeto Record<string,string> diretamente;
 *  - string JSON válida que, após JSON.parse, seja Record<string,string>.
 * Qualquer outra forma é inválida → null.
 */
function parseProfileMapping(value: unknown): Record<string, string> | null {
  if (isStringRecord(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (isStringRecord(parsed)) return parsed;
    } catch {
      // string que não é JSON — inválida, cai no return null
    }
  }
  return null;
}

/** Descreve apenas a FORMA do valor (para log seguro), nunca o conteúdo. */
function describeMappingShape(value: unknown): string {
  if (value === null || value === undefined) return "vazio";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "objeto com valores não-string";
  if (typeof value === "string") return "string sem objeto Record válido";
  return typeof value;
}

/** Mapping manual só conta quando tem pelo menos uma entrada string→string. */
function hasManualMappingEntries(mapping: Record<string, string> | undefined): boolean {
  return !!mapping && Object.values(mapping).some((v) => typeof v === "string");
}

/** Carrega o perfil ativo de um fornecedor (0 ou 1 devido ao UNIQUE). */
export async function loadSupplierProfile(supplierId: number): Promise<SupplierImportProfile | null> {
  const [rawProfile] = await db.select({
    id: supplierImportProfiles.id,
    supplierId: supplierImportProfiles.supplierId,
    mapping: supplierImportProfiles.mapping,
    delimiter: supplierImportProfiles.delimiter,
    createdBy: supplierImportProfiles.createdBy,
    createdAt: supplierImportProfiles.createdAt,
    updatedAt: supplierImportProfiles.updatedAt,
  }).from(supplierImportProfiles).where(eq(supplierImportProfiles.supplierId, supplierId)).limit(1);
  if (!rawProfile) return null;
  const mapping = parseProfileMapping(rawProfile.mapping);
  if (!mapping) {
    // Mapping corrompido/inválido no JSONB — não é engolido em silêncio: fica
    // logged de forma SEGURA (apenas ids e a forma do valor — nunca o conteúdo
    // do mapping nem dados do ficheiro) e o perfil é tratado como ausente,
    // mantendo o preview funcional via autoMapHeaders/fallback.
    console.warn(
      `[supplier-import] perfil #${rawProfile.id} do fornecedor #${rawProfile.supplierId} ignorado: mapping JSONB inválido (${describeMappingShape(rawProfile.mapping)})`
    );
    return null;
  }
  return {
    id: rawProfile.id,
    supplierId: rawProfile.supplierId,
    mapping,
    delimiter: rawProfile.delimiter,
    createdBy: rawProfile.createdBy,
    createdAt: rawProfile.createdAt,
    updatedAt: rawProfile.updatedAt,
  };
}

/** Guarda (INSERT ou UPDATE) o perfil para um fornecedor. */
export async function saveSupplierProfile(
  supplierId: number,
  mapping: Record<string, string>,
  delimiter?: string | null,
  userId?: number
): Promise<{ id: number; updated: boolean }> {
  const existing = await loadSupplierProfile(supplierId);
  if (existing) {
    await db.update(supplierImportProfiles).set({
      mapping,
      delimiter: delimiter ?? null,
      updatedAt: new Date(),
    }).where(eq(supplierImportProfiles.id, existing.id));
    return { id: existing.id, updated: true };
  }
  const [created] = await db.insert(supplierImportProfiles).values({
    supplierId,
    mapping,
    delimiter: delimiter ?? null,
    createdBy: userId ?? null,
  }).returning({ id: supplierImportProfiles.id });
  return { id: created.id, updated: false };
}

// ─── C.3.3 (etapa 1) — movidos para @/lib/supplier-import/file ──
// `isProfileCompatibleWithHeaders` e o tipo `ProfileResolution` passaram a viver
// junto da resolução mapping/perfil (pura, agnóstica ao formato). Mantêm-se
// exportados DAQUI para não partir os importadores C.3.2 existentes.
export { isProfileCompatibleWithHeaders } from "@/lib/supplier-import/file";
export type { ProfileResolution } from "@/lib/supplier-import/file";
