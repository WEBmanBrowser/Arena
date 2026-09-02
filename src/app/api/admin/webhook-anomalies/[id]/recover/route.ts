/**
 * B.3.5.2 — POST /api/admin/webhook-anomalies/[id]/recover
 *
 * Safe recovery action for a single ignored Eupago refund webhook event.
 *
 * Authorisation: Manager / Admin only. CSRF: required.
 * Request body: EMPTY. All financial / correlation values come from the
 *               trusted persisted `provider_webhook_events.metadata`, set
 *               at verified ingestion by the existing settlement pipeline.
 *
 * Response: a sanitized `{ outcome: "settled" | "already_settled", refund: {...} }`
 *           on success, or `{ outcome: "rejected", code, message }` on refusal.
 *
 * Forbidden by design:
 *   - no financial fields in the request body;
 *   - no generic replay / mark-processed / arbitrary state mutation;
 *   - no creation of new refund_attempts (recovery only correlates to an
 *     existing one — if none exists, the response is a deterministic
 *     `REFUND_CANDIDATE_NOT_FOUND` and the event stays ignored/visible).
 */

import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser, isManager } from "@/lib/auth";
import { csrfGuard } from "@/lib/csrf";
import { recoverIgnoredEupagoRefund } from "@/lib/services/eupago-refund-recovery-service";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // CSRF — the same standard applied to every other admin state mutation.
  const csrf = csrfGuard(req);
  if (csrf) return csrf;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sessão requerida" }, { status: 401 });
  if (!isManager(user.role)) {
    return NextResponse.json({ error: "Operação requer nível manager ou admin" }, { status: 403 });
  }

  const { id } = await params;
  const webhookEventId = Number(id);
  if (!Number.isInteger(webhookEventId) || webhookEventId < 1) {
    return NextResponse.json({ error: "ID inválido" }, { status: 400 });
  }

  // The body is intentionally unused — we only accept an empty / opaque
  // payload. A non-empty JSON body with financial fields would be ignored,
  // not echoed. (Defence-in-depth: we never read body fields.)
  // We DO NOT call req.json() at all: any financial/correlation field in
  // the request is rejected by silence.

  const result = await recoverIgnoredEupagoRefund({
    webhookEventId,
    actorId: user.id,
  });

  if (result.outcome === "settled") {
    return NextResponse.json({
      outcome: "settled",
      refund: {
        id: result.refund.id,
        orderId: result.refund.orderId,
        amountCents: result.refund.amountCents,
        currency: result.refund.currency,
        status: result.refund.status,
        providerRefundId: result.refund.providerRefundId,
      },
      webhookEvent: {
        id: result.webhookEvent.id,
        status: result.webhookEvent.status,
        providerEventId: result.webhookEvent.providerEventId,
      },
    });
  }
  if (result.outcome === "already_settled") {
    return NextResponse.json({
      outcome: "already_settled",
      refund: {
        id: result.refund.id,
        orderId: result.refund.orderId,
        amountCents: result.refund.amountCents,
        currency: result.refund.currency,
        status: result.refund.status,
        providerRefundId: result.refund.providerRefundId,
      },
      webhookEvent: {
        id: result.webhookEvent.id,
        status: result.webhookEvent.status,
        providerEventId: result.webhookEvent.providerEventId,
      },
    });
  }

  // Rejection — return a deterministic code + a sanitized human message.
  const status = rejectionStatus(result.code);
  return NextResponse.json(
    { outcome: "rejected", code: result.code, message: result.message },
    { status }
  );
}

function rejectionStatus(code: string): number {
  switch (code) {
    case "WEBHOOK_EVENT_NOT_FOUND":
      return 404;
    case "WRONG_PROVIDER":
    case "WRONG_STATUS":
    case "WRONG_LAST_ERROR":
    case "LEGACY_EVENT_UNRECOVERABLE":
    case "MISSING_PERSISTED_METADATA":
    case "MISSING_TRID":
    case "MISSING_ORIGINAL_TRID":
    case "MISSING_AMOUNT":
    case "MISSING_CURRENCY":
    case "INVALID_AMOUNT":
    case "INVALID_CURRENCY":
    case "ORIGINAL_PAYMENT_NOT_FOUND":
    case "REFUND_CANDIDATE_NOT_FOUND":
      return 409;
    case "ALREADY_PROCESSED":
    case "ALREADY_SETTLED":
      return 409;
    case "CONFLICT":
      return 409;
    default:
      return 400;
  }
}
