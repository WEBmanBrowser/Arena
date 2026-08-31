import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser, isManager } from "@/lib/auth";
import { csrfGuard } from "@/lib/csrf";
import { updateCustomerNote, deleteCustomerNote, CustomerValidationError } from "@/lib/services/admin-customers-service";
import { updateNoteSchema } from "@/lib/b22-schemas";

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; noteId: string }> },
) {
  const csrf = csrfGuard(req);
  if (csrf) return csrf;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sessão requerida" }, { status: 401 });
  if (!isManager(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

  const { id: customerIdStr, noteId: noteIdStr } = await params;
  const customerId = parseInt(customerIdStr, 10);
  const noteId = parseInt(noteIdStr, 10);
  if (!Number.isFinite(customerId) || customerId < 1) return NextResponse.json({ error: "ID inválido" }, { status: 400 });
  if (!Number.isFinite(noteId) || noteId < 1) return NextResponse.json({ error: "ID inválido" }, { status: 400 });

  const parsed = updateNoteSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "VALIDATION_ERROR" }, { status: 400 });

  try {
    await updateCustomerNote(customerId, noteId, parsed.data.note, user.id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Erro";
    if (msg === "NOTE_NOT_FOUND") return NextResponse.json({ error: "Nota não encontrada" }, { status: 404 });
    if (e instanceof CustomerValidationError) return NextResponse.json({ error: e.message }, { status: 400 });
    console.error("update customer note failed:", e);
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; noteId: string }> },
) {
  const csrf = csrfGuard(req);
  if (csrf) return csrf;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sessão requerida" }, { status: 401 });
  if (!isManager(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

  const { id: customerIdStr, noteId: noteIdStr } = await params;
  const customerId = parseInt(customerIdStr, 10);
  const noteId = parseInt(noteIdStr, 10);
  if (!Number.isFinite(customerId) || customerId < 1) return NextResponse.json({ error: "ID inválido" }, { status: 400 });
  if (!Number.isFinite(noteId) || noteId < 1) return NextResponse.json({ error: "ID inválido" }, { status: 400 });

  try {
    await deleteCustomerNote(customerId, noteId, user.id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Erro";
    if (msg === "NOTE_NOT_FOUND") return NextResponse.json({ error: "Nota não encontrada" }, { status: 404 });
    console.error("delete customer note failed:", e);
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
