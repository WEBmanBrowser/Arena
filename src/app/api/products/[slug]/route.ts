import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { products, brands, categories } from "@/db/schema";
import { eq, and, ne, sql } from "drizzle-orm";
import { publicProductSelect, publicProductListSelect, getPublicProductImages, getPrimaryImageUrls, sanitizeForPublic } from "@/lib/public-products";
import { getSupplierAvailabilityByProductIds } from "@/lib/supplier-stock";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await params;

    const [raw] = await db.select(publicProductSelect).from(products).where(and(eq(products.slug, slug), eq(products.isActive, true))).limit(1);
    if (!raw) return NextResponse.json({ error: "Produto não encontrado" }, { status: 404 });

    // Sanitize public product and add generic local/supplier availability.
    const supplierAvailability = await getSupplierAvailabilityByProductIds(db, [raw.id]);
    const localAvailableStock = Math.max(0, raw.stock - raw.reservedStock);
    const supplierAvailableStock = supplierAvailability.get(raw.id) ?? 0;
    const product = {
      ...sanitizeForPublic(raw),
      localAvailableStock,
      supplierAvailableStock,
      availableStock: raw.isService ? 999 : localAvailableStock + supplierAvailableStock,
      stockSource: raw.isService ? "service" : localAvailableStock > 0 ? "local" : supplierAvailableStock > 0 ? "supplier" : "none",
    };

    let brand = null;
    if (product.brandId) {
      const [b] = await db.select({ id: brands.id, name: brands.name, slug: brands.slug }).from(brands).where(eq(brands.id, product.brandId)).limit(1);
      brand = b || null;
    }
    let category = null;
    if (product.categoryId) {
      const [c] = await db.select({ id: categories.id, name: categories.name, slug: categories.slug }).from(categories).where(eq(categories.id, product.categoryId)).limit(1);
      category = c || null;
    }

    // Consolidated gallery: productImages first, legacy fallback
    const r2Images = await getPublicProductImages(raw.id);
    let gallery: Array<{ id: number | null; url: string | null; altText: string | null; sortOrder: number; isPrimary: boolean }>;
    if (r2Images.length > 0) {
      gallery = r2Images;
    } else if (raw.images && Array.isArray(raw.images) && raw.images.length > 0) {
      gallery = (raw.images as string[]).map((url, i) => ({ id: null, url, altText: product.name, sortOrder: i, isPrimary: i === 0 }));
    } else {
      gallery = [];
    }

    const primaryImageUrl = gallery.find(g => g.isPrimary)?.url || gallery[0]?.url || null;

    // Related products with images
    const related = product.categoryId
      ? await db.select(publicProductListSelect).from(products)
          .where(and(eq(products.categoryId, product.categoryId), ne(products.id, raw.id), eq(products.isActive, true)))
          .limit(4)
      : [];
    const relatedIds = related.map(r => r.id);
    const [relImgMap, relatedSupplierAvailability] = await Promise.all([
      getPrimaryImageUrls(relatedIds),
      getSupplierAvailabilityByProductIds(db, relatedIds),
    ]);
    const enrichedRelated = related.map(r => {
      const local = Math.max(0, r.stock - r.reservedStock);
      const supplier = relatedSupplierAvailability.get(r.id) ?? 0;
      return {
        ...sanitizeForPublic(r),
        localAvailableStock: local,
        supplierAvailableStock: supplier,
        availableStock: r.isService ? 999 : local + supplier,
        stockSource: r.isService ? "service" : local > 0 ? "local" : supplier > 0 ? "supplier" : "none",
        primaryImageUrl: relImgMap[r.id] || r.images?.[0] || null,
      };
    });

    // Increment view count (fire and forget)
    db.update(products).set({ viewCount: sql`${products.viewCount} + 1` }).where(eq(products.id, raw.id)).catch(() => {});

    // Remove legacy images field from product response
    const { images: _legacyImages, ...productWithoutLegacy } = product;

    return NextResponse.json({
      product: { ...productWithoutLegacy, primaryImageUrl, images: gallery },
      brand, category,
      related: enrichedRelated,
    });
  } catch {
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
