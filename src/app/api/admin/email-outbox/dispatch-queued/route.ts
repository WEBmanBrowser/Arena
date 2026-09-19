/**
 * PAYMENT P0 (C4) — POST /api/admin/email-outbox/dispatch-queued
 *
 * OPERATOR-DRIVEN, BOUNDED drain of notifications stuck in `queued`.
 *
 * WHY THIS EXISTS
 *  A requeue commits the audited state change and THEN dispatches. If the process
 *  dies in between, the row stays `queued` — committed, never handed to a
 *  transport — and there is deliberately no cron anywhere that would ever pick it
 *  up (M5: no Cloudflare Cron Trigger). This endpoint is the explicit, audited
 *  human path that re-drives those rows.
 *
 * SCOPE — deliberately narrow and bounded
 *  • ONLY rows in `queued` are eligible (`dispatchQueuedEmails` selects nothing
 *    else). `dispatching` rows are NEVER swept here: their claim is released
 *    exclusively through the single-row `?releaseStrandedClaim=1` decision, and
 *    only when the claim is demonstrably abandoned. `delivery_unknown` rows are
 *    NEVER retried automatically — they require the human per-row decision.
 *  • The batch is bounded server-side (`limit`, 1–20; default 5). No message
 *    content, recipient, subject or id list is accepted from the caller.
 *  • Each row is claimed through the same atomic `status = 'queued'` CAS used by
 *    the normal dispatch, so two concurrent operators can never send the same
 *    notification twice.
 *  • No financial transaction is open here and no provider is called: the money
 *    movement is already committed; this only drains its notification.
 *
 * Authorisation: admin only. CSRF: same-origin (project standard). Audited.
 */

import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser, isAdmin } from "@/lib/auth";
import { csrfGuard } from "@/lib/csrf";
import { dispatchQueuedEmails } from "@/lib/email-outbox";
import { createAuditLog } from "@/lib/audit";

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

export async function POST(req: NextRequest) {
  const csrf = csrfGuard(req);
  if (csrf) return csrf;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sessão requerida" }, { status: 401 });
  if (!isAdmin(user.role)) {
    return NextResponse.json({ error: "Operação requer nível admin" }, { status: 403 });
  }

  let requested: unknown = undefined;
  try {
    const body = (await req.json()) as { limit?: unknown };
    requested = body?.limit;
  } catch {
    // An empty body is valid: nothing about the messages can be supplied anyway.
    requested = undefined;
  }

  const parsed = typeof requested === "number" ? requested : Number(requested);
  const limit = Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, MAX_LIMIT) : DEFAULT_LIMIT;

  const result = await dispatchQueuedEmails(limit);

  await createAuditLog({
    userId: user.id,
    action: "email_outbox.queued_dispatched",
    entity: "email_notification",
    details: { limit, ...result },
  });

  return NextResponse.json({ outcome: "dispatched", limit, ...result });
}
