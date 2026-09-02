/**
 * B.4.1 — GET /api/admin/stats
 *
 * Legacy summary endpoint (original dashboard card layout). Numbers now come
 * from the corrected command-center read model: revenue counts only PAID
 * orders and is aggregated as integer cents.
 */
import { NextResponse } from "next/server";
import { getCurrentUser, isStaff } from "@/lib/auth";
import { getLegacyStats } from "@/lib/services/dashboard-service";

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user || !isStaff(user.role)) {
      return NextResponse.json({ error: "Não autorizado" }, { status: 403 });
    }
    const stats = await getLegacyStats();
    return NextResponse.json(stats, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
