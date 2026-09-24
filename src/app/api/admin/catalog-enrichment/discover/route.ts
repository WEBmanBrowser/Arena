import { NextRequest, NextResponse } from "next/server";
import { createAuditLog } from "@/lib/audit";
import { getCurrentUser, isManager, isStaff } from "@/lib/auth";
import { discoverCatalogBatch, getDiscoverySummary, resetDiscoveryAttempts } from "@/lib/catalog-enrichment/discovery-service";
import { z } from "zod";

const runSchema = z.object({ action: z.literal("run"), supplierId: z.number().int().positive(), provider: z.literal("upcitemdb"), limit: z.number().int().min(1).max(25).default(10) });
const resetSchema = z.object({ action: z.literal("reset"), supplierId: z.number().int().positive(), provider: z.literal("upcitemdb"), statuses: z.array(z.enum(["not_found","error","rate_limited","skipped"])).min(1) });

export async function GET(req: NextRequest) {
  const user = await getCurrentUser(); if (!user || !isStaff(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });
  const supplierId = Number(req.nextUrl.searchParams.get("supplierId")); if (!Number.isInteger(supplierId) || supplierId < 1) return NextResponse.json({ error: "Fornecedor inválido" }, { status: 400 });
  return NextResponse.json(await getDiscoverySummary(supplierId));
}
export async function POST(req: NextRequest) {
  const user = await getCurrentUser(); if (!user || !isManager(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });
  const raw = await req.json(); const run = runSchema.safeParse(raw);
  if (run.success) { const result = await discoverCatalogBatch(run.data); await createAuditLog({ userId:user.id, action:"catalog_enrichment.discovery_batch", entity:"supplier", entityId:run.data.supplierId, details:{provider:run.data.provider,processed:result.processed} }); return NextResponse.json(result); }
  const reset = resetSchema.safeParse(raw); if (reset.success) { const result=await resetDiscoveryAttempts(reset.data.supplierId,reset.data.provider,reset.data.statuses); await createAuditLog({ userId:user.id, action:"catalog_enrichment.discovery_reset", entity:"supplier", entityId:reset.data.supplierId, details:{provider:reset.data.provider,statuses:reset.data.statuses,deleted:result.deleted} }); return NextResponse.json(result); }
  return NextResponse.json({ error:"VALIDATION_ERROR" }, { status:400 });
}
