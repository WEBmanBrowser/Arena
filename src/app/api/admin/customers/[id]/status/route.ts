import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser, isManager } from "@/lib/auth";
import { csrfGuard } from "@/lib/csrf";
import { disableCustomer, reactivateCustomer, CustomerValidationError } from "@/lib/services/admin-customers-service";
import { z } from "zod";

const statusSchema = z.object({
  action: z.enum(["disable", "reactivate"]),
  reason: z.string().max(1000).optional(),
}).strict();

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const csrf = csrfGuard(req);
  if (csrf) return csrf;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sessão requerida" }, { status: 401 });
  if (!isManager(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

  const { id: idParam } = await params;
  const customerId = parseInt(idParam, 10);
  if (!Number.isFinite(customerId) || customerId < 1) {
    return NextResponse.json({ error: "ID inválido" }, { status: 400 });
  }

  const parsed = statusSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "VALIDATION_ERROR" }, { status: 400 });

  try {
    let changed: boolean;
    if (parsed.data.action === "disable") {
      ({ changed } = await disableCustomer(customerId, user.id, parsed.data.reason));
    } else {
      ({ changed } = await reactivateCustomer(customerId, user.id));
    }
    return NextResponse.json({ ok: true, changed });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Erro";
    if (msg === "CUSTOMER_NOT_FOUND") return NextResponse.json({ error: "Cliente não encontrado" }, { status: 404 });
    if (e instanceof CustomerValidationError) return NextResponse.json({ error: e.message }, { status: 400 });
    console.error("admin customer status failed:", e);
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
