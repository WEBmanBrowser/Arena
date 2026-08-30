import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { wishlists, products } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });

  const items = await db.select({
    id: wishlists.id,
    productId: wishlists.productId,
    productName: products.name,
    productSlug: products.slug,
    productPrice: products.price,
    productComparePrice: products.comparePrice,
    productImages: products.images,
    productStock: products.stock,
  }).from(wishlists)
    .innerJoin(products, eq(wishlists.productId, products.id))
    .where(eq(wishlists.userId, user.id));

  return NextResponse.json({ wishlist: items });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });

  const { productId } = await req.json();
  const [existing] = await db.select().from(wishlists).where(and(eq(wishlists.userId, user.id), eq(wishlists.productId, productId))).limit(1);
  if (existing) {
    await db.delete(wishlists).where(eq(wishlists.id, existing.id));
    return NextResponse.json({ added: false });
  }
  await db.insert(wishlists).values({ userId: user.id, productId });
  return NextResponse.json({ added: true });
}
