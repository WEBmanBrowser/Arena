/**
 * C.2 — Global commercial rounding policy.
 *
 * The bands are stored in `settings` by the C.1 rounding-policy module, so
 * this route is a thin, validated wrapper. No migration involved.
 */
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser, isStaff, isManager } from "@/lib/auth";
import { validate } from "@/lib/validation";
import { roundingPolicySchema } from "@/lib/pricing-rules-schemas";
import { getRoundingPolicy, saveRoundingPolicy } from "@/lib/rounding-policy";
import { DEFAULT_ROUNDING_POLICY } from "@/lib/pricing-calculator";
import { createAuditLog } from "@/lib/audit";

export async function GET() {
  const user = await getCurrentUser();
  if (!user || !isStaff(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });
  return NextResponse.json({ policy: await getRoundingPolicy(), defaultPolicy: DEFAULT_ROUNDING_POLICY });
}

export async function PUT(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user || !isManager(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });
  const raw = await req.json();
  const v = validate(roundingPolicySchema, raw);
  if (!v.success) return NextResponse.json({ error: "VALIDATION_ERROR", details: v.error }, { status: 400 });

  try {
    // Changing the policy does NOT reprice anything on its own — the operator
    // must run an explicit recalculation preview afterwards.
    await saveRoundingPolicy(v.data);
    await createAuditLog({
      userId: user.id, action: "pricing.rounding_policy_updated", entity: "settings",
      details: { enabled: v.data.enabled, bands: v.data.bands.length },
    });
    return NextResponse.json({ policy: await getRoundingPolicy() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    return NextResponse.json({ error: "INVALID_POLICY", message: msg || "Política inválida" }, { status: 400 });
  }
}
