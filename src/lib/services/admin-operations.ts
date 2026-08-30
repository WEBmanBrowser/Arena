/**
 * Admin operation handlers — orchestrate existing services + audit.
 * Routes call THESE. Tests call THESE. Same audit behavior.
 */
import { applyBulkPricing } from "./bulk-pricing-service";
import { updateAlt, deleteImage } from "./product-image-service";
import { deleteProductSupplier } from "./product-supplier-service";
import { createAuditLog } from "@/lib/audit";
import type { StorageProvider } from "@/lib/storage/types";

/** Bulk price apply with audit */
export async function executeBulkPriceApply(actorId: number, previewToken: string) {
  const result = await applyBulkPricing(previewToken);
  await createAuditLog({
    userId: actorId,
    action: "bulk.price_update",
    entity: "products",
    details: { count: result.updated, changes: result.changes.slice(0, 100) },
  });
  return result;
}

/** Image alt update with audit (no-op aware) */
export async function executeImageAltUpdate(actorId: number, productId: number, imageId: number, altText: string | null) {
  const result = await updateAlt(productId, imageId, altText);
  if (result.changed) {
    await createAuditLog({
      userId: actorId,
      action: "image.alt_updated",
      entity: "product_image",
      entityId: imageId,
      details: { productId, oldAlt: result.oldAlt, newAlt: altText },
    });
  }
  return result;
}

/** Image delete with audit */
export async function executeImageDelete(actorId: number, productId: number, imageId: number, storage: StorageProvider | null) {
  await deleteImage(productId, imageId, storage);
  await createAuditLog({
    userId: actorId,
    action: "image.deleted",
    entity: "product_image",
    entityId: imageId,
    details: { productId },
  });
}

/** Product supplier delete with audit (ownership-safe) */
export async function executeProductSupplierDelete(actorId: number, productId: number, psId: number) {
  const result = await deleteProductSupplier(productId, psId);
  await createAuditLog({
    userId: actorId,
    action: "product_supplier.deleted",
    entity: "product_supplier",
    entityId: psId,
    details: { productId },
  });
  return result;
}
