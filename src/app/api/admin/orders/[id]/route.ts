import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser, isStaff } from "@/lib/auth";
import { getAdminOrderDetail } from "@/lib/services/admin-orders-service";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user || !isStaff(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

  const { id } = await params;
  const orderId = parseInt(id);
  if (!orderId) return NextResponse.json({ error: "ID inválido" }, { status: 400 });

  try {
    const detail = await getAdminOrderDetail(orderId);
    return NextResponse.json(detail);
  } catch (e) {
    if ((e as Error).message === "ORDER_NOT_FOUND") return NextResponse.json({ error: "Encomenda não encontrada" }, { status: 404 });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
