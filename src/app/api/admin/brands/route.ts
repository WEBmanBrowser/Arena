import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { brands, products } from "@/db/schema";
import { eq, asc, sql } from "drizzle-orm";
import { getCurrentUser, isStaff, isManager } from "@/lib/auth";
import { slugify } from "@/lib/utils";
import { createAuditLog } from "@/lib/audit";

export async function GET() {
  const user = await getCurrentUser();
  if (!user || !isStaff(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

  const items = await db.select().from(brands).orderBy(asc(brands.sortOrder), asc(brands.name));
  // Count products per brand
  const counts = await db.select({ brandId: products.brandId, count: sql<number>`count(*)` })
    .from(products).where(eq(products.isActive, true)).groupBy(products.brandId);
  const countMap: Record<number, number> = {};
  for (const c of counts) { if (c.brandId) countMap[c.brandId] = Number(c.count); }

  return NextResponse.json({ brands: items.map(b => ({ ...b, productCount: countMap[b.id] || 0 })) });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user || !isManager(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });
  const body = await req.json() as Record<string, unknown>;
  if (!body.name) return NextResponse.json({ error: "Nome obrigatório" }, { status: 400 });
  const slug = (body.slug as string) || slugify(body.name as string);
  const [brand] = await db.insert(brands).values({
    name: body.name as string, slug, logo: (body.logo as string) || null,
    description: (body.description as string) || null, isActive: body.isActive !== false,
    sortOrder: parseInt(body.sortOrder as string) || 0,
  }).returning();
  await createAuditLog({ userId: user.id, action: "brand.created", entity: "brand", entityId: brand.id });
  return NextResponse.json({ brand });
}

export async function PUT(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user || !isManager(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });
  const body = await req.json() as Record<string, unknown>;
  if (!body.id) return NextResponse.json({ error: "ID obrigatório" }, { status: 400 });
  const [brand] = await db.update(brands).set({
    name: body.name as string, slug: (body.slug as string) || slugify(body.name as string),
    logo: (body.logo as string) || null, description: (body.description as string) || null,
    isActive: body.isActive !== false, sortOrder: parseInt(body.sortOrder as string) || 0,
  }).where(eq(brands.id, parseInt(body.id as string))).returning();
  await createAuditLog({ userId: user.id, action: "brand.updated", entity: "brand", entityId: brand.id });
  return NextResponse.json({ brand });
}

export async function DELETE(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user || !isManager(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });
  const body = await req.json() as Record<string, unknown>;
  const id = parseInt(body.id as string);
  const [hasProducts] = await db.select({ id: products.id }).from(products).where(eq(products.brandId, id)).limit(1);
  if (hasProducts) return NextResponse.json({ error: "Marca tem produtos associados. Desative ou transfira antes de eliminar." }, { status: 400 });
  await db.delete(brands).where(eq(brands.id, id));
  await createAuditLog({ userId: user.id, action: "brand.deleted", entity: "brand", entityId: id });
  return NextResponse.json({ ok: true });
}
