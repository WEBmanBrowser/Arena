/**
 * C.2 — Pricing rules CRUD.
 *
 * RBAC follows the existing convention: staff may READ the configuration,
 * only managers may change it (same split as /api/admin/suppliers).
 */
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser, isStaff, isManager } from "@/lib/auth";
import { validate } from "@/lib/validation";
import {
  createPricingRuleSchema,
  updatePricingRuleSchema,
  deletePricingRuleSchema,
  togglePricingRuleSchema,
} from "@/lib/pricing-rules-schemas";
import {
  listPricingRules,
  createPricingRule,
  updatePricingRule,
  togglePricingRule,
  deletePricingRule,
  getCatalogueCoverage,
} from "@/lib/services/pricing-rules-service";

/** Map business errors to stable HTTP codes. */
function mapError(e: unknown): NextResponse {
  const msg = e instanceof Error ? e.message : "";
  switch (msg) {
    case "RULE_ALREADY_EXISTS":
      return NextResponse.json({ error: "RULE_ALREADY_EXISTS", message: "Já existe uma regra ativa para este alvo. Edite ou desative a existente." }, { status: 409 });
    case "RULE_NOT_FOUND":
      return NextResponse.json({ error: "RULE_NOT_FOUND", message: "Regra não encontrada" }, { status: 404 });
    case "INVALID_RULE_TARGET":
      return NextResponse.json({ error: "INVALID_RULE_TARGET", message: "O alvo não corresponde ao âmbito" }, { status: 400 });
    case "MARGIN_TOO_HIGH":
      return NextResponse.json({ error: "MARGIN_TOO_HIGH", message: "A margem sobre venda tem de ser inferior a 100%" }, { status: 400 });
    case "INVALID_RATE":
      return NextResponse.json({ error: "INVALID_RATE", message: "Percentagem inválida" }, { status: 400 });
    case "TARGET_NOT_FOUND":
      return NextResponse.json({ error: "TARGET_NOT_FOUND", message: "Fornecedor/marca/categoria/produto inexistente" }, { status: 400 });
    default:
      console.error("Pricing rules error:", e);
      return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user || !isStaff(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });
  const [rules, coverage] = await Promise.all([listPricingRules(), getCatalogueCoverage()]);
  return NextResponse.json({ rules, coverage });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user || !isManager(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });
  const raw = await req.json();
  const v = validate(createPricingRuleSchema, raw);
  if (!v.success) return NextResponse.json({ error: "VALIDATION_ERROR", details: v.error }, { status: 400 });
  try {
    // Saving a rule deliberately does NOT reprice anything.
    const rule = await createPricingRule(v.data, user.id);
    return NextResponse.json({ rule }, { status: 201 });
  } catch (e) {
    return mapError(e);
  }
}

export async function PUT(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user || !isManager(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });
  const raw = await req.json();

  // A toggle sends only { id, isActive }.
  if (raw && typeof raw === "object" && Object.keys(raw).length === 2 && "isActive" in raw && "id" in raw) {
    const t = validate(togglePricingRuleSchema, raw);
    if (!t.success) return NextResponse.json({ error: "VALIDATION_ERROR", details: t.error }, { status: 400 });
    try {
      const rule = await togglePricingRule(t.data.id, t.data.isActive, user.id);
      return NextResponse.json({ rule });
    } catch (e) {
      return mapError(e);
    }
  }

  const v = validate(updatePricingRuleSchema, raw);
  if (!v.success) return NextResponse.json({ error: "VALIDATION_ERROR", details: v.error }, { status: 400 });
  try {
    const { id, ...input } = v.data;
    const rule = await updatePricingRule(id, input, user.id);
    return NextResponse.json({ rule });
  } catch (e) {
    return mapError(e);
  }
}

export async function DELETE(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user || !isManager(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });
  const raw = await req.json();
  const v = validate(deletePricingRuleSchema, raw);
  if (!v.success) return NextResponse.json({ error: "VALIDATION_ERROR", details: v.error }, { status: 400 });
  try {
    return NextResponse.json(await deletePricingRule(v.data.id, user.id));
  } catch (e) {
    return mapError(e);
  }
}
