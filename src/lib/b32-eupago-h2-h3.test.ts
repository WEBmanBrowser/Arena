/**
 * PAYMENT P0 — H2 (transient non-correlation) and H3 (recovery budget) tests.
 *
 * H2 — ORDER OF ARRIVAL MUST NOT DECIDE THE OUTCOME.
 *   The create call commits the stable `identifier` BEFORE it is issued, but the
 *   provider `reference` only arrives with the create RESPONSE. A `Paid` webhook
 *   that reaches the store while that response is still in flight therefore
 *   carries a reference that is not persisted yet. It must NOT be discarded:
 *   the delivery is deferred, and the SAME authenticated delivery is evaluated
 *   again once the reference exists → settled EXACTLY ONCE.
 *
 * H3 — BUDGET.
 *   The automatic claim budget stays capped; an event that exhausts it can only
 *   be revived by a bounded, audited administrative grant, and even then the
 *   money can move only on a NEW authenticated delivery.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/db";
import {
  auditLogs,
  emailNotifications,
  orderItems,
  orderStatusHistory,
  orders,
  paymentAttempts,
  payments,
  products,
  providerWebhookEvents,
  refundAttempts,
  stockMovements,
  users,
} from "@/db/schema";
import { and, eq, inArray, like } from "drizzle-orm";
import type { EupagoConfig } from "@/lib/providers/eupago/config";
import { computeSignature } from "@/lib/providers/eupago/webhook-crypto";
import { createEupagoPayment } from "@/lib/services/eupago-payment-service";
import { processEupagoWebhook } from "@/lib/services/eupago-settlement-service";
import {
  DEFAULT_MAX_WEBHOOK_ATTEMPTS,
  MAX_RECOVERY_GRANTS,
  effectiveMaxAttempts,
  getWebhookEvent,
  isDeferredWebhookEvent,
  recoveryGrants,
} from "@/lib/providers/webhook-events";
import { POST as grantRecoveryPOST } from "@/app/api/admin/webhook-anomalies/[id]/grant-recovery/route";

const WEBHOOK_KEY = "0123456789abcdef0123456789abcdef"; // 32 bytes, dummy
const CONFIG: EupagoConfig = {
  environment: "sandbox",
  apiKey: "dummy-api-key",
  oauthClientId: "dummy-client-id",
  oauthClientSecret: "dummy-client-secret",
  webhookKey: WEBHOOK_KEY,
};

// ─── auth mock (route-level authorisation is asserted here, real RBAC lives in auth.ts) ──

const authState: { user: { id: number; role: string } | null } = { user: null };

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    getCurrentUser: async () => authState.user,
  };
});

import { vi } from "vitest";

// ─── fixtures ─────────────────────────────────────────────

let seq = 0;
function unique() {
  seq += 1;
  return `${Date.now()}${seq}${Math.floor(Math.random() * 1000)}`;
}

async function cleanup() {
  const rows = await db.select({ id: orders.id }).from(orders).where(like(orders.orderNumber, "H23-%"));
  const ids = rows.map((r) => r.id);
  if (ids.length) {
    await db.delete(refundAttempts).where(inArray(refundAttempts.orderId, ids));
    await db.delete(paymentAttempts).where(inArray(paymentAttempts.orderId, ids));
    await db.delete(payments).where(inArray(payments.orderId, ids));
    await db.delete(orderStatusHistory).where(inArray(orderStatusHistory.orderId, ids));
    await db.delete(orderItems).where(inArray(orderItems.orderId, ids));
    await db.delete(stockMovements).where(inArray(stockMovements.referenceId, ids));
    await db.delete(orders).where(inArray(orders.id, ids));
  }
  await db.delete(providerWebhookEvents);
  await db.delete(emailNotifications);
  await db.delete(auditLogs).where(like(auditLogs.action, "payment.%"));
  await db.delete(auditLogs).where(like(auditLogs.action, "order.%"));
  await db.delete(auditLogs).where(like(auditLogs.action, "webhook.%"));
  await db.delete(products).where(like(products.sku, "H23-%"));
  await db.delete(users).where(like(users.email, "h23-%@test.local"));
}

async function createAdmin() {
  const [u] = await db
    .insert(users)
    .values({ email: `h23-${unique()}@test.local`, password: "x", name: "H23", role: "admin" })
    .returning();
  return u;
}

async function createPendingOrder(totalCents = 5000) {
  const [product] = await db
    .insert(products)
    .values({
      sku: `H23-${unique()}`,
      name: "H23 Product",
      slug: `h23-${unique()}`,
      price: "50.00",
      stock: 10,
      reservedStock: 1,
    })
    .returning();

  const total = (totalCents / 100).toFixed(2);
  const [order] = await db
    .insert(orders)
    .values({
      orderNumber: `H23-${unique()}`,
      // A customer email exists so the post-commit outbox path is exercised.
      guestEmail: `cliente-${unique()}@test.local`,
      status: "pending_payment",
      paymentStatus: "pending",
      subtotal: total,
      shipping: "0.00",
      discount: "0.00",
      vat: "0.00",
      total,
      deliveryType: "pickup",
      paymentMethod: "mbway",
      reservationExpiresAt: new Date(Date.now() + 3_600_000),
    })
    .returning();

  await db.insert(orderItems).values({
    orderId: order.id,
    productId: product.id,
    productName: product.name,
    productSku: product.sku,
    quantity: 1,
    unitPriceGross: total,
    unitPriceNet: total,
    vatRate: "0.00",
    vatAmount: "0.00",
    discountAmount: "0.00",
    lineTotalGross: total,
  });

  // Manual pending payment — exactly what the bank_transfer-only checkout writes.
  await db.insert(payments).values({
    orderId: order.id,
    provider: "manual",
    method: "bank_transfer",
    amount: total,
    currency: "EUR",
    status: "pending",
  });

  return { order, product };
}

async function plainWebhook(payload: Record<string, unknown>) {
  const rawBody = JSON.stringify(payload);
  const signature = await computeSignature(WEBHOOK_KEY, rawBody);
  return { rawBody, headers: { "x-signature": signature }, webhookKey: WEBHOOK_KEY };
}

function paidPayload(overrides: Record<string, unknown>) {
  return {
    status: "Paid",
    method: "mbway",
    amount: "50.00",
    currency: "EUR",
    ...overrides,
  };
}

async function countAttempts(orderId: number) {
  const rows = await db.select({ id: paymentAttempts.id }).from(paymentAttempts).where(eq(paymentAttempts.orderId, orderId));
  return rows.length;
}

async function countPayments(orderId: number) {
  const rows = await db.select({ id: payments.id }).from(payments).where(eq(payments.orderId, orderId));
  return rows.length;
}

beforeEach(cleanup);
afterEach(cleanup);

// ─── H2 ───────────────────────────────────────────────────

describe("H2 — a webhook that arrives while the create response is in flight", () => {
  it("defers the reference-only delivery, then settles the SAME trid exactly once", async () => {
    const { order } = await createPendingOrder(5000);
    const trid = `T-${unique()}`;
    const providerReference = `REF-${unique()}`;

    let delivered: Awaited<ReturnType<typeof processEupagoWebhook>> | null = null;
    let webhookError: unknown = null;

    // The create request is in flight. The webhook arrives BEFORE the response
    // (and therefore before its reference) is persisted: this is the race H2 is
    // about. The delivery is awaited inside the "network" call so the interleaving
    // is deterministic.
    const racingFetch = (async () => {
      try {
        delivered = await processEupagoWebhook(
          await plainWebhook(paidPayload({ trid, reference: providerReference, identifier: null }))
        );
      } catch (error) {
        webhookError = error;
      }
      return new Response(
        JSON.stringify({ transactionStatus: "Success", transactionID: `TX-${unique()}`, reference: providerReference }),
        { status: 201, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const created = await createEupagoPayment({
      orderId: order.id,
      method: "mbway",
      amountCents: 5000,
      config: CONFIG,
      customerPhone: "912345678",
      countryCode: "351",
      fetchImpl: racingFetch,
    });

    expect(webhookError).toBeNull();
    expect(created.outcome).toBe("created");

    // 1. The early delivery is NOT lost and NOT ignored: deferred with a reason.
    expect(delivered).not.toBeNull();
    expect(delivered!.outcome).toBe("deferred");
    expect(delivered!.code).toBe("DEFERRED_REFERENCE_NOT_YET_PERSISTED");

    const [deferredRow] = await db
      .select()
      .from(providerWebhookEvents)
      .where(eq(providerWebhookEvents.providerEventId, trid))
      .limit(1);
    expect(deferredRow).toBeDefined();
    // Parked in the re-evaluable state (never terminal `ignored`), with the
    // reason recorded — and the deferral consumed one unit of the H3 budget.
    expect(deferredRow.status).toBe("pending");
    expect(deferredRow.lastError).toBe("DEFERRED_REFERENCE_NOT_YET_PERSISTED");
    expect(deferredRow.attempts).toBe(1);
    // `isDeferredWebhookEvent` means "deferred AND out of budget": still false
    // here, because this event has budget left.
    expect(isDeferredWebhookEvent(deferredRow)).toBe(false);

    // 2. The create RESPONSE persisted the reference (no downgrade of anything).
    const [attemptAfterCreate] = await db.select().from(paymentAttempts).where(eq(paymentAttempts.orderId, order.id)).limit(1);
    expect(attemptAfterCreate.providerReference).toBe(providerReference);
    expect(attemptAfterCreate.status).toBe("pending"); // creation ≠ settlement

    // 3. The provider redelivers the SAME authenticated trid → settles ONCE.
    const settled = await processEupagoWebhook(
      await plainWebhook(paidPayload({ trid, reference: providerReference, identifier: null }))
    );
    expect(settled.outcome).toBe("payment_confirmed");

    // 4. Exactly once: one attempt, one settled payment, one order transition,
    //    one email notification, one processed ledger row.
    expect(await countAttempts(order.id)).toBe(1);
    const paymentRows = await db.select().from(payments).where(eq(payments.orderId, order.id));
    expect(paymentRows).toHaveLength(2); // manual placeholder + canonical Eupago payment
    expect(paymentRows.filter((row) => row.status === "paid")).toHaveLength(1);
    expect(paymentRows.find((row) => row.provider === "eupago")?.metadata).toMatchObject({
      eupagoEnvironment: "sandbox",
    });

    const [finalOrder] = await db.select().from(orders).where(eq(orders.id, order.id)).limit(1);
    expect(finalOrder.status).toBe("paid");

    const notifications = await db
      .select()
      .from(emailNotifications)
      .where(and(eq(emailNotifications.referenceType, "order"), eq(emailNotifications.referenceId, order.id)));
    expect(notifications).toHaveLength(1);

    const [finalEvent] = await db
      .select()
      .from(providerWebhookEvents)
      .where(eq(providerWebhookEvents.providerEventId, trid))
      .limit(1);
    expect(finalEvent.status).toBe("processed");
    expect(finalEvent.attempts).toBe(2); // the deferral AND the settlement are both accounted for

    // 5. A THIRD delivery of the same trid is a duplicate with no side effects.
    const third = await processEupagoWebhook(
      await plainWebhook(paidPayload({ trid, reference: providerReference, identifier: null }))
    );
    expect(third.outcome).toBe("duplicate");
    expect(await countAttempts(order.id)).toBe(1);
    expect(await db.select().from(emailNotifications).where(and(eq(emailNotifications.referenceType, "order"), eq(emailNotifications.referenceId, order.id)))).toHaveLength(1);
    expect(await db.select().from(payments).where(eq(payments.orderId, order.id))).toHaveLength(2);
  });

  it("stays fail-closed when a definitive divergence is detected (no payment, no attempt)", async () => {
    const { order } = await createPendingOrder(5000);
    const created = await createEupagoPayment({
      orderId: order.id,
      method: "mbway",
      amountCents: 5000,
      config: CONFIG,
      customerPhone: "912345678",
      countryCode: "351",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ transactionStatus: "Success", transactionID: `TX-${unique()}`, reference: `REF-${unique()}` }), {
          status: 201,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });
    expect(created.outcome).toBe("created");
    const attemptsBefore = await countAttempts(order.id);
    const paymentsBefore = await countPayments(order.id);

    // Same identifier, DIFFERENT amount → definitive divergence.
    const divergent = await processEupagoWebhook(
      await plainWebhook(
        paidPayload({
          trid: `T-${unique()}`,
          identifier: created.attempt.providerIdentifier,
          amount: "49.99",
        })
      )
    );

    expect(divergent.outcome).toBe("mismatch");
    expect(divergent.code).toBe("AMOUNT_MISMATCH");

    const [attemptAfter] = await db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.id, created.attempt.id))
      .limit(1);
    expect(attemptAfter.status).toBe("pending"); // never confirmed
    expect(await countAttempts(order.id)).toBe(attemptsBefore); // nothing created
    expect(await countPayments(order.id)).toBe(paymentsBefore);
    const [orderAfter] = await db.select().from(orders).where(eq(orders.id, order.id)).limit(1);
    expect(orderAfter.status).toBe("pending_payment");
  });
});

// ─── H3 ───────────────────────────────────────────────────

describe("H3 — capped budget + restricted administrative recovery", () => {
  async function deliverUncorrelatableTrid(trid: string) {
    return processEupagoWebhook(
      await plainWebhook(paidPayload({ trid, reference: `REF-${unique()}`, identifier: null }))
    );
  }

  it("caps the automatic budget and requires an explicit grant afterwards", async () => {
    const trid = `T-${unique()}`;

    // The budget is consumed by repeated deliveries of the same unpersisted
    // reference: each one is deferred (never ignored) while budget remains.
    for (let i = 0; i < DEFAULT_MAX_WEBHOOK_ATTEMPTS; i += 1) {
      const result = await deliverUncorrelatableTrid(trid);
      expect(result.outcome).toBe("deferred");
    }

    const exhausted = await db
      .select()
      .from(providerWebhookEvents)
      .where(eq(providerWebhookEvents.providerEventId, trid))
      .limit(1);
    expect(exhausted[0].attempts).toBe(DEFAULT_MAX_WEBHOOK_ATTEMPTS);
    expect(recoveryGrants(exhausted[0])).toBe(0);

    // Once the cap is reached the delivery can no longer claim the event…
    const overBudget = await processEupagoWebhook(
      await plainWebhook(paidPayload({ trid, reference: `REF-${unique()}`, identifier: null }))
    );
    expect(overBudget.outcome).toBe("deferred");
    expect(overBudget.code).toBe("CLAIM_BUDGET_EXHAUSTED");

    // …unless an administrator grants a further bounded window.
    const admin = await createAdmin();
    authState.user = { id: admin.id, role: "admin" };

    const request = new NextRequest(`http://loja.mdtech.pt/api/admin/webhook-anomalies/${exhausted[0].id}/grant-recovery`, {
      method: "POST",
      headers: { origin: "http://loja.mdtech.pt", host: "loja.mdtech.pt" },
      body: "{}",
    });
    const response = await grantRecoveryPOST(request, { params: Promise.resolve({ id: String(exhausted[0].id) }) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ outcome: "granted", grants: 1, nextStep: "NEW_AUTHENTICATED_DELIVERY_REQUIRED" });

    // The grant is audited…
    const grants = await db.select().from(auditLogs).where(eq(auditLogs.action, "webhook.recovery_budget_granted"));
    expect(grants).toHaveLength(1);

    // …and it only extends the budget: it never settles, never creates a
    // payment or an attempt, never fabricates a payload.
    const paymentsBefore = await db.select({ id: payments.id }).from(payments);
    const attemptsBefore = await db.select({ id: paymentAttempts.id }).from(paymentAttempts);
    const afterGrant = await getWebhookEvent(exhausted[0].id);
    expect(afterGrant?.status).not.toBe("processed");
    expect(effectiveMaxAttempts({ extraGrantedAttempts: recoveryGrants(afterGrant!) })).toBe(
      DEFAULT_MAX_WEBHOOK_ATTEMPTS * 2
    );
    expect(await db.select({ id: payments.id }).from(payments)).toHaveLength(paymentsBefore.length);
    expect(await db.select({ id: paymentAttempts.id }).from(paymentAttempts)).toHaveLength(attemptsBefore.length);
  });

  it("never touches a processed event and never grants twice beyond the ceiling", async () => {
    const trid = `T-${unique()}`;
    for (let i = 0; i < DEFAULT_MAX_WEBHOOK_ATTEMPTS; i += 1) {
      await deliverUncorrelatableTrid(trid);
    }
    const [event] = await db
      .select()
      .from(providerWebhookEvents)
      .where(eq(providerWebhookEvents.providerEventId, trid))
      .limit(1);

    const admin = await createAdmin();
    authState.user = { id: admin.id, role: "admin" };

    const grant = () =>
      grantRecoveryPOST(
        new NextRequest(`http://loja.mdtech.pt/api/admin/webhook-anomalies/${event.id}/grant-recovery`, {
          method: "POST",
          headers: { origin: "http://loja.mdtech.pt", host: "loja.mdtech.pt" },
          body: "{}",
        }),
        { params: Promise.resolve({ id: String(event.id) }) }
      );

    expect((await grant()).status).toBe(200); // 1st grant
    expect((await grant()).status).toBe(200); // 2nd grant (ceiling)
    const third = await grant(); //            → refused
    expect(third.status).toBe(409);
    expect((await third.json()).code).toBe("GRANT_LIMIT_REACHED");

    // Mark it processed through the real settlement path of another event and
    // verify a processed event can never receive a grant.
    const { order } = await createPendingOrder(5000);
    const created = await createEupagoPayment({
      orderId: order.id,
      method: "mbway",
      amountCents: 5000,
      config: CONFIG,
      customerPhone: "912345678",
      countryCode: "351",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ transactionStatus: "Success", transactionID: `TX-${unique()}`, reference: `REF-${unique()}` }), {
          status: 201,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });
    const settledTrid = `T-${unique()}`;
    const settled = await processEupagoWebhook(
      await plainWebhook(paidPayload({ trid: settledTrid, identifier: created.attempt.providerIdentifier }))
    );
    expect(settled.outcome).toBe("payment_confirmed");

    const [processed] = await db
      .select()
      .from(providerWebhookEvents)
      .where(eq(providerWebhookEvents.providerEventId, settledTrid))
      .limit(1);
    const refused = await grantRecoveryPOST(
      new NextRequest(`http://loja.mdtech.pt/api/admin/webhook-anomalies/${processed.id}/grant-recovery`, {
        method: "POST",
        headers: { origin: "http://loja.mdtech.pt", host: "loja.mdtech.pt" },
        body: "{}",
      }),
      { params: Promise.resolve({ id: String(processed.id) }) }
    );
    expect(refused.status).toBe(409);
    expect((await refused.json()).code).toBe("WRONG_STATUS");
    // The processed event keeps its settlement.
    const [stillProcessed] = await db
      .select()
      .from(providerWebhookEvents)
      .where(eq(providerWebhookEvents.id, processed.id))
      .limit(1);
    expect(stillProcessed.status).toBe("processed");
  });

  it("enforces authorisation on the administrative recovery route", async () => {
    const trid = `T-${unique()}`;
    for (let i = 0; i < DEFAULT_MAX_WEBHOOK_ATTEMPTS; i += 1) await deliverUncorrelatableTrid(trid);
    const [event] = await db
      .select()
      .from(providerWebhookEvents)
      .where(eq(providerWebhookEvents.providerEventId, trid))
      .limit(1);

    const call = () =>
      grantRecoveryPOST(
        new NextRequest(`http://loja.mdtech.pt/api/admin/webhook-anomalies/${event.id}/grant-recovery`, {
          method: "POST",
          headers: { origin: "http://loja.mdtech.pt", host: "loja.mdtech.pt" },
          body: "{}",
        }),
        { params: Promise.resolve({ id: String(event.id) }) }
      );

    authState.user = null;
    expect((await call()).status).toBe(401);

    const [customer] = await db
      .insert(users)
      .values({ email: `h23-${unique()}@test.local`, password: "x", name: "Cliente", role: "customer" })
      .returning();
    authState.user = { id: customer.id, role: "customer" };
    expect((await call()).status).toBe(403);

    // A manager (not admin) IS allowed: this is an operational, bounded action.
    const [manager] = await db
      .insert(users)
      .values({ email: `h23-${unique()}@test.local`, password: "x", name: "Gestor", role: "manager" })
      .returning();
    authState.user = { id: manager.id, role: "manager" };
    expect((await call()).status).toBe(200);

    // Cross-origin mutation is refused by the CSRF guard, even for an admin.
    const [admin] = await db
      .insert(users)
      .values({ email: `h23-${unique()}@test.local`, password: "x", name: "Admin", role: "admin" })
      .returning();
    authState.user = { id: admin.id, role: "admin" };
    const crossOrigin = await grantRecoveryPOST(
      new NextRequest(`http://loja.mdtech.pt/api/admin/webhook-anomalies/${event.id}/grant-recovery`, {
        method: "POST",
        headers: { origin: "http://evil.example", host: "loja.mdtech.pt" },
        body: "{}",
      }),
      { params: Promise.resolve({ id: String(event.id) }) }
    );
    expect(crossOrigin.status).toBeGreaterThanOrEqual(400);

    // MAX_RECOVERY_GRANTS is the documented ceiling.
    expect(MAX_RECOVERY_GRANTS).toBe(2);
  });
});
