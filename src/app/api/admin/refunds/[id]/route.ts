import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser, isManager } from "@/lib/auth";
import { RefundError, cancelRefund, completeManualRefund, markRefundFailed, retryRefund } from "@/lib/refunds";

/**
 * Admin lifecycle actions on a single refund attempt (manager+ only,
 * POST-only, every action audited):
 *
 *   complete — record that an externally executed manual refund occurred
 *              (requires externalReference + completedAt evidence).
 *   cancel   — cancel a pending/processing refund (releases commitment).
 *   fail     — mark a pending/processing refund failed (releases commitment).
 *   retry    — explicitly retry a FAILED refund (same row, same identity).
 *
 * Succeeded refunds are terminal and immutable: every action on them fails.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sessão requerida" }, { status: 401 });
  if (!isManager(user.role)) return NextResponse.json({ error: "Operação requer nível manager ou admin" }, { status: 403 });

  const { id } = await params;
  const refundId = Number(id);
  if (!Number.isInteger(refundId) || refundId < 1) return NextResponse.json({ error: "ID inválido" }, { status: 400 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  try {
    switch (body.action) {
      case "complete": {
        const externalReference = typeof body.externalReference === "string" ? body.externalReference : "";
        const completedAt = new Date(typeof body.completedAt === "string" ? body.completedAt : "");
        const refund = await completeManualRefund({ refundId, externalReference, completedAt, actorId: user.id });
        return NextResponse.json({ refund });
      }
      case "cancel": {
        const refund = await cancelRefund(refundId, user.id, typeof body.reason === "string" ? body.reason : null);
        return NextResponse.json({ refund });
      }
      case "fail": {
        const refund = await markRefundFailed(refundId, user.id, {
          code: typeof body.errorCode === "string" ? body.errorCode : undefined,
          message: typeof body.errorMessage === "string" ? body.errorMessage : undefined,
        });
        return NextResponse.json({ refund });
      }
      case "retry": {
        const refund = await retryRefund(refundId, user.id);
        return NextResponse.json({ refund });
      }
      default:
        return NextResponse.json({ error: "Ação desconhecida" }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof RefundError) {
      const status =
        e.code === "REFUND_NOT_FOUND" ? 404 : e.code === "REFUND_IMMUTABLE" || e.code === "INVALID_REFUND_STATE" ? 409 : 400;
      return NextResponse.json({ error: e.message, code: e.code }, { status });
    }
    console.error("admin refund action error:", e);
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
