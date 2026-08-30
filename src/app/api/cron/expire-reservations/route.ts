import { NextRequest, NextResponse } from "next/server";
import { releaseExpiredReservations } from "@/lib/orders";

/**
 * POST /api/cron/expire-reservations
 * Protected endpoint for releasing expired order reservations.
 * Called by Cloudflare Cron Trigger or manually by admin.
 * Protected by CRON_SECRET header.
 */
export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-cron-secret") || req.headers.get("authorization")?.replace("Bearer ", "");
  const expected = process.env.CRON_SECRET || process.env.JWT_SECRET;
  if (!expected || secret !== expected) {
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
