import { createHash } from "node:crypto";
import { db } from "@/db";
import { productCatalogEnrichments, productSuppliers, products } from "@/db/schema";
import { and, eq } from "drizzle-orm";

export type CatalogImageCandidate = { url: string; alt?: string | null; sourceRef?: string | null };
export type CatalogSnapshotInput = {
  productId: number;
  supplierId: number;
  supplierSku: string;
  provider?: "also_1worldsync" | "upcitemdb";
  sourceUrl?: string | null;
  shortDescription?: string | null;
  description?: string | null;
  attributes?: Record<string, string>;
  images?: CatalogImageCandidate[];
};

const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const cleanText = (v: string | null | undefined) => v?.trim() || null;
const cleanAttributes = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([k, v]) => [k.trim(), String(v ?? "").trim()])
    .filter(([k, v]) => Boolean(k && v)));
};
const canReplaceText = (current: string | null, lastAppliedHash: string | null) => {
  const normalized = cleanText(current);
  if (!normalized) return true;
  return Boolean(lastAppliedHash && sha(normalized) === lastAppliedHash);
};

/**
 * S35.2 write boundary: this service deliberately has no price/stock/catalog-master
 * fields in its input contract. ProductID is identity only.
 */
export async function stageCatalogSnapshot(input: CatalogSnapshotInput) {
  const [link] = await db.select({ id: productSuppliers.id, supplierSku: productSuppliers.supplierSku })
    .from(productSuppliers)
    .where(and(eq(productSuppliers.productId, input.productId), eq(productSuppliers.supplierId, input.supplierId)))
    .limit(1);
  if (!link || !link.supplierSku || link.supplierSku !== input.supplierSku) throw new Error("SUPPLIER_PRODUCT_MISMATCH");

  const attributes = cleanAttributes(input.attributes ?? {});
  const images = (input.images ?? []).filter(i => /^https:\/\//i.test(i.url)).slice(0, 50);
  const snapshot = {
    shortDescription: cleanText(input.shortDescription), description: cleanText(input.description), attributes, images,
  };
  const contentHash = sha(snapshot);
  const provider = input.provider ?? "also_1worldsync";
  const values = {
    productId: input.productId, supplierId: input.supplierId, supplierSku: input.supplierSku, provider,
    sourceUrl: input.sourceUrl ?? null, sourceShortDescription: snapshot.shortDescription,
    sourceDescription: snapshot.description, sourceAttributes: attributes, sourceImages: images,
    contentHash, fetchedAt: new Date(), updatedAt: new Date(),
  };
  const [row] = await db.insert(productCatalogEnrichments).values(values)
    .onConflictDoUpdate({ target: [productCatalogEnrichments.productId, productCatalogEnrichments.supplierId, productCatalogEnrichments.provider], set: values })
    .returning();
  return row;
}

export async function getCatalogEnrichment(productId: number) {
  const snapshots = await db.select().from(productCatalogEnrichments).where(eq(productCatalogEnrichments.productId, productId));
  const links = await db.select({ supplierId: productSuppliers.supplierId, supplierSku: productSuppliers.supplierSku, manufacturerPartNumber: productSuppliers.manufacturerPartNumber })
    .from(productSuppliers).where(eq(productSuppliers.productId, productId));
  const [product] = await db.select({ description: products.description, shortDescription: products.shortDescription, attributes: products.attributes })
    .from(products).where(eq(products.id, productId)).limit(1);
  if (!product) throw new Error("PRODUCT_NOT_FOUND");
  return { product, links, snapshots };
}

export async function applyCatalogSnapshot(params: { productId: number; enrichmentId: number; applyDescription: boolean; applyShortDescription: boolean; applyAttributes: boolean }) {
  const [snap] = await db.select().from(productCatalogEnrichments)
    .where(and(eq(productCatalogEnrichments.id, params.enrichmentId), eq(productCatalogEnrichments.productId, params.productId))).limit(1);
  if (!snap) throw new Error("SNAPSHOT_NOT_FOUND");
  const [current] = await db.select({ description: products.description, shortDescription: products.shortDescription, attributes: products.attributes })
    .from(products).where(eq(products.id, params.productId)).limit(1);
  if (!current) throw new Error("PRODUCT_NOT_FOUND");

  const update: Record<string, unknown> = {};
  const applied = { description: false, shortDescription: false, attributeKeys: [] as string[] };
  const protectedFields = { description: false, shortDescription: false, attributeKeys: [] as string[] };
  let nextDescriptionHash = snap.appliedDescriptionHash;
  let nextShortDescriptionHash = snap.appliedShortDescriptionHash;
  let nextAttributesSnapshot = cleanAttributes(snap.appliedAttributesSnapshot);

  if (params.applyDescription) {
    if (canReplaceText(current.description, snap.appliedDescriptionHash)) {
      update.description = snap.sourceDescription;
      nextDescriptionHash = sha(cleanText(snap.sourceDescription));
      applied.description = true;
    } else protectedFields.description = true;
  }

  if (params.applyShortDescription) {
    if (canReplaceText(current.shortDescription, snap.appliedShortDescriptionHash)) {
      update.shortDescription = snap.sourceShortDescription;
      nextShortDescriptionHash = sha(cleanText(snap.sourceShortDescription));
      applied.shortDescription = true;
    } else protectedFields.shortDescription = true;
  }

  if (params.applyAttributes) {
    const currentAttributes = cleanAttributes(current.attributes);
    const sourceAttributes = cleanAttributes(snap.sourceAttributes);
    const previousApplied = cleanAttributes(snap.appliedAttributesSnapshot);
    const merged = { ...currentAttributes };
    const owned: Record<string, string> = {};
    for (const [key, sourceValue] of Object.entries(sourceAttributes)) {
      const currentValue = currentAttributes[key];
      const previousValue = previousApplied[key];
      const supplierOwned = currentValue === undefined || (previousValue !== undefined && sha(currentValue) === sha(previousValue));
      if (supplierOwned) {
        merged[key] = sourceValue;
        owned[key] = sourceValue;
        applied.attributeKeys.push(key);
      } else {
        protectedFields.attributeKeys.push(key);
      }
    }
    update.attributes = merged;
    nextAttributesSnapshot = owned;
  }

  if (Object.keys(update).length) {
    update.updatedAt = new Date();
    await db.update(products).set(update).where(eq(products.id, params.productId));
  }
  await db.update(productCatalogEnrichments).set({
    lastAppliedAt: new Date(),
    appliedDescriptionHash: nextDescriptionHash,
    appliedShortDescriptionHash: nextShortDescriptionHash,
    appliedAttributesHash: params.applyAttributes ? sha(nextAttributesSnapshot) : snap.appliedAttributesHash,
    appliedAttributesSnapshot: nextAttributesSnapshot,
    updatedAt: new Date(),
  }).where(eq(productCatalogEnrichments.id, snap.id));
  return { ok: true, applied, protected: protectedFields };
}
