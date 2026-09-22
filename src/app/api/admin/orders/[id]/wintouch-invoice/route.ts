import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser, isManager } from "@/lib/auth";
import { issueWintouchInvoiceForOrder } from "@/lib/services/wintouch-invoicing-service";

const SAFE_ERRORS: Record<string, { status: number; message: string }> = {
  ORDER_NOT_FOUND: { status: 404, message: "Encomenda não encontrada" },
  ORDER_NOT_PAID: { status: 409, message: "A encomenda ainda não está paga" },
  ORDER_HAS_NO_ITEMS: { status: 409, message: "A encomenda não tem artigos" },
  ORDER_ALREADY_INVOICED: { status: 409, message: "A encomenda já possui um documento fiscal emitido" },
  WINTOUCH_RECONCILIATION_REQUIRED: { status: 409, message: "A emissão requer reconciliação antes de nova tentativa" },
  WINTOUCH_TOTAL_MISMATCH: { status: 409, message: "O total fiscal não coincide com o total da encomenda" },
  WINTOUCH_INVALID_QUANTITY: { status: 409, message: "A encomenda contém uma quantidade inválida para faturação" },
  WINTOUCH_INVALID_LINE_TOTAL: { status: 409, message: "A encomenda contém um valor de linha inválido para faturação" },
  WINTOUCH_INVALID_ORDER_TOTAL: { status: 409, message: "A encomenda contém um total inválido para faturação" },
};

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sessão requerida" }, { status: 401 });
  if (!isManager(user.role)) return NextResponse.json({ error: "Operação requer nível manager ou admin" }, { status: 403 });
  const { id } = await params;
  const orderId = Number.parseInt(id, 10);
  if (!Number.isInteger(orderId) || orderId < 1) return NextResponse.json({ error: "ID inválido" }, { status: 400 });

  try {
    const document = await issueWintouchInvoiceForOrder(orderId, user.id);
    return NextResponse.json({ document }, { status: 201 });
  } catch (e) {
    const code = e instanceof Error ? e.message : "WINTOUCH_ERROR";
    const safe = SAFE_ERRORS[code];
    console.error("WINTOUCH invoice issue failed", safe ? code : "PROVIDER_ERROR");
    return NextResponse.json(
      { error: safe?.message ?? "Não foi possível concluir a emissão no WINTOUCH" },
      { status: safe?.status ?? 502 }
    );
  }
}
