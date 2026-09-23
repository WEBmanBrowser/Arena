import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { csrfGuard } from "@/lib/csrf";
import { createLoyaltyVoucher } from "@/lib/services/loyalty-voucher-service";

export async function POST(req: NextRequest) {
  const csrf = csrfGuard(req);
  if (csrf) return csrf;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sessão requerida" }, { status: 401 });
  const body = await req.json().catch(() => null) as { points?: unknown } | null;
  const points = body?.points;
  if (!Number.isInteger(points) || (points as number) < 100 || (points as number) % 100 !== 0) {
    return NextResponse.json({ error: "Os pontos devem ser um múltiplo inteiro de 100" }, { status: 400 });
  }
  try {
    const voucher = await createLoyaltyVoucher(user.id, points as number, user.id);
    return NextResponse.json({ voucher }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro";
    if (message.startsWith("VALIDATION:")) return NextResponse.json({ error: message.slice(11) }, { status: 400 });
    console.error("account loyalty voucher POST failed:", error);
    return NextResponse.json({ error: "Erro ao gerar vale" }, { status: 500 });
  }
}
