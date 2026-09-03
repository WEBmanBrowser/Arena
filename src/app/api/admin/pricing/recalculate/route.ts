/**
 * C.2 — Impact preview and safe mass application of automatic prices.
 *
 * Two modes on one endpoint, mirroring /api/admin/bulk:
 *   { mode: "preview", ruleId }  → what would change (writes nothing)
 *   { mode: "apply", previewToken, confirmDecreases } → applies it
 *
 * Apply is manager-only and always goes through the signed token, so no client
 * can push prices that were never previewed.
 */
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser, isStaff, isManager } from "@/lib/auth";
import { validate } from "@/lib/validation";
import { recalcRequestSchema } from "@/lib/pricing-rules-schemas";
import { previewRecalculation, applyRecalculation } from "@/lib/services/pricing-recalc-service";

function mapError(e: unknown): NextResponse {
  const msg = e instanceof Error ? e.message : "";
  switch (msg) {
    case "RECALC_TOO_MANY_PRODUCTS":
      return NextResponse.json({ error: "RECALC_TOO_MANY_PRODUCTS", message: "Demasiados produtos afetados (limite 5000). Restrinja o âmbito." }, { status: 400 });
    case "RULE_NOT_FOUND":
      return NextResponse.json({ error: "RULE_NOT_FOUND", message: "Regra não encontrada" }, { status: 404 });
    case "RECALC_PREVIEW_INVALID":
      return NextResponse.json({ error: "RECALC_PREVIEW_INVALID", message: "Pré-visualização inválida" }, { status: 400 });
    case "RECALC_PREVIEW_EXPIRED":
      return NextResponse.json({ error: "RECALC_PREVIEW_EXPIRED", message: "Pré-visualização expirada. Volte a calcular o impacto." }, { status: 409 });
    case "RECALC_PREVIEW_STALE":
      return NextResponse.json({ error: "RECALC_PREVIEW_STALE", message: "Os produtos mudaram entretanto. Volte a calcular o impacto." }, { status: 409 });
    case "RECALC_DECREASES_NOT_CONFIRMED":
      return NextResponse.json({ error: "RECALC_DECREASES_NOT_CONFIRMED", message: "Existem descidas de preço que têm de ser confirmadas explicitamente." }, { status: 400 });
    case "RECALC_NOTHING_TO_APPLY":
      return NextResponse.json({ error: "RECALC_NOTHING_TO_APPLY", message: "Não há alterações para aplicar" }, { status: 400 });
    case "BULK_PREVIEW_SECRET_NOT_CONFIGURED":
      return NextResponse.json({ error: "SERVER_NOT_CONFIGURED", message: "Servidor sem segredo de pré-visualização configurado" }, { status: 500 });
    default:
      console.error("Recalculation error:", e);
      return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user || !isStaff(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

  const raw = await req.json();
  const v = validate(recalcRequestSchema, raw);
  if (!v.success) return NextResponse.json({ error: "VALIDATION_ERROR", details: v.error }, { status: 400 });

  try {
    if (v.data.mode === "preview") {
      const { mode: _mode, ...target } = v.data;
      void _mode;
      return NextResponse.json(await previewRecalculation(target));
    }

    // Applying prices is a manager action, even though staff may preview.
    if (!isManager(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });
    const result = await applyRecalculation(v.data.previewToken, {
      userId: user.id,
      confirmDecreases: v.data.confirmDecreases,
    });
    return NextResponse.json(result);
  } catch (e) {
    return mapError(e);
  }
}
