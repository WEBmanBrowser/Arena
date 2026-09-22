import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { products, categories, brands } from "@/db/schema";
import { getSupplierAvailabilityByProductIds } from "@/lib/supplier-stock";
import { eq, and, ilike, gte, lte, desc, asc, sql, or } from "drizzle-orm";
import { publicProductListSelect, getPrimaryImageUrls, sanitizeForPublic } from "@/lib/public-products";
import { getCategoryAndDescendantIds } from "@/lib/category-descendants";

export async function GET(req: NextRequest) {
  try {
    const url = req.nextUrl;
    const page = parseInt(url.searchParams.get("page") || "1");
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "20"), 60);
    const offset = (page - 1) * limit;
    const search = url.searchParams.get("q");
    const cat = url.searchParams.get("cat");
    const brand = url.searchParams.get("brand");
    const minPrice = url.searchParams.get("minPrice");
    const maxPrice = url.searchParams.get("maxPrice");
    const sort = url.searchParams.get("sort") || "newest";
    const featured = url.searchParams.get("featured");
    const service = url.searchParams.get("service");
    const inStock = url.searchParams.get("inStock");

    const conditions = [eq(products.isActive, true)];

    if (search) {
      conditions.push(
        or(
          ilike(products.name, `%${search}%`),
          ilike(products.shortDescription, `%${search}%`),
          ilike(products.sku, `%${search}%`)
        )!
      );
    }
    if (cat) {
      const [category] = await db.select().from(categories).where(eq(categories.slug, cat)).limit(1);
      if (category) {
        // Use shared helper for recursive category resolution
        const catIds = await getCategoryAndDescendantIds(category.id);
        if (catIds.length > 0) {
          conditions.push(sql`${products.categoryId} IN (${sql.join(catIds.map(id => sql`${id}`), sql`, `)})`);
        }
      }
    }
    if (brand) {
      const [b] = await db.select().from(brands).where(eq(brands.slug, brand)).limit(1);
      if (b) conditions.push(eq(products.brandId, b.id));
    }
    if (minPrice) conditions.push(gte(products.price, minPrice));
    if (maxPrice) conditions.push(lte(products.price, maxPrice));
    if (featured === "true") conditions.push(eq(products.isFeatured, true));
    if (service === "true") conditions.push(eq(products.isService, true));
    if (inStock === "true") conditions.push(sql`(
      ${products.stock} - ${products.reservedStock} > 0
      OR EXISTS (
        SELECT 1 FROM product_suppliers ps
        JOIN suppliers s ON s.id = ps.supplier_id
        WHERE ps.product_id = ${products.id}
          AND s.is_active = true
          AND greatest(coalesce(ps.supplier_stock, 0) - ps.supplier_reserved_stock, 0) > 0
      )
    )`);

    let orderBy;
    switch (sort) {
      case "price_asc": orderBy = asc(products.price); break;
      case "price_desc": orderBy = desc(products.price); break;
      case "popular": orderBy = desc(products.soldCount); break;
      case "name": orderBy = asc(products.name); break;
      default: orderBy = desc(products.createdAt);
    }

    const [countResult] = await db.select({ count: sql<number>`count(*)` }).from(products).where(and(...conditions));
    const total = Number(countResult.count);

    const items = await db.select(publicProductListSelect).from(products)
      .where(and(...conditions))
      .orderBy(orderBy)
      .limit(limit)
      .offset(offset);

    // Batch-load primary images (no N+1) + sanitize (remove reservedStock, add availableStock)
    const productIds = items.map(i => i.id);
    const [imgMap, supplierAvailability] = await Promise.all([
      getPrimaryImageUrls(productIds),
      getSupplierAvailabilityByProductIds(db, productIds),
    ]);
    const enriched = items.map(i => {
      const base = sanitizeForPublic(i);
      const localAvailableStock = Math.max(0, i.stock - i.reservedStock);
      const supplierAvailableStock = supplierAvailability.get(i.id) ?? 0;
      return {
        ...base,
        localAvailableStock,
        supplierAvailableStock,
        availableStock: i.isService ? 999 : localAvailableStock + supplierAvailableStock,
        stockSource: i.isService ? "service" : localAvailableStock > 0 ? "local" : supplierAvailableStock > 0 ? "supplier" : "none",
        primaryImageUrl: imgMap[i.id] || i.images?.[0] || null,
      };
    });

    return NextResponse.json({ products: enriched, total, page, pages: Math.ceil(total / limit) });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "Erro ao carregar produtos" }, { status: 500 });
  }
}
