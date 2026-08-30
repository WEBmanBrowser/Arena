import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { rmaRequests } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  const items = await db.select().from(rmaRequests).where(eq(rmaRequests.userId, user.id)).orderBy(desc(rmaRequests.createdAt));
  return NextResponse.json({ rmaRequests: items });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });

  const body = await req.json();
  const [rma] = await db.insert(rmaRequests).values({
    userId: user.id,
    orderId: body.orderId || null,
    type: body.type || "repair",
    status: "requested",
    description: body.description,
    attachments: body.attachments || [],
  }).returning();

  return NextResponse.json({ rma });
}
