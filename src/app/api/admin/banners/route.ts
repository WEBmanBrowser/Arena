import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { banners } from "@/db/schema";
import { eq, asc } from "drizzle-orm";
import { getCurrentUser, isManager } from "@/lib/auth";

export async function GET() {
  const items = await db.select().from(banners).orderBy(asc(banners.sortOrder));
  return NextResponse.json({ banners: items });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user || !isManager(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

  const body = await req.json();
  const [banner] = await db.insert(banners).values({
    title: body.title,
    subtitle: body.subtitle || null,
    image: body.image || null,
    link: body.link || null,
    buttonText: body.buttonText || null,
    sortOrder: body.sortOrder || 0,
    isActive: body.isActive !== false,
  }).returning();

  return NextResponse.json({ banner });
}

export async function PUT(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user || !isManager(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

  const body = await req.json();
  const [banner] = await db.update(banners).set({
    title: body.title,
    subtitle: body.subtitle,
    image: body.image,
    link: body.link,
    buttonText: body.buttonText,
    sortOrder: body.sortOrder || 0,
    isActive: body.isActive !== false,
  }).where(eq(banners.id, body.id)).returning();

  return NextResponse.json({ banner });
}

export async function DELETE(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user || !isManager(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

  const { id } = await req.json();
  await db.delete(banners).where(eq(banners.id, id));
  return NextResponse.json({ ok: true });
}
