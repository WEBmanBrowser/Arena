import { NextRequest, NextResponse } from "next/server";
import { releaseExpiredReservations } from "@/lib/orders";

/**
 * POST /api/cron/expire-reservations
 * Protected endpoint for releasing expired order reservations.
 * Called by Cloudflare Cron Trigger or manually by admin.
 * B.5.3 — Fail closed: CRON_SECRET is the ONLY cron authentication secret.
 * There is deliberately no JWT_SECRET fallback: JWT_SECRET must never
 * authorize cron. Missing, empty or wrong secret => 401.
 */
export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-cron-secret") || req.headers.get("authorization")?.replace("Bearer ", "");
  const expected = process.env.CRON_SECRET;
  if (!expected || !secret || secret !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await releaseExpiredReservations();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    console.error("Cron expire error:", e);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
