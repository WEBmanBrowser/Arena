/**
 * PAYMENT P0 (M5) — POST /api/admin/email-outbox/[id]/requeue
 *
 * OPERATOR-DRIVEN recovery for ONE notification stuck in `failed` or
 * `delivery_unknown`. There is NO automatic retry anywhere in the outbox: a
 * `delivery_unknown` message may already have reached the customer, so the
 * decision to re-send is a human one.
 *
 * Authorisation: admin only. CSRF: same-origin (standard admin mutation guard).
 * Body: EMPTY — nothing about the message can be supplied by the caller (no
 * recipient, no subject, no content); the row is simply re-armed for ONE new
 * dispatch, and the body is re-rendered from committed state.
 *
 * MEDIUM-2 — the requeue ACTUALLY DISPATCHES: after the audited state change
 * commits, one dispatch is attempted post-commit with the real transport, and the
 * outcome is reported back to the operator (`sent` / `failed` / `delivery_unknown`
 * / `not_attempted`). A `delivery_unknown` row is still never re-sent
 * automatically — only this explicit operator action re-drives it.
 *
 * C4 — STRANDED DISPATCH RECOVERY: a crash between the requeue commit and the
 * dispatch leaves the row in `queued`, and a crash DURING the dispatch leaves it
 * in `dispatching` with `dispatch_started_at` set. The second case is recoverable
 * only through the explicit `?releaseStrandedClaim=1` decision: it releases the
 * claim when (and only when) it is demonstrably ABANDONED — older than
 * `STRANDED_CLAIM_MS` — so an in-flight dispatch is never re-driven concurrently.
 * A fresh claim is refused with `CLAIM_STILL_ACTIVE`. The flag carries NO message
 * data: it is an operator decision, nothing else.
 *
 * The HTTP response stays free of recipients, subject and provider internals.
 */

import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser, isAdmin } from "@/lib/auth";
import { csrfGuard } from "@/lib/csrf";
import { redispatchRequeuedNotification } from "@/lib/email-outbox";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const csrf = csrfGuard(req);
  if (csrf) return csrf;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sessão requerida" }, { status: 401 });
  if (!isAdmin(user.role)) {
    return NextResponse.json({ error: "Operação requer nível admin" }, { status: 403 });
  }

  const { id } = await params;
  const notificationId = Number(id);
  if (!Number.isInteger(notificationId) || notificationId < 1) {
    return NextResponse.json({ error: "ID inválido" }, { status: 400 });
  }

  // C4 — explicit, audited release of an ABANDONED dispatch claim. Nothing about
  // the message can be supplied by the caller; the flag only allows a
  // `dispatching` row whose claim is older than STRANDED_CLAIM_MS to be re-armed.
  const releaseStrandedClaim = req.nextUrl.searchParams.get("releaseStrandedClaim") === "1";

  const result = await redispatchRequeuedNotification({
    id: notificationId,
    actorId: user.id,
    allowStrandedClaim: releaseStrandedClaim,
  });
  if (!result.ok) {
    return NextResponse.json(
      { outcome: "rejected", code: result.code, releaseStrandedClaim },
      { status: 409 }
    );
  }
  return NextResponse.json({
    outcome: "requeued",
    code: result.code,
    releaseStrandedClaim,
    dispatch: result.dispatch,
  });
}
