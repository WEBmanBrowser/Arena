import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser, isStaff } from "@/lib/auth";
import { getAdminCustomerDetail } from "@/lib/services/admin-customers-service";
import { adminCustomerDetailQuerySchema } from "@/lib/b22-schemas";

function compactQuery(req: NextRequest): Record<string, string> {
  const out: Record<string, string> = {};
  req.nextUrl.searchParams.forEach((value, key) => { if (value !== "") out[key] = value; });
  return out;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sessão requerida" }, { status: 401 });
  if (!isStaff(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

  const { id: idParam } = await params;
  const customerId = parseInt(idParam, 10);
  if (!Number.isFinite(customerId) || customerId < 1) {
    return NextResponse.json({ error: "ID inválido" }, { status: 400 });
  }

  const qParsed = adminCustomerDetailQuerySchema.safeParse(compactQuery(req));
  if (!qParsed.success) {
    return NextResponse.json({ error: "VALIDATION_ERROR" }, { status: 400 });
  }

  try {
    const detail = await getAdminCustomerDetail(
      customerId,
      qParsed.data.ordersPage,
      qParsed.data.ordersPageSize,
    );
    return NextResponse.json(detail);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Erro";
    if (msg === "CUSTOMER_NOT_FOUND") return NextResponse.json({ error: "Cliente não encontrado" }, { status: 404 });
    console.error("admin customer detail failed:", e);
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
