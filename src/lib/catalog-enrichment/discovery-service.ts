import { db } from "@/db";
import { brands, catalogEnrichmentAttempts, productCatalogEnrichments, productSuppliers, products } from "@/db/schema";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { stageCatalogSnapshot } from "@/lib/services/catalog-enrichment-service";
import { upcItemDbProvider } from "./providers/upcitemdb";

const providers = { upcitemdb: upcItemDbProvider } as const;
export type DiscoveryProviderId = keyof typeof providers;

export async function getDiscoverySummary(supplierId: number) {
  const rows = await db.select({ status: catalogEnrichmentAttempts.status, count: sql<number>`count(*)::int` })
    .from(catalogEnrichmentAttempts).where(eq(catalogEnrichmentAttempts.supplierId, supplierId)).groupBy(catalogEnrichmentAttempts.status);
  const [eligible] = await db.select({ count: sql<number>`count(*)::int` }).from(productSuppliers)
    .innerJoin(products, eq(products.id, productSuppliers.productId))
    .where(and(eq(productSuppliers.supplierId, supplierId), isNotNull(productSuppliers.supplierSku), isNotNull(products.ean)));
  return { eligible: eligible?.count ?? 0, attempts: Object.fromEntries(rows.map(r => [r.status, r.count])) };
}

export async function discoverCatalogBatch(params: { supplierId: number; provider: DiscoveryProviderId; limit: number }) {
  const provider = providers[params.provider];
  const attempted = db.select({ productId: catalogEnrichmentAttempts.productId }).from(catalogEnrichmentAttempts)
    .where(and(eq(catalogEnrichmentAttempts.supplierId, params.supplierId), eq(catalogEnrichmentAttempts.provider, params.provider)));
  const candidates = await db.select({
    productId: products.id, ean: products.ean, brand: brands.name, supplierSku: productSuppliers.supplierSku,
    manufacturerPartNumber: productSuppliers.manufacturerPartNumber,
  }).from(productSuppliers)
    .innerJoin(products, eq(products.id, productSuppliers.productId))
    .leftJoin(brands, eq(brands.id, products.brandId))
    .where(and(eq(productSuppliers.supplierId, params.supplierId), isNotNull(productSuppliers.supplierSku), isNotNull(products.ean), sql`${products.id} NOT IN (${attempted})`))
    .orderBy(products.id).limit(Math.max(1, Math.min(params.limit, 25)));

  const results: Array<{ productId: number; status: string; detail?: string | null; enrichmentId?: number }> = [];
  for (const c of candidates) {
    const result = await provider.lookup({ ean: c.ean, manufacturerPartNumber: c.manufacturerPartNumber, manufacturer: c.brand });
    let enrichmentId: number | undefined;
    if (result.status === "found" && c.supplierSku) {
      const snapshot = await stageCatalogSnapshot({
        productId: c.productId, supplierId: params.supplierId, supplierSku: c.supplierSku, provider: params.provider,
        sourceUrl: result.sourceUrl, shortDescription: result.shortDescription, description: result.description,
        attributes: result.attributes, images: result.images,
      });
      enrichmentId = snapshot.id;
    }
    await db.insert(catalogEnrichmentAttempts).values({
      productId: c.productId, supplierId: params.supplierId, provider: params.provider,
      lookupKey: `ean:${c.ean}`, status: result.status, detail: result.detail ?? null, retryAfter: result.retryAfter ?? null,
    });
    results.push({ productId: c.productId, status: result.status, detail: result.detail, enrichmentId });
    if (result.status === "rate_limited") break;
  }
  return { provider: params.provider, requested: params.limit, processed: results.length, results, summary: await getDiscoverySummary(params.supplierId) };
}

export async function resetDiscoveryAttempts(supplierId: number, provider: DiscoveryProviderId, statuses: string[]) {
  const allowed = statuses.filter(s => ["not_found", "error", "rate_limited", "skipped"].includes(s));
  if (!allowed.length) return { deleted: 0 };
  const deleted = await db.delete(catalogEnrichmentAttempts).where(and(eq(catalogEnrichmentAttempts.supplierId, supplierId), eq(catalogEnrichmentAttempts.provider, provider), inArray(catalogEnrichmentAttempts.status, allowed))).returning({ id: catalogEnrichmentAttempts.id });
  return { deleted: deleted.length };
}
