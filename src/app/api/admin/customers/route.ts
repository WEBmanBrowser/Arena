import { NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { getCurrentUser, isStaff } from "@/lib/auth";

export async function GET() {
  const user = await getCurrentUser();
  if (!user || !isStaff(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

  const customers = await db.select({
    id: users.id, email: users.email, name: users.name, phone: users.phone,
    nif: users.nif, company: users.company, role: users.role, isActive: users.isActive, createdAt: users.createdAt,
  }).from(users).where(eq(users.role, "customer")).orderBy(desc(users.createdAt)).limit(200);

  return NextResponse.json({ customers });
}
