import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { settings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getCurrentUser, isAdmin } from "@/lib/auth";

export async function GET() {
  const all = await db.select().from(settings);
  const map: Record<string, string> = {};
  for (const s of all) map[s.key] = s.value || "";
  return NextResponse.json({ settings: map });
}

export async function PUT(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user || !isAdmin(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

  const body = await req.json();
  for (const [key, value] of Object.entries(body)) {
    const [existing] = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
    if (existing) {
      await db.update(settings).set({ value: String(value) }).where(eq(settings.key, key));
    } else {
      await db.insert(settings).values({ key, value: String(value), group: "general" });
    }
  }
  return NextResponse.json({ ok: true });
}
