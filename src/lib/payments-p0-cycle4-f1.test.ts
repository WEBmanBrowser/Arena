/**
 * PAYMENT P0 (CYCLE 4) — F-1 · HIGH · TOCTOU C8 / DIVERGENT PAYLOAD.
 *
 * THE FINDING
 *   `processEupagoWebhook` evaluates the C2 divergent-payload gate on
 *   `registration.event` — a snapshot read OUTSIDE the settlement transaction
 *   (`registerWebhookEvent` is called without an executor). When that snapshot
 *   still says `pending`/`failed` the gate is skipped, but the delivery that wins
 *   the claim can CONCLUDE the event while this one waits for the row lock.
 *
 *   The claim then fails and control reaches the C8 branch. C8 correctly re-reads
 *   the row that really exists — but it answered from the re-read STATUS ALONE.
 *   A redelivery whose authenticated payload materially diverges from the one
 *   that was just concluded (amount / currency / method / event type / original
 *   trid) was acknowledged as a plain
 *   `duplicate / CONSUMED_BY_CONCURRENT_DELIVERY`: exactly the silent change of
 *   meaning C2 exists to prevent, reached through the race window instead of the
 *   ordinary redelivery path. The divergence left no anomaly, no audit trail and
 *   nothing for an operator to reconcile.
 *
 * THE FIX
 *   Inside C8, the C2 comparison is RE-RUN against the re-read row (`processed`
 *   or anomaly; `ignored` stays excluded exactly as in the pre-transaction gate).
 *   `escalateConcludedConflict` opens its OWN transaction and can therefore never
 *   run nested inside the settlement one, so the transaction returns an internal
 *   marker and the caller escalates POST-COMMIT — the pattern already used for
 *   the outbox dispatch. The marker's `outcome` is `payment_anomaly` even before
 *   the escalation runs, so the answer is fail-closed: a divergent delivery can
 *   never be mistaken for a duplicate again.
 *
 * HOW THE RACE IS MADE DETERMINISTIC
 *   A real two-connection race cannot be timed from a test. `claimWebhookEvent`
 *   is therefore wrapped so that, when a test arms it, the concurrent twin
 *   concludes the event on the OTHER connection (`db`, not the settlement `tx`)
 *   in the exact instant between this delivery's snapshot read and its own claim
 *   — claim (`pending → processing`) then conclude (`processing → processed /
 *   anomaly / ignored`), which is precisely what the winning delivery does.
 *
 *   Because the gate only fires on a NON-concluded snapshot, each test first lets
 *   the twin settle for real (so the event row carries genuine evidence written
 *   by the twin's own payload) and then rewinds ONLY the row's `status` to
 *   `pending`, keeping `metadata` intact. That reproduces the interleaving
 *   "snapshot taken before the twin concluded" without fabricating any of the
 *   evidence the conflict comparison reads.
 *
 * STATUS — UNIT REGRESSION, NOT THE ACCEPTANCE EVIDENCE
 *   Every test below wraps `claimWebhookEvent`, so the race window it exercises
 *   is manufactured by that wrapper rather than produced by two deliveries
 *   really competing for the same row. These five tests are kept as fast unit
 *   regression for the C8 gate, but they do NOT discharge F-1 acceptance: no
 *   mock can stand in for real row-lock contention. The eight mandatory
 *   acceptance scenarios run the real pipeline against the runner's real
 *   disposable PostgreSQL, opening the window with a deterministic
 *   `SELECT … FOR UPDATE` barrier and no `vi.mock`, in
 *   `payments-p0-cycle4-f1-concurrency.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import {
  auditLogs,
  emailNotifications,
  orders,
  paymentAttempts,
  payments,
  products,
  providerWebhookEvents,
  reconciliationObservations,
} from "@/db/schema";
import { and, eq } from "drizzle-orm";
import type { EupagoConfig } from "@/lib/providers/eupago/config";
import type { WebhookEventRecord } from "@/lib/providers/webhook-events";
import { createEupagoPayment } from "@/lib/services/eupago-payment-service";
import { processEupagoWebhook } from "@/lib/services/eupago-settlement-service";
import {
  TEST_WEBHOOK_KEY,
  cleanupByPrefix,
  createPendingOrder,
  paidWebhookPayload,
  resetEupagoLedgerSlice,
  signedWebhook,
  stubFetch,
  unique,
} from "@/test-support/fixtures";

const PREFIX = "P0C4F1";

const CONFIG: EupagoConfig = {
  environment: "sandbox",
  apiKey: "dummy-api-key",
  oauthClientId: "dummy-client-id",
  oauthClientSecret: "dummy-client-secret",
  webhookKey: TEST_WEBHOOK_KEY,
};

// ─── The race window ───────────────────────────────────────

/**
 * Armed by a test to say how the concurrent twin concludes the event inside the
 * C8 window. One-shot: the wrapper clears it as soon as it fires, so it can never
 * leak into another delivery.
 */
const race = vi.hoisted(() => ({
  twin: null as null | "processed" | "anomaly" | "ignored",
}));

vi.mock("@/lib/providers/webhook-events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/providers/webhook-events")>();

  return {
    ...actual,
    claimWebhookEvent: async (
      id: number,
      options?: Parameters<typeof actual.claimWebhookEvent>[1]
    ): Promise<WebhookEventRecord | null> => {
      const twin = race.twin;
      if (twin) {
        race.twin = null;
        // The twin runs on its OWN connection, never on the settlement `tx`: it is
        // a different delivery, and its writes must be committed and visible to
        // this transaction (READ COMMITTED) before this claim is attempted.
        const won = await actual.claimWebhookEvent(id);
        if (won) {
          if (twin === "processed") await actual.markWebhookEventProcessed(id);
          else if (twin === "anomaly") await actual.markWebhookEventAnomaly(id, "DOUBLE_CHARGE");
          else await actual.markWebhookEventIgnored(id, "AMOUNT_MISMATCH");
        }
      }
      return actual.claimWebhookEvent(id, options);
    },
  };
});

// ─── Helpers ───────────────────────────────────────────────

async function createAttempt(orderId: number) {
  return createEupagoPayment({
    orderId,
    method: "mbway",
    amountCents: 5000,
    config: CONFIG,
    customerPhone: "912345678",
    countryCode: "351",
    fetchImpl: stubFetch({
      transactionStatus: "Success",
      transactionID: `TX-${unique()}`,
      reference: `REF-${unique()}`,
    }),
  });
}

const eventRow = async (trid: string) =>
  (
    await db
      .select()
      .from(providerWebhookEvents)
      .where(eq(providerWebhookEvents.providerEventId, trid))
      .limit(1)
  )[0];

const orderRow = async (id: number) => (await db.select().from(orders).where(eq(orders.id, id)).limit(1))[0];
const productRow = async (id: number) => (await db.select().from(products).where(eq(products.id, id)).limit(1))[0];
const observationsFor = async (orderId: number) =>
  db.select().from(reconciliationObservations).where(eq(reconciliationObservations.orderId, orderId));
const anomalyAuditsFor = async (attemptId: number) =>
  db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, "payment.provider_anomaly_recorded"), eq(auditLogs.entityId, attemptId)));
const paidPaymentsFor = async (orderId: number) =>
  db
    .select()
    .from(payments)
    .where(and(eq(payments.orderId, orderId), eq(payments.status, "paid")));
const orderEmailsFor = async (orderId: number) =>
  db
    .select()
    .from(emailNotifications)
    .where(and(eq(emailNotifications.referenceType, "order"), eq(emailNotifications.referenceId, orderId)));

/**
 * Reproduce the interleaving "this delivery's snapshot was taken BEFORE the twin
 * concluded". Only the state machine columns are rewound — `metadata` (the
 * evidence the conflict comparison reads), `eventType` and `payloadHash` are the
 * ones the twin's real delivery wrote and are left untouched.
 */
async function rewindToPreConclusion(trid: string) {
  await db
    .update(providerWebhookEvents)
    .set({ status: "pending", processedAt: null, failedAt: null, lastError: null, attempts: 0 })
    .where(eq(providerWebhookEvents.providerEventId, trid));
  const row = await eventRow(trid);
  if (row.status !== "pending") throw new Error("test setup failed: event was not rewound to pending");
  return row;
}

beforeEach(async () => {
  race.twin = null;
  await cleanupByPrefix(PREFIX);
  await resetEupagoLedgerSlice();
});

afterEach(async () => {
  race.twin = null;
  await cleanupByPrefix(PREFIX);
});

// ─── F-1 ───────────────────────────────────────────────────

describe("F-1 — a divergent payload cannot slip through the C8 race window", () => {
  it("escalates instead of answering CONSUMED_BY_CONCURRENT_DELIVERY", async () => {
    const fixture = await createPendingOrder({ prefix: PREFIX });
    const created = await createAttempt(fixture.orderId);
    if (created.outcome !== "created") throw new Error("attempt not created");
    const identifier = created.attempt.providerIdentifier!;
    const trid = `T-F1A-${unique()}`;

    // The twin settles for real: the event row now carries genuine evidence
    // (amount 50.00) written by the twin's own authenticated payload.
    const settled = await processEupagoWebhook(await signedWebhook(paidWebhookPayload({ trid, identifier })));
    expect(settled.outcome).toBe("payment_confirmed");
    expect((await orderRow(fixture.orderId)).status).toBe("paid");

    const stockAfterSettlement = await productRow(fixture.productId);
    const emailsAfterSettlement = await orderEmailsFor(fixture.orderId);

    // This delivery reads its snapshot while the row is still `pending`…
    const snapshot = await rewindToPreConclusion(trid);
    expect(snapshot.status).toBe("pending");
    expect(snapshot.metadata?.amountCents).toBe(5000);

    // …and by the time it claims, the twin has concluded it as `processed`.
    race.twin = "processed";
    const divergent = await processEupagoWebhook(
      await signedWebhook(paidWebhookPayload({ trid, identifier, amount: "99.99" }))
    );

    // BEFORE THE FIX: outcome "duplicate", code "CONSUMED_BY_CONCURRENT_DELIVERY".
    expect(divergent.outcome).toBe("payment_anomaly");
    expect(divergent.code).toBe("PROVIDER_EVENT_CONFLICT");

    // The divergence is durable and attributed to the local money record.
    const event = await eventRow(trid);
    expect(event.status).toBe("anomaly");
    expect(String(event.metadata?.anomalyCode)).toContain("PROVIDER_EVENT_CONFLICT");
    expect(typeof event.metadata?.eventConflict).toBe("string");
    expect(String(event.metadata?.eventConflict).length).toBeGreaterThan(0);

    const anomalies = await observationsFor(fixture.orderId);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({
      anomalyCode: "PROVIDER_EVENT_CONFLICT",
      provider: "eupago",
      providerReference: trid,
      paymentId: created.attempt.paymentId,
      status: "open",
      recordedBy: null,
    });

    const audit = await anomalyAuditsFor(created.attempt.id);
    expect(audit).toHaveLength(1);
    expect(audit[0].details).toMatchObject({ trid, code: "PROVIDER_EVENT_CONFLICT", settled: false });
    expect((audit[0].details as { conflictFields?: string[] }).conflictFields).toContain("amount");

    // Nothing was settled a second time and nothing about the twin's settlement
    // changed: the escalation is an escalation, never a replay.
    expect((await orderRow(fixture.orderId)).status).toBe("paid");
    expect(await productRow(fixture.productId)).toMatchObject({
      stock: stockAfterSettlement.stock,
      soldCount: stockAfterSettlement.soldCount,
    });
    expect(await orderEmailsFor(fixture.orderId)).toHaveLength(emailsAfterSettlement.length);
    expect(await paidPaymentsFor(fixture.orderId)).toHaveLength(1);
    const attempt = (
      await db.select().from(paymentAttempts).where(eq(paymentAttempts.id, created.attempt.id)).limit(1)
    )[0];
    expect(attempt.status).toBe("paid");
    expect(attempt.providerTransactionId).toBe(trid);
  });

  it("still answers duplicate for a byte-identical redelivery inside the same window", async () => {
    const fixture = await createPendingOrder({ prefix: PREFIX });
    const created = await createAttempt(fixture.orderId);
    if (created.outcome !== "created") throw new Error("attempt not created");
    const identifier = created.attempt.providerIdentifier!;
    const trid = `T-F1B-${unique()}`;

    expect(
      (await processEupagoWebhook(await signedWebhook(paidWebhookPayload({ trid, identifier })))).outcome
    ).toBe("payment_confirmed");
    await rewindToPreConclusion(trid);

    // Same trid, SAME payload: the comparison must not invent a divergence.
    race.twin = "processed";
    const identical = await processEupagoWebhook(await signedWebhook(paidWebhookPayload({ trid, identifier })));

    expect(identical.outcome).toBe("duplicate");
    expect(identical.code).toBe("CONSUMED_BY_CONCURRENT_DELIVERY");

    const event = await eventRow(trid);
    expect(event.status).toBe("processed");
    expect(event.metadata?.eventConflict).toBeUndefined();
    expect(await observationsFor(fixture.orderId)).toHaveLength(0);
    expect(await anomalyAuditsFor(created.attempt.id)).toHaveLength(0);
    expect(await paidPaymentsFor(fixture.orderId)).toHaveLength(1);
  });

  it("is idempotent: a further redelivery of the SAME divergence adds no second anomaly", async () => {
    const fixture = await createPendingOrder({ prefix: PREFIX });
    const created = await createAttempt(fixture.orderId);
    if (created.outcome !== "created") throw new Error("attempt not created");
    const identifier = created.attempt.providerIdentifier!;
    const trid = `T-F1C-${unique()}`;

    expect(
      (await processEupagoWebhook(await signedWebhook(paidWebhookPayload({ trid, identifier })))).outcome
    ).toBe("payment_confirmed");
    await rewindToPreConclusion(trid);

    race.twin = "processed";
    const first = await processEupagoWebhook(
      await signedWebhook(paidWebhookPayload({ trid, identifier, amount: "99.99" }))
    );
    expect(first.code).toBe("PROVIDER_EVENT_CONFLICT");
    expect(await observationsFor(fixture.orderId)).toHaveLength(1);
    expect(await anomalyAuditsFor(created.attempt.id)).toHaveLength(1);

    // The row is now `anomaly` and carries the fingerprint: the replay is caught
    // by the pre-transaction gate and must not duplicate the evidence.
    const replay = await processEupagoWebhook(
      await signedWebhook(paidWebhookPayload({ trid, identifier, amount: "99.99" }))
    );
    expect(replay.outcome).toBe("payment_anomaly");
    expect(replay.code).toBe("PROVIDER_EVENT_CONFLICT");
    expect(await observationsFor(fixture.orderId)).toHaveLength(1);
    expect(await anomalyAuditsFor(created.attempt.id)).toHaveLength(1);
    expect(await paidPaymentsFor(fixture.orderId)).toHaveLength(1);
  });

  it("escalates when the twin concluded as an ANOMALY and the payload diverges", async () => {
    const fixture = await createPendingOrder({ prefix: PREFIX });
    const created = await createAttempt(fixture.orderId);
    if (created.outcome !== "created") throw new Error("attempt not created");
    const identifier = created.attempt.providerIdentifier!;
    const trid = `T-F1D-${unique()}`;

    expect(
      (await processEupagoWebhook(await signedWebhook(paidWebhookPayload({ trid, identifier })))).outcome
    ).toBe("payment_confirmed");
    await rewindToPreConclusion(trid);

    // The twin concludes as an anomaly for another reason; this delivery states a
    // DIFFERENT amount. C8 must not simply echo the twin's anomaly code.
    race.twin = "anomaly";
    const divergent = await processEupagoWebhook(
      await signedWebhook(paidWebhookPayload({ trid, identifier, amount: "99.99" }))
    );

    expect(divergent.outcome).toBe("payment_anomaly");
    expect(divergent.code).toBe("PROVIDER_EVENT_CONFLICT");

    const event = await eventRow(trid);
    expect(event.status).toBe("anomaly");
    expect(String(event.metadata?.anomalyCode)).toContain("PROVIDER_EVENT_CONFLICT");
    expect((await anomalyAuditsFor(created.attempt.id))[0].details).toMatchObject({
      code: "PROVIDER_EVENT_CONFLICT",
      settled: false,
    });
    expect(await observationsFor(fixture.orderId)).toHaveLength(1);
    expect(await paidPaymentsFor(fixture.orderId)).toHaveLength(1);
  });

  it("keeps the C2 exclusion: an `ignored` twin is answered coherently, never escalated", async () => {
    const fixture = await createPendingOrder({ prefix: PREFIX });
    const created = await createAttempt(fixture.orderId);
    if (created.outcome !== "created") throw new Error("attempt not created");
    const identifier = created.attempt.providerIdentifier!;
    const trid = `T-F1E-${unique()}`;

    expect(
      (await processEupagoWebhook(await signedWebhook(paidWebhookPayload({ trid, identifier })))).outcome
    ).toBe("payment_confirmed");
    await rewindToPreConclusion(trid);

    // `ignored` deliveries concluded nothing about money, so their re-evaluation
    // semantics must survive the race window unchanged (no C2 escalation, no 503).
    race.twin = "ignored";
    const divergent = await processEupagoWebhook(
      await signedWebhook(paidWebhookPayload({ trid, identifier, amount: "99.99" }))
    );

    expect(divergent.outcome).toBe("mismatch");
    expect(divergent.code).toBe("AMOUNT_MISMATCH");

    const event = await eventRow(trid);
    expect(event.status).toBe("ignored");
    expect(event.metadata?.eventConflict).toBeUndefined();
  });
});
