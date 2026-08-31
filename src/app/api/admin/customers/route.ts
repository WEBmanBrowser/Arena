import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser, isStaff } from "@/lib/auth";
import { listAdminCustomers, CustomerValidationError } from "@/lib/services/admin-customers-service";
import { adminCustomerQuerySchema } from "@/lib/b22-schemas";

function compactQuery(req: NextRequest): Record<string, string> {
  const out: Record<string, string> = {};
  req.nextUrl.searchParams.forEach((value, key) => { if (value !== "") out[key] = value; });
  return out;
}

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sessão requerida" }, { status: 401 });
  if (!isStaff(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

  const parsed = adminCustomerQuerySchema.safeParse(compactQuery(req));
  if (!parsed.success) {
    const issues = parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`);
    return NextResponse.json({ error: "VALIDATION_ERROR", issues }, { status: 400 });
  }

  try {
    const result = await listAdminCustomers(parsed.data);
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof CustomerValidationError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    console.error("admin customers list failed:", e);
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
