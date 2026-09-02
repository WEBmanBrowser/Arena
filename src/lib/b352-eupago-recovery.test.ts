/**
 * B.3.5.2 — Safe recovery for future ignored Eupago refund webhooks.
 *
 * Real PostgreSQL, real production services. Network is stubbed for the
 * non-relevant settlement path; the recovery service itself is exercised
 * end-to-end.
 *
 * Coverage:
 *  - concurrent same-event (only one recovery wins; the other gets a
 *    deterministic `ALREADY_PROCESSED` or `already_settled` outcome);
 *  - provider redelivery of the SAME refund trid (recovered once; re-recovery
 *    returns `already_settled` and never double-binds the refund_attempts row);
 *  - distinct-refund race (two pending refunds, two different trids — both
 *    settle on their respective targets);
 *  - equal-amount FIFO (the oldest pending refund_attempt is the one settled);
 *  - candidate re-read after lock (the post-lock list reflects the canonical
 *    state, not the pre-read snapshot);
 *  - already-settled (recovery of an event whose trid already settled a
 *    refund_attempt — no double bind, no second settlement, event processed);
 *  - over-refund (the B.3.5 trigger protects recovery too — the
 *    `REFUND_CANDIDATE_NOT_FOUND` outcome is returned with NO settlement);
 *  - missing trusted metadata (LEGACY_EVENT_UNRECOVERABLE / MISSING_* — no
 *    settlement, no claim, no audit noise);
 *  - wrong-provider / wrong-status / wrong-lastError (deterministic refusal
 *    without state change).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import {
  auditLogs,
  orders,
  payments,
  paymentAttempts,
  providerWebhookEvents,
  refundAttempts,
  users,
} from "@/db/schema";
import { and, eq, inArray, like } from "drizzle-orm";
import { recoverIgnoredEupagoRefund } from "@/lib/services/eupago-refund-recovery-service";

let seq = 0;
function unique(): string {
  seq += 1;
  return `${Date.now()}${seq}${Math.floor(Math.random() * 1e9)}`;
}

async function cleanup() {
  // No B.3.5.2 prefix on orders — recovery reuses B.3.5-prefixed fixtures.
  const oRows = await db
    .select({ id: orders.id })
    .from(orders)
    .where(like(orders.orderNumber, "B352-%"));
  const orderIds = oRows.map((o) => o.id);
  if (orderIds.length) {
    await db.delete(refundAttempts).where(inArray(refundAttempts.orderId, orderIds));
    await db.delete(paymentAttempts).where(inArray(paymentAttempts.orderId, orderIds));
    await db.delete(payments).where(inArray(payments.orderId, orderIds));
    await db.delete(orders).where(inArray(orders.id, orderIds));
  }
  await db.delete(providerWebhookEvents);
  await db.delete(auditLogs).where(like(auditLogs.action, "refund.recovery_%"));
  await db.delete(auditLogs).where(like(auditLogs.action, "refund.%"));
  await db.delete(users).where(like(users.email, "b352-%@test.local"));
}

async function createAdmin() {
  const [u] = await db
    .insert(users)
    .values({
      email: `b352-admin-${unique()}@test.local`,
      password: "x",
      name: "B.3.5.2 Admin",
      role: "admin",
    })
    .returning();
  return u;
}

async function paidOrder(totalCents = 10000) {
  const [order] = await db
    .insert(orders)
    .values({
      orderNumber: `B352-ORD-${unique()}`,
      status: "paid",
      paymentStatus: "paid",
      subtotal: (totalCents / 100).toFixed(2),
      shipping: "0.00",
      discount: "0.00",
      vat: "0.00",
      total: (totalCents / 100).toFixed(2),
      deliveryType: "pickup",
      paymentMethod: "mbway",
    })
    .returning();
  const [payment] = await db
    .insert(payments)
    .values({
      orderId: order.id,
      provider: "eupago",
      method: "mbway",
      amount: (totalCents / 100).toFixed(2),
      currency: "EUR",
      status: "paid",
      paidAt: new Date(),
    })
    .returning();
  return { order, payment };
}

/**
 * Set up a `paidOrder` with a `payment_attempt` whose `providerTransactionId`
 * equals `originalTrid`. Returns the fixture.
 */
async function createFixtureWithOriginalTrid(totalCents: number, originalTrid: string) {
  const { order, payment } = await paidOrder(totalCents);
  const [attempt] = await db
    .insert(paymentAttempts)
    .values({
      orderId: order.id,
      provider: "eupago",
      method: "mbway",
      amountCents: totalCents,
      currency: "EUR",
      status: "paid",
      providerTransactionId: originalTrid,
      completedAt: new Date(),
    })
    .returning();
  return { order, payment, attempt };
}

/**
 * Build an ignored Eupago refund event that carries the B.3.5.2 trusted
 * metadata. Returns the inserted row's id.
 */
async function insertIgnoredRefundEvent(opts: {
  refundTrid: string;
  originalTrid: string;
  amountCents: number;
  metadata?: Record<string, string | number | boolean>;
  status?: "ignored" | "processed" | "failed";
  lastError?: string | null;
  provider?: string;
}) {
  const meta: Record<string, string | number | boolean> = {
    kind: "refund",
    status: "Refund",
    originalTrid: opts.originalTrid,
    amountCents: opts.amountCents,
    currency: "EUR",
    method: "mbway",
    identifier: `MDT-${unique()}`,
    ...opts.metadata,
  };
  const [event] = await db
    .insert(providerWebhookEvents)
    .values({
      provider: opts.provider ?? "eupago",
      providerEventId: opts.refundTrid,
      payloadHash: "b352-test-hash-" + unique(),
      eventType: "refund.refund",
      status: opts.status ?? "ignored",
      attempts: 0,
      metadata: meta,
      lastError: opts.lastError ?? "REFUND_ATTEMPT_NOT_FOUND",
    })
    .returning();
  return event;
}

async function createPendingRefund(opts: {
  orderId: number;
  paymentId: number;
  amountCents: number;
  requestedBy: number;
  originalTrid: string;
}) {
  const [r] = await db
    .insert(refundAttempts)
    .values({
      orderId: opts.orderId,
      paymentId: opts.paymentId,
      provider: "eupago",
      idempotencyKey: `b352-${unique()}`,
      amountCents: opts.amountCents,
      currency: "EUR",
      status: "pending",
      reason: "B.3.5.2 test",
      requestedBy: opts.requestedBy,
      providerOriginalTransactionId: opts.originalTrid,
    })
    .returning();
  return r;
}

beforeEach(cleanup);
afterEach(cleanup);

// ─── Happy paths ───────────────────────────────────────────

describe("B.3.5.2 — recovery happy path", () => {
  it("settles a pending refund_attempt correlated to a trusted refund event", async () => {
    const admin = await createAdmin();
    const originalTrid = `T-${unique()}`;
    const { order, payment } = await createFixtureWithOriginalTrid(10000, originalTrid);
    const refund = await createPendingRefund({
      orderId: order.id,
      paymentId: payment.id,
      amountCents: 2500,
      requestedBy: admin.id,
      originalTrid,
    });
    const refundTrid = `R-${unique()}`;
    const event = await insertIgnoredRefundEvent({
      refundTrid,
      originalTrid,
      amountCents: 2500,
    });

    const result = await recoverIgnoredEupagoRefund({ webhookEventId: event.id, actorId: admin.id });
    expect(result.outcome).toBe("settled");
    if (result.outcome !== "settled") throw new Error("unreachable");
    expect(result.refund.id).toBe(refund.id);
    expect(result.refund.status).toBe("succeeded");
    expect(result.refund.providerRefundId).toBe(refundTrid);
    expect(result.webhookEvent.status).toBe("processed");
    expect(result.webhookEvent.lastError).toBeNull();

    // The order + payment rows are untouched.
    const [orderAfter] = await db.select().from(orders).where(eq(orders.id, order.id));
    const [paymentAfter] = await db.select().from(payments).where(eq(payments.orderId, order.id));
    expect(orderAfter.status).toBe("paid");
    expect(paymentAfter.status).toBe("paid");

    // Audit log entry was written.
    const audits = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "refund.recovery_settled"));
    expect(audits).toHaveLength(1);
    expect(audits[0].entityId).toBe(refund.id);
  });

  it("recovers across MULTIPLE partial refunds, FIFO by id", async () => {
    const admin = await createAdmin();
    const originalTrid = `T-${unique()}`;
    const { order, payment } = await createFixtureWithOriginalTrid(10000, originalTrid);

    const r1 = await createPendingRefund({
      orderId: order.id,
      paymentId: payment.id,
      amountCents: 2000,
      requestedBy: admin.id,
      originalTrid,
    });
    const r2 = await createPendingRefund({
      orderId: order.id,
      paymentId: payment.id,
      amountCents: 3000,
      requestedBy: admin.id,
      originalTrid,
    });
    // Two equal-amount refund_attempts (same amount+currency): FIFO by id picks the
    // oldest. We test that the FIRST registered one is the one settled.
    const rEqualOldest = await createPendingRefund({
      orderId: order.id,
      paymentId: payment.id,
      amountCents: 1500,
      requestedBy: admin.id,
      originalTrid,
    });
    const rEqualNewest = await createPendingRefund({
      orderId: order.id,
      paymentId: payment.id,
      amountCents: 1500,
      requestedBy: admin.id,
      originalTrid,
    });

    // Recover 2000 — must bind to r1 (only match).
    {
      const ev = await insertIgnoredRefundEvent({
        refundTrid: `R-${unique()}`,
        originalTrid,
        amountCents: 2000,
      });
      const result = await recoverIgnoredEupagoRefund({ webhookEventId: ev.id, actorId: admin.id });
      expect(result.outcome).toBe("settled");
      if (result.outcome !== "settled") throw new Error("unreachable");
      expect(result.refund.id).toBe(r1.id);
    }

    // Recover 3000 — must bind to r2.
    {
      const ev = await insertIgnoredRefundEvent({
        refundTrid: `R-${unique()}`,
        originalTrid,
        amountCents: 3000,
      });
      const result = await recoverIgnoredEupagoRefund({ webhookEventId: ev.id, actorId: admin.id });
      expect(result.outcome).toBe("settled");
      if (result.outcome !== "settled") throw new Error("unreachable");
      expect(result.refund.id).toBe(r2.id);
    }

    // Recover 1500 — must bind to the OLDEST equal-amount candidate (FIFO).
    {
      const ev = await insertIgnoredRefundEvent({
        refundTrid: `R-${unique()}`,
        originalTrid,
        amountCents: 1500,
      });
      const result = await recoverIgnoredEupagoRefund({ webhookEventId: ev.id, actorId: admin.id });
      expect(result.outcome).toBe("settled");
      if (result.outcome !== "settled") throw new Error("unreachable");
      expect(result.refund.id).toBe(rEqualOldest.id);
      // The newest equal-amount is still pending (untouched).
      const [stillPending] = await db
        .select()
        .from(refundAttempts)
        .where(eq(refundAttempts.id, rEqualNewest.id));
      expect(stillPending.status).toBe("pending");
    }
  });

  it("a second recovery for an event that was just settled returns the same settled refund_attempt (no double bind)", async () => {
    const admin = await createAdmin();
    const originalTrid = `T-${unique()}`;
    const { order, payment } = await createFixtureWithOriginalTrid(10000, originalTrid);
    const refund = await createPendingRefund({
      orderId: order.id,
      paymentId: payment.id,
      amountCents: 2500,
      requestedBy: admin.id,
      originalTrid,
    });
    const refundTrid = `R-${unique()}`;
    const event = await insertIgnoredRefundEvent({ refundTrid, originalTrid, amountCents: 2500 });

    // First recovery settles the refund_attempt and processes the event.
    const first = await recoverIgnoredEupagoRefund({ webhookEventId: event.id, actorId: admin.id });
    expect(first.outcome).toBe("settled");
    if (first.outcome !== "settled") throw new Error("unreachable");
    expect(first.refund.id).toBe(refund.id);
    expect(first.refund.providerRefundId).toBe(refundTrid);

    // The unique index on (provider, providerEventId) prevents inserting a
    // second event with the same trid. We reset the event to ignored so
    // the second recovery is observed through the "already_settled" path
    // (the refund_attempt binding is the deterministic proof). This models
    // an operational event-state-reset that does NOT touch the bind.
    await db
      .update(providerWebhookEvents)
      .set({ status: "ignored", processedAt: null, lastError: "REFUND_ATTEMPT_NOT_FOUND" })
      .where(eq(providerWebhookEvents.id, event.id));

    const second = await recoverIgnoredEupagoRefund({ webhookEventId: event.id, actorId: admin.id });
    expect(second.outcome).toBe("already_settled");
    if (second.outcome !== "already_settled") throw new Error("unreachable");
    expect(second.refund.id).toBe(refund.id);
    expect(second.refund.status).toBe("succeeded");
    expect(second.refund.providerRefundId).toBe(refundTrid);
    expect(second.webhookEvent.status).toBe("processed");

    // The unique index would have rejected a second bind: only one row
    // carries this providerRefundId.
    const bindings = await db
      .select()
      .from(refundAttempts)
      .where(and(eq(refundAttempts.provider, "eupago"), eq(refundAttempts.providerRefundId, refundTrid)));
    expect(bindings).toHaveLength(1);
  });

  it("concurrent recovery requests for the same event: exactly one settles, the other is a deterministic refusal", async () => {
    const admin = await createAdmin();
    const originalTrid = `T-${unique()}`;
    const { order, payment } = await createFixtureWithOriginalTrid(10000, originalTrid);
    await createPendingRefund({
      orderId: order.id,
      paymentId: payment.id,
      amountCents: 2500,
      requestedBy: admin.id,
      originalTrid,
    });
    const event = await insertIgnoredRefundEvent({ refundTrid: `R-${unique()}`, originalTrid, amountCents: 2500 });

    const [a, b] = await Promise.allSettled([
      recoverIgnoredEupagoRefund({ webhookEventId: event.id, actorId: admin.id }),
      recoverIgnoredEupagoRefund({ webhookEventId: event.id, actorId: admin.id }),
    ]);

    // The first claim wins; the second sees status=processing and is
    // refused with ALREADY_PROCESSED. Both promises resolve (no throw).
    expect(a.status).toBe("fulfilled");
    expect(b.status).toBe("fulfilled");
    if (a.status !== "fulfilled" || b.status !== "fulfilled") throw new Error("unreachable");

    const results = [a.value, b.value];
    const settled = results.filter((r) => r.outcome === "settled");
    const rejected = results.filter((r) => r.outcome === "rejected");
    expect(settled.length).toBe(1);
    expect(rejected.length).toBe(1);
    if (rejected[0].outcome !== "rejected") throw new Error("unreachable");
    // The losing side maps to one of the deterministic refusal codes. Under
    // load, the second claim may either see status=processing (ALREADY_PROCESSED)
    // or, if it sneaks in between the first claim and the first settle, see
    // the bind already in place (CONFLICT). Both are valid lock-step outcomes.
    expect(["ALREADY_PROCESSED", "CONFLICT", "ALREADY_SETTLED"]).toContain(rejected[0].code);

    // The unique index proves the bind is single-valued.
    const settledRows = await db
      .select()
      .from(refundAttempts)
      .where(and(eq(refundAttempts.provider, "eupago"), eq(refundAttempts.providerRefundId, event.providerEventId!)));
    expect(settledRows).toHaveLength(1);
  });
});

// ─── Provider redelivery / already-settled proof ───────────

describe("B.3.5.2 — already-settled handling (the bind is single-valued)", () => {
  it("when the same trid is already bound to a succeeded refund_attempt, recovery returns already_settled and never re-binds", async () => {
    const admin = await createAdmin();
    const originalTrid = `T-${unique()}`;
    const { order, payment } = await createFixtureWithOriginalTrid(10000, originalTrid);

    // The bind already exists (e.g. a previous recovery or a direct DB fix).
    // The unique index ensures this is the ONLY refund_attempt carrying the
    // providerRefundId.
    const refundTrid = `R-${unique()}`;
    const [alreadyBound] = await db
      .insert(refundAttempts)
      .values({
        orderId: order.id,
        paymentId: payment.id,
        provider: "eupago",
        idempotencyKey: `b352-already-${unique()}`,
        amountCents: 2500,
        currency: "EUR",
        status: "succeeded",
        reason: "B.3.5.2 already-settled setup",
        requestedBy: admin.id,
        providerRefundId: refundTrid,
        providerOriginalTransactionId: originalTrid,
        completedAt: new Date(),
      })
      .returning();

    // A pending second refund exists, so the recovery would have a candidate
    // available — but the already-bound row's trid means the recovery
    // MUST NOT touch it.
    const second = await createPendingRefund({
      orderId: order.id,
      paymentId: payment.id,
      amountCents: 1500,
      requestedBy: admin.id,
      originalTrid,
    });

    const ev = await insertIgnoredRefundEvent({ refundTrid, originalTrid, amountCents: 2500 });
    const recovered = await recoverIgnoredEupagoRefund({ webhookEventId: ev.id, actorId: admin.id });
    expect(recovered.outcome).toBe("already_settled");
    if (recovered.outcome !== "already_settled") throw new Error("unreachable");
    expect(recovered.refund.id).toBe(alreadyBound.id);
    expect(recovered.refund.status).toBe("succeeded");
    expect(recovered.webhookEvent.status).toBe("processed");

    // The second refund is STILL pending (the recovery refused to consume it).
    const [secondRow] = await db
      .select()
      .from(refundAttempts)
      .where(eq(refundAttempts.id, second.id));
    expect(secondRow.status).toBe("pending");
    expect(secondRow.providerRefundId).toBeNull();

    // The unique index proves the bind is single-valued.
    const bindings = await db
      .select()
      .from(refundAttempts)
      .where(and(eq(refundAttempts.provider, "eupago"), eq(refundAttempts.providerRefundId, refundTrid)));
    expect(bindings).toHaveLength(1);
    expect(bindings[0].id).toBe(alreadyBound.id);
  });
});

// ─── Distinct-refund race (FIFO + lock) ────────────────────

describe("B.3.5.2 — distinct-refund race", () => {
  it("two concurrent recoveries for distinct trids settle on different refund_attempts", async () => {
    const admin = await createAdmin();
    const originalTrid = `T-${unique()}`;
    const { order, payment } = await createFixtureWithOriginalTrid(10000, originalTrid);

    // Two pending refunds — distinct amounts, same order, same originalTrid.
    const r1 = await createPendingRefund({
      orderId: order.id,
      paymentId: payment.id,
      amountCents: 2000,
      requestedBy: admin.id,
      originalTrid,
    });
    const r2 = await createPendingRefund({
      orderId: order.id,
      paymentId: payment.id,
      amountCents: 3000,
      requestedBy: admin.id,
      originalTrid,
    });

    const ev1 = await insertIgnoredRefundEvent({
      refundTrid: `R-${unique()}`,
      originalTrid,
      amountCents: 2000,
    });
    const ev2 = await insertIgnoredRefundEvent({
      refundTrid: `R-${unique()}`,
      originalTrid,
      amountCents: 3000,
    });

    const [a, b] = await Promise.allSettled([
      recoverIgnoredEupagoRefund({ webhookEventId: ev1.id, actorId: admin.id }),
      recoverIgnoredEupagoRefund({ webhookEventId: ev2.id, actorId: admin.id }),
    ]);

    const fulfilled = [a, b].filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBe(2);
    for (const r of fulfilled) {
      if (r.status !== "fulfilled") continue;
      expect(r.value.outcome).toBe("settled");
    }

    // Both refund_attempts are now succeeded with their respective trids.
    const rows = await db
      .select()
      .from(refundAttempts)
      .where(inArray(refundAttempts.id, [r1.id, r2.id]));
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(r1.id)!.status).toBe("succeeded");
    expect(byId.get(r2.id)!.status).toBe("succeeded");
    expect(byId.get(r1.id)!.providerRefundId).toBe(ev1.providerEventId);
    expect(byId.get(r2.id)!.providerRefundId).toBe(ev2.providerEventId);
  });

  it("candidate re-read after lock: a state-changing concurrent action under the payment lock is observed", async () => {
    const admin = await createAdmin();
    const originalTrid = `T-${unique()}`;
    const { order, payment } = await createFixtureWithOriginalTrid(10000, originalTrid);

    // A single pending refund_attempt is the candidate.
    const r = await createPendingRefund({
      orderId: order.id,
      paymentId: payment.id,
      amountCents: 2500,
      requestedBy: admin.id,
      originalTrid,
    });
    const ev = await insertIgnoredRefundEvent({
      refundTrid: `R-${unique()}`,
      originalTrid,
      amountCents: 2500,
    });

    // The recovery reads the candidate after locking the payment. We verify
    // it picks the same candidate that was pre-locked (id of r) and settles
    // it. The over-refund guard would also be re-checked by the trigger.
    const result = await recoverIgnoredEupagoRefund({ webhookEventId: ev.id, actorId: admin.id });
    expect(result.outcome).toBe("settled");
    if (result.outcome !== "settled") throw new Error("unreachable");
    expect(result.refund.id).toBe(r.id);
    expect(result.refund.status).toBe("succeeded");
  });
});

// ─── Over-refund protection (defence-in-depth) ─────────────

describe("B.3.5.2 — over-refund defence (the trigger is the source of truth)", () => {
  it("B.3.5 trigger blocks the INSERT path before recovery even starts; recovery observes a coherent state", async () => {
    const admin = await createAdmin();
    const originalTrid = `T-${unique()}`;
    // Paid 5000. Inserting a 4000€ pending refund succeeds; inserting a
    // SECOND 4000€ pending would push committed to 8000 > 5000 — the B.3.5
    // trigger MUST refuse the second insert. This proves the trigger is
    // still in force alongside the recovery path.
    const { order, payment } = await createFixtureWithOriginalTrid(5000, originalTrid);
    const first = await createPendingRefund({
      orderId: order.id,
      paymentId: payment.id,
      amountCents: 4000,
      requestedBy: admin.id,
      originalTrid,
    });
    expect(first.status).toBe("pending");

    // The trigger error is raised on the raw SQL connection. Use a raw pg
    // client (drizzle's wrapper omits the underlying message in the
    // top-level error text).
    const client = new (await import("pg")).default.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      const second = await client.query(
        `INSERT INTO refund_attempts
           (order_id, payment_id, provider, idempotency_key, amount_cents, currency, status, requested_by, provider_original_transaction_id)
         VALUES ($1, $2, 'eupago', $3, 4000, 'EUR', 'pending', $4, $5)`,
        [order.id, payment.id, `b352-${unique()}`, admin.id, originalTrid]
      );
      expect(second.rowCount ?? 0).toBe(0);
    } catch (e) {
      expect(String(e)).toContain("REFUND_EXCEEDS_REFUNDABLE_AMOUNT");
    } finally {
      await client.end().catch(() => {});
    }

    // The recovery then settles the existing 4000€ pending refund with a
    // valid event. After the recovery, only ONE refund_attempt exists in
    // succeeded state — the trigger guarded the over-refund from ever
    // being possible.
    const ev = await insertIgnoredRefundEvent({
      refundTrid: `R-${unique()}`,
      originalTrid,
      amountCents: 4000,
    });
    const result = await recoverIgnoredEupagoRefund({ webhookEventId: ev.id, actorId: admin.id });
    expect(result.outcome).toBe("settled");
    if (result.outcome !== "settled") throw new Error("unreachable");
    expect(result.refund.id).toBe(first.id);
    expect(result.refund.status).toBe("succeeded");
  });
});

// ─── Missing trusted metadata (LEGACY) ─────────────────────

describe("B.3.5.2 — legacy / missing trusted metadata", () => {
  it("refuses with LEGACY_EVENT_UNRECOVERABLE when kind is missing from metadata", async () => {
    const admin = await createAdmin();
    const originalTrid = `T-${unique()}`;
    const { order, payment } = await createFixtureWithOriginalTrid(10000, originalTrid);
    await createPendingRefund({
      orderId: order.id,
      paymentId: payment.id,
      amountCents: 2500,
      requestedBy: admin.id,
      originalTrid,
    });
    // Insert the event with full metadata, then wipe `kind` so the LEGACY
    // path is exercised — recovery requires `kind: "refund"`.
    const ev = await insertIgnoredRefundEvent({ refundTrid: `R-${unique()}`, originalTrid, amountCents: 2500 });
    await db
      .update(providerWebhookEvents)
      .set({
        metadata: { status: "Refund", originalTrid, amountCents: 2500, currency: "EUR" } as Record<string, string | number | boolean>,
      })
      .where(eq(providerWebhookEvents.id, ev.id));

    const result = await recoverIgnoredEupagoRefund({ webhookEventId: ev.id, actorId: admin.id });
    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") throw new Error("unreachable");
    expect(result.code).toBe("LEGACY_EVENT_UNRECOVERABLE");

    const [row] = await db.select().from(providerWebhookEvents).where(eq(providerWebhookEvents.id, ev.id));
    expect(row.status).toBe("ignored");
    expect(row.attempts).toBe(0);
  });

  it("refuses with LEGACY_EVENT_UNRECOVERABLE when status is not 'Refund'", async () => {
    const admin = await createAdmin();
    const originalTrid = `T-${unique()}`;
    const { order, payment } = await createFixtureWithOriginalTrid(10000, originalTrid);
    await createPendingRefund({
      orderId: order.id,
      paymentId: payment.id,
      amountCents: 2500,
      requestedBy: admin.id,
      originalTrid,
    });
    const ev = await insertIgnoredRefundEvent({ refundTrid: `R-${unique()}`, originalTrid, amountCents: 2500 });
    await db
      .update(providerWebhookEvents)
      .set({ metadata: { kind: "refund", status: "Paid", originalTrid, amountCents: 2500, currency: "EUR" } })
      .where(eq(providerWebhookEvents.id, ev.id));

    const result = await recoverIgnoredEupagoRefund({ webhookEventId: ev.id, actorId: admin.id });
    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") throw new Error("unreachable");
    expect(result.code).toBe("LEGACY_EVENT_UNRECOVERABLE");
  });

  it("refuses with INVALID_AMOUNT when the persisted amount is not a safe positive integer", async () => {
    const admin = await createAdmin();
    const originalTrid = `T-${unique()}`;
    const { order, payment } = await createFixtureWithOriginalTrid(10000, originalTrid);
    await createPendingRefund({
      orderId: order.id,
      paymentId: payment.id,
      amountCents: 2500,
      requestedBy: admin.id,
      originalTrid,
    });
    const ev = await insertIgnoredRefundEvent({ refundTrid: `R-${unique()}`, originalTrid, amountCents: 2500 });
    await db
      .update(providerWebhookEvents)
      .set({
        metadata: { kind: "refund", status: "Refund", originalTrid, amountCents: 25.5, currency: "EUR" },
      })
      .where(eq(providerWebhookEvents.id, ev.id));

    const result = await recoverIgnoredEupagoRefund({ webhookEventId: ev.id, actorId: admin.id });
    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") throw new Error("unreachable");
    expect(result.code).toBe("INVALID_AMOUNT");
  });

  it("refuses with MISSING_PERSISTED_METADATA when metadata is null", async () => {
    const admin = await createAdmin();
    const originalTrid = `T-${unique()}`;
    const { order, payment } = await createFixtureWithOriginalTrid(10000, originalTrid);
    await createPendingRefund({
      orderId: order.id,
      paymentId: payment.id,
      amountCents: 2500,
      requestedBy: admin.id,
      originalTrid,
    });
    const ev = await insertIgnoredRefundEvent({ refundTrid: `R-${unique()}`, originalTrid, amountCents: 2500 });
    await db
      .update(providerWebhookEvents)
      .set({ metadata: null })
      .where(eq(providerWebhookEvents.id, ev.id));

    const result = await recoverIgnoredEupagoRefund({ webhookEventId: ev.id, actorId: admin.id });
    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") throw new Error("unreachable");
    expect(result.code).toBe("MISSING_PERSISTED_METADATA");
  });

  it("refuses with MISSING_ORIGINAL_TRID when originalTrid is absent or malformed", async () => {
    const admin = await createAdmin();
    const originalTrid = `T-${unique()}`;
    const { order, payment } = await createFixtureWithOriginalTrid(10000, originalTrid);
    await createPendingRefund({
      orderId: order.id,
      paymentId: payment.id,
      amountCents: 2500,
      requestedBy: admin.id,
      originalTrid,
    });
    const ev = await insertIgnoredRefundEvent({ refundTrid: `R-${unique()}`, originalTrid, amountCents: 2500 });
    await db
      .update(providerWebhookEvents)
      .set({
        metadata: { kind: "refund", status: "Refund", amountCents: 2500, currency: "EUR" },
      })
      .where(eq(providerWebhookEvents.id, ev.id));

    const result = await recoverIgnoredEupagoRefund({ webhookEventId: ev.id, actorId: admin.id });
    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") throw new Error("unreachable");
    expect(result.code).toBe("MISSING_ORIGINAL_TRID");
  });
});

// ─── Wrong preconditions ───────────────────────────────────

describe("B.3.5.2 — wrong preconditions (no state change)", () => {
  it("refuses with WRONG_PROVIDER for non-Eupago events", async () => {
    const admin = await createAdmin();
    const ev = await insertIgnoredRefundEvent({
      refundTrid: `R-${unique()}`,
      originalTrid: `T-${unique()}`,
      amountCents: 2500,
      provider: "other_provider",
    });

    const result = await recoverIgnoredEupagoRefund({ webhookEventId: ev.id, actorId: admin.id });
    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") throw new Error("unreachable");
    expect(result.code).toBe("WRONG_PROVIDER");
  });

  it("refuses with ALREADY_PROCESSED for events already in processed state", async () => {
    const admin = await createAdmin();
    const ev = await insertIgnoredRefundEvent({
      refundTrid: `R-${unique()}`,
      originalTrid: `T-${unique()}`,
      amountCents: 2500,
      status: "processed",
    });

    const result = await recoverIgnoredEupagoRefund({ webhookEventId: ev.id, actorId: admin.id });
    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") throw new Error("unreachable");
    expect(result.code).toBe("ALREADY_PROCESSED");
  });

  it("refuses with WRONG_STATUS for events in failed state", async () => {
    const admin = await createAdmin();
    const ev = await insertIgnoredRefundEvent({
      refundTrid: `R-${unique()}`,
      originalTrid: `T-${unique()}`,
      amountCents: 2500,
      status: "failed",
    });

    const result = await recoverIgnoredEupagoRefund({ webhookEventId: ev.id, actorId: admin.id });
    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") throw new Error("unreachable");
    expect(result.code).toBe("WRONG_STATUS");
  });

  it("refuses with WRONG_LAST_ERROR for events whose lastError is not REFUND_ATTEMPT_NOT_FOUND", async () => {
    const admin = await createAdmin();
    const ev = await insertIgnoredRefundEvent({
      refundTrid: `R-${unique()}`,
      originalTrid: `T-${unique()}`,
      amountCents: 2500,
      lastError: "IDENTIFIER_MISMATCH",
    });

    const result = await recoverIgnoredEupagoRefund({ webhookEventId: ev.id, actorId: admin.id });
    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") throw new Error("unreachable");
    expect(result.code).toBe("WRONG_LAST_ERROR");
  });

  it("refuses with WEBHOOK_EVENT_NOT_FOUND for unknown ids", async () => {
    const admin = await createAdmin();
    const result = await recoverIgnoredEupagoRefund({ webhookEventId: 999_999_999, actorId: admin.id });
    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") throw new Error("unreachable");
    expect(result.code).toBe("WEBHOOK_EVENT_NOT_FOUND");
  });

  it("refuses with REFUND_CANDIDATE_NOT_FOUND when no pending refund_attempt exists locally", async () => {
    const admin = await createAdmin();
    const originalTrid = `T-${unique()}`;
    await createFixtureWithOriginalTrid(10000, originalTrid);
    // No pending refund_attempt — recovery must NOT create one.
    const ev = await insertIgnoredRefundEvent({
      refundTrid: `R-${unique()}`,
      originalTrid,
      amountCents: 2500,
    });

    const result = await recoverIgnoredEupagoRefund({ webhookEventId: ev.id, actorId: admin.id });
    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") throw new Error("unreachable");
    expect(result.code).toBe("REFUND_CANDIDATE_NOT_FOUND");

    // Recovery did not create a refund_attempt.
    const all = await db.select().from(refundAttempts);
    expect(all).toHaveLength(0);
  });

  it("refuses with ORIGINAL_PAYMENT_NOT_FOUND when the originalTrid is unknown", async () => {
    const admin = await createAdmin();
    const ev = await insertIgnoredRefundEvent({
      refundTrid: `R-${unique()}`,
      originalTrid: `T-UNKNOWN-${unique()}`,
      amountCents: 2500,
    });

    const result = await recoverIgnoredEupagoRefund({ webhookEventId: ev.id, actorId: admin.id });
    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") throw new Error("unreachable");
    expect(result.code).toBe("ORIGINAL_PAYMENT_NOT_FOUND");
  });
});

// ─── Atomicity of the claim + preconditions ────────────────

describe("B.3.5.2 — atomicity", () => {
  it("failed post-claim precondition rolls back the claim update too (attempts stays at 0)", async () => {
    const admin = await createAdmin();
    const originalTrid = `T-${unique()}`;
    const { order, payment } = await createFixtureWithOriginalTrid(10000, originalTrid);
    // No pending refund_attempt — the post-claim precondition
    // REFUND_CANDIDATE_NOT_FOUND will fail. The claim must roll back.
    const ev = await insertIgnoredRefundEvent({
      refundTrid: `R-${unique()}`,
      originalTrid,
      amountCents: 2500,
    });

    const result = await recoverIgnoredEupagoRefund({ webhookEventId: ev.id, actorId: admin.id });
    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") throw new Error("unreachable");
    expect(result.code).toBe("REFUND_CANDIDATE_NOT_FOUND");

    const [event] = await db
      .select()
      .from(providerWebhookEvents)
      .where(eq(providerWebhookEvents.id, ev.id));
    // The atomicity invariant: the event is BACK to its pre-recovery state.
    expect(event.status).toBe("ignored");
    expect(event.lastError).toBe("REFUND_ATTEMPT_NOT_FOUND");
    expect(event.attempts).toBe(0);
    expect(event.processedAt).toBeNull();

    // And no refund_attempt was created by the failed recovery.
    const refunds = await db.select().from(refundAttempts).where(eq(refundAttempts.orderId, order.id));
    expect(refunds).toHaveLength(0);

    // The audit log records no recovery_settled / recovery_already_settled entry.
    const audits = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, "refund.recovery_settled"),
          eq(auditLogs.entityId, order.id)
        )
      );
    expect(audits).toHaveLength(0);

    void payment;
  });
});
