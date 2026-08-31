import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getAccountOrders } from "@/lib/services/admin-customers-service";
import { accountOrderQuerySchema } from "@/lib/b22-schemas";

function compactQuery(req: NextRequest): Record<string, string> {
  const out: Record<string, string> = {};
  req.nextUrl.searchParams.forEach((value, key) => { if (value !== "") out[key] = value; });
  return out;
}

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sessão requerida" }, { status: 401 });

  const parsed = accountOrderQuerySchema.safeParse(compactQuery(req));
  if (!parsed.success) return NextResponse.json({ error: "VALIDATION_ERROR" }, { status: 400 });

  const result = await getAccountOrders(user.id, parsed.data.page, parsed.data.pageSize);
  return NextResponse.json(result);
}
