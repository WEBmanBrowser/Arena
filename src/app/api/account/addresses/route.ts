import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { csrfGuard } from "@/lib/csrf";
import { getAccountAddresses, createAccountAddress } from "@/lib/services/admin-customers-service";
import { createAccountAddressSchema } from "@/lib/b22-schemas";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sessão requerida" }, { status: 401 });

  const addresses = await getAccountAddresses(user.id);
  return NextResponse.json({ addresses });
}

export async function POST(req: NextRequest) {
  const csrf = csrfGuard(req);
  if (csrf) return csrf;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sessão requerida" }, { status: 401 });

  const parsed = createAccountAddressSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "VALIDATION_ERROR", issues: parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });
  }

  try {
    const address = await createAccountAddress(user.id, parsed.data);
    return NextResponse.json({ address }, { status: 201 });
  } catch (e) {
    console.error("create address failed:", e);
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
