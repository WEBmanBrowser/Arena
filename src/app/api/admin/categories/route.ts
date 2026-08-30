import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { categories } from "@/db/schema";
import { eq, asc } from "drizzle-orm";
import { getCurrentUser, isStaff, isManager } from "@/lib/auth";
import { slugify } from "@/lib/utils";
import { createAuditLog } from "@/lib/audit";
import { wouldCreateCategoryCycle } from "@/lib/validation";

export async function GET() {
  const user = await getCurrentUser();
  if (!user || !isStaff(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });
  const cats = await db.select().from(categories).orderBy(asc(categories.sortOrder), asc(categories.name));
  return NextResponse.json({ categories: cats });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user || !isManager(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

  const body = await req.json() as Record<string, unknown>;
  if (!body.name) return NextResponse.json({ error: "Nome obrigatório" }, { status: 400 });

  const parentId = body.parentId ? parseInt(body.parentId as string) : null;
  const slug = (body.slug as string) || slugify(body.name as string);

  const [cat] = await db.insert(categories).values({
    name: body.name as string, slug, description: (body.description as string) || null,
    parentId, icon: (body.icon as string) || null, sortOrder: parseInt(body.sortOrder as string) || 0,
    isActive: body.isActive !== false,
  }).returning();

  await createAuditLog({ userId: user.id, action: "category.created", entity: "category", entityId: cat.id, details: { name: cat.name, parentId } });
  return NextResponse.json({ category: cat });
}

export async function PUT(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user || !isManager(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

  const body = await req.json() as Record<string, unknown>;
  const id = parseInt(body.id as string);
  if (!id) return NextResponse.json({ error: "ID obrigatório" }, { status: 400 });

  const newParentId = body.parentId ? parseInt(body.parentId as string) : null;

  // Cycle detection
  if (newParentId) {
    const allCats = await db.select({ id: categories.id, parentId: categories.parentId }).from(categories);
    if (wouldCreateCategoryCycle(id, newParentId, allCats)) {
      return NextResponse.json({ error: "CATEGORY_CYCLE_DETECTED", message: "Esta alteração criaria um ciclo na hierarquia de categorias" }, { status: 400 });
    }
  }

  const [existing] = await db.select().from(categories).where(eq(categories.id, id)).limit(1);
  const oldParentId = existing?.parentId;

  const [cat] = await db.update(categories).set({
    name: body.name as string, slug: (body.slug as string) || slugify(body.name as string),
    description: (body.description as string) || null, parentId: newParentId,
    icon: (body.icon as string) || null, sortOrder: parseInt(body.sortOrder as string) || 0,
    isActive: body.isActive !== false,
  }).where(eq(categories.id, id)).returning();

  await createAuditLog({ userId: user.id, action: "category.updated", entity: "category", entityId: id,
    details: { name: cat.name, oldParentId, newParentId } });
  return NextResponse.json({ category: cat });
}

export async function DELETE(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user || !isManager(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

  const body = await req.json() as Record<string, unknown>;
  const id = parseInt(body.id as string);
  await db.delete(categories).where(eq(categories.id, id));
  await createAuditLog({ userId: user.id, action: "category.deleted", entity: "category", entityId: id });
  return NextResponse.json({ ok: true });
}
