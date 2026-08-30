import { NextResponse } from "next/server";
import { db } from "@/db";
import { categories } from "@/db/schema";
import { eq, asc } from "drizzle-orm";

/** Public categories endpoint — no auth required */
export async function GET() {
  const cats = await db.select({
    id: categories.id,
    name: categories.name,
    slug: categories.slug,
    parentId: categories.parentId,
    icon: categories.icon,
    sortOrder: categories.sortOrder,
  }).from(categories).where(eq(categories.isActive, true)).orderBy(asc(categories.sortOrder), asc(categories.name));
  return NextResponse.json({ categories: cats });
}
