import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { products, categories, brands } from "@/db/schema";
import { ilike, eq, and, or } from "drizzle-orm";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q");
  if (!q || q.length < 2) return NextResponse.json({ products: [], categories: [], brands: [] });

  const prods = await db.select({
    id: products.id, name: products.name, slug: products.slug, price: products.price, images: products.images,
  }).from(products)
    .where(and(eq(products.isActive, true), or(ilike(products.name, `%${q}%`), ilike(products.sku, `%${q}%`))))
    .limit(6);

  const cats = await db.select({ id: categories.id, name: categories.name, slug: categories.slug, icon: categories.icon })
    .from(categories)
    .where(and(eq(categories.isActive, true), ilike(categories.name, `%${q}%`)))
    .limit(4);

  const brnds = await db.select({ id: brands.id, name: brands.name, slug: brands.slug })
    .from(brands)
    .where(and(eq(brands.isActive, true), ilike(brands.name, `%${q}%`)))
    .limit(4);

  return NextResponse.json({ products: prods, categories: cats, brands: brnds });
}
