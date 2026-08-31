import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser, isManager } from "@/lib/auth";
import { csrfGuard } from "@/lib/csrf";
import { createCustomerNote, CustomerValidationError } from "@/lib/services/admin-customers-service";
import { createNoteSchema } from "@/lib/b22-schemas";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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

  const parsed = createNoteSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "VALIDATION_ERROR" }, { status: 400 });
  }

  try {
    const result = await createCustomerNote(customerId, parsed.data.note, user.id);
    return NextResponse.json({ id: result.id }, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Erro";
    if (msg === "CUSTOMER_NOT_FOUND") return NextResponse.json({ error: "Cliente não encontrado" }, { status: 404 });
    if (e instanceof CustomerValidationError) return NextResponse.json({ error: e.message }, { status: 400 });
    console.error("create customer note failed:", e);
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
