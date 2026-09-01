import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser, isManager } from "@/lib/auth";
import { RefundError, getOrderRefundState, requestRefund } from "@/lib/refunds";

/**
 * Admin refund operations for an order (manager+ only).
 *
 * GET  — derived financial refund state + refund history.
 * POST — request a refund, or record an externally COMPLETED manual refund
 *        (bank transfer etc.) when `manualCompletion` evidence is supplied.
 *
 * All state changes are POST-only; every action is audited.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sessão requerida" }, { status: 401 });
  if (!isManager(user.role)) return NextResponse.json({ error: "Operação requer nível manager ou admin" }, { status: 403 });

  const { id } = await params;
  const orderId = Number(id);
  if (!Number.isInteger(orderId) || orderId < 1) return NextResponse.json({ error: "ID inválido" }, { status: 400 });

  try {
    const state = await getOrderRefundState(orderId);
    return NextResponse.json({ refundState: state });
  } catch (e) {
    if (e instanceof RefundError) {
      const status = e.code === "ORDER_NOT_FOUND" ? 404 : 400;
      return NextResponse.json({ error: e.message, code: e.code }, { status });
    }
    console.error("admin refund state error:", e);
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sessão requerida" }, { status: 401 });
  if (!isManager(user.role)) return NextResponse.json({ error: "Operação requer nível manager ou admin" }, { status: 403 });

  const { id } = await params;
  const orderId = Number(id);
  if (!Number.isInteger(orderId) || orderId < 1) return NextResponse.json({ error: "ID inválido" }, { status: 400 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const amountCents = Number(body.amountCents);
  if (!Number.isInteger(amountCents)) return NextResponse.json({ error: "Montante em cêntimos inteiro obrigatório" }, { status: 400 });

  const manualCompletion = normalizeManualCompletion(body.manualCompletion);

  try {
    const result = await requestRefund({
      orderId,
      amountCents,
      idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : "",
      requestedBy: user.id,
      provider: typeof body.provider === "string" ? body.provider : undefined,
      currency: typeof body.currency === "string" ? body.currency : undefined,
      reason: typeof body.reason === "string" ? body.reason : null,
      manualCompletion,
    });
    return NextResponse.json(
      { refund: result.refund, created: result.created, executionSupported: result.executionSupported },
      { status: result.created ? 201 : 200 }
    );
  } catch (e) {
    if (e instanceof RefundError) {
      const status = mapStatus(e.code);
      return NextResponse.json({ error: e.message, code: e.code }, { status });
    }
    console.error("admin refund request error:", e);
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}

function normalizeManualCompletion(value: unknown): { externalReference: string; completedAt: Date } | null {
  if (value == null || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const externalReference = typeof raw.externalReference === "string" ? raw.externalReference : "";
  const completedAtRaw = typeof raw.completedAt === "string" ? raw.completedAt : "";
  const completedAt = new Date(completedAtRaw);
  if (!externalReference || !completedAtRaw || Number.isNaN(completedAt.getTime())) return null;
  return { externalReference, completedAt };
}

function mapStatus(code: string): number {
  switch (code) {
    case "ORDER_NOT_FOUND":
    case "REFUND_NOT_FOUND":
      return 404;
    case "REFUND_EXCEEDS_REFUNDABLE":
    case "IDEMPOTENCY_KEY_CONFLICT":
      return 409;
    default:
      return 400;
  }
}
