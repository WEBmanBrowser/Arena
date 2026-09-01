import { NextRequest, NextResponse } from "next/server";
import { findStaleRefundAttempts } from "@/lib/refunds";

/**
 * POST /api/cron/refund-maintenance
 *
 * Provider-neutral scheduled maintenance: REPORTS refund attempts that
 * have been pending/processing longer than the configured threshold so
 * operations can intervene. Read-only — it never mutates financial state
 * and never contacts external providers (all provider integrations remain
 * frozen). Follows the existing cron endpoint pattern (CRON_SECRET header).
 */
export async function POST(req: NextRequest) {
  // Fail closed: ONLY CRON_SECRET authorizes this maintenance endpoint.
  // No JWT_SECRET fallback — reusing the session-signing secret as a cron
  // credential would widen the blast radius of either secret.
  const secret = req.headers.get("x-cron-secret") || req.headers.get("authorization")?.replace("Bearer ", "");
  const expected = process.env.CRON_SECRET;
  if (!expected || !secret || secret !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const minutesRaw = Number(new URL(req.url).searchParams.get("staleMinutes"));
    const staleMinutes = Number.isInteger(minutesRaw) && minutesRaw > 0 && minutesRaw <= 1440 ? minutesRaw : 60;
    const stale = await findStaleRefundAttempts(staleMinutes);
    return NextResponse.json({
      ok: true,
      staleMinutes,
      staleCount: stale.length,
      staleRefunds: stale.map((r) => ({
        id: r.id,
        orderId: r.orderId,
        paymentId: r.paymentId,
        provider: r.provider,
        amountCents: r.amountCents,
        currency: r.currency,
        status: r.status,
        createdAt: r.createdAt,
      })),
    });
  } catch (e) {
    console.error("Cron refund maintenance error:", e);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
