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
 */

import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser, isAdmin } from "@/lib/auth";
import { csrfGuard } from "@/lib/csrf";
import { requeueEmailNotification } from "@/lib/email-outbox";

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

  const result = await requeueEmailNotification({ id: notificationId, actorId: user.id });
  if (!result.ok) {
    return NextResponse.json({ outcome: "rejected", code: result.code }, { status: 409 });
  }
  return NextResponse.json({ outcome: "requeued", code: result.code });
}
