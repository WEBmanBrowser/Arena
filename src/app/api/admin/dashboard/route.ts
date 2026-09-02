/**
 * B.4.1 — GET /api/admin/dashboard
 *
 * Operational command center read model. Read-only; staff and above.
 * All financial figures are integer cents computed server-side.
 */
import { NextResponse } from "next/server";
import { getCurrentUser, isStaff } from "@/lib/auth";
import { getDashboardData } from "@/lib/services/dashboard-service";

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user || !isStaff(user.role)) {
      return NextResponse.json({ error: "Não autorizado" }, { status: 403 });
    }
    const data = await getDashboardData();
    return NextResponse.json(data, {
      headers: {
        // Operational data must never be cached by shared caches.
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("dashboard error:", err);
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
