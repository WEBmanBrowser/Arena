/**
 * PAYMENT P0 (M5) — GET /api/admin/email-outbox
 *
 * Read-only outbox observability: status counters plus the rows that need
 * operator attention (queued / dispatching / delivery_unknown / failed).
 *
 * Authorisation: manager+ (read-only operational surface).
 * Privacy: recipients are MASKED (no full addresses) and no payload, template
 * body or credential is ever returned. `delivery_unknown` rows are never retried
 * automatically — they are visible here so a human can decide (see
 * POST /api/admin/email-outbox/[id]/requeue).
 */

import { NextResponse } from "next/server";
import { getCurrentUser, isManager } from "@/lib/auth";
import { getEmailOutboxSummary, listEmailOutboxForOperations } from "@/lib/email-outbox";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sessão requerida" }, { status: 401 });
  if (!isManager(user.role)) {
    return NextResponse.json({ error: "Operação requer nível manager ou admin" }, { status: 403 });
  }

  const [summary, rows] = await Promise.all([getEmailOutboxSummary(), listEmailOutboxForOperations()]);
  return NextResponse.json({
    summary,
    // `delivery_unknown` requires an explicit human decision — never automatic.
    requiresAttention: summary.delivery_unknown + summary.failed + summary.dispatching,
    rows,
  });
}
