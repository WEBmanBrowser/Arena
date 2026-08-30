import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { suppliers } from "@/db/schema";
import { eq, asc } from "drizzle-orm";
import { getCurrentUser, isStaff, isManager } from "@/lib/auth";
import { createAuditLog } from "@/lib/audit";
import { createSupplierSchema, updateSupplierSchema, validate } from "@/lib/validation";

export async function GET() {
  const user = await getCurrentUser();
  if (!user || !isStaff(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });
  const items = await db.select().from(suppliers).orderBy(asc(suppliers.name));
  return NextResponse.json({ suppliers: items });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user || !isManager(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });
  const raw = await req.json();
  const v = validate(createSupplierSchema, raw);
  if (!v.success) return NextResponse.json({ error: "VALIDATION_ERROR", details: v.error }, { status: 400 });
  const d = v.data;
  const [supplier] = await db.insert(suppliers).values({
    name: d.name, legalName: d.legalName || null, taxId: d.taxId || null,
    email: d.email || null, phone: d.phone || null, website: d.website || null,
    contactName: d.contactName || null, notes: d.notes || null, isActive: d.isActive !== false,
  }).returning();
  await createAuditLog({ userId: user.id, action: "supplier.created", entity: "supplier", entityId: supplier.id });
  return NextResponse.json({ supplier });
}

export async function PUT(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user || !isManager(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });
  const raw = await req.json();
  const id = raw?.id ? parseInt(String(raw.id)) : 0;
  if (!id || id < 1) return NextResponse.json({ error: "ID obrigatório" }, { status: 400 });
  const v = validate(updateSupplierSchema, raw);
  if (!v.success) return NextResponse.json({ error: "VALIDATION_ERROR", details: v.error }, { status: 400 });
  const d = v.data;
  const updateData: Record<string, unknown> = { updatedAt: new Date() };
  if (d.name !== undefined) updateData.name = d.name;
  if (d.legalName !== undefined) updateData.legalName = d.legalName || null;
  if (d.taxId !== undefined) updateData.taxId = d.taxId || null;
  if (d.email !== undefined) updateData.email = d.email || null;
  if (d.phone !== undefined) updateData.phone = d.phone || null;
  if (d.website !== undefined) updateData.website = d.website || null;
  if (d.contactName !== undefined) updateData.contactName = d.contactName || null;
  if (d.notes !== undefined) updateData.notes = d.notes || null;
  if (d.isActive !== undefined) updateData.isActive = d.isActive;
  const [supplier] = await db.update(suppliers).set(updateData).where(eq(suppliers.id, id)).returning();
  await createAuditLog({ userId: user.id, action: "supplier.updated", entity: "supplier", entityId: id });
  return NextResponse.json({ supplier });
}
