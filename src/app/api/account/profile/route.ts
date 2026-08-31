import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { csrfGuard } from "@/lib/csrf";
import { getAccountProfile, updateAccountProfile, CustomerValidationError } from "@/lib/services/admin-customers-service";
import { updateAccountProfileSchema } from "@/lib/b22-schemas";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sessão requerida" }, { status: 401 });

  try {
    const profile = await getAccountProfile(user.id);
    return NextResponse.json({ profile });
  } catch (e) {
    if ((e as Error).message === "USER_NOT_FOUND") {
      return NextResponse.json({ error: "Utilizador não encontrado" }, { status: 404 });
    }
    console.error("get profile failed:", e);
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  const csrf = csrfGuard(req);
  if (csrf) return csrf;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sessão requerida" }, { status: 401 });

  const parsed = updateAccountProfileSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "VALIDATION_ERROR", issues: parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });
  }

  try {
    const profile = await updateAccountProfile(user.id, parsed.data);
    return NextResponse.json({ profile });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Erro";
    if (msg === "USER_NOT_FOUND") return NextResponse.json({ error: "Utilizador não encontrado" }, { status: 404 });
    if (e instanceof CustomerValidationError) return NextResponse.json({ error: msg }, { status: 400 });
    console.error("update profile failed:", e);
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
