import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { rmaRequests, users } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { getCurrentUser, isStaff } from "@/lib/auth";

export async function GET() {
  const user = await getCurrentUser();
  if (!user || !isStaff(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

  const items = await db.select({
    id: rmaRequests.id, type: rmaRequests.type, status: rmaRequests.status,
    description: rmaRequests.description, adminNotes: rmaRequests.adminNotes,
    createdAt: rmaRequests.createdAt, updatedAt: rmaRequests.updatedAt,
    userId: rmaRequests.userId, orderId: rmaRequests.orderId,
    userName: users.name, userEmail: users.email,
  }).from(rmaRequests).leftJoin(users, eq(rmaRequests.userId, users.id)).orderBy(desc(rmaRequests.createdAt));

  return NextResponse.json({ rmaRequests: items });
}

export async function PUT(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user || !isStaff(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

  const body = await req.json();
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (body.status) update.status = body.status;
  if (body.adminNotes !== undefined) update.adminNotes = body.adminNotes;

  const [rma] = await db.update(rmaRequests).set(update).where(eq(rmaRequests.id, body.id)).returning();
  return NextResponse.json({ rma });
}
