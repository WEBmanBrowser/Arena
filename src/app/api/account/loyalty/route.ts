import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getLoyaltySummary, listLoyaltyMovements } from "@/lib/services/loyalty-service";
import { listLoyaltyVouchers } from "@/lib/services/loyalty-voucher-service";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sessão requerida" }, { status: 401 });
  try {
    const [summary, movements, vouchers] = await Promise.all([
      getLoyaltySummary(user.id), listLoyaltyMovements(user.id, 50), listLoyaltyVouchers(user.id),
    ]);
    return NextResponse.json({ summary, movements, vouchers });
  } catch (error) {
    console.error("account loyalty GET failed:", error);
    return NextResponse.json({ error: "Erro ao carregar pontos e vales" }, { status: 500 });
  }
}
