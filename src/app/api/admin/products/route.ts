import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { products, orderItems } from "@/db/schema";
import { eq, desc, asc, ilike, and, or, sql, ne } from "drizzle-orm";
import { getCurrentUser, isStaff, isManager } from "@/lib/auth";
import { slugify } from "@/lib/utils";
import { createAuditLog } from "@/lib/audit";
import { isValidGTIN, createProductSchema, updateProductSchema, validate } from "@/lib/validation";
import { buildAdminProductConditions } from "@/lib/product-filters";

function catchUniqueViolation(e: unknown): NextResponse | null {
  const msg = e instanceof Error ? e.message : "";
  if (msg.includes("products_sku_unique") || msg.includes("products_sku_key")) return NextResponse.json({ error: "SKU_ALREADY_EXISTS" }, { status: 409 });
  if (msg.includes("products_ean_unique")) return NextResponse.json({ error: "EAN_ALREADY_EXISTS" }, { status: 409 });
  if (msg.includes("products_slug_unique") || msg.includes("products_slug_key")) return NextResponse.json({ error: "SLUG_ALREADY_EXISTS" }, { status: 409 });
  return null;
}

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user || !isStaff(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

  const url = req.nextUrl;
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1"));
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "25")));
  const offset = (page - 1) * limit;
  const q = url.searchParams.get("q");
  const brandId = url.searchParams.get("brandId");
  const categoryId = url.searchParams.get("categoryId");
  const isActive = url.searchParams.get("isActive");
  const isFeatured = url.searchParams.get("isFeatured");
  const stockStatus = url.searchParams.get("stockStatus");
  const sort = url.searchParams.get("sort") || "newest";

  // Use shared filter builder (same as Bulk Pricing)
  const where = buildAdminProductConditions({
    q: q || undefined,
    brandId: brandId ? parseInt(brandId) : undefined,
    categoryId: categoryId ? parseInt(categoryId) : undefined,
    isActive: isActive === "true" ? true : isActive === "false" ? false : undefined,
    isFeatured: isFeatured === "true" ? true : isFeatured === "false" ? false : undefined,
    stockStatus: stockStatus || undefined,
  });
  let orderBy;
  switch (sort) {
    case "price_asc": orderBy = asc(products.price); break;
    case "price_desc": orderBy = desc(products.price); break;
    case "name": orderBy = asc(products.name); break;
    case "stock": orderBy = asc(products.stock); break;
    case "oldest": orderBy = asc(products.createdAt); break;
    default: orderBy = desc(products.createdAt);
  }

  const [countResult] = await db.select({ count: sql<number>`count(*)` }).from(products).where(where);
  const items = await db.select().from(products).where(where).orderBy(orderBy).limit(limit).offset(offset);
  return NextResponse.json({ products: items, total: Number(countResult.count), page, pages: Math.ceil(Number(countResult.count) / limit), limit });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user || !isManager(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

  const raw = await req.json();
  // Coerce types from form
  const input = { ...raw, stock: raw.stock != null ? Number(raw.stock) : 0, minStock: raw.minStock != null ? Number(raw.minStock) : 0, brandId: raw.brandId ? Number(raw.brandId) : null, categoryId: raw.categoryId ? Number(raw.categoryId) : null };
  const v = validate(createProductSchema, input);
  if (!v.success) return NextResponse.json({ error: "VALIDATION_ERROR", details: v.error }, { status: 400 });
  const d = v.data;

  // EAN validation
  if (d.ean && d.ean.trim()) {
    if (!isValidGTIN(d.ean.trim())) return NextResponse.json({ error: "INVALID_GTIN" }, { status: 400 });
  }

  // Price validation
  const price = parseFloat(d.price);
  if (isNaN(price) || price < 0) return NextResponse.json({ error: "Preço inválido" }, { status: 400 });

  let slug = d.slug || slugify(d.name);
  const [existingSlug] = await db.select({ id: products.id }).from(products).where(eq(products.slug, slug)).limit(1);
  if (existingSlug) slug = slug + "-" + Date.now().toString(36);

  try {
    const [product] = await db.insert(products).values({
      name: d.name, slug, sku: d.sku, ean: d.ean?.trim() || null,
      brandId: d.brandId || null, categoryId: d.categoryId || null,
      shortDescription: d.shortDescription || null, description: d.description || null,
      price: price.toFixed(2), comparePrice: d.comparePrice || null, costPrice: d.costPrice || null,
      vatRate: d.vatRate || "23.00", stock: d.stock ?? 0, minStock: d.minStock ?? 0,
      weight: d.weight || null, dimensions: d.dimensions || null,
      images: d.images || [], attributes: d.attributes || {}, tags: d.tags || [],
      isActive: d.isActive !== false, isFeatured: !!d.isFeatured, isService: !!d.isService, allowPreorder: !!d.allowPreorder,
      metaTitle: d.metaTitle || null, metaDescription: d.metaDescription || null,
    }).returning();

    await createAuditLog({ userId: user.id, action: "product.created", entity: "product", entityId: product.id, details: { sku: product.sku } });
    return NextResponse.json({ product }, { status: 201 });
  } catch (e) {
    const mapped = catchUniqueViolation(e);
    if (mapped) return mapped;
    throw e;
  }
}

export async function PUT(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user || !isManager(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

  const raw = await req.json();
  const input = { ...raw, id: raw.id ? Number(raw.id) : undefined, minStock: raw.minStock != null ? Number(raw.minStock) : undefined, brandId: raw.brandId ? Number(raw.brandId) : null, categoryId: raw.categoryId ? Number(raw.categoryId) : null };
  const v = validate(updateProductSchema, input);
  if (!v.success) return NextResponse.json({ error: "VALIDATION_ERROR", details: v.error }, { status: 400 });
  const d = v.data;

  const [existing] = await db.select().from(products).where(eq(products.id, d.id)).limit(1);
  if (!existing) return NextResponse.json({ error: "Produto não encontrado" }, { status: 404 });

  // EAN validation on update
  if (d.ean !== undefined) {
    const eanVal = d.ean?.trim() || null;
    if (eanVal) {
      if (!isValidGTIN(eanVal)) return NextResponse.json({ error: "INVALID_GTIN" }, { status: 400 });
      if (eanVal !== existing.ean) {
        const [dup] = await db.select({ id: products.id }).from(products).where(and(eq(products.ean, eanVal), ne(products.id, d.id))).limit(1);
        if (dup) return NextResponse.json({ error: "EAN_ALREADY_EXISTS" }, { status: 409 });
      }
    }
  }

  // Price validation
  if (d.price !== undefined) {
    const p = parseFloat(d.price);
    if (isNaN(p) || p < 0) return NextResponse.json({ error: "Preço inválido" }, { status: 400 });
  }

  const updateData: Record<string, unknown> = {};
  if (d.name !== undefined) { updateData.name = d.name; updateData.slug = d.slug || slugify(d.name); }
  if (d.sku !== undefined) updateData.sku = d.sku;
  if (d.ean !== undefined) updateData.ean = d.ean?.trim() || null;
  if (d.price !== undefined) updateData.price = parseFloat(d.price).toFixed(2);
  if (d.vatRate !== undefined) updateData.vatRate = d.vatRate;
  if (d.brandId !== undefined) updateData.brandId = d.brandId;
  if (d.categoryId !== undefined) updateData.categoryId = d.categoryId;
  if (d.shortDescription !== undefined) updateData.shortDescription = d.shortDescription;
  if (d.description !== undefined) updateData.description = d.description;
  if (d.comparePrice !== undefined) updateData.comparePrice = d.comparePrice;
  if (d.costPrice !== undefined) updateData.costPrice = d.costPrice;
  if (d.minStock !== undefined) updateData.minStock = d.minStock;
  if (d.isActive !== undefined) updateData.isActive = d.isActive;
  if (d.isFeatured !== undefined) updateData.isFeatured = d.isFeatured;
  if (d.metaTitle !== undefined) updateData.metaTitle = d.metaTitle;
  if (d.metaDescription !== undefined) updateData.metaDescription = d.metaDescription;
  updateData.updatedAt = new Date();

  try {
    const [updated] = await db.update(products).set(updateData).where(eq(products.id, d.id)).returning();
    const priceChanged = d.price !== undefined && d.price !== existing.price;
    await createAuditLog({ userId: user.id, action: "product.updated", entity: "product", entityId: d.id,
      details: priceChanged ? { priceFrom: existing.price, priceTo: d.price } : { name: updated.name } });
    return NextResponse.json({ product: updated });
  } catch (e) {
    const mapped = catchUniqueViolation(e);
    if (mapped) return mapped;
    throw e;
  }
}

export async function DELETE(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user || !isManager(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });
  const body = await req.json() as Record<string, unknown>;
  const id = parseInt(body.id as string);
  const [hasOrders] = await db.select({ id: orderItems.id }).from(orderItems).where(eq(orderItems.productId, id)).limit(1);
  if (hasOrders) {
    await db.update(products).set({ isActive: false, updatedAt: new Date() }).where(eq(products.id, id));
    await createAuditLog({ userId: user.id, action: "product.deactivated", entity: "product", entityId: id });
    return NextResponse.json({ ok: true, softDeleted: true });
  }
  await db.delete(products).where(eq(products.id, id));
  await createAuditLog({ userId: user.id, action: "product.deleted", entity: "product", entityId: id });
  return NextResponse.json({ ok: true });
}
