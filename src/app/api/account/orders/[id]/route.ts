import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getAccountOrderDetail } from "@/lib/services/admin-customers-service";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sessão requerida" }, { status: 401 });

  const { id: idParam } = await params;
  const orderId = parseInt(idParam, 10);
  if (!Number.isFinite(orderId) || orderId < 1) {
    return NextResponse.json({ error: "ID inválido" }, { status: 400 });
  }

  const detail = await getAccountOrderDetail(orderId, user.id);
  if (!detail) return NextResponse.json({ error: "Encomenda não encontrada" }, { status: 404 });

  // IDOR-safe: only own order reaches here
  return NextResponse.json(detail);
}
