import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { productSuppliers, suppliers, products } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { getCurrentUser, isStaff, isManager } from "@/lib/auth";
import { createAuditLog } from "@/lib/audit";
import { validate, createProductSupplierSchema, updateProductSupplierSchema } from "@/lib/validation";
import { executeProductSupplierDelete } from "@/lib/services/admin-operations";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

/**
 * Collect the message of an error and of its nested causes.
 *
 * The driver wraps constraint violations, so the PostgreSQL detail
 * ("duplicate key value violates unique constraint ...") is only present on
 * `error.cause`. Matching just `error.message` silently missed every unique
 * violation and returned 500 instead of a 409.
 */
function errorMessageChain(e: unknown): string {
  const parts: string[] = [];
  let current: unknown = e;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    parts.push(current.message);
    current = (current as Error).cause;
  }
  return parts.join(" | ");
}

function catchPSViolation(e: unknown): NextResponse | null {
  const msg = errorMessageChain(e);
  if (msg.includes("ps_product_supplier_unique")) return NextResponse.json({ error: "PRODUCT_SUPPLIER_ALREADY_EXISTS" }, { status: 409 });
  if (msg.includes("ps_preferred_unique")) return NextResponse.json({ error: "PREFERRED_SUPPLIER_CONFLICT" }, { status: 409 });
  return null;
}

/** Sync products.costPrice from current preferred supplier. Uses typed db parameter. */
async function syncProductCost(txDb: NodePgDatabase, productId: number) {
  const [preferred] = await txDb.select({ costPrice: productSuppliers.costPrice })
    .from(productSuppliers)
    .where(and(eq(productSuppliers.productId, productId), eq(productSuppliers.isPreferred, true)))
    .limit(1);
  const newCost = preferred ? preferred.costPrice : null;
  await txDb.update(products).set({ costPrice: newCost, updatedAt: new Date() }).where(eq(products.id, productId));
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user || !isStaff(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });
  const { id } = await params;
  const items = await db.select({
    id: productSuppliers.id, supplierId: productSuppliers.supplierId, supplierName: suppliers.name,
    supplierSku: productSuppliers.supplierSku, costPrice: productSuppliers.costPrice,
    lastCostPrice: productSuppliers.lastCostPrice, leadTimeDays: productSuppliers.leadTimeDays,
    isPreferred: productSuppliers.isPreferred,
  }).from(productSuppliers).innerJoin(suppliers, eq(productSuppliers.supplierId, suppliers.id))
    .where(eq(productSuppliers.productId, parseInt(id)));
  return NextResponse.json({ suppliers: items });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user || !isManager(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });
  const { id } = await params;
  const productId = parseInt(id);

  const raw = await req.json();
  const v = validate(createProductSupplierSchema, raw);
  if (!v.success) return NextResponse.json({ error: "VALIDATION_ERROR", details: v.error }, { status: 400 });
  const d = v.data;

  const isPreferred = d.isPreferred ?? false;
  // Resolve costPrice: number→string, null→null, undefined→null
  const costPrice = d.costPrice !== undefined && d.costPrice !== null
    ? parseFloat(String(d.costPrice)).toFixed(2)
    : null;

  try {
    await db.transaction(async (tx) => {
      if (isPreferred) {
        await tx.update(productSuppliers).set({ isPreferred: false, updatedAt: new Date() })
          .where(and(eq(productSuppliers.productId, productId), eq(productSuppliers.isPreferred, true)));
      }
      await tx.insert(productSuppliers).values({
        productId, supplierId: d.supplierId,
        supplierSku: d.supplierSku ?? null,
        costPrice, lastCostPrice: null,
        leadTimeDays: d.leadTimeDays ?? null,
        isPreferred,
      });
      await syncProductCost(tx as unknown as NodePgDatabase, productId);
    });
    await createAuditLog({ userId: user.id, action: "product_supplier.created", entity: "product_supplier", details: { productId, supplierId: d.supplierId, isPreferred } });
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (e) {
    const mapped = catchPSViolation(e);
    if (mapped) return mapped;
    console.error("PS create error:", e);
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user || !isManager(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });
  const { id } = await params;
  const productId = parseInt(id);

  const raw = await req.json();
  const v = validate(updateProductSupplierSchema, raw);
  if (!v.success) return NextResponse.json({ error: "VALIDATION_ERROR", details: v.error }, { status: 400 });
  const d = v.data;

  try {
    await db.transaction(async (tx) => {
      const [current] = await tx.select().from(productSuppliers).where(eq(productSuppliers.id, d.psId)).limit(1);
      if (!current || current.productId !== productId) throw new Error("VALIDATION:Não encontrado");

      const newPreferred = d.isPreferred !== undefined ? d.isPreferred : current.isPreferred;
      if (newPreferred && !current.isPreferred) {
        await tx.update(productSuppliers).set({ isPreferred: false, updatedAt: new Date() })
          .where(and(eq(productSuppliers.productId, productId), eq(productSuppliers.isPreferred, true)));
      }

      // Cost price: undefined=no change, null=clear, number/string=set
      let newCost: string | null = current.costPrice;
      let newLastCost: string | null = current.lastCostPrice;
      if (d.costPrice !== undefined) {
        const costStr = d.costPrice === null ? null : parseFloat(String(d.costPrice)).toFixed(2);
        if (costStr !== current.costPrice) {
          newLastCost = current.costPrice;
          newCost = costStr;
        }
      }

      await tx.update(productSuppliers).set({
        supplierSku: d.supplierSku !== undefined ? (d.supplierSku ?? null) : current.supplierSku,
        costPrice: newCost, lastCostPrice: newLastCost,
        leadTimeDays: d.leadTimeDays !== undefined ? (d.leadTimeDays ?? null) : current.leadTimeDays,
        isPreferred: newPreferred, updatedAt: new Date(),
      }).where(eq(productSuppliers.id, d.psId));

      await syncProductCost(tx as unknown as NodePgDatabase, productId);
    });
    await createAuditLog({ userId: user.id, action: "product_supplier.updated", entity: "product_supplier", entityId: d.psId });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (msg.startsWith("VALIDATION:")) return NextResponse.json({ error: msg.replace("VALIDATION:", "") }, { status: 400 });
    const mapped = catchPSViolation(e);
    if (mapped) return mapped;
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user || !isManager(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });
  const { id } = await params;
  const productId = parseInt(id);
  const raw = await req.json();
  const psId = raw?.psId ? parseInt(String(raw.psId)) : 0;
  if (!psId) return NextResponse.json({ error: "psId obrigatório" }, { status: 400 });

  try {
    await executeProductSupplierDelete(user.id, productId, psId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if ((e as Error).message === "NOT_FOUND") return NextResponse.json({ error: "Não encontrado" }, { status: 404 });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
