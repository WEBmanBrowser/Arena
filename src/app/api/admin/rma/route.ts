import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { rmaRequests, users, RMA_STATUSES } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { getCurrentUser, isStaff } from "@/lib/auth";
import { z } from "zod";
import { createAuditLog } from "@/lib/audit";

const updateRmaSchema = z.object({
  id: z.number().int().positive(),
  status: z.enum(RMA_STATUSES).optional(),
  adminNotes: z.string().trim().max(5000).nullable().optional(),
  resolution: z.string().trim().max(5000).nullable().optional(),
}).strict().refine(v => v.status !== undefined || v.adminNotes !== undefined || v.resolution !== undefined, "NO_CHANGES");

export async function GET() {
  const user = await getCurrentUser();
  if (!user || !isStaff(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });
  const items = await db.select({
    id: rmaRequests.id, type: rmaRequests.type, status: rmaRequests.status, reason: rmaRequests.reason,
    description: rmaRequests.description, adminNotes: rmaRequests.adminNotes, resolution: rmaRequests.resolution,
    attachments: rmaRequests.attachments, createdAt: rmaRequests.createdAt, updatedAt: rmaRequests.updatedAt,
    userId: rmaRequests.userId, orderId: rmaRequests.orderId, productId: rmaRequests.productId,
    userName: users.name, userEmail: users.email,
  }).from(rmaRequests).leftJoin(users, eq(rmaRequests.userId, users.id)).orderBy(desc(rmaRequests.createdAt));
  return NextResponse.json({ rmaRequests: items });
}

export async function PUT(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user || !isStaff(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });
  const parsed = updateRmaSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "VALIDATION_ERROR", issues: parsed.error.issues }, { status: 400 });
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (parsed.data.status !== undefined) update.status = parsed.data.status;
  if (parsed.data.adminNotes !== undefined) update.adminNotes = parsed.data.adminNotes || null;
  if (parsed.data.resolution !== undefined) update.resolution = parsed.data.resolution || null;
  const [rma] = await db.update(rmaRequests).set(update).where(eq(rmaRequests.id, parsed.data.id)).returning();
  if (!rma) return NextResponse.json({ error: "RMA_NOT_FOUND" }, { status: 404 });
  await createAuditLog({ userId: user.id, action: "rma.updated", entity: "rma", entityId: rma.id, details: { status: rma.status } });
  return NextResponse.json({ rma });
}
