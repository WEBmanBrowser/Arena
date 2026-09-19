/**
 * PAYMENT P0 (CYCLE 4) — F-1 ACCEPTANCE · REAL CONCURRENCY, NO MOCKS.
 *
 * WHY THIS FILE EXISTS
 *   `payments-p0-cycle4-f1.test.ts` proves the C8 divergent-payload gate with a
 *   wrapped `claimWebhookEvent`. That is useful unit regression, but it is NOT
 *   the acceptance evidence: the window it exercises is manufactured by the
 *   wrapper, not by two deliveries really competing for the same row.
 *
 *   These are the 8 mandatory acceptance scenarios. Every one drives the REAL
 *   pipeline — `processEupagoWebhook` → `registerWebhookEvent` → the
 *   pre-transaction C2 gate → `db.transaction` → `claimWebhookEvent` →
 *   `settlePaymentEvent` → `confirmOrderPaymentInTx` → the post-commit
 *   escalation — against the runner's real disposable PostgreSQL. There is no
 *   `vi.mock` anywhere in this file, and nothing intercepts `claimWebhookEvent`,
 *   `getWebhookEvent` or the settlement path. The only test-side primitives are
 *   a raw `pg.Client` lock barrier and the signed-payload fixtures.
 *
 * HOW THE WINDOW IS OPENED DETERMINISTICALLY
 *   The barrier holds `SELECT … FOR UPDATE` on the **`provider_webhook_events`
 *   row** — the row the claim UPDATE must lock — never on a financial row:
 *
 *     0. One REAL deferred delivery (a `reference` that matches no local
 *        attempt → `DEFERRED_REFERENCE_NOT_YET_PERSISTED`, the H3 path) creates
 *        the event row, committed, `status='pending'`, having settled nothing.
 *        No raw SQL fabricates provider state.
 *     1. The barrier locks that committed row. A row-level `FOR UPDATE` sets
 *        `xmax` WITHOUT creating a new tuple version, so `registerWebhookEvent`'s
 *        `INSERT … ON CONFLICT DO NOTHING` still skips immediately instead of
 *        waiting: both deliveries read back the committed `pending`.
 *     2. Delivery A registers (snapshot `pending` → the pre-tx C2 gate is
 *        correctly skipped) and its claim UPDATE blocks on the barrier.
 *     3. Delivery B registers (snapshot ALSO `pending`, because A's claim has
 *        not applied) and its claim UPDATE queues behind A.
 *     4. Both park points are PROVEN before anything is released: the test waits
 *        until TWO distinct backends hold a NON-granted `tuple`/`transactionid`
 *        lock while already owning a relation lock on `provider_webhook_events`.
 *        If the interleaving did not happen the test fails loudly — no scenario
 *        can pass vacuously, and a delivery stuck anywhere other than the event
 *        row cannot both satisfy this and produce scenario 5's C8-only code.
 *     5. The barrier COMMITs. PostgreSQL's FIFO tuple-lock queue lets A (queued
 *        first) claim, settle and commit `processed`. B's blocked UPDATE is then
 *        re-evaluated against the newest committed version (EvalPlanQual):
 *        `processed ∉ ('pending','failed')` → 0 rows → the claim returns null →
 *        the C8 branch runs for real, with a fresh re-read of the concluded row.
 *
 *   Lock order is acyclic (barrier: event row; A and B: event row → attempt →
 *   order → payment → products), so nothing can deadlock against the barrier.
 *   The only sleeps are the 10 ms ticks of the bounded polls, which carry a
 *   deadline and an assertion — never a timing assumption about the pipeline.
 *
 * WHY THE BARRIER IS NOT ON `payment_attempts`
 *   That was the first design and it is measurably wrong. Parking a delivery on
 *   the attempt row leaves its claim as an UNCOMMITTED UPDATE of the event row,
 *   which creates a new tuple version in the unique indexes with an in-progress
 *   xact; the racer's `INSERT … ON CONFLICT DO NOTHING` then WAITS for the winner
 *   instead of skipping, so the racer only reads its snapshot AFTER the winner
 *   committed and is answered by the pre-transaction C2 gate instead of C8.
 *   Evidence: with an identical racer payload that design returned
 *   `{outcome:"duplicate"}` with NO `code` (line ~342, pre-tx), whereas C8 always
 *   returns `code:"CONSUMED_BY_CONCURRENT_DELIVERY"` (line ~421). Scenario 5
 *   asserts exactly that code, so it doubles as the harness's own control
 *   experiment: if the race ever stops reaching C8, scenario 5 fails.
 *
 *   Detection deliberately avoids `pg_stat_activity.query`: it is truncated by
 *   `track_activity_query_size` (a wide drizzle `SELECT` lists every column
 *   before its `FROM`, so the table name is not reliably present), and a backend
 *   blocked on a lock can report `state='idle'` with a STALE statement. Both
 *   made a text-based predicate return 0 while deliveries were genuinely queued.
 *
 * FACTUAL FINDING RECORDED FOR SCENARIO 7
 *   The ONLY production caller of `claimWebhookEvent` is the settlement
 *   transaction, which concludes the event in that same transaction. A COMMITTED
 *   `processing` status is therefore not reachable from `processEupagoWebhook`:
 *   `processing` only ever exists uncommitted/in-flight. Scenario 7 accordingly
 *   exercises the in-flight `processing` window through the real barrier (leg C)
 *   and the reachable origin of `deferred` — budget exhaustion (legs A/B) — with
 *   no raw SQL fabricating provider state.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import pg from "pg";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  auditLogs,
  emailNotifications,
  orderStatusHistory,
  orders,
  paymentAttempts,
  payments,
  products,
  providerWebhookEvents,
  reconciliationObservations,
  stockMovements,
} from "@/db/schema";
import { POST as webhookPOST } from "@/app/api/webhooks/eupago/route";
import type { EupagoConfig } from "@/lib/providers/eupago/config";
import {
  DEFAULT_MAX_WEBHOOK_ATTEMPTS,
  grantWebhookRecoveryBudget,
  isDeferredWebhookEvent,
} from "@/lib/providers/webhook-events";
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

const PREFIX = "P0C4F1C";

const CONFIG: EupagoConfig = {
  environment: "sandbox",
  apiKey: "dummy-api-key",
  oauthClientId: "dummy-client-id",
  oauthClientSecret: "dummy-client-secret",
  webhookKey: TEST_WEBHOOK_KEY,
};

// ─── Read helpers ──────────────────────────────────────────

const eventRows = async (trid: string) =>
  db.select().from(providerWebhookEvents).where(eq(providerWebhookEvents.providerEventId, trid));
const eventRow = async (trid: string) => (await eventRows(trid))[0];
const orderRow = async (id: number) => (await db.select().from(orders).where(eq(orders.id, id)).limit(1))[0];
const productRow = async (id: number) => (await db.select().from(products).where(eq(products.id, id)).limit(1))[0];
const attemptRow = async (id: number) =>
  (await db.select().from(paymentAttempts).where(eq(paymentAttempts.id, id)).limit(1))[0];
const attemptRowsFor = async (orderId: number) =>
  db.select().from(paymentAttempts).where(eq(paymentAttempts.orderId, orderId));

const paidPaymentsFor = async (orderId: number) =>
  db.select().from(payments).where(and(eq(payments.orderId, orderId), eq(payments.status, "paid")));
const observationsFor = async (orderId: number) =>
  db.select().from(reconciliationObservations).where(eq(reconciliationObservations.orderId, orderId));
const paidHistoryFor = async (orderId: number) =>
  db
    .select()
    .from(orderStatusHistory)
    .where(and(eq(orderStatusHistory.orderId, orderId), eq(orderStatusHistory.toStatus, "paid")));
const saleMovementsFor = async (orderId: number) =>
  db
    .select()
    .from(stockMovements)
    .where(
      and(
        eq(stockMovements.referenceType, "order"),
        eq(stockMovements.referenceId, orderId),
        eq(stockMovements.type, "sale")
      )
    );
const orderEmailsFor = async (orderId: number) =>
  db
    .select()
    .from(emailNotifications)
    .where(and(eq(emailNotifications.referenceType, "order"), eq(emailNotifications.referenceId, orderId)));
const auditsFor = async (action: string, entityId: number) =>
  db.select().from(auditLogs).where(and(eq(auditLogs.action, action), eq(auditLogs.entityId, entityId)));

const anomalyAuditsFor = (attemptId: number) => auditsFor("payment.provider_anomaly_recorded", attemptId);
const confirmationAuditsFor = (orderId: number) => auditsFor("order.payment_confirmed", orderId);

/** `audit_logs.details` is JSON: read it as a plain object for `toMatchObject`. */
const detailsOf = (row: { details: unknown } | undefined) => (row?.details ?? {}) as Record<string, unknown>;

// ─── The deterministic barrier ─────────────────────────────

type Outcome<T> = { ok: true; result: T } | { ok: false; error: unknown };

const settle = async <T>(promise: Promise<T>): Promise<Outcome<T>> =>
  promise.then(
    (result) => ({ ok: true as const, result }),
    (error: unknown) => ({ ok: false as const, error })
  );

const unwrap = <T>(outcome: Outcome<T>): T => {
  if (!outcome.ok) throw outcome.error;
  return outcome.result;
};

/**
 * Deliveries queued behind the barrier on the event row.
 *
 * Detected through `pg_locks` ONLY, never through `pg_stat_activity.state` or
 * `.query`: a backend blocked on a lock can report `state='idle'` with a STALE
 * `query` (the statement it ran before blocking), which was measured to make a
 * text-based predicate return 0 while the delivery was genuinely queued. A
 * non-granted `tuple`/`transactionid` lock held by a backend that already owns a
 * relation lock on `provider_webhook_events` is the reliable signal.
 *
 * Both park modes are covered: the first waiter blocks on the barrier's
 * `transactionid`, the second on the `tuple` lock itself (measured: winner
 * `transactionid/ShareLock granted=false`, racer `tuple/ExclusiveLock
 * granted=false`). Requiring `>= 2` therefore proves BOTH deliveries are queued
 * on the event row — each having already registered, so each holding a `pending`
 * snapshot — before anything is released. A delivery stuck anywhere else (for
 * example in `registerWebhookEvent`'s INSERT, which is what the rejected
 * attempt-row barrier caused) cannot satisfy this while also producing scenario
 * 5's `CONSUMED_BY_CONCURRENT_DELIVERY`, the code only the C8 branch returns.
 */
const QUEUED_AT_CLAIM_SQL = `
  SELECT count(DISTINCT l.pid)::int AS count
  FROM pg_locks l
  WHERE NOT l.granted
    AND l.locktype IN ('tuple', 'transactionid')
    AND l.pid <> pg_backend_pid()
    AND EXISTS (
      SELECT 1 FROM pg_locks r
      WHERE r.pid = l.pid AND r.granted AND r.locktype = 'relation'
        AND r.relation = 'provider_webhook_events'::regclass
    )
`;

async function holdEventRowForUpdate(trid: string) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query("BEGIN");
  const held = await client.query(
    "SELECT id FROM provider_webhook_events WHERE provider = 'eupago' AND provider_event_id = $1 FOR UPDATE",
    [trid]
  );
  // Fail loudly if the barrier locked nothing: an unlocked row would let the
  // winner settle freely and every scenario below would pass vacuously.
  if (held.rowCount !== 1) throw new Error(`test setup failed: barrier locked ${held.rowCount} event rows`);

  /** Bounded poll: returns as soon as `want` deliveries are blocked at the claim. */
  const waitForQueuedAtClaim = async (want: number, deadlineMs = 15_000): Promise<number> => {
    const deadline = Date.now() + deadlineMs;
    for (;;) {
      const found = await client.query<{ count: number }>(QUEUED_AT_CLAIM_SQL);
      const count = Number(found.rows[0]?.count ?? 0);
      if (count >= want || Date.now() > deadline) return count;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  let released = false;
  return {
    waitForQueuedAtClaim,
    release: async () => {
      await client.query("COMMIT");
      released = true;
    },
    close: async () => {
      // Only roll back a barrier that was never released: rolling back an
      // already-committed transaction makes PostgreSQL warn on stderr.
      if (!released) await client.query("ROLLBACK").catch(() => {});
      await client.end().catch(() => {});
    },
  };
}

/**
 * Run TWO authenticated deliveries for the SAME `trid` as a genuine race and
 * return both results.
 *
 * The event row is seeded, when it does not exist yet, by one REAL deferred
 * delivery: it registers the `trid` and settles nothing, leaving the row
 * committed as `pending` for the barrier to hold. Both deliveries then take a
 * `pending` snapshot and queue on the claim, so the winner concludes while the
 * racer is still waiting — the exact window the C8 branch has to survive.
 */
async function raceTwoDeliveries(input: {
  trid: string;
  winner: Record<string, unknown>;
  racer: Record<string, unknown>;
}) {
  if ((await eventRows(input.trid)).length === 0) {
    const seed = await processEupagoWebhook(
      await signedWebhook(paidWebhookPayload({ trid: input.trid, reference: `REF-${unique()}` }))
    );
    if (seed.outcome !== "deferred") {
      throw new Error(`test setup failed: seed delivery answered ${seed.outcome}/${seed.code ?? "-"}`);
    }
  }

  const winnerDelivery = await signedWebhook(input.winner);
  const racerDelivery = await signedWebhook(input.racer);
  const barrier = await holdEventRowForUpdate(input.trid);
  try {
    const winnerPromise = settle(processEupagoWebhook(winnerDelivery));
    // A has registered (snapshot `pending`) and is blocked at the claim: it has
    // concluded NOTHING, so B's snapshot cannot yet see a concluded event.
    expect(await barrier.waitForQueuedAtClaim(1)).toBeGreaterThanOrEqual(1);

    const racerPromise = settle(processEupagoWebhook(racerDelivery));
    // B is blocked at the SAME claim statement, behind A. Both snapshots are
    // `pending`, which is the real TOCTOU window C8 has to answer from.
    expect(await barrier.waitForQueuedAtClaim(2)).toBeGreaterThanOrEqual(2);

    // Release: A wins the FIFO tuple-lock queue, settles and commits; B's claim
    // is re-evaluated against `processed` → 0 rows → the C8 branch.
    await barrier.release();
    return { winner: unwrap(await winnerPromise), racer: unwrap(await racerPromise) };
  } finally {
    await barrier.close();
  }
}

// ─── Fixtures ──────────────────────────────────────────────

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

/** Real order + real pending Eupago attempt + a fresh `trid`. */
async function raceFixture() {
  const fixture = await createPendingOrder({ prefix: PREFIX });
  const created = await createAttempt(fixture.orderId);
  if (created.outcome !== "created") throw new Error("test setup failed: attempt not created");
  const attempt = created.attempt;
  const identifier = attempt.providerIdentifier;
  if (!identifier) throw new Error("test setup failed: attempt has no providerIdentifier");
  return { fixture, attempt, identifier, trid: `T-F1C-${unique()}` };
}

beforeEach(async () => {
  await cleanupByPrefix(PREFIX);
  await resetEupagoLedgerSlice();
});

afterEach(async () => {
  await cleanupByPrefix(PREFIX);
});

// ─── F-1 ACCEPTANCE ────────────────────────────────────────

describe("F-1 acceptance — real concurrency on one trid, no mocks", () => {
  /**
   * Scenarios 1–3 share one shape: a non-Paid provider state races the Paid one
   * for the same `trid`. The Paid delivery concludes the money movement; the
   * racer must escalate, and must NEVER be acknowledged as a plain duplicate.
   */
  async function expectEscalatedConflict(status: "Expired" | "Cancel" | "Error") {
    const { fixture, attempt, identifier, trid } = await raceFixture();

    const { winner, racer } = await raceTwoDeliveries({
      trid,
      winner: paidWebhookPayload({ trid, identifier }),
      racer: paidWebhookPayload({ trid, identifier, status }),
    });

    // The Paid delivery really concluded.
    expect(winner.outcome).toBe("payment_confirmed");
    expect((await orderRow(fixture.orderId)).status).toBe("paid");

    // The racer is never a silent duplicate.
    expect(racer.outcome).not.toBe("duplicate");
    expect(racer.outcome).toBe("payment_anomaly");
    expect(racer.code).toBe("PROVIDER_EVENT_CONFLICT");
    expect(racer.trid).toBe(trid);

    // …and the divergence is durable and precise: the event is escalated and the
    // audit names the field that changed meaning.
    expect((await eventRow(trid)).status).toBe("anomaly");
    const [audit] = await anomalyAuditsFor(attempt.id);
    expect(audit).toBeDefined();
    expect(detailsOf(audit)).toMatchObject({
      code: "PROVIDER_EVENT_CONFLICT",
      conflictFields: ["event_type"],
      persistedEventType: "payment.paid",
      receivedEventType: `payment.${status.toLowerCase()}`,
      settled: false,
    });
    expect(await observationsFor(fixture.orderId)).toHaveLength(1);

    // The escalation settles nothing a second time.
    expect(await paidPaymentsFor(fixture.orderId)).toHaveLength(1);
    expect(await confirmationAuditsFor(fixture.orderId)).toHaveLength(1);
    expect(await paidHistoryFor(fixture.orderId)).toHaveLength(1);
  }

  it("1 — Expired racing Paid on the same trid escalates instead of answering duplicate", async () => {
    await expectEscalatedConflict("Expired");
  });

  it("2 — Cancel racing Paid on the same trid escalates instead of answering duplicate", async () => {
    await expectEscalatedConflict("Cancel");
  });

  it("3 — Error racing Paid on the same trid escalates instead of answering duplicate", async () => {
    await expectEscalatedConflict("Error");
  });

  it("4 — Paid 50.00 racing Paid 60.00 on the same trid escalates an amount conflict", async () => {
    const { fixture, attempt, identifier, trid } = await raceFixture();

    const { winner, racer } = await raceTwoDeliveries({
      trid,
      winner: paidWebhookPayload({ trid, identifier, amount: "50.00" }),
      racer: paidWebhookPayload({ trid, identifier, amount: "60.00" }),
    });

    expect(winner.outcome).toBe("payment_confirmed");
    expect(racer.outcome).not.toBe("duplicate");
    expect(racer.outcome).toBe("payment_anomaly");
    expect(racer.code).toBe("PROVIDER_EVENT_CONFLICT");

    const [audit] = await anomalyAuditsFor(attempt.id);
    expect(audit).toBeDefined();
    expect(detailsOf(audit)).toMatchObject({
      conflictFields: ["amount"],
      persistedEventType: "payment.paid",
      receivedEventType: "payment.paid",
      persistedAmountCents: 5000,
      receivedAmountCents: 6000,
      settled: false,
    });
    expect((await eventRow(trid)).status).toBe("anomaly");
    expect(await observationsFor(fixture.orderId)).toHaveLength(1);

    // The extra 10.00 never became money: exactly one paid payment, for 50.00.
    const paid = await paidPaymentsFor(fixture.orderId);
    expect(paid).toHaveLength(1);
    expect(String(paid[0].amount)).toBe("50.00");
  });

  it("5 — a semantically identical payload racing itself stays a legitimate duplicate", async () => {
    const { fixture, attempt, identifier, trid } = await raceFixture();

    const { winner, racer } = await raceTwoDeliveries({
      trid,
      winner: paidWebhookPayload({ trid, identifier }),
      racer: paidWebhookPayload({ trid, identifier }),
    });

    expect(winner.outcome).toBe("payment_confirmed");
    // The genuine redelivery is NOT turned into a false conflict.
    expect(racer.outcome).toBe("duplicate");
    // This code exists ONLY in the C8 branch: it is the control experiment that
    // proves the race really reached C8 and not the pre-transaction gate.
    expect(racer.code).toBe("CONSUMED_BY_CONCURRENT_DELIVERY");

    const event = await eventRow(trid);
    expect(event.status).toBe("processed");
    expect(await observationsFor(fixture.orderId)).toHaveLength(0);
    expect(await anomalyAuditsFor(attempt.id)).toHaveLength(0);
    expect(await paidPaymentsFor(fixture.orderId)).toHaveLength(1);
  });

  it("6 — a divergent replay after the escalation is idempotent and adds no second observation", async () => {
    const { fixture, attempt, identifier, trid } = await raceFixture();
    const divergent = paidWebhookPayload({ trid, identifier, status: "Expired" });

    const { winner, racer } = await raceTwoDeliveries({
      trid,
      winner: paidWebhookPayload({ trid, identifier }),
      racer: divergent,
    });
    expect(winner.outcome).toBe("payment_confirmed");
    expect(racer.code).toBe("PROVIDER_EVENT_CONFLICT");
    expect(await observationsFor(fixture.orderId)).toHaveLength(1);

    const escalated = await eventRow(trid);
    expect(escalated.status).toBe("anomaly");
    const fingerprint = escalated.metadata?.eventConflict;
    expect(typeof fingerprint).toBe("string");

    // The provider retries the SAME divergent payload. The pre-transaction gate
    // now sees a concluded anomaly row and answers with the anomaly that exists.
    const replay = await processEupagoWebhook(await signedWebhook(divergent));
    expect(replay.outcome).toBe("payment_anomaly");
    expect(replay.code).toBe(racer.code);
    expect(replay.trid).toBe(trid);

    const afterReplay = await eventRow(trid);
    expect(afterReplay.status).toBe("anomaly");
    expect(afterReplay.metadata?.eventConflict).toBe(fingerprint);
    // No second observation, no second audit, no second settlement.
    expect(await observationsFor(fixture.orderId)).toHaveLength(1);
    expect(await anomalyAuditsFor(attempt.id)).toHaveLength(1);
    expect(await paidPaymentsFor(fixture.orderId)).toHaveLength(1);
  });

  it("7 — processing/deferred answers 503 + Retry-After and the retry after conclusion still conflicts", async () => {
    // The route resolves the webhook key from env/Backoffice.
    process.env.EUPAGO_WEBHOOK_KEY = TEST_WEBHOOK_KEY;
    const { fixture, attempt, identifier, trid } = await raceFixture();

    // ── Leg A — the capped budget is exhausted by REAL deferred deliveries
    // (a reference that matches no local attempt), exactly as H3 does.
    for (let index = 0; index < DEFAULT_MAX_WEBHOOK_ATTEMPTS; index += 1) {
      const deferred = await processEupagoWebhook(
        await signedWebhook(paidWebhookPayload({ trid, reference: `REF-${unique()}` }))
      );
      expect(deferred.outcome).toBe("deferred");
    }
    const [exhausted] = await eventRows(trid);
    expect(exhausted.attempts).toBe(DEFAULT_MAX_WEBHOOK_ATTEMPTS);
    expect(isDeferredWebhookEvent(exhausted)).toBe(true);

    // ── Leg B — the next delivery is refused by the budget and the REAL route
    // answers retryably (never a blanket 200). Note it answers `deferred`, NOT a
    // conflict: nothing was concluded yet, so there is nothing to diverge from.
    const overBudget = paidWebhookPayload({ trid, identifier, amount: "60.00" });
    const overBudgetResponse = await webhookPOST(
      new NextRequest("https://arena.test/api/webhooks/eupago", {
        method: "POST",
        headers: { "x-signature": (await signedWebhook(overBudget)).headers["x-signature"] },
        body: JSON.stringify(overBudget),
      })
    );
    expect(overBudgetResponse.status).toBe(503);
    expect(overBudgetResponse.headers.get("Retry-After")).not.toBeNull();
    expect(await overBudgetResponse.json()).toMatchObject({ received: false, retry: true, outcome: "deferred" });

    // ── Leg C — the audited recovery grant is production code, and the
    // provider's retry then races the winning delivery through the SAME real
    // in-flight `processing` window: the deferred/503 cycle must not have
    // corrupted conflict detection.
    const granted = await grantWebhookRecoveryBudget({ eventId: exhausted.id });
    expect(granted.outcome).toBe("granted");

    const { winner, racer } = await raceTwoDeliveries({
      trid,
      winner: paidWebhookPayload({ trid, identifier }),
      racer: paidWebhookPayload({ trid, identifier, amount: "60.00" }),
    });
    expect(winner.outcome).toBe("payment_confirmed");
    expect(racer.outcome).not.toBe("duplicate");
    expect(racer.outcome).toBe("payment_anomaly");
    expect(racer.code).toBe("PROVIDER_EVENT_CONFLICT");

    const concluded = await eventRow(trid);
    expect(concluded.status).toBe("anomaly");
    const [audit] = await anomalyAuditsFor(attempt.id);
    expect(audit).toBeDefined();
    expect(detailsOf(audit)).toMatchObject({ conflictFields: ["amount"], settled: false });
    expect(await observationsFor(fixture.orderId)).toHaveLength(1);
    expect(await paidPaymentsFor(fixture.orderId)).toHaveLength(1);
    expect((await orderRow(fixture.orderId)).status).toBe("paid");
  });

  it("8 — no race produces two settlements or two financial confirmations", async () => {
    // ── 8a — the classic double-delivery race: both payloads identical.
    const first = await raceFixture();
    const productBefore = await productRow(first.fixture.productId);

    const identical = await raceTwoDeliveries({
      trid: first.trid,
      winner: paidWebhookPayload({ trid: first.trid, identifier: first.identifier }),
      racer: paidWebhookPayload({ trid: first.trid, identifier: first.identifier }),
    });
    expect(identical.winner.outcome).toBe("payment_confirmed");
    expect(identical.racer.outcome).toBe("duplicate");
    expect(identical.racer.code).toBe("CONSUMED_BY_CONCURRENT_DELIVERY");

    // EXACTLY ONE of every financial effect of `confirmOrderPaymentInTx`.
    expect(await paidPaymentsFor(first.fixture.orderId)).toHaveLength(1);
    expect((await orderRow(first.fixture.orderId)).status).toBe("paid");
    expect(await paidHistoryFor(first.fixture.orderId)).toHaveLength(1);
    expect(await saleMovementsFor(first.fixture.orderId)).toHaveLength(1);
    expect(await confirmationAuditsFor(first.fixture.orderId)).toHaveLength(1);
    expect(await orderEmailsFor(first.fixture.orderId)).toHaveLength(1);
    expect(await attemptRowsFor(first.fixture.orderId)).toHaveLength(1);

    const settledAttempt = await attemptRow(first.attempt.id);
    expect(settledAttempt.status).toBe("paid");
    expect(Number(settledAttempt.operationRevision)).toBeGreaterThan(Number(first.attempt.operationRevision));

    // The `trid` is the identity: ONE event row, concluded once, stock moved once.
    const events = await eventRows(first.trid);
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe("processed");
    expect(await observationsFor(first.fixture.orderId)).toHaveLength(0);

    const productAfter = await productRow(first.fixture.productId);
    expect(Number(productAfter.soldCount)).toBe(Number(productBefore.soldCount) + 1);
    expect(Number(productAfter.stock)).toBe(Number(productBefore.stock) - 1);
    expect(Number(productAfter.reservedStock)).toBe(Number(productBefore.reservedStock) - 1);

    // ── 8b — the divergent race: the loser escalates and STILL settles nothing.
    const second = await raceFixture();
    const divergent = await raceTwoDeliveries({
      trid: second.trid,
      winner: paidWebhookPayload({ trid: second.trid, identifier: second.identifier }),
      racer: paidWebhookPayload({ trid: second.trid, identifier: second.identifier, amount: "60.00" }),
    });
    expect(divergent.winner.outcome).toBe("payment_confirmed");
    expect(divergent.racer.code).toBe("PROVIDER_EVENT_CONFLICT");

    expect(await paidPaymentsFor(second.fixture.orderId)).toHaveLength(1);
    expect((await orderRow(second.fixture.orderId)).status).toBe("paid");
    expect(await paidHistoryFor(second.fixture.orderId)).toHaveLength(1);
    expect(await saleMovementsFor(second.fixture.orderId)).toHaveLength(1);
    expect(await confirmationAuditsFor(second.fixture.orderId)).toHaveLength(1);
    expect(await orderEmailsFor(second.fixture.orderId)).toHaveLength(1);
    expect(await attemptRowsFor(second.fixture.orderId)).toHaveLength(1);
    // Exactly ONE durable anomaly for the divergence — never two.
    expect(await observationsFor(second.fixture.orderId)).toHaveLength(1);
    expect(await anomalyAuditsFor(second.attempt.id)).toHaveLength(1);
    expect(await eventRows(second.trid)).toHaveLength(1);
    expect((await eventRow(second.trid)).status).toBe("anomaly");
  });
});
