import { NextRequest, NextResponse } from "next/server";
import { csrfGuard } from "@/lib/csrf";
import { db } from "@/db";
import { orders, rmaRequests } from "@/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import { z } from "zod";

const createRmaSchema = z.object({
  orderId: z.number().int().positive().nullable().optional(),
  type: z.enum(["repair", "rma", "return", "support"]).default("repair"),
  reason: z.string().trim().max(255).nullable().optional(),
  description: z.string().trim().min(10).max(5000),
  attachments: z.array(z.string().trim().min(1).max(1000)).max(10).default([]),
}).strict();

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  const items = await db.select().from(rmaRequests).where(eq(rmaRequests.userId, user.id)).orderBy(desc(rmaRequests.createdAt));
  return NextResponse.json({ rmaRequests: items });
}

export async function POST(req: NextRequest) {
  const csrf = csrfGuard(req);
  if (csrf) return csrf;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  const parsed = createRmaSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "VALIDATION_ERROR", issues: parsed.error.issues }, { status: 400 });

  if (parsed.data.orderId) {
    const [owned] = await db.select({ id: orders.id }).from(orders)
      .where(and(eq(orders.id, parsed.data.orderId), eq(orders.userId, user.id))).limit(1);
    if (!owned) return NextResponse.json({ error: "Encomenda não encontrada" }, { status: 404 });
  }

  const [rma] = await db.insert(rmaRequests).values({
    userId: user.id,
    orderId: parsed.data.orderId ?? null,
    type: parsed.data.type,
    status: "requested",
    reason: parsed.data.reason ?? null,
    description: parsed.data.description,
    attachments: parsed.data.attachments,
  }).returning();
  return NextResponse.json({ rma }, { status: 201 });
}
