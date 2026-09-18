/**
 * PAYMENT P0 — items 20/21/22 + M5: the post-commit email outbox.
 *
 * Guarantees under test:
 *   • the notification row is enqueued INSIDE the financial transaction;
 *   • the transport is only touched AFTER the commit, and never from inside a tx;
 *   • `delivery_unknown` exists and is NEVER retried automatically;
 *   • a `dispatching` row is not re-claimed (at-most-once hand-off);
 *   • operators can read the outbox (masked) and requeue a single row (admin);
 *   • a manual confirmation marks ONE canonical payment, never all of them;
 *   • the financial audit is written inside the same transaction (item 21).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { auditLogs, emailNotifications, orders, payments } from "@/db/schema";
import { and, eq, like } from "drizzle-orm";
import { confirmOrderPayment, confirmOrderPaymentInTx } from "@/lib/orders";
import {
  claimQueuedEmail,
  dispatchEmailNotification,
  dispatchQueuedEmails,
  enqueueEmail,
  getEmailOutboxSummary,
  listEmailOutboxForOperations,
  maskRecipient,
  requeueEmailNotification,
} from "@/lib/email-outbox";
import { GET as outboxGET } from "@/app/api/admin/email-outbox/route";
import { POST as requeuePOST } from "@/app/api/admin/email-outbox/[id]/requeue/route";
import { cleanupByPrefix, createPendingOrder, createUser, unique } from "@/test-support/fixtures";

const PREFIX = "P0O";

const authState: { user: { id: number; role: string } | null } = { user: null };
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getCurrentUser: async () => authState.user };
});

const TEST_TRANSPORT_KEY = "test-transport-key"; // never a real credential

function transport(status: number, body: unknown = {}): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

beforeEach(async () => {
  await cleanupByPrefix(PREFIX);
  authState.user = null;
});
afterEach(async () => {
  await cleanupByPrefix(PREFIX);
});

/** A committed, still-`queued` notification (the suite has no transport key). */
async function queueNotification(orderId: number): Promise<number> {
  const [row] = await db
    .insert(emailNotifications)
    .values({
      eventKey: `p0o-${orderId}-${unique()}`,
      type: "payment_confirmed",
      recipient: "cliente@test.local",
      subject: "Encomenda paga",
      status: "queued",
      referenceType: "order",
      referenceId: orderId,
    })
    .returning();
  return row.id;
}

async function outboxRow(orderId: number) {
  const [row] = await db
    .select()
    .from(emailNotifications)
    .where(and(eq(emailNotifications.referenceType, "order"), eq(emailNotifications.referenceId, orderId)))
    .limit(1);
  return row;
}

describe("P0 items 20/21 — enqueue in-tx, deliver post-commit", () => {
  it("writes the notification and the financial audit inside the SAME transaction", async () => {
    const { orderId } = await createPendingOrder({ prefix: PREFIX });

    // A transaction that is rolled back must leave NOTHING behind — proof that
    // both rows belong to the financial transaction (and that no email could
    // have been sent from inside it).
    await expect(
      db.transaction(async (tx) => {
        const result = await confirmOrderPaymentInTx(tx, { orderId, actorId: null, source: "manual" });
        expect(result.changed).toBe(true);
        expect(result.notificationId).not.toBeNull();
        const [notification] = await tx
          .select()
          .from(emailNotifications)
          .where(eq(emailNotifications.id, result.notificationId!))
          .limit(1);
        expect(notification.status).toBe("queued");
        throw new Error("ROLLBACK_PLEASE");
      })
    ).rejects.toThrow("ROLLBACK_PLEASE");

    expect(await outboxRow(orderId)).toBeUndefined();
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    expect(order.status).toBe("pending_payment");
  });

  it("keeps the notification deduplicated by event key", async () => {
    const { orderId } = await createPendingOrder({ prefix: PREFIX });
    const first = await confirmOrderPayment(orderId, null, { source: "manual" });
    expect(first.changed).toBe(true);
    const second = await confirmOrderPayment(orderId, null, { source: "manual" });
    expect(second.changed).toBe(false);

    const rows = await db
      .select()
      .from(emailNotifications)
      .where(and(eq(emailNotifications.referenceType, "order"), eq(emailNotifications.referenceId, orderId)));
    expect(rows).toHaveLength(1);
  });

  it("never claims a notification that another dispatcher already claimed", async () => {
    const { orderId } = await createPendingOrder({ prefix: PREFIX });
    const notificationId = await queueNotification(orderId);
    const [row] = await db.select().from(emailNotifications).where(eq(emailNotifications.id, notificationId)).limit(1);
    expect(row.status).toBe("queued");

    const claimed = await claimQueuedEmail(row.id);
    expect(claimed).not.toBeNull();
    expect(claimed!.status).toBe("dispatching");
    expect(claimed!.dispatchStartedAt).not.toBeNull();

    // A second claimer (or a crash-restart) cannot take it again.
    expect(await claimQueuedEmail(row.id)).toBeNull();
    expect(await dispatchEmailNotification(row.id, { fetchImpl: transport(200), apiKey: TEST_TRANSPORT_KEY })).toBe("not_claimable");
  });

  it("fails the row definitively when the template context no longer exists", async () => {
    const { orderId } = await createPendingOrder({ prefix: PREFIX });
    const [queued] = await db
      .insert(emailNotifications)
      .values({
        type: "unknown_operational_type",
        recipient: "cliente@test.local",
        subject: "x",
        status: "queued",
        referenceType: "order",
        referenceId: orderId,
      })
      .returning();

    const outcome = await dispatchEmailNotification(queued.id, { fetchImpl: transport(200), apiKey: TEST_TRANSPORT_KEY });
    expect(outcome).toBe("failed");
    const [after] = await db.select().from(emailNotifications).where(eq(emailNotifications.id, queued.id)).limit(1);
    expect(after.status).toBe("failed");
    expect(after.lastError).toBe("TEMPLATE_CONTEXT_UNAVAILABLE");
  });
});

describe("M5 — delivery_unknown is terminal until a human decides", () => {
  it("marks 5xx / 429 as delivery_unknown and NEVER retries automatically", async () => {
    const { orderId } = await createPendingOrder({ prefix: PREFIX });
    const notificationId = await queueNotification(orderId);

    const outcome = await dispatchEmailNotification(notificationId, { fetchImpl: transport(503, { name: "provider_busy" }), apiKey: TEST_TRANSPORT_KEY });
    expect(outcome).toBe("delivery_unknown");
    const row = { id: notificationId };

    const [after] = await db.select().from(emailNotifications).where(eq(emailNotifications.id, row.id)).limit(1);
    expect(after.status).toBe("delivery_unknown");
    expect(after.lastError).toBe("TRANSPORT_HTTP_503");

    // A queue sweep finds nothing to do: the row is NOT re-attempted.
    const sweep = await dispatchQueuedEmails(50, { fetchImpl: transport(200), apiKey: TEST_TRANSPORT_KEY });
    expect(sweep.attempted).toBe(0);
    const [stillUnknown] = await db.select().from(emailNotifications).where(eq(emailNotifications.id, row.id)).limit(1);
    expect(stillUnknown.status).toBe("delivery_unknown");
    expect(stillUnknown.attempts).toBe(after.attempts);
  });

  it("records a definitive 4xx rejection as failed with a sanitized provider code", async () => {
    const { orderId } = await createPendingOrder({ prefix: PREFIX });
    const notificationId = await queueNotification(orderId);

    const outcome = await dispatchEmailNotification(notificationId, {
      fetchImpl: transport(422, { name: "validation_error", message: "recipient rejected: cliente@test.local" }),
      apiKey: TEST_TRANSPORT_KEY,
    });
    expect(outcome).toBe("failed");
    const row = { id: notificationId };

    const [after] = await db.select().from(emailNotifications).where(eq(emailNotifications.id, row.id)).limit(1);
    expect(after.status).toBe("failed");
    // Only the sanitized NAME is persisted — never the raw provider body, which
    // here contained the recipient address.
    expect(after.lastError).toBe("validation_error");
    // The raw provider body (which echoed the recipient) is NOT persisted.
    expect(after.lastError).not.toContain("cliente@test.local");
    expect(JSON.stringify(after.lastError)).not.toContain("recipient rejected");
  });

  it("sends a queued notification exactly once when the transport accepts it", async () => {
    const { orderId } = await createPendingOrder({ prefix: PREFIX });
    const notificationId = await queueNotification(orderId);
    const row = { id: notificationId };

    let calls = 0;
    const counting = (async () => {
      calls += 1;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    expect(await dispatchEmailNotification(row.id, { fetchImpl: counting, apiKey: TEST_TRANSPORT_KEY })).toBe("sent");
    expect(calls).toBe(1);
    const [after] = await db.select().from(emailNotifications).where(eq(emailNotifications.id, row.id)).limit(1);
    expect(after.status).toBe("sent");
    expect(after.sentAt).not.toBeNull();

    // Already sent → never dispatched again.
    expect(await dispatchEmailNotification(row.id, { fetchImpl: counting, apiKey: TEST_TRANSPORT_KEY })).toBe("not_claimable");
    expect(calls).toBe(1);
  });

  it("treats a transport with no credentials as definitively failed (no HTTP attempt)", async () => {
    const { orderId } = await createPendingOrder({ prefix: PREFIX });
    const notificationId = await queueNotification(orderId);
    const row = { id: notificationId };

    let calls = 0;
    const neverCalled = (async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const outcome = await dispatchEmailNotification(notificationId, { fetchImpl: neverCalled });
    // EMAIL_API_KEY is unset in the suite (the harness removes it): nothing is sent.
    expect(outcome).toBe("failed");
    expect(calls).toBe(0);
  });
});

describe("M5 — operator surfaces", () => {
  it("masks recipients in the operational read model", async () => {
    expect(maskRecipient("ana.silva@example.com")).toBe("a***a@example.com");
    expect(maskRecipient("a@b.pt")).toBe("a***@b.pt");
    expect(maskRecipient("not-an-email")).toBe("***");

    const { orderId } = await createPendingOrder({ prefix: PREFIX });
    const notificationId = await queueNotification(orderId);
    await dispatchEmailNotification(notificationId, { fetchImpl: transport(503), apiKey: TEST_TRANSPORT_KEY });

    const listed = await listEmailOutboxForOperations(50);
    const mine = listed.find((entry) => entry.id === notificationId);
    expect(mine).toBeDefined();
    expect(mine!.maskedRecipient).toContain("***");
    expect(JSON.stringify(listed)).not.toContain("cliente-");

    const summary = await getEmailOutboxSummary();
    expect(summary.delivery_unknown).toBeGreaterThanOrEqual(1);
    expect(summary.queued).toBeGreaterThanOrEqual(0);
  });

  it("requires manager+ to read and admin+CSRF to requeue", async () => {
    const { orderId } = await createPendingOrder({ prefix: PREFIX });
    const notificationId = await queueNotification(orderId);
    await dispatchEmailNotification(notificationId, { fetchImpl: transport(500), apiKey: TEST_TRANSPORT_KEY });
    const row = { id: notificationId };

    // Unauthenticated / under-privileged reads are refused.
    authState.user = null;
    expect((await outboxGET()).status).toBe(401);

    const customer = await createUser(PREFIX, "customer");
    authState.user = { id: customer.id, role: "customer" };
    expect((await outboxGET()).status).toBe(403);

    const manager = await createUser(PREFIX, "manager");
    authState.user = { id: manager.id, role: "manager" };
    const read = await outboxGET();
    expect(read.status).toBe(200);
    expect(await read.json()).toHaveProperty("summary");

    // Requeue is ADMIN-only and CSRF-guarded.
    const requeue = () =>
      requeuePOST(
        new NextRequest(`http://loja.mdtech.pt/api/admin/email-outbox/${row.id}/requeue`, {
          method: "POST",
          headers: { origin: "http://loja.mdtech.pt", host: "loja.mdtech.pt" },
          body: "{}",
        }),
        { params: Promise.resolve({ id: String(row.id) }) }
      );

    expect((await requeue()).status).toBe(403); // manager is not enough
    const admin = await createUser(PREFIX, "admin");
    authState.user = { id: admin.id, role: "admin" };
    const ok = await requeue();
    expect(ok.status).toBe(200);
    expect((await ok.json()).outcome).toBe("requeued");

    const [after] = await db.select().from(emailNotifications).where(eq(emailNotifications.id, row.id)).limit(1);
    expect(after.status).toBe("queued");
    expect(after.dispatchStartedAt).toBeNull();

    // Audited, and the same row cannot be requeued twice in a row.
    const audits = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "email_outbox.requeued"));
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect((await requeue()).status).toBe(409);

    // The service itself refuses non-requeueable rows too (defence in depth).
    expect((await requeueEmailNotification({ id: row.id, actorId: admin.id })).ok).toBe(false);
  });
});

describe("P0 item 22 — manual confirmation marks ONE payment", () => {
  it("never marks every payment of the order as paid", async () => {
    const { orderId, total } = await createPendingOrder({ prefix: PREFIX });

    // A second, unrelated pending payment for the SAME order (e.g. a second
    // checkout attempt). The manual confirmation must not settle it silently.
    const [extra] = await db
      .insert(payments)
      .values({
        orderId,
        provider: "manual",
        method: "bank_transfer",
        amount: total,
        currency: "EUR",
        status: "pending",
      })
      .returning();

    const [first] = await db.select().from(payments).where(eq(payments.orderId, orderId)).limit(1);
    const result = await confirmOrderPayment(orderId, null, { source: "manual", paymentId: first.id });
    expect(result.success).toBe(true);
    expect(result.changed).toBe(true);

    const rows = await db.select().from(payments).where(eq(payments.orderId, orderId));
    const paid = rows.filter((row) => row.status === "paid");
    expect(paid).toHaveLength(1);
    expect(paid[0].id).toBe(first.id);
    expect(paid.map((row: { id: number }) => row.id)).not.toContain(extra.id);

    const [extraAfter] = await db.select().from(payments).where(eq(payments.id, extra.id)).limit(1);
    expect(extraAfter.status).toBe("pending");

    // The audit trail names the settled payment (item 21).
    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entity, "order"), eq(auditLogs.entityId, orderId), like(auditLogs.action, "order.payment%")))
      .limit(1);
    expect(audit).toBeDefined();
  });

  it("refuses a paymentId that belongs to another order", async () => {
    const a = await createPendingOrder({ prefix: PREFIX });
    const b = await createPendingOrder({ prefix: PREFIX });
    const [paymentB] = await db.select().from(payments).where(eq(payments.orderId, b.orderId)).limit(1);

    const result = await confirmOrderPayment(a.orderId, null, { source: "manual", paymentId: paymentB.id });
    expect(result.success).toBe(false);
    const [orderA] = await db.select().from(orders).where(eq(orders.id, a.orderId)).limit(1);
    expect(orderA.status).toBe("pending_payment");
  });
});
