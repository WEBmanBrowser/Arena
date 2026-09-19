/**
 * PAYMENT P0 (item 20 / M5) — post-commit email outbox.
 *
 * WHY AN OUTBOX
 *  The settlement path must be ONE PostgreSQL transaction (webhook claim +
 *  attempt + payment + order + stock + history + audit + notification row +
 *  webhook processed). Resend is an external HTTP call and therefore may NEVER
 *  happen inside that transaction. The notification row is written INSIDE the
 *  transaction (so it is atomic with the money movement and deduplicated by the
 *  existing `event_key` unique constraint) and is handed to the transport only
 *  AFTER the commit succeeded.
 *
 * DELIVERY SEMANTICS (no automatic retries)
 *  queued           → committed, never handed to a transport
 *  dispatching      → claimed; `dispatch_started_at` set (fencing)
 *  sent             → transport accepted (2xx)
 *  failed           → transport DEFINITIVELY rejected (4xx other than 429)
 *  delivery_unknown → ambiguous (network error, timeout, 5xx, 429). It is NEVER
 *                     retried automatically: the notification may already have
 *                     been delivered, so a retry could duplicate a real email.
 *                     Operator-driven `requeueEmailNotification()` is the only
 *                     path out of that state (documented, audited).
 *
 * NO CRON: nothing here schedules itself. `dispatchQueuedEmails()` is an
 * explicit call, and no Cloudflare Cron Trigger is configured for it in this
 * checkpoint.
 */

import { db } from "@/db";
import { emailNotifications, orders } from "@/db/schema";
import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { createAuditLog } from "@/lib/audit";
import { orderPaidEmail } from "@/lib/email";
import type { EmailOutboxStatus } from "@/db/schema";

export type EmailNotificationRow = typeof emailNotifications.$inferSelect;

/** Injectable transport (tests only; production always uses the real fetch). */
export interface EmailTransportDeps {
  /**
   * Transport override. Supplied ONLY by tests (the suite injects a simulated
   * transport so it can never reach the real provider).
   */
  readonly fetchImpl?: typeof fetch;
  /** Credential override that travels with the injected transport. */
  readonly apiKey?: string;
  readonly from?: string;
}

export type TransportOutcome =
  | { readonly kind: "sent" }
  | { readonly kind: "failed"; readonly code: string }
  | { readonly kind: "unknown"; readonly code: string };

export interface EnqueueEmailInput {
  /** Also the RENDERING key used post-commit (see `renderOutboxEmail`). */
  readonly type: string;
  readonly recipient: string;
  readonly subject: string;
  /** Idempotency key — the existing `email_notifications.event_key` unique. */
  readonly eventKey?: string | null;
  readonly referenceType?: string | null;
  readonly referenceId?: number | null;
}

type Tx = any;

/**
 * Write the notification row inside the caller's transaction.
 *
 * Returns `created: false` when an identical `event_key` already exists — the
 * exactly-once guarantee for "payment confirmed" style emails, now enforced
 * inside the same transaction as the settlement itself.
 */
export async function enqueueEmail(
  tx: Tx,
  input: EnqueueEmailInput
): Promise<{ created: boolean; id: number | null }> {
  const values = {
    eventKey: input.eventKey ?? null,
    type: input.type,
    recipient: input.recipient,
    subject: input.subject,
    status: "queued" as EmailOutboxStatus,
    referenceType: input.referenceType ?? null,
    referenceId: input.referenceId ?? null,
  };

  if (values.eventKey) {
    const rows = await tx
      .insert(emailNotifications)
      .values(values)
      .onConflictDoNothing({ target: emailNotifications.eventKey })
      .returning({ id: emailNotifications.id });
    if (rows.length === 0) return { created: false, id: null };
    return { created: true, id: rows[0].id };
  }

  const [row] = await tx.insert(emailNotifications).values(values).returning({ id: emailNotifications.id });
  return { created: true, id: row?.id ?? null };
}

/** Claim a queued notification for dispatch. At most one dispatcher wins. */
export async function claimQueuedEmail(id: number): Promise<EmailNotificationRow | null> {
  const now = new Date();
  const [row] = await db
    .update(emailNotifications)
    .set({ status: "dispatching", dispatchStartedAt: now })
    .where(and(eq(emailNotifications.id, id), eq(emailNotifications.status, "queued")))
    .returning();
  return row ?? null;
}

/**
 * Dispatch ONE already-committed notification.
 *
 * The row must be claimed first (`claimQueuedEmail`). Nothing is retried: an
 * ambiguous transport outcome lands in `delivery_unknown` and stays there until
 * an operator explicitly requeues it.
 */
export async function dispatchEmailNotification(
  id: number,
  deps: EmailTransportDeps = {}
): Promise<EmailOutboxStatus | "not_claimable"> {
  const claimed = await claimQueuedEmail(id);
  if (!claimed) return "not_claimable";

  const rendered = await renderOutboxEmail(claimed);
  if (!rendered) {
    // The body could not be re-derived from committed state → nothing is sent
    // and the row is definitively failed (never a silent half-delivery).
    await db
      .update(emailNotifications)
      .set({
        status: "failed",
        attempts: sql`${emailNotifications.attempts} + 1`,
        lastError: "TEMPLATE_CONTEXT_UNAVAILABLE",
      })
      .where(eq(emailNotifications.id, id));
    return "failed";
  }

  const outcome = await deliverEmail(
    {
      to: claimed.recipient,
      subject: rendered.subject,
      html: rendered.html,
    },
    deps
  );

  const now = new Date();
  if (outcome.kind === "sent") {
    await db
      .update(emailNotifications)
      .set({ status: "sent", sentAt: now, attempts: sql`${emailNotifications.attempts} + 1`, lastError: null })
      .where(eq(emailNotifications.id, id));
    return "sent";
  }

  const status: EmailOutboxStatus = outcome.kind === "failed" ? "failed" : "delivery_unknown";
  await db
    .update(emailNotifications)
    .set({
      status,
      attempts: sql`${emailNotifications.attempts} + 1`,
      lastError: outcome.code.slice(0, 250),
    })
    .where(eq(emailNotifications.id, id));
  return status;
}

/**
 * Dispatch committed-but-unsent notifications, oldest first.
 *
 * `dispatching` rows are NOT picked up again (they were handed to a transport
 * by a previous run — possibly the one that crashed mid-flight); they remain
 * visible for operations instead of being silently re-sent.
 */
export async function dispatchQueuedEmails(
  limit = 20,
  deps: EmailTransportDeps = {}
): Promise<{ attempted: number; sent: number; failed: number; unknown: number }> {
  const queued = await db
    .select({ id: emailNotifications.id })
    .from(emailNotifications)
    .where(eq(emailNotifications.status, "queued"))
    .orderBy(asc(emailNotifications.id))
    .limit(Math.max(1, Math.min(limit, 100)));

  let sent = 0;
  let failed = 0;
  let unknown = 0;
  for (const row of queued) {
    const outcome = await dispatchEmailNotification(row.id, deps);
    if (outcome === "sent") sent += 1;
    else if (outcome === "failed") failed += 1;
    else if (outcome === "delivery_unknown") unknown += 1;
  }
  return { attempted: queued.length, sent, failed, unknown };
}

/**
 * OPERATOR-ONLY recovery for a single `delivery_unknown` / `failed`
 * notification. Admin level, CSRF-protected at the route, audited, and strictly
 * single-row: it re-arms the row for ONE new dispatch attempt. It is never
 * called automatically.
 */
/** A claim older than this was abandoned (crash mid-dispatch) and may be released. */
export const STRANDED_CLAIM_MS = 15 * 60 * 1000;

export async function requeueEmailNotification(input: {
  id: number;
  actorId: number;
  /** Release a claim abandoned by a crashed dispatch (operator decision). */
  readonly allowStrandedClaim?: boolean;
}): Promise<{ ok: boolean; code: string }> {
  const now = Date.now();
  // A `dispatching` row is only released when its claim is demonstrably ABANDONED
  // (older than STRANDED_CLAIM_MS): an in-flight dispatch must never be re-driven
  // concurrently. `delivery_unknown` / `failed` remain the normal cases.
  const claimableStatuses = input.allowStrandedClaim
    ? (["delivery_unknown", "failed", "dispatching"] as const)
    : (["delivery_unknown", "failed"] as const);

  const [row] = await db
    .update(emailNotifications)
    .set({ status: "queued", dispatchStartedAt: null, lastError: null })
    .where(
      and(
        eq(emailNotifications.id, input.id),
        inArray(emailNotifications.status, [...claimableStatuses]),
        input.allowStrandedClaim
          ? or(
              sql`${emailNotifications.status} <> 'dispatching'`,
              isNull(emailNotifications.dispatchStartedAt),
              lt(
                emailNotifications.dispatchStartedAt,
                new Date(now - STRANDED_CLAIM_MS)
              )
            )
          : undefined
      )
    )
    .returning();

  if (!row) {
    // Distinguish "no such row / wrong state" from "claim still too fresh".
    //
    // `CLAIM_STILL_ACTIVE` is only meaningful to a caller that ASKED to release an
    // abandoned claim (that is the only caller who could have resolved it): the
    // default requeue path must not report a dispatching row as if the operator had
    // requested its release.
    const [current] = await db
      .select({ status: emailNotifications.status, dispatchStartedAt: emailNotifications.dispatchStartedAt })
      .from(emailNotifications)
      .where(eq(emailNotifications.id, input.id))
      .limit(1);
    if (
      input.allowStrandedClaim === true &&
      current?.status === "dispatching" &&
      current.dispatchStartedAt &&
      now - current.dispatchStartedAt.getTime() < STRANDED_CLAIM_MS
    ) {
      return { ok: false, code: "CLAIM_STILL_ACTIVE" };
    }
    return { ok: false, code: "NOT_REQUEUEABLE" };
  }

  await createAuditLog({
    userId: input.actorId,
    action: "email_outbox.requeued",
    entity: "email_notification",
    entityId: row.id,
    details: {
      type: row.type,
      referenceType: row.referenceType,
      referenceId: row.referenceId,
      releasedAbandonedClaim: input.allowStrandedClaim === true,
    },
  });
  return { ok: true, code: "REQUEUED" };
}

/** Result of the operator-driven requeue PLUS its explicit dispatch attempt. */
export type RequeueDispatchResult = {
  readonly ok: boolean;
  readonly code: string;
  /**
   * `not_attempted` when the requeue was refused or the dispatch crashed;
   * `not_claimable` when another worker claimed the row first.
   */
  readonly dispatch: EmailOutboxStatus | "not_attempted" | "not_claimable";
};

/**
 * MEDIUM-2 — THE OPERATOR PATH THAT ACTUALLY SENDS.
 *
 * A requeue that only flips the row back to `queued` leaves the notification
 * waiting for a sweep nobody calls: the operator sees "requeued" and the customer
 * never receives anything. This composite therefore performs the two steps in
 * order, with the SAME guarantees:
 *
 *   1. `requeueEmailNotification()` — atomic, authorized, audited, committed;
 *   2. `dispatchEmailNotification()` — POST-COMMIT, outside the financial
 *      transaction, with the real (or injected) transport.
 *
 * Failure/crash semantics:
 *   • refusal → nothing is sent (`not_attempted`);
 *   • crash between the two steps, or a crash mid-dispatch, leaves the row in
 *     `queued`/`dispatching` with `dispatch_started_at` set: it stays visible in
 *     the admin read model and can be released explicitly
 *     (`allowStrandedClaim`), or picked up by an explicit `dispatchQueuedEmails()`
 *     sweep. Nothing is ever re-sent automatically.
 */
export async function redispatchRequeuedNotification(input: {
  id: number;
  actorId: number;
  deps?: EmailTransportDeps;
  allowStrandedClaim?: boolean;
}): Promise<RequeueDispatchResult> {
  const requeued = await requeueEmailNotification({
    id: input.id,
    actorId: input.actorId,
    allowStrandedClaim: input.allowStrandedClaim,
  });
  if (!requeued.ok) return { ok: false, code: requeued.code, dispatch: "not_attempted" };

  try {
    const outcome = await dispatchEmailNotification(input.id, input.deps ?? {});
    return { ok: true, code: requeued.code, dispatch: outcome };
  } catch {
    // The requeue is committed: the row is `queued`/`dispatching` and remains
    // recoverable (never re-sent automatically, never lost).
    return { ok: true, code: requeued.code, dispatch: "not_attempted" };
  }
}

/** Status counters for the admin read model (no recipients, no secrets). */
export async function getEmailOutboxSummary(): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: emailNotifications.status, count: sql<number>`count(*)::int` })
    .from(emailNotifications)
    .groupBy(emailNotifications.status);
  const summary: Record<string, number> = {
    queued: 0,
    dispatching: 0,
    sent: 0,
    failed: 0,
    delivery_unknown: 0,
    legacy_pending: 0,
  };
  for (const row of rows) {
    if (row.status === "pending") summary.legacy_pending += row.count;
    else if (row.status in summary) summary[row.status] = row.count;
    else summary[row.status] = row.count;
  }
  return summary;
}

/**
 * Administrative read model: the rows that need attention, with the recipient
 * MASKED (the outbox is an operational surface, not a customer-data export).
 */
export async function listEmailOutboxForOperations(limit = 50): Promise<Array<{
  id: number;
  type: string;
  status: string;
  maskedRecipient: string;
  attempts: number;
  lastError: string | null;
  referenceType: string | null;
  referenceId: number | null;
  createdAt: Date;
  dispatchStartedAt: Date | null;
  sentAt: Date | null;
}>> {
  const rows = await db
    .select()
    .from(emailNotifications)
    .where(inArray(emailNotifications.status, ["queued", "dispatching", "delivery_unknown", "failed"]))
    .orderBy(asc(emailNotifications.id))
    .limit(Math.max(1, Math.min(limit, 200)));

  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    status: row.status,
    maskedRecipient: maskRecipient(row.recipient),
    attempts: row.attempts,
    lastError: row.lastError,
    referenceType: row.referenceType,
    referenceId: row.referenceId,
    createdAt: row.createdAt,
    dispatchStartedAt: row.dispatchStartedAt,
    sentAt: row.sentAt,
  }));
}

/** `ana.silva@example.com` → `a***a@example.com` (never the full local part). */
export function maskRecipient(recipient: string): string {
  const at = recipient.lastIndexOf("@");
  if (at <= 0) return "***";
  const local = recipient.slice(0, at);
  const domain = recipient.slice(at);
  const head = local.slice(0, 1);
  const tail = local.length > 1 ? local.slice(-1) : "";
  return `${head}***${tail}${domain}`;
}

// ─── Rendering (post-commit, from committed state only) ───

/**
 * Re-derive the message body AFTER the commit.
 *
 * The outbox intentionally stores no rendered HTML: the body is a pure function
 * of committed state (`type` + `referenceId`) and the existing templates. If the
 * context cannot be resolved, nothing is sent — a failed row is strictly safer
 * than an email describing a state that no longer exists.
 */
async function renderOutboxEmail(row: EmailNotificationRow): Promise<{ subject: string; html: string } | null> {
  if (row.type === "payment_confirmed" && row.referenceType === "order" && row.referenceId != null) {
    const [order] = await db
      .select({ orderNumber: orders.orderNumber })
      .from(orders)
      .where(eq(orders.id, row.referenceId))
      .limit(1);
    if (!order) return null;
    return orderPaidEmail(order.orderNumber);
  }
  return null;
}

// ─── Transport (sanitized, no raw provider payloads in logs) ──

/**
 * Hand one message to the configured transport and classify the outcome.
 *
 * LOGGING RULE (PAYMENT P0): the provider's raw response body is NEVER logged
 * (it can echo the recipient, the message id, or provider internals). Only a
 * sanitized status code / provider error NAME reaches the log.
 */
export async function deliverEmail(
  payload: { to: string; subject: string; html: string; text?: string },
  deps: EmailTransportDeps = {}
): Promise<TransportOutcome> {
  const apiKey = deps.apiKey ?? process.env.EMAIL_API_KEY;
  const fromAddress = deps.from ?? process.env.EMAIL_FROM ?? "noreply@mdtech.pt";
  if (!apiKey) {
    // No transport configured: this is DEFINITIVE (nothing was sent).
    return { kind: "failed", code: "EMAIL_API_KEY_NOT_CONFIGURED" };
  }

  let response: Response;
  try {
    // PAYMENT P0 (M3) — the transport is INJECTABLE so the test suite can never
    // reach the real Resend endpoint; production passes no override.
    const transportFetch = deps.fetchImpl ?? fetch;
    response = await transportFetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromAddress,
        to: [payload.to],
        subject: payload.subject,
        html: payload.html,
        text: payload.text,
      }),
    });
  } catch {
    // Network failure / timeout: the request may still have been delivered.
    return { kind: "unknown", code: "TRANSPORT_UNAVAILABLE" };
  }

  if (response.ok) return { kind: "sent" };

  // 5xx and 429 are ambiguous (the provider may have accepted the message).
  if (response.status >= 500 || response.status === 429) {
    return { kind: "unknown", code: `TRANSPORT_HTTP_${response.status}` };
  }

  // 4xx: definitively rejected. Only the sanitized provider error NAME is read.
  const providerCode = await readSanitizedProviderCode(response);
  return { kind: "failed", code: providerCode ?? `TRANSPORT_HTTP_${response.status}` };
}

async function readSanitizedProviderCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { name?: unknown; code?: unknown };
    const candidate = typeof body?.name === "string" ? body.name : typeof body?.code === "string" ? body.code : null;
    if (!candidate) return null;
    return /^[A-Za-z0-9_.:-]{1,60}$/.test(candidate) ? candidate : null;
  } catch {
    return null;
  }
}
