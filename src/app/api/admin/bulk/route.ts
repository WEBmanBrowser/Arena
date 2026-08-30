import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { products } from "@/db/schema";
import { inArray } from "drizzle-orm";
import { getCurrentUser, isManager } from "@/lib/auth";
import { createAuditLog } from "@/lib/audit";
import { previewBulkPricing } from "@/lib/services/bulk-pricing-service";
import { executeBulkPriceApply } from "@/lib/services/admin-operations";
import { previewSchema, applySchema, simpleActionSchema } from "@/lib/bulk-schemas";
import type { BulkPriceOp } from "@/lib/bulk-pricing";

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user || !isManager(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

  const raw = await req.json();
  const action = (raw as Record<string, unknown>).action;

  // Simple bulk actions
  if (typeof action === "string" && ["activate", "deactivate", "set_featured", "remove_featured", "set_category", "set_brand"].includes(action)) {
    const p = simpleActionSchema.safeParse(raw);
    if (!p.success) return NextResponse.json({ error: "VALIDATION_ERROR", details: p.error.issues.map(i => i.message).join("; ") }, { status: 400 });
    const d = p.data;
    const ids = d.ids || [];
    if (!ids.length) return NextResponse.json({ error: "NO_PRODUCTS_SELECTED" }, { status: 400 });
    const ud: Record<string, unknown> = { updatedAt: new Date() };
    if (d.action === "activate") ud.isActive = true;
    else if (d.action === "deactivate") ud.isActive = false;
    else if (d.action === "set_featured") ud.isFeatured = true;
    else if (d.action === "remove_featured") ud.isFeatured = false;
    else if (d.action === "set_category") ud.categoryId = d.value || null;
    else if (d.action === "set_brand") ud.brandId = d.value || null;
    await db.update(products).set(ud).where(inArray(products.id, ids));
    await createAuditLog({ userId: user.id, action: `bulk.${d.action}`, entity: "products", details: { count: ids.length } });
    return NextResponse.json({ ok: true, affected: ids.length });
  }

  // Price Preview — uses service
  const pp = previewSchema.safeParse(raw);
  if (pp.success) {
    const d = pp.data;
    if (d.operation.includes("percent") && d.value > 1000) return NextResponse.json({ error: "Percentagem máxima: 1000%" }, { status: 400 });
    try {
      const result = await previewBulkPricing(d.target, d.operation as BulkPriceOp, d.value);
      return NextResponse.json(result);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === "BULK_TOO_MANY_PRODUCTS" || msg === "NO_PRODUCTS_SELECTED" || msg === "NO_PRODUCTS_MATCH_FILTERS" || msg === "NEGATIVE_RESULTING_PRICE")
        return NextResponse.json({ error: msg }, { status: 400 });
      return NextResponse.json({ error: msg }, { status: 500 });
    }
  }

  // Price Apply — uses service
  const ap = applySchema.safeParse(raw);
  if (ap.success) {
    try {
      const result = await executeBulkPriceApply(user.id, ap.data.previewToken);
      return NextResponse.json({ ok: true, updated: result.updated });
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === "BULK_PREVIEW_STALE") return NextResponse.json({ error: msg }, { status: 409 });
      if (["BULK_PREVIEW_INVALID", "BULK_PREVIEW_EXPIRED", "NEGATIVE_RESULTING_PRICE"].includes(msg))
        return NextResponse.json({ error: msg }, { status: 400 });
      return NextResponse.json({ error: msg }, { status: 500 });
    }
  }

  return NextResponse.json({ error: "VALIDATION_ERROR", details: "Dados inválidos" }, { status: 400 });
}
