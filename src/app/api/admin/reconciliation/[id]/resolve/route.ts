import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser, isManager } from "@/lib/auth";
import { csrfGuard } from "@/lib/csrf";
import { ReconciliationError, resolveReconciliationAnomaly } from "@/lib/reconciliation";
import type { ReconciliationResolutionCode } from "@/db/schema";

/**
 * Explicit, audited resolution of a reconciliation anomaly
 * (manager+ only, POST-only). Anomalies are never auto-fixed; the caller must
 * supply BOTH an accountable note and an explicit CLASSIFICATION
 * (`code`: REFUNDED / MANUALLY_RECONCILED / FALSE_POSITIVE / ACCEPTED_EXCEPTION).
 * `REFUNDED` is only accepted when `succeeded` refunds on the SAME payment cover
 * the anomaly's amount (F-3); anything less — including an observation that
 * cannot be attributed to one payment — is refused with
 * `REFUND_EVIDENCE_REQUIRED`.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // CSRF — state-changing admin action requires same-origin (project standard).
  const csrf = csrfGuard(req);
  if (csrf) return csrf;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sessão requerida" }, { status: 401 });
  if (!isManager(user.role)) return NextResponse.json({ error: "Operação requer nível manager ou admin" }, { status: 403 });

  const { id } = await params;
  const observationId = Number(id);
  if (!Number.isInteger(observationId) || observationId < 1) return NextResponse.json({ error: "ID inválido" }, { status: 400 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  try {
    const observation = await resolveReconciliationAnomaly(
      observationId,
      user.id,
      typeof body.note === "string" ? body.note : "",
      (typeof body.code === "string" ? body.code : "") as ReconciliationResolutionCode
    );
    return NextResponse.json({ observation });
  } catch (e) {
    if (e instanceof ReconciliationError) {
      const status = e.code === "OBSERVATION_NOT_FOUND" ? 404 : e.code === "OBSERVATION_NOT_OPEN" || e.code === "OBSERVATION_STATE_CONFLICT" ? 409 : 400;
      return NextResponse.json({ error: e.message, code: e.code }, { status });
    }
    console.error("reconciliation resolve error:", e);
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
