import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser, isStaff } from "@/lib/auth";
import { csrfGuard } from "@/lib/csrf";
import {
  bulkTransitionAdminOrders,
  AdminOrderValidationError,
  ADMIN_MAX_BULK_ORDERS,
} from "@/lib/services/admin-orders-service";
import { z } from "zod";

const bulkSchema = z.object({
  action: z.enum(["start_processing", "mark_ready_for_pickup"]),
  orderIds: z
    .array(z.number().int().positive("IDs de encomenda devem ser inteiros positivos"))
    .min(1, "Selecione pelo menos uma encomenda")
    .max(ADMIN_MAX_BULK_ORDERS, `Máximo de ${ADMIN_MAX_BULK_ORDERS} encomendas por lote`),
});

export async function POST(req: NextRequest) {
  const csrf = csrfGuard(req);
  if (csrf) return csrf;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sessão requerida" }, { status: 401 });
  if (!isStaff(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const parsed = bulkSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "VALIDATION_ERROR", details: parsed.error.issues.map((i) => i.message).join("; ") },
      { status: 400 }
    );
  }

  try {
    const result = await bulkTransitionAdminOrders(parsed.data.action, parsed.data.orderIds, user.id);
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof AdminOrderValidationError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    console.error("admin bulk orders failed:", e);
    return NextResponse.json({ error: "Erro interno ao processar lote" }, { status: 500 });
  }
}
