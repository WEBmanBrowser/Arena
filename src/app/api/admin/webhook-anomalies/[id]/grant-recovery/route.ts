/**
 * PAYMENT P0 (H3) — POST /api/admin/webhook-anomalies/[id]/grant-recovery
 *
 * RESTRICTED administrative recovery for an AUTHENTICATED financial webhook
 * whose capped processing budget ran out (five failed/deferred deliveries).
 *
 * What it does: raises that event's retry budget by one bounded window, so the
 * provider's NEXT authenticated delivery of the same `trid` can be evaluated
 * again. That is all.
 *
 * What it deliberately does NOT do:
 *   • it never touches a `processed` event (first predicate of the service);
 *   • it does not re-send anything, does not call Eupago and never creates a
 *     payment or an attempt;
 *   • it does not fabricate a payload: no financial value is accepted from the
 *     caller. When the persisted trusted metadata is not sufficient to resolve
 *     the event automatically, the response says so explicitly
 *     (`NEW_AUTHENTICATED_DELIVERY_REQUIRED`) and the operator must obtain a new
 *     delivery from the provider.
 *
 * Authorisation: manager+. CSRF: same-origin. Body: EMPTY (ignored by design).
 * The concession itself is audited (`webhook.recovery_budget_granted`).
 */

import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser, isManager } from "@/lib/auth";
import { csrfGuard } from "@/lib/csrf";
import { createAuditLog } from "@/lib/audit";
import { EUPAGO_PROVIDER_ID } from "@/lib/providers/eupago/config";
import {
  grantWebhookRecoveryBudget,
  getWebhookEvent,
  isDeferredWebhookEvent,
} from "@/lib/providers/webhook-events";
import { isMetadataEligibleForRecovery } from "@/lib/services/eupago-refund-recovery-service";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const csrf = csrfGuard(req);
  if (csrf) return csrf;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sessão requerida" }, { status: 401 });
  if (!isManager(user.role)) {
    return NextResponse.json({ error: "Operação requer nível manager ou admin" }, { status: 403 });
  }

  const { id } = await params;
  const eventId = Number(id);
  if (!Number.isInteger(eventId) || eventId < 1) {
    return NextResponse.json({ error: "ID inválido" }, { status: 400 });
  }

  const event = await getWebhookEvent(eventId);
  if (!event) return NextResponse.json({ outcome: "rejected", code: "EVENT_NOT_FOUND" }, { status: 404 });
  if (event.provider !== EUPAGO_PROVIDER_ID) {
    return NextResponse.json({ outcome: "rejected", code: "WRONG_PROVIDER" }, { status: 409 });
  }

  // The grant is only meaningful for an event that is deferred or failed OUT OF
  // BUDGET — never for a processed/ignored one.
  const deferred = isDeferredWebhookEvent(event);
  const failedOutOfBudget = event.status === "failed";
  if (!deferred && !failedOutOfBudget) {
    return NextResponse.json({ outcome: "rejected", code: "WRONG_STATUS" }, { status: 409 });
  }

  // If the persisted trusted metadata could be resolved WITHOUT a new delivery
  // (refund movements carry originalTrid/amount/currency), the operator is
  // pointed at the existing refund recovery instead of burning a grant.
  if (isMetadataEligibleForRecovery(event)) {
    return NextResponse.json(
      {
        outcome: "rejected",
        code: "USE_REFUND_RECOVERY",
        message: "Este evento tem metadados suficientes — usar /recover (recuperação de reembolso).",
      },
      { status: 409 }
    );
  }

  const granted = await grantWebhookRecoveryBudget({ eventId });
  if (granted.outcome === "rejected") {
    return NextResponse.json({ outcome: "rejected", code: granted.code }, { status: 409 });
  }

  await createAuditLog({
    userId: user.id,
    action: "webhook.recovery_budget_granted",
    entity: "provider_webhook_event",
    entityId: eventId,
    details: { provider: EUPAGO_PROVIDER_ID, grants: granted.grants, attempts: granted.event.attempts },
  });

  return NextResponse.json({
    outcome: "granted",
    grants: granted.grants,
    // The event can only be settled by a NEW authenticated delivery — no
    // financial value is produced by this action.
    nextStep: "NEW_AUTHENTICATED_DELIVERY_REQUIRED",
  });
}
