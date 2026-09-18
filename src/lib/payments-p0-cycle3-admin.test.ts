/**
 * PAYMENT P0 (CYCLE 3) — C4, C6, C7.
 *
 * C4 — QUEUED-STRANDED / EXPIRED-DISPATCHING OUTBOX RECOVERY.
 *   A requeue commits and THEN dispatches. A crash between the two leaves a
 *   `queued` row nobody would ever send (there is no cron), and a crash mid-send
 *   leaves `dispatching` with `dispatch_started_at` set. Both must be recoverable
 *   ONLY through an explicit, authorised, audited, BOUNDED admin action — never
 *   automatically, and never twice.
 *
 * C6 — ANOMALY RESOLUTION REQUIRES A CLASSIFICATION.
 *   A resolution must say WHY (REFUNDED / MANUALLY_RECONCILED / FALSE_POSITIVE /
 *   ACCEPTED_EXCEPTION), keep actor + timestamp + note, and may not claim money
 *   was returned without a succeeded refund on record.
 *
 * C7 — AN ANOMALY DEDUPE MUST NOT SWALLOW A NEW ONE.
 *   The (provider, provider_reference) unique index is idempotent per OCCURRENCE:
 *   a resolved row, a row written by a human, or a row with a different code must
 *   not absorb a NEW anomaly for the same movement.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/db";
import {
  auditLogs,
  emailNotifications,
  orders,
  payments,
  reconciliationObservations,
  refundAttempts,
} from "@/db/schema";
import { and, eq, like } from "drizzle-orm";
import {
  STRANDED_CLAIM_MS,
  dispatchQueuedEmails,
  redispatchRequeuedNotification,
  requeueEmailNotification,
} from "@/lib/email-outbox";
import { recordSettlementAnomalyTx } from "@/lib/services/financial-anomalies";
import { ingestReconciliationObservation, resolveReconciliationAnomaly } from "@/lib/reconciliation";
import { confirmOrderPayment } from "@/lib/orders";
import { POST as requeuePOST } from "@/app/api/admin/email-outbox/[id]/requeue/route";
import { POST as dispatchQueuedPOST } from "@/app/api/admin/email-outbox/dispatch-queued/route";
import { cleanupByPrefix, createPendingOrder, createUser, unique } from "@/test-support/fixtures";

const PREFIX = "P0C3X";
const ORIGIN = { origin: "http://loja.mdtech.pt", host: "loja.mdtech.pt" };

const authState: { user: { id: number; role: string } | null } = { user: null };
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getCurrentUser: async () => authState.user };
});

/** Counting simulated transport (never reaches the network). */
function countingTransport(status: number) {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ id: "simulated" }), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

async function insertNotification(input: {
  status: string;
  dispatchStartedAt?: Date | null;
  referenceId: number;
}): Promise<number> {
  const [row] = await db
    .insert(emailNotifications)
    .values({
      eventKey: `p0c3x-${unique()}`,
      type: "payment_confirmed",
      recipient: "cliente@test.local",
      subject: "Encomenda paga",
      status: input.status,
      referenceType: "order",
      referenceId: input.referenceId,
      dispatchStartedAt: input.dispatchStartedAt ?? null,
    })
    .returning();
  return row.id;
}

const notificationRow = async (id: number) =>
  (await db.select().from(emailNotifications).where(eq(emailNotifications.id, id)).limit(1))[0];

beforeEach(async () => {
  await cleanupByPrefix(PREFIX);
  await db.delete(auditLogs).where(like(auditLogs.action, "email_outbox.%"));
  authState.user = null;
});
afterEach(async () => {
  await cleanupByPrefix(PREFIX);
  await db.delete(auditLogs).where(like(auditLogs.action, "email_outbox.%"));
});

// ─── C4 ───────────────────────────────────────────────────

describe("C4 — explicit admin recovery of stranded outbox rows", () => {
  it("refuses a FRESH dispatching claim and releases it only with the explicit flag, once abandoned", async () => {
    const fixture = await createPendingOrder({ prefix: PREFIX });
    const admin = await createUser(PREFIX, "admin");
    authState.user = { id: admin.id, role: "admin" };

    // A claim that is still in flight (fresh) must never be re-driven.
    const freshId = await insertNotification({
      status: "dispatching",
      dispatchStartedAt: new Date(),
      referenceId: fixture.orderId,
    });

    const freshPlain = await requeuePOST(
      new NextRequest(`http://loja.mdtech.pt/api/admin/email-outbox/${freshId}/requeue`, {
        method: "POST",
        headers: ORIGIN,
        body: "{}",
      }),
      { params: Promise.resolve({ id: String(freshId) }) }
    );
    expect(freshPlain.status).toBe(409);
    expect((await freshPlain.json()).code).toBe("NOT_REQUEUEABLE");

    const freshFlagged = await requeuePOST(
      new NextRequest(`http://loja.mdtech.pt/api/admin/email-outbox/${freshId}/requeue?releaseStrandedClaim=1`, {
        method: "POST",
        headers: ORIGIN,
        body: "{}",
      }),
      { params: Promise.resolve({ id: String(freshId) }) }
    );
    expect(freshFlagged.status).toBe(409);
    expect((await freshFlagged.json()).code).toBe("CLAIM_STILL_ACTIVE");

    // An ABANDONED claim (crash mid-dispatch) is released — audited as such.
    const abandonedId = await insertNotification({
      status: "dispatching",
      dispatchStartedAt: new Date(Date.now() - (STRANDED_CLAIM_MS + 60_000)),
      referenceId: fixture.orderId,
    });

    const abandonedPlain = await requeuePOST(
      new NextRequest(`http://loja.mdtech.pt/api/admin/email-outbox/${abandonedId}/requeue`, {
        method: "POST",
        headers: ORIGIN,
        body: "{}",
      }),
      { params: Promise.resolve({ id: String(abandonedId) }) }
    );
    expect(abandonedPlain.status).toBe(409);
    expect((await abandonedPlain.json()).code).toBe("NOT_REQUEUEABLE");

    const abandonedFlagged = await requeuePOST(
      new NextRequest(`http://loja.mdtech.pt/api/admin/email-outbox/${abandonedId}/requeue?releaseStrandedClaim=1`, {
        method: "POST",
        headers: ORIGIN,
        body: "{}",
      }),
      { params: Promise.resolve({ id: String(abandonedId) }) }
    );
    expect(abandonedFlagged.status).toBe(200);
    expect((await abandonedFlagged.json()).releaseStrandedClaim).toBe(true);

    const audit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "email_outbox.requeued"), eq(auditLogs.entityId, abandonedId)));
    expect(audit).toHaveLength(1);
    expect(audit[0].userId).toBe(admin.id);
    expect(audit[0].details).toMatchObject({ releasedAbandonedClaim: true });

    // The row was re-armed (the suite has no transport key → not sent).
    const row = await notificationRow(abandonedId);
    expect(["failed", "queued", "dispatching"]).toContain(row.status);
  });

  it("two concurrent recoveries of the same row send at most ONE email", async () => {
    const fixture = await createPendingOrder({ prefix: PREFIX });
    const admin = await createUser(PREFIX, "admin");
    const notificationId = await insertNotification({ status: "delivery_unknown", referenceId: fixture.orderId });
    const transport = countingTransport(200);

    const [first, second] = await Promise.all([
      redispatchRequeuedNotification({
        id: notificationId,
        actorId: admin.id,
        deps: { fetchImpl: transport.fetchImpl, apiKey: "test-key" },
      }),
      redispatchRequeuedNotification({
        id: notificationId,
        actorId: admin.id,
        deps: { fetchImpl: transport.fetchImpl, apiKey: "test-key" },
      }),
    ]);

    expect(transport.calls()).toBe(1);
    expect([first, second].filter((result) => result.ok && result.dispatch === "sent")).toHaveLength(1);
    expect((await notificationRow(notificationId)).status).toBe("sent");
  });

  it("the bounded drain recovers `queued` drift exactly once, and never touches dispatching / delivery_unknown", async () => {
    const fixture = await createPendingOrder({ prefix: PREFIX });
    const manager = await createUser(PREFIX, "manager");
    const admin = await createUser(PREFIX, "admin");

    const queuedA = await insertNotification({ status: "queued", referenceId: fixture.orderId });
    const queuedB = await insertNotification({ status: "queued", referenceId: fixture.orderId });
    const queuedC = await insertNotification({ status: "queued", referenceId: fixture.orderId });
    const abandoned = await insertNotification({
      status: "dispatching",
      dispatchStartedAt: new Date(Date.now() - (STRANDED_CLAIM_MS + 60_000)),
      referenceId: fixture.orderId,
    });
    const unknown = await insertNotification({ status: "delivery_unknown", referenceId: fixture.orderId });

    const url = "http://loja.mdtech.pt/api/admin/email-outbox/dispatch-queued";

    // RBAC: manager is refused; admin without CSRF is refused.
    authState.user = { id: manager.id, role: "manager" };
    expect((await dispatchQueuedPOST(new NextRequest(url, { method: "POST", headers: ORIGIN, body: "{}" }))).status).toBe(403);
    authState.user = { id: admin.id, role: "admin" };
    expect((await dispatchQueuedPOST(new NextRequest(url, { method: "POST", body: "{}" }))).status).toBe(403);

    // BOUNDED: one call dispatches at most `limit` rows.
    authState.user = { id: admin.id, role: "admin" };
    const bounded = await dispatchQueuedPOST(
      new NextRequest(url, { method: "POST", headers: ORIGIN, body: JSON.stringify({ limit: 2 }) })
    );
    expect(bounded.status).toBe(200);
    const boundedBody = (await bounded.json()) as { limit: number; attempted: number };
    expect(boundedBody.limit).toBe(2);
    expect(boundedBody.attempted).toBe(2);

    // Only the two oldest queued rows were attempted; the third is untouched.
    const attempted = [queuedA, queuedB].map(async (id) => notificationRow(id));
    const statuses = (await Promise.all(attempted)).map((row) => row.status);
    expect(statuses.every((status) => status !== "queued")).toBe(true);
    expect((await notificationRow(queuedC)).status).toBe("queued");

    // Never automatic: `dispatching` and `delivery_unknown` are out of scope.
    expect((await notificationRow(abandoned)).status).toBe("dispatching");
    expect((await notificationRow(unknown)).status).toBe("delivery_unknown");

    // Audited, bounded, no message content.
    const audit = await db.select().from(auditLogs).where(eq(auditLogs.action, "email_outbox.queued_dispatched"));
    expect(audit).toHaveLength(1);
    expect(audit[0].userId).toBe(admin.id);
    expect(audit[0].details).toMatchObject({ limit: 2, attempted: 2 });

    // A second bounded call drains what is left, and then there is nothing left.
    const rest = await dispatchQueuedPOST(
      new NextRequest(url, { method: "POST", headers: ORIGIN, body: JSON.stringify({ limit: 20 }) })
    );
    expect(((await rest.json()) as { attempted: number }).attempted).toBe(1);
    const empty = await dispatchQueuedPOST(
      new NextRequest(url, { method: "POST", headers: ORIGIN, body: JSON.stringify({ limit: 20 }) })
    );
    expect(((await empty.json()) as { attempted: number }).attempted).toBe(0);
    expect((await notificationRow(unknown)).status).toBe("delivery_unknown");
  });

  it("crash window: a released claim that never dispatched is recovered by the bounded drain exactly once", async () => {
    const fixture = await createPendingOrder({ prefix: PREFIX });
    const admin = await createUser(PREFIX, "admin");

    const notificationId = await insertNotification({
      status: "dispatching",
      dispatchStartedAt: new Date(Date.now() - (STRANDED_CLAIM_MS + 60_000)),
      referenceId: fixture.orderId,
    });

    // Step 1: the operator releases the abandoned claim (audited, committed).
    // The process "dies" here — the dispatch never happens — so the row is
    // `queued` and nobody would ever send it without this explicit path.
    const released = await requeueEmailNotification({ id: notificationId, actorId: admin.id, allowStrandedClaim: true });
    expect(released.ok).toBe(true);
    expect((await notificationRow(notificationId)).status).toBe("queued");

    // Step 2: the bounded operator drain sends it — exactly once.
    const transport = countingTransport(200);
    const drained = await dispatchQueuedEmails(5, { fetchImpl: transport.fetchImpl, apiKey: "test-key" });
    expect(drained.sent).toBe(1);
    expect(transport.calls()).toBe(1);
    expect((await notificationRow(notificationId)).status).toBe("sent");

    // Step 3: nothing is re-sent.
    const again = await dispatchQueuedEmails(5, { fetchImpl: transport.fetchImpl, apiKey: "test-key" });
    expect(again.attempted).toBe(0);
    expect(transport.calls()).toBe(1);
  });

  it("a provider FAILURE during recovery stays visible and is never auto-retried", async () => {
    const fixture = await createPendingOrder({ prefix: PREFIX });
    const notificationId = await insertNotification({ status: "queued", referenceId: fixture.orderId });
    const transport = countingTransport(500);

    const first = await dispatchQueuedEmails(5, { fetchImpl: transport.fetchImpl, apiKey: "test-key" });
    expect(first).toMatchObject({ attempted: 1, sent: 0, unknown: 1 });
    expect((await notificationRow(notificationId)).status).toBe("delivery_unknown");

    // `delivery_unknown` is terminal for the automatic path: only the per-row
    // operator decision may re-drive it.
    const second = await dispatchQueuedEmails(5, { fetchImpl: transport.fetchImpl, apiKey: "test-key" });
    expect(second.attempted).toBe(0);
    expect(transport.calls()).toBe(1);
  });
});

// ─── C6 ───────────────────────────────────────────────────

describe("C6 — anomaly resolution requires an explicit classification", () => {
  async function openAnomalyForOrder(orderId: number, user: { id: number }) {
    const { observation } = await ingestReconciliationObservation({
      orderId,
      provider: "manual",
      providerReference: `REC-${unique()}`,
      observedPaidCents: 0,
      observedRefundedCents: 0,
      currency: "EUR",
      observedAt: new Date(),
      recordedBy: user.id,
    });
    expect(observation.status).toBe("open");
    return observation;
  }

  it("refuses a note-only resolution, an unknown code, and `REFUNDED` without a succeeded refund", async () => {
    const fixture = await createPendingOrder({ prefix: PREFIX });
    const resolver = await createUser(PREFIX, "manager");
    // A settled order: the ingested observation then DIVERGES from internal state
    // (observed 0 vs internal 50.00) and is therefore an OPEN anomaly.
    const confirmed = await confirmOrderPayment(fixture.orderId, null, { source: "manual" });
    expect(confirmed.changed).toBe(true);
    const observation = await openAnomalyForOrder(fixture.orderId, resolver);

    await expect(
      resolveReconciliationAnomaly(observation.id, resolver.id, "nota válida sem classificação", "" as never)
    ).rejects.toMatchObject({ code: "RESOLUTION_CODE_REQUIRED" });

    await expect(
      resolveReconciliationAnomaly(observation.id, resolver.id, "nota válida", "NAO_EXISTE" as never)
    ).rejects.toMatchObject({ code: "INVALID_RESOLUTION_CODE" });

    // No refund was executed: claiming one is refused and the anomaly stays OPEN.
    await expect(
      resolveReconciliationAnomaly(observation.id, resolver.id, "reembolsado por fora", "REFUNDED")
    ).rejects.toMatchObject({ code: "REFUND_EVIDENCE_REQUIRED" });
    const stillOpen = (await db.select().from(reconciliationObservations).where(eq(reconciliationObservations.id, observation.id)).limit(1))[0];
    expect(stillOpen.status).toBe("open");

    // A truthful classification is accepted and persists actor/time/note/code.
    const resolved = await resolveReconciliationAnomaly(
      observation.id,
      resolver.id,
      "Confirmado com extrato bancário — diferença de taxas.",
      "MANUALLY_RECONCILED"
    );
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolvedBy).toBe(resolver.id);
    expect(resolved.resolvedAt).toBeInstanceOf(Date);
    expect(resolved.resolutionCode).toBe("MANUALLY_RECONCILED");
    expect(resolved.resolutionNote).toContain("extrato");

    const audit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "reconciliation.anomaly_resolved"), eq(auditLogs.entityId, observation.id)));
    expect(audit).toHaveLength(1);
    expect(audit[0].details).toMatchObject({ resolutionCode: "MANUALLY_RECONCILED" });

    await expect(
      resolveReconciliationAnomaly(observation.id, resolver.id, "segunda resolução", "FALSE_POSITIVE")
    ).rejects.toMatchObject({ code: "OBSERVATION_NOT_OPEN" });
  });

  it("accepts `REFUNDED` when a succeeded refund exists for that money", async () => {
    const fixture = await createPendingOrder({ prefix: PREFIX });
    const resolver = await createUser(PREFIX, "manager");

    // Settle the order so there is a paid canonical payment to bind a refund to.
    const confirmed = await confirmOrderPayment(fixture.orderId, null, { source: "manual" });
    expect(confirmed.changed).toBe(true);
    const [paidPayment] = (
      await db.select().from(payments).where(eq(payments.orderId, fixture.orderId))
    ).filter((row) => row.status === "paid");
    expect(paidPayment).toBeTruthy();

    const observation = await openAnomalyForOrder(fixture.orderId, resolver);

    await db.insert(refundAttempts).values({
      orderId: fixture.orderId,
      paymentId: paidPayment.id,
      provider: "manual",
      idempotencyKey: `p0c3x-${unique()}`,
      amountCents: 5000,
      currency: "EUR",
      status: "succeeded",
      reason: "C6 evidence fixture",
      requestedBy: resolver.id,
      completedAt: new Date(),
    });

    const resolved = await resolveReconciliationAnomaly(
      observation.id,
      resolver.id,
      "Reembolso registado e confirmado no ledger.",
      "REFUNDED"
    );
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolutionCode).toBe("REFUNDED");
  });
});

// ─── C7 ───────────────────────────────────────────────────

describe("C7 — a dedupe occurrence never swallows a new anomaly", () => {
  it("is idempotent for the SAME occurrence and records a NEW row for a resolved one", async () => {
    const fixture = await createPendingOrder({ prefix: PREFIX });
    const resolver = await createUser(PREFIX, "manager");
    const trid = `T-C7-${unique()}`;

    const first = await recordSettlementAnomalyTx(db, {
      orderId: fixture.orderId,
      paymentId: null,
      code: "LATE_PAID",
      amountCents: 5000,
      currency: "EUR",
      movementId: trid,
    });
    expect(first).toBeTruthy();
    expect(first!.providerReference).toBe(trid);

    // Same occurrence again → the SAME row (no duplicate, no suffix).
    const same = await recordSettlementAnomalyTx(db, {
      orderId: fixture.orderId,
      paymentId: null,
      code: "LATE_PAID",
      amountCents: 5000,
      currency: "EUR",
      movementId: trid,
    });
    expect(same!.id).toBe(first!.id);
    expect((await db.select().from(reconciliationObservations).where(eq(reconciliationObservations.orderId, fixture.orderId)))).toHaveLength(1);

    // The operator resolves it…
    await resolveReconciliationAnomaly(first!.id, resolver.id, "Resolvido manualmente com o extrato.", "MANUALLY_RECONCILED");

    // …and a NEW relevant anomaly for the SAME movement is recorded, not swallowed.
    const next = await recordSettlementAnomalyTx(db, {
      orderId: fixture.orderId,
      paymentId: null,
      code: "LATE_PAID",
      amountCents: 5000,
      currency: "EUR",
      movementId: trid,
    });
    expect(next).toBeTruthy();
    expect(next!.id).not.toBe(first!.id);
    expect(next!.providerReference).toBe(`${trid}#2`);
    expect(next!.status).toBe("open");
    expect(next!.anomalyCode).toBe("LATE_PAID");

    const rows = await db.select().from(reconciliationObservations).where(eq(reconciliationObservations.orderId, fixture.orderId));
    expect(rows).toHaveLength(2);
  });

  it("records a different code for the same movement as its own occurrence", async () => {
    const fixture = await createPendingOrder({ prefix: PREFIX });
    const trid = `T-C7B-${unique()}`;

    const late = await recordSettlementAnomalyTx(db, {
      orderId: fixture.orderId,
      paymentId: null,
      code: "LATE_PAID",
      amountCents: 5000,
      currency: "EUR",
      movementId: trid,
    });
    expect(late!.providerReference).toBe(trid);

    const conflict = await recordSettlementAnomalyTx(db, {
      orderId: fixture.orderId,
      paymentId: null,
      code: "PROVIDER_EVENT_CONFLICT",
      amountCents: 5000,
      currency: "EUR",
      movementId: trid,
    });
    expect(conflict!.id).not.toBe(late!.id);
    expect(conflict!.providerReference).toBe(`${trid}#2`);
    expect(conflict!.anomalyCode).toBe("PROVIDER_EVENT_CONFLICT");
  });
});
