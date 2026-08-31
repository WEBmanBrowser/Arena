import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { csrfGuard } from "@/lib/csrf";
import { updateAccountAddress, deleteAccountAddress, getAccountAddressById, CustomerValidationError } from "@/lib/services/admin-customers-service";
import { updateAccountAddressSchema } from "@/lib/b22-schemas";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sessão requerida" }, { status: 401 });

  const { id: idParam } = await params;
  const addressId = parseInt(idParam, 10);
  if (!Number.isFinite(addressId) || addressId < 1) {
    return NextResponse.json({ error: "ID inválido" }, { status: 400 });
  }

  const address = await getAccountAddressById(addressId, user.id);
  if (!address) return NextResponse.json({ error: "Morada não encontrada" }, { status: 404 });
  return NextResponse.json({ address });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const csrf = csrfGuard(req);
  if (csrf) return csrf;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sessão requerida" }, { status: 401 });

  const { id: idParam } = await params;
  const addressId = parseInt(idParam, 10);
  if (!Number.isFinite(addressId) || addressId < 1) {
    return NextResponse.json({ error: "ID inválido" }, { status: 400 });
  }

  const parsed = updateAccountAddressSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "VALIDATION_ERROR", issues: parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });
  }

  try {
    const address = await updateAccountAddress(addressId, user.id, parsed.data);
    return NextResponse.json({ address });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Erro";
    if (msg === "ADDRESS_NOT_FOUND") return NextResponse.json({ error: "Morada não encontrada" }, { status: 404 });
    if (e instanceof CustomerValidationError) return NextResponse.json({ error: msg }, { status: 400 });
    console.error("update address failed:", e);
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const csrf = csrfGuard(req);
  if (csrf) return csrf;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sessão requerida" }, { status: 401 });

  const { id: idParam } = await params;
  const addressId = parseInt(idParam, 10);
  if (!Number.isFinite(addressId) || addressId < 1) {
    return NextResponse.json({ error: "ID inválido" }, { status: 400 });
  }

  try {
    await deleteAccountAddress(addressId, user.id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Erro";
    if (msg === "ADDRESS_NOT_FOUND") return NextResponse.json({ error: "Morada não encontrada" }, { status: 404 });
    console.error("delete address failed:", e);
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
