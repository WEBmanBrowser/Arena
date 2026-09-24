import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser, isStaff, isManager } from "@/lib/auth";
import { createAuditLog } from "@/lib/audit";
import { applyCatalogSnapshot, getCatalogEnrichment, stageCatalogSnapshot } from "@/lib/services/catalog-enrichment-service";
import { z } from "zod";

const imageSchema = z.object({ url: z.string().url().refine(v => v.startsWith("https://"), "HTTPS obrigatório"), alt: z.string().max(500).nullable().optional(), sourceRef: z.string().max(500).nullable().optional() });
const stageSchema = z.object({
  action: z.literal("stage"), supplierId: z.number().int().positive(), supplierSku: z.string().min(1).max(100),
  provider: z.literal("also_1worldsync").optional(), sourceUrl: z.string().url().nullable().optional(),
  shortDescription: z.string().max(5000).nullable().optional(), description: z.string().max(100000).nullable().optional(),
  attributes: z.record(z.string(), z.string()).optional(), images: z.array(imageSchema).max(50).optional(),
});
const applySchema = z.object({ action: z.literal("apply"), enrichmentId: z.number().int().positive(), applyDescription: z.boolean().default(false), applyShortDescription: z.boolean().default(false), applyAttributes: z.boolean().default(false) });

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user || !isStaff(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });
  const productId = Number((await params).id);
  if (!Number.isInteger(productId) || productId < 1) return NextResponse.json({ error: "Produto inválido" }, { status: 400 });
  try { return NextResponse.json(await getCatalogEnrichment(productId)); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: (e as Error).message === "PRODUCT_NOT_FOUND" ? 404 : 500 }); }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user || !isManager(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });
  const productId = Number((await params).id);
  const raw = await req.json();
  const stage = stageSchema.safeParse(raw);
  if (stage.success) {
    try {
      const snapshot = await stageCatalogSnapshot({ productId, ...stage.data });
      await createAuditLog({ userId: user.id, action: "catalog_enrichment.staged", entity: "product", entityId: productId, details: { enrichmentId: snapshot.id, supplierId: stage.data.supplierId, provider: snapshot.provider } });
      return NextResponse.json({ snapshot }, { status: 201 });
    } catch (e) { const m=(e as Error).message; return NextResponse.json({ error: m }, { status: m === "SUPPLIER_PRODUCT_MISMATCH" ? 409 : 500 }); }
  }
  const apply = applySchema.safeParse(raw);
  if (apply.success) {
    try {
      const result = await applyCatalogSnapshot({ productId, ...apply.data });
      await createAuditLog({ userId: user.id, action: "catalog_enrichment.applied", entity: "product", entityId: productId, details: { enrichmentId: apply.data.enrichmentId, description: apply.data.applyDescription, shortDescription: apply.data.applyShortDescription, attributes: apply.data.applyAttributes } });
      return NextResponse.json(result);
    } catch (e) { const m=(e as Error).message; return NextResponse.json({ error: m }, { status: m.endsWith("NOT_FOUND") ? 404 : 500 }); }
  }
  return NextResponse.json({ error: "VALIDATION_ERROR" }, { status: 400 });
}
