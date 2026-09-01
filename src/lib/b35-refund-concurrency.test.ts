import { afterEach, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { db } from "@/db";
import {
  auditLogs,
  orderItems,
  orderStatusHistory,
  orders,
  payments,
  refundAttempts,
  users,
} from "@/db/schema";
import { inArray, like } from "drizzle-orm";
import { getOrderRefundState, requestRefund } from "@/lib/refunds";

/**
 * B.3.5 — REAL PostgreSQL concurrency tests.
 *
 * The over-refund invariant is exercised with genuinely parallel
 * transactions (separate pool connections) and, for the raw database guard,
 * with two independent SQL clients bypassing the application layer.
 */

const DB_URL = process.env.DATABASE_URL || "";

async function cleanupB35C() {
  const rows = await db.select({ id: orders.id }).from(orders).where(like(orders.orderNumber, "B35C-%"));
  const orderIds = rows.map((o) => o.id);
  if (orderIds.length) {
    await db.delete(refundAttempts).where(inArray(refundAttempts.orderId, orderIds));
    await db.delete(payments).where(inArray(payments.orderId, orderIds));
    await db.delete(orderStatusHistory).where(inArray(orderStatusHistory.orderId, orderIds));
    await db.delete(orderItems).where(inArray(orderItems.orderId, orderIds));
    await db.delete(orders).where(inArray(orders.id, orderIds));
  }
  await db.delete(auditLogs).where(like(auditLogs.action, "refund.%"));
  await db.delete(users).where(like(users.email, "b35c-%@test.local"));
}

async function createUser() {
  const [u] = await db
    .insert(users)
    .values({
      email: `b35c-admin-${Date.now()}-${Math.floor(Math.random() * 1e9)}@test.local`,
      password: "x",
      name: "B35C Admin",
      role: "admin",
    })
    .returning();
  return u;
}

async function createPaidOrder(total = "100.00") {
  const [order] = await db
    .insert(orders)
    .values({
      orderNumber: `B35C-ORD-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
      status: "paid",
      paymentStatus: "paid",
      subtotal: total,
      shipping: "0.00",
      total,
      deliveryType: "shipping",
      paymentMethod: "bank_transfer",
    })
    .returning();
  const [payment] = await db
    .insert(payments)
    .values({
      orderId: order.id,
      provider: "manual",
      method: "bank_transfer",
      amount: total,
      currency: "EUR",
      status: "paid",
      paidAt: new Date(),
    })
    .returning();
  return { order, payment };
}

function key() {
  return `b35c-key-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

/** Run the given factories in GENUINE parallel (Promise.all — no awaiting between). */
async function race<T>(factories: Array<() => Promise<T>>): Promise<Array<{ ok: true; value: T } | { ok: false; error: unknown }>> {
  return Promise.all(
    factories.map(async (f) => {
      try {
        return { ok: true as const, value: await f() };
      } catch (e) {
        return { ok: false as const, error: e };
      }
    })
  );
}

beforeEach(async () => {
  await cleanupB35C();
});
afterEach(async () => {
  await cleanupB35C();
});

describe("B.3.5 refund concurrency (application layer)", () => {
  it("concurrent DIFFERENT refunds cannot jointly over-refund (100€: 60€ + 50€)", async () => {
    const user = await createUser();
    const { order } = await createPaidOrder("100.00");

    const results = await race([
      () => requestRefund({ orderId: order.id, amountCents: 6000, idempotencyKey: key(), requestedBy: user.id }),
      () => requestRefund({ orderId: order.id, amountCents: 5000, idempotencyKey: key(), requestedBy: user.id }),
    ]);

    const succeeded = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);
    expect(succeeded.length + failed.length).toBe(2);

    const state = await getOrderRefundState(order.id);
    // THE invariant: committed refunds may never exceed the paid amount.
    expect(state.committedCents).toBeLessThanOrEqual(10000);
    expect(state.committedCents).toBe(6000); // exactly one refund committed (60€ blocks 50€)
    expect(succeeded.length).toBe(1);
    expect(failed.length).toBe(1);
    expect((failed[0].error as { code?: string }).code).toBe("REFUND_EXCEEDS_REFUNDABLE");
  });

  it("in-flight committed refund protects against a later over-refund", async () => {
    const user = await createUser();
    const { order } = await createPaidOrder("100.00");

    // 60€ pending (committed, NOT yet succeeded)
    await requestRefund({ orderId: order.id, amountCents: 6000, idempotencyKey: key(), requestedBy: user.id });
    const state = await getOrderRefundState(order.id);
    expect(state.refundedCents).toBe(0);
    expect(state.committedCents).toBe(6000);
    expect(state.remainingRefundableCents).toBe(4000);

    // 50€ must now be rejected even though NOTHING has been refunded yet
    await expect(
      requestRefund({ orderId: order.id, amountCents: 5000, idempotencyKey: key(), requestedBy: user.id })
    ).rejects.toMatchObject({ code: "REFUND_EXCEEDS_REFUNDABLE" });

    // 40€ fits exactly
    const ok = await requestRefund({ orderId: order.id, amountCents: 4000, idempotencyKey: key(), requestedBy: user.id });
    expect(ok.refund.status).toBe("pending");
  });

  it("concurrent DUPLICATE idempotency requests create exactly one refund", async () => {
    const user = await createUser();
    const { order } = await createPaidOrder("100.00");
    const idem = key();

    const results = await race([
      () => requestRefund({ orderId: order.id, amountCents: 2500, idempotencyKey: idem, requestedBy: user.id }),
      () => requestRefund({ orderId: order.id, amountCents: 2500, idempotencyKey: idem, requestedBy: user.id }),
      () => requestRefund({ orderId: order.id, amountCents: 2500, idempotencyKey: idem, requestedBy: user.id }),
    ]);

    const created = results.filter((r) => r.ok && r.value.created);
    const replays = results.filter((r) => r.ok && !r.value.created);
    expect(created.length).toBe(1);
    expect(replays.length).toBe(2);

    const ids = new Set(results.filter((r) => r.ok).map((r) => r.value.refund.id));
    expect(ids.size).toBe(1);

    const rows = await db.select().from(refundAttempts).where(inArray(refundAttempts.orderId, [order.id]));
    expect(rows.length).toBe(1);
  });

  it("many concurrent partial refunds never exceed the paid amount", async () => {
    const user = await createUser();
    const { order } = await createPaidOrder("100.00");

    // 10 × 20€ racing against a 100€ paid amount → at most 5 can commit.
    const results = await race(
      Array.from({ length: 10 }, () =>
        () => requestRefund({ orderId: order.id, amountCents: 2000, idempotencyKey: key(), requestedBy: user.id })
      )
    );

    const state = await getOrderRefundState(order.id);
    expect(state.committedCents).toBeLessThanOrEqual(10000);
    expect(state.committedCents % 2000).toBe(0);
    expect(results.filter((r) => r.ok).length).toBe(5);
    expect(results.filter((r) => !r.ok).length).toBe(5);
  });
});

describe("B.3.5 database-level over-refund guard (trigger)", () => {
  it("two raw concurrent inserts bypassing the app cannot over-refund", async () => {
    const user = await createUser();
    const { order, payment } = await createPaidOrder("100.00");

    const clientA = new pg.Client({ connectionString: DB_URL });
    const clientB = new pg.Client({ connectionString: DB_URL });
    await clientA.connect();
    await clientB.connect();

    const rawInsert = async (c: pg.Client, k: string, amount: number, delayMs: number) => {
      await c.query("BEGIN");
      try {
        if (delayMs > 0) await c.query("SELECT pg_sleep($1)", [delayMs / 1000]);
        await c.query(
          `INSERT INTO refund_attempts
             (order_id, payment_id, provider, idempotency_key, amount_cents, currency, status, requested_by)
           VALUES ($1, $2, 'manual', $3, $4, 'EUR', 'pending', $5)`,
          [order.id, payment.id, k, amount, user.id]
        );
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK").catch(() => {});
        throw e;
      }
    };

    // 60€ + 60€ racing on a 100€ payment → the DB trigger must reject one.
    const [a, b] = await Promise.allSettled([
      rawInsert(clientA, key(), 6000, 0),
      rawInsert(clientB, key(), 6000, 15),
    ]);

    const rows = await db.select().from(refundAttempts).where(inArray(refundAttempts.orderId, [order.id]));
    expect(rows.length).toBe(1);
    expect(rows[0].amountCents).toBe(6000);

    const failedSide = a.status === "rejected" ? a : b;
    expect(failedSide.status).toBe("rejected");
    expect(String((failedSide as PromiseRejectedResult).reason)).toContain("REFUND_EXCEEDS_REFUNDABLE_AMOUNT");

    await clientA.end().catch(() => {});
    await clientB.end().catch(() => {});
  });

  it("trigger rejects insert above paid amount even single-threaded, and enforces currency", async () => {
    const user = await createUser();
    const { order, payment } = await createPaidOrder("50.00");

    const client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    const insert = (k: string, amount: number, currency: string) =>
      client.query(
        `INSERT INTO refund_attempts
           (order_id, payment_id, provider, idempotency_key, amount_cents, currency, status, requested_by)
         VALUES ($1, $2, 'manual', $3, $4, $5, 'pending', $6)`,
        [order.id, payment.id, k, amount, currency, user.id]
      );

    await expect(insert(key(), 5001, "EUR")).rejects.toThrow(/REFUND_EXCEEDS_REFUNDABLE_AMOUNT/);
    await expect(insert(key(), 100, "USD")).rejects.toThrow(/REFUND_CURRENCY_MISMATCH/);
    await expect(insert(key(), 5000, "EUR")).resolves.toBeTruthy(); // exact amount is allowed
    await client.end();
  });
});
