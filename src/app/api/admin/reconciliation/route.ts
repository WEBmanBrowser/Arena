import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser, isManager } from "@/lib/auth";
import { ReconciliationError, ingestReconciliationObservation, listOpenAnomalies } from "@/lib/reconciliation";
import { findStaleRefundAttempts } from "@/lib/refunds";

/**
 * Provider-agnostic reconciliation console (manager+ only).
 *
 * GET  — open anomalies + stale refund attempts (operational report only;
 *        nothing is auto-fixed).
 * POST — ingest a NORMALIZED external observation (integer cents, explicit
 *        currency). Never raw provider payloads. Anomalies are computed
 *        against authoritative internal state and require explicit audited
 *        resolution.
 */
export async function GET(_req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sessão requerida" }, { status: 401 });
  if (!isManager(user.role)) return NextResponse.json({ error: "Operação requer nível manager ou admin" }, { status: 403 });

  try {
    const anomalies = await listOpenAnomalies();
    const staleRefunds = await findStaleRefundAttempts(60);
    return NextResponse.json({ anomalies, staleRefunds });
  } catch (e) {
    console.error("reconciliation report error:", e);
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sessão requerida" }, { status: 401 });
  if (!isManager(user.role)) return NextResponse.json({ error: "Operação requer nível manager ou admin" }, { status: 403 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const observedAt = new Date(typeof body.observedAt === "string" ? body.observedAt : "");

  try {
    const result = await ingestReconciliationObservation({
      orderId: Number(body.orderId),
      provider: typeof body.provider === "string" ? body.provider : "",
      providerReference: typeof body.providerReference === "string" ? body.providerReference : null,
      observedPaidCents: Number(body.observedPaidCents),
      observedRefundedCents: Number(body.observedRefundedCents),
      currency: typeof body.currency === "string" ? body.currency : "",
      observedAt,
      recordedBy: user.id,
    });
    return NextResponse.json(
      { observation: result.observation, created: result.created },
      { status: result.created ? 201 : 200 }
    );
  } catch (e) {
    if (e instanceof ReconciliationError) {
      const status = e.code === "ORDER_NOT_FOUND" ? 404 : 400;
      return NextResponse.json({ error: e.message, code: e.code }, { status });
    }
    console.error("reconciliation ingest error:", e);
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
