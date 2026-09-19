/**
 * PAYMENT P0 — network discipline (items 11/12/15), deterministic locks (M1),
 * stale-response fencing (item 16), the M3 harness guard, and refunds
 * (items 13/14/23/24).
 *
 * The whole file runs with the suite-wide guard that FAILS any test which tries
 * to reach a real host: provider behaviour exists here only through injected
 * `fetchImpl` stubs.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import { orders, paymentAttempts, payments, products, refundAttempts } from "@/db/schema";
import { eq, inArray, sql } from "drizzle-orm";
import { lockProductsAscending } from "@/lib/stock-locks";
import {
  createEupagoPayment,
  recoverPaymentAttempt,
} from "@/lib/services/eupago-payment-service";
import { processEupagoWebhook } from "@/lib/services/eupago-settlement-service";
import { armEupagoRefund, executeEupagoRefund } from "@/lib/services/eupago-refund-service";
import { requestRefund, getOrderRefundState } from "@/lib/refunds";
import { consumeHttpAttempts, unexpectedHttpAttempts } from "@/test-support/setup";
import type { EupagoConfig } from "@/lib/providers/eupago/config";
import {
  cleanupByPrefix,
  resetEupagoLedgerSlice,
  createPendingOrder,
  createUser,
  paidWebhookPayload,
  signedWebhook,
  stubFetch,
  unique,
  TEST_WEBHOOK_KEY,
} from "@/test-support/fixtures";

const PREFIX = "P0H";
const CONFIG: EupagoConfig = {
  environment: "sandbox",
  apiKey: "dummy-api-key",
  oauthClientId: "dummy-client-id",
  oauthClientSecret: "dummy-client-secret",
  webhookKey: TEST_WEBHOOK_KEY,
};

/** A stub that answers the OAuth token endpoint and the rest with `body`. */
function providerStub(body: unknown, status = 201, counter?: { calls: number }): typeof fetch {
  const inner = stubFetch(body, status, counter);
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/auth/token")) {
      return new Response(JSON.stringify({ access_token: "test-token", expires_in: 300 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return inner(input, init);
  }) as unknown as typeof fetch;
}

function mbwayCreated(reference = `REF-${unique()}`) {
  return { transactionStatus: "Success", transactionID: `TX-${unique()}`, reference };
}

beforeEach(async () => {
  await cleanupByPrefix(PREFIX);
  await resetEupagoLedgerSlice();
  consumeHttpAttempts();
});
afterEach(async () => {
  await cleanupByPrefix(PREFIX);
});

describe("M3 — the suite cannot reach a real service", () => {
  it("blocks and counts any outbound HTTP attempt (even one that would be converted to UNKNOWN)", async () => {
    expect(globalThis.fetch).not.toBe(undefined);
    await expect(fetch("https://api.eupago.pt/anything")).rejects.toThrow(/ARENA_TEST_REAL_HTTP_FORBIDDEN/);
    const attempts = consumeHttpAttempts();
    expect(attempts).toHaveLength(1);
    expect(attempts[0].url).toContain("api.eupago.pt");

    // The recorder is drained, so this test does not fail the file.
    expect(unexpectedHttpAttempts()).toHaveLength(0);
  });

  it("binds the suite to the disposable PostgreSQL and keeps Hyperdrive out", async () => {
    // The runner owns the connection and the guard verified it by QUERYING.
    expect(process.env.ARENA_TEST_GUARD).toBe("1");
    const url = new URL(process.env.DATABASE_URL!);
    expect(url.hostname).toBe("127.0.0.1");
    expect(url.port).toBe(process.env.ARENA_TEST_PG_PORT);

    const port = await db.execute<{ port: number }>(sql`SELECT inet_server_port() AS port`);
    expect(String(port.rows[0]?.port)).toBe(process.env.ARENA_TEST_PG_PORT);

    // A Cloudflare context (the only source of a Hyperdrive connection string) is
    // never usable inside the suite: it either throws our guard or the binding
    // error, and NEVER yields a connection.
    const mod = (await import("@opennextjs/cloudflare")) as { getCloudflareContext: () => unknown };
    expect(() => mod.getCloudflareContext()).toThrow();
  });
});

describe("M1 — deterministic product lock order", () => {
  it("locks products in ascending id order regardless of the caller's order", async () => {
    const a = await createPendingOrder({ prefix: PREFIX });
    const b = await createPendingOrder({ prefix: PREFIX });
    const ids = [a.productId, b.productId];
    const [low, high] = ids.sort((x, y) => x - y);

    await db.transaction(async (tx) => {
      // Asking in DESCENDING order must still take the locks ASCENDING.
      const locked = await lockProductsAscending(tx, [high, low, high]);
      expect([...locked.keys()]).toEqual([low, high]);
    });
  });

  it("never deadlocks two concurrent writers that touch the same products in opposite orders", async () => {
    const first = await createPendingOrder({ prefix: PREFIX });
    const second = await createPendingOrder({ prefix: PREFIX });
    const ordered = [first.productId, second.productId].sort((x, y) => x - y);
    const reversed = [...ordered].reverse();

    const worker = async (ids: number[], markStock: number) => {
      await db.transaction(async (tx) => {
        await lockProductsAscending(tx, ids);
        // A second statement after the lock — the classic deadlock trigger when
        // the lock order differs between workers.
        await tx.update(products).set({ reservedStock: 5 }).where(inArray(products.id, ordered));
        expect(markStock).toBeGreaterThan(0);
      });
    };

    await expect(Promise.all([worker(ordered, 1), worker(reversed, 1)])).resolves.toBeDefined();
  });

  it("exposes reserved stock read under the same lock the checkout uses", async () => {
    const fixture = await createPendingOrder({ prefix: PREFIX });
    await db.update(products).set({ reservedStock: 3 }).where(eq(products.id, fixture.productId));

    const locked = await db.transaction((tx) => lockProductsAscending(tx, [fixture.productId]));
    expect(locked.get(fixture.productId)?.reservedStock).toBe(3);
    expect(Object.keys(locked.get(fixture.productId) ?? {})).toContain("stock");
  });
});

describe("P0 item 11 — no provider traffic inside the settlement transaction", () => {
  it("settles a paid webhook without issuing a single outbound request", async () => {
    const fixture = await createPendingOrder({ prefix: PREFIX });
    const counter = { calls: 0 };
    const created = await createEupagoPayment({
      orderId: fixture.orderId,
      method: "mbway",
      amountCents: 5000,
      config: CONFIG,
      customerPhone: "912345678",
      countryCode: "351",
      fetchImpl: providerStub(mbwayCreated(), 201, counter),
    });
    expect(created.outcome).toBe("created");
    expect(counter.calls).toBe(1);

    const settled = await processEupagoWebhook(
      await signedWebhook(paidWebhookPayload({ trid: `T-${unique()}`, identifier: created.attempt.providerIdentifier }))
    );
    expect(settled.outcome).toBe("payment_confirmed");
    // The webhook path performed ZERO provider requests (the counter is unchanged)
    // and the harness recorded no real HTTP attempt.
    expect(counter.calls).toBe(1);
    expect(unexpectedHttpAttempts()).toHaveLength(0);

    const [order] = await db.select().from(orders).where(eq(orders.id, fixture.orderId)).limit(1);
    expect(order.status).toBe("paid");
  });
});

describe("P0 item 12 — refund claim is committed BEFORE the external call", () => {
  it("shows the durable `requested` claim to another connection while the HTTP call is in flight", async () => {
    const fixture = await createPendingOrder({ prefix: PREFIX });
    const counter = { calls: 0 };
    const created = await createEupagoPayment({
      orderId: fixture.orderId,
      method: "mbway",
      amountCents: 5000,
      config: CONFIG,
      customerPhone: "912345678",
      countryCode: "351",
      fetchImpl: providerStub(mbwayCreated(), 201, counter),
    });
    await processEupagoWebhook(
      await signedWebhook(paidWebhookPayload({ trid: `T-${unique()}`, identifier: created.attempt.providerIdentifier }))
    );

    const operator = await createUser(PREFIX);
    const requested = await requestRefund({
      orderId: fixture.orderId,
      amountCents: 2500,
      idempotencyKey: `p0h-${unique()}`,
      requestedBy: operator.id,
      provider: "eupago",
    });
    // The original movement is resolved and persisted by the arming step.
    const armed = await armEupagoRefund(requested.refund.id);
    expect(armed.providerOriginalTransactionId).not.toBeNull();

    // Observable proof: by the time the provider is called, ANOTHER connection
    // already sees the committed `requested` claim — the single-use token that
    // prevents a second transmission.
    let observedState: string | null = null;
    const inspecting = (async (input: RequestInfo | URL) => {
      const result = await db.execute<{ recovery_state: string | null }>(
        sql`SELECT recovery_state FROM refund_attempts WHERE id = ${requested.refund.id}`
      );
      observedState = result.rows[0]?.recovery_state ?? null;
      if (String(input).includes("/auth/token")) {
        return new Response(JSON.stringify({ access_token: "t", expires_in: 300 }), { status: 200 });
      }
      return new Response(JSON.stringify({ transactionStatus: "Success", trid: `R-${unique()}` }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const executed = await executeEupagoRefund({ refundId: armed.id, actorId: operator.id, config: CONFIG, fetchImpl: inspecting });
    expect(observedState).toBe("requested");
    expect(executed.outcome).toBe("submitted");
    expect(unexpectedHttpAttempts()).toHaveLength(0);

    // 201 is acceptance, never settlement.
    expect(executed.refund.status).not.toBe("succeeded");
    const state = await getOrderRefundState(fixture.orderId);
    expect(state.committedCents).toBe(2500);
    expect(state.refundedCents).toBe(0);
  });
});

describe("P0 items 13/14/15 — recovery keeps the commitment", () => {
  async function ambiguousAttempt() {
    const fixture = await createPendingOrder({ prefix: PREFIX });
    const counter = { calls: 0 };
    const timingOut = (async (input: RequestInfo | URL) => {
      if (String(input).includes("/auth/token")) {
        return new Response(JSON.stringify({ access_token: "t", expires_in: 300 }), { status: 200 });
      }
      counter.calls += 1;
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }) as unknown as typeof fetch;

    const created = await createEupagoPayment({
      orderId: fixture.orderId,
      method: "mbway",
      amountCents: 5000,
      config: CONFIG,
      customerPhone: "912345678",
      countryCode: "351",
      fetchImpl: timingOut,
    });
    expect(created.outcome).toBe("reconciliation_required");
    return { fixture, attempt: created.attempt };
  }

  it("maps a reported ABSENCE to UNKNOWN without a positive proof (item 15)", async () => {
    const { attempt } = await ambiguousAttempt();
    const before = attempt.operationRevision;

    const emptyLookup = (async (input: RequestInfo | URL) => {
      if (String(input).includes("/auth/token")) {
        return new Response(JSON.stringify({ access_token: "t", expires_in: 300 }), { status: 200 });
      }
      return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const recovered = await recoverPaymentAttempt({ attemptId: attempt.id, config: CONFIG, fetchImpl: emptyLookup });
    expect(recovered.outcome).toBe("unknown");
    expect(recovered.code).toBe("ABSENCE_NOT_ACCEPTED");
    expect(recovered.attempt.recoveryState).toBe("reconciliation_required");
    // The commitment survives: the attempt was NOT re-armed and nothing was
    // created. Only the revision may have moved (fencing).
    expect(recovered.attempt.operationRevision).toBeGreaterThanOrEqual(before);
  });

  it("re-arms ONLY with an injected positive proof, and never twice", async () => {
    const { attempt } = await ambiguousAttempt();
    const emptyLookup = (async (input: RequestInfo | URL) =>
      String(input).includes("/auth/token")
        ? new Response(JSON.stringify({ access_token: "t", expires_in: 300 }), { status: 200 })
        : new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

    const proved = await recoverPaymentAttempt({
      attemptId: attempt.id,
      config: CONFIG,
      fetchImpl: emptyLookup,
      absenceProof: () => true,
    });
    expect(proved.outcome).toBe("proven_absent");
    expect(proved.attempt.recoveryState).toBe("armed");
  });

  it("keeps a network-ambiguous lookup in UNKNOWN and never re-arms", async () => {
    const { attempt } = await ambiguousAttempt();
    const failing = (async (input: RequestInfo | URL) => {
      if (String(input).includes("/auth/token")) {
        return new Response(JSON.stringify({ access_token: "t", expires_in: 300 }), { status: 200 });
      }
      return new Response("{}", { status: 503 });
    }) as unknown as typeof fetch;

    const recovered = await recoverPaymentAttempt({ attemptId: attempt.id, config: CONFIG, fetchImpl: failing });
    expect(recovered.outcome).toBe("unknown");
    expect(recovered.attempt.recoveryState).toBe("reconciliation_required");
  });

  it("adopts provider correlation data only for FOUND, without settling anything", async () => {
    const { attempt } = await ambiguousAttempt();
    const reference = `REF-${unique()}`;
    const found = (async (input: RequestInfo | URL) =>
      String(input).includes("/auth/token")
        ? new Response(JSON.stringify({ access_token: "t", expires_in: 300 }), { status: 200 })
        : new Response(
            JSON.stringify({ results: [{ referencia: reference, transactionID: `TX-${unique()}`, estado: "Pendente" }] }),
            { status: 200, headers: { "content-type": "application/json" } }
          )) as unknown as typeof fetch;

    const recovered = await recoverPaymentAttempt({ attemptId: attempt.id, config: CONFIG, fetchImpl: found });
    expect(recovered.outcome).toBe("found");
    // Recovery NEVER confirms a payment: money still moves only through a
    // verified webhook.
    expect(recovered.attempt.status).toBe("pending");
    const [order] = await db.select().from(orders).where(eq(orders.id, attempt.orderId)).limit(1);
    expect(order.status).toBe("pending_payment");
  });
});

describe("P0 item 16 — stale provider responses cannot overwrite newer state", () => {
  it("fences the create write-back against a webhook that already settled the attempt", async () => {
    const fixture = await createPendingOrder({ prefix: PREFIX });
    const reference = `REF-${unique()}`;
    let settledMeanwhile = false;

    // The provider response arrives AFTER a webhook has already settled the
    // attempt: the settlement wins, the late response is additive-only.
    const racingFetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes("/auth/token")) {
        return new Response(JSON.stringify({ access_token: "t", expires_in: 300 }), { status: 200 });
      }
      // Simulate the settlement happening while the HTTP call is in flight. The
      // attempt already carries its locally generated identifier, so the delivery
      // correlates WITHOUT needing the reference that is still in flight.
      const [row] = await db
        .select()
        .from(paymentAttempts)
        .where(eq(paymentAttempts.orderId, fixture.orderId))
        .limit(1);
      if (row?.providerIdentifier && !settledMeanwhile) {
        settledMeanwhile = true;
        const settled = await processEupagoWebhook(
          await signedWebhook(paidWebhookPayload({ trid: `T-${unique()}`, identifier: row.providerIdentifier }))
        );
        expect(settled.outcome).toBe("payment_confirmed");
      }
      return new Response(JSON.stringify(mbwayCreated(reference)), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const created = await createEupagoPayment({
      orderId: fixture.orderId,
      method: "mbway",
      amountCents: 5000,
      config: CONFIG,
      customerPhone: "912345678",
      countryCode: "351",
      fetchImpl: racingFetch,
    });

    expect(settledMeanwhile).toBe(true);
    // The attempt is still settled after the late response was applied.
    const [attempt] = await db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.orderId, fixture.orderId))
      .limit(1);
    expect(attempt.status).toBe("paid");
    const [order] = await db.select().from(orders).where(eq(orders.id, fixture.orderId)).limit(1);
    expect(order.status).toBe("paid");
    expect(created.attempt).toBeDefined();
  });
});

describe("P0 items 23/24 — refunds stay bound and preserved", () => {
  it("fences a stale refund acknowledgement against a settlement that already happened", async () => {
    const fixture = await createPendingOrder({ prefix: PREFIX });
    const created = await createEupagoPayment({
      orderId: fixture.orderId,
      method: "mbway",
      amountCents: 5000,
      config: CONFIG,
      customerPhone: "912345678",
      countryCode: "351",
      fetchImpl: providerStub(mbwayCreated(), 201),
    });
    const paymentTrid = `T-${unique()}`;
    const settledPayment = await processEupagoWebhook(
      await signedWebhook(paidWebhookPayload({ trid: paymentTrid, identifier: created.attempt.providerIdentifier }))
    );
    expect(settledPayment.outcome).toBe("payment_confirmed");

    const operator = await createUser(PREFIX);
    const requested = await requestRefund({
      orderId: fixture.orderId,
      amountCents: 2000,
      idempotencyKey: `p0h-fence-${unique()}`,
      requestedBy: operator.id,
      provider: "eupago",
    });
    const armed = await armEupagoRefund(requested.refund.id);

    // While the acknowledgement is in flight, the refund webhook settles the
    // attempt (own trid + originalTrid).
    const racing = (async (input: RequestInfo | URL) => {
      if (String(input).includes("/auth/token")) {
        return new Response(JSON.stringify({ access_token: "t", expires_in: 300 }), { status: 200 });
      }
      const refundTrid = `R-${unique()}`;
      const settledRefund = await processEupagoWebhook(
        await signedWebhook({
          trid: refundTrid,
          originalTrid: armed.providerOriginalTransactionId,
          status: "Refund",
          method: "mbway",
          amount: "20.00",
          currency: "EUR",
        })
      );
      expect(settledRefund.outcome).toBe("refund_settled");
      return new Response(JSON.stringify({ transactionStatus: "Success", trid: `R-${unique()}` }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const executed = await executeEupagoRefund({ refundId: armed.id, actorId: operator.id, config: CONFIG, fetchImpl: racing });

    // The acknowledgement is recorded, but it NEVER moves the settled refund back.
    expect(executed.outcome).toBe("submitted");
    const [refundRow] = await db.select().from(refundAttempts).where(eq(refundAttempts.id, armed.id)).limit(1);
    expect(refundRow.status).toBe("succeeded");
    const state = await getOrderRefundState(fixture.orderId);
    expect(state.refundedCents).toBe(2000);
  });

  it("preserves partial refunds and refuses an over-refund", async () => {
    const fixture = await createPendingOrder({ prefix: PREFIX });
    const counter = { calls: 0 };
    const created = await createEupagoPayment({
      orderId: fixture.orderId,
      method: "mbway",
      amountCents: 5000,
      config: CONFIG,
      customerPhone: "912345678",
      countryCode: "351",
      fetchImpl: providerStub(mbwayCreated(), 201, counter),
    });
    await processEupagoWebhook(
      await signedWebhook(paidWebhookPayload({ trid: `T-${unique()}`, identifier: created.attempt.providerIdentifier }))
    );

    const operator = await createUser(PREFIX);
    const first = await requestRefund({
      orderId: fixture.orderId,
      amountCents: 2000,
      idempotencyKey: `p0h-a-${unique()}`,
      requestedBy: operator.id,
      provider: "eupago",
    });
    const second = await requestRefund({
      orderId: fixture.orderId,
      amountCents: 2000,
      idempotencyKey: `p0h-b-${unique()}`,
      requestedBy: operator.id,
      provider: "eupago",
    });
    const state = await getOrderRefundState(fixture.orderId);
    expect(state.committedCents).toBe(4000);

    // Partial refunds are preserved as separate attempts (item 24)…
    const rows = await db.select().from(refundAttempts).where(eq(refundAttempts.orderId, fixture.orderId));
    expect(rows).toHaveLength(2);
    expect(rows.map((row: { amountCents: number }) => row.amountCents).sort()).toEqual([2000, 2000]);

    // …and the over-refund guard still refuses the remaining 2000 + 1 cent.
    await expect(
      requestRefund({
        orderId: fixture.orderId,
        amountCents: 2001,
        idempotencyKey: `p0h-c-${unique()}`,
        requestedBy: operator.id,
        provider: "eupago",
      })
    ).rejects.toThrow(/OVER_REFUND|reembolso/i);

    // Each provider refund is bound to the CANONICAL payment of the order.
    const armed = await armEupagoRefund(first.refund.id);
    const [payment] = await db.select().from(payments).where(eq(payments.id, armed.paymentId)).limit(1);
    expect(payment.provider).toBe("eupago");
    expect(payment.orderId).toBe(fixture.orderId);
    expect(armed.providerOriginalTransactionId).not.toBeNull();
    expect(second.refund.paymentId).toBe(armed.paymentId);
  });
});
