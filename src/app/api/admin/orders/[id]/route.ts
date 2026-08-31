import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser, isStaff } from "@/lib/auth";
import { getAdminOrderDetail, AdminOrderValidationError } from "@/lib/services/admin-orders-service";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // RBAC — 401 (no session) vs 403 (authenticated, insufficient role)
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sessão requerida" }, { status: 401 });
  if (!isStaff(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

  const { id } = await params;
  const orderId = Number.parseInt(id, 10);
  if (!Number.isInteger(orderId) || orderId < 1) return NextResponse.json({ error: "ID inválido" }, { status: 400 });

  try {
    const detail = await getAdminOrderDetail(orderId);
    return NextResponse.json(detail);
  } catch (e) {
    if (e instanceof AdminOrderValidationError) return NextResponse.json({ error: e.message }, { status: 400 });
    if ((e as Error).message === "ORDER_NOT_FOUND") return NextResponse.json({ error: "Encomenda não encontrada" }, { status: 404 });
    console.error("admin order detail failed:", e);
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
