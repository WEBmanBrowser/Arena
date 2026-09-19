/**
 * PAYMENT P0 — H2 (transient non-correlation) and H3 (webhook recovery budget).
 *
 * H2: a `Paid` delivery can legitimately arrive BEFORE the create response has
 *     persisted the provider reference. That delivery must be DEFERRED (never
 *     terminally ignored) and re-evaluate on redelivery — settling exactly once.
 *
 * H3: the automatic processing budget stays capped; the only way to extend it is
 *     a restricted, audited administrative grant that changes NOTHING
 *     financially and still requires a new authenticated delivery.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/db";
import {
  auditLogs,
  emailNotifications,
  orders,
  paymentAttempts,
  payments,
  providerWebhookEvents,
} from "@/db/schema";
import { and, eq } from "drizzle-orm";
import type { EupagoConfig } from "@/lib/providers/eupago/config";
import {
  DEFAULT_MAX_WEBHOOK_ATTEMPTS,
  effectiveMaxAttempts,
  getWebhookEvent,
  grantWebhookRecoveryBudget,
  isDeferredWebhookEvent,
  MAX_RECOVERY_GRANTS,
  recoveryGrants,
} from "@/lib/providers/webhook-events";
import { createEupagoPayment } from "@/lib/services/eupago-payment-service";
import { processEupagoWebhook } from "@/lib/services/eupago-settlement-service";
import { POST as grantRecoveryPOST } from "@/app/api/admin/webhook-anomalies/[id]/grant-recovery/route";
import {
  cleanupByPrefix,
  resetEupagoLedgerSlice,
  createPendingOrder,
  createUser,
  signedWebhook,
  TEST_WEBHOOK_KEY,
  unique,
} from "@/test-support/fixtures";

const PREFIX = "P0H2";
const CONFIG: EupagoConfig = {
  environment: "sandbox",
  apiKey: "dummy-api-key",
  oauthClientId: "dummy-client-id",
  oauthClientSecret: "dummy-client-secret",
  webhookKey: TEST_WEBHOOK_KEY,
};

const authState: { user: { id: number; role: string } | null } = { user: null };
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getCurrentUser: async () => authState.user };
});

function paidPayload(overrides: Record<string, unknown> = {}) {
  return { status: "Paid", method: "mbway", amount: "50.00", currency: "EUR", ...overrides };
}

async function orderRow(orderId: number) {
  const [row] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  return row;
}

async function paidPayments(orderId: number) {
  const rows = await db.select().from(payments).where(eq(payments.orderId, orderId));
  return rows.filter((row) => row.status === "paid");
}

beforeEach(async () => {
  await cleanupByPrefix(PREFIX);
  await resetEupagoLedgerSlice();
  authState.user = null;
});
afterEach(async () => {
  await cleanupByPrefix(PREFIX);
});

describe("H2 — a delivery that arrives before the reference is persisted", () => {
  it("defers the early delivery and settles the SAME trid exactly once on redelivery", async () => {
    const fixture = await createPendingOrder({ prefix: PREFIX });
    const trid = `T-${unique()}`;
    const reference = `REF-${unique()}`;
    let providerCalls = 0;
    let earlyDelivery: Awaited<ReturnType<typeof processEupagoWebhook>> | null = null;

    // The provider answer is produced AFTER the webhook has been delivered: this
    // is the real-world race (the reference only exists in the create RESPONSE).
    const racingFetch = (async () => {
      providerCalls += 1;
      earlyDelivery = await processEupagoWebhook(
        await signedWebhook(paidPayload({ trid, reference }))
      );
      return new Response(JSON.stringify({ transactionStatus: "Success", transactionID: `TX-${unique()}`, reference }), {
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
    expect(created.outcome).toBe("created");
    expect(providerCalls).toBe(1);

    // The early delivery is deferred — NOT ignored, NOT processed.
    expect(earlyDelivery).not.toBeNull();
    expect(earlyDelivery!.outcome).toBe("deferred");
    expect(String(earlyDelivery!.code)).toContain("DEFERRED_REFERENCE_NOT_YET_PERSISTED");

    const [pending] = await db
      .select()
      .from(providerWebhookEvents)
      .where(eq(providerWebhookEvents.providerEventId, trid))
      .limit(1);
    expect(pending.status).toBe("pending");
    expect(isDeferredWebhookEvent(pending)).toBe(false); // still has budget left
    expect(await orderRow(fixture.orderId)).toMatchObject({ status: "pending_payment" });
    expect(await paidPayments(fixture.orderId)).toHaveLength(0);

    // The create response has now persisted the reference.
    const [attempt] = await db.select().from(paymentAttempts).where(eq(paymentAttempts.orderId, fixture.orderId)).limit(1);
    expect(attempt.providerReference).toBe(reference);

    // The provider redelivers the SAME trid: this time it correlates.
    const settled = await processEupagoWebhook(await signedWebhook(paidPayload({ trid, reference })));
    expect(settled.outcome).toBe("payment_confirmed");

    // EXACTLY ONCE: one paid payment, one order transition, one notification.
    expect(await paidPayments(fixture.orderId)).toHaveLength(1);
    expect((await orderRow(fixture.orderId)).status).toBe("paid");
    const notifications = await db
      .select()
      .from(emailNotifications)
      .where(and(eq(emailNotifications.referenceType, "order"), eq(emailNotifications.referenceId, fixture.orderId)));
    expect(notifications).toHaveLength(1);

    // …and the webhook never issued a provider call (only the create did) and
    // never created an extra attempt.
    expect(providerCalls).toBe(1);
    expect(await db.select().from(paymentAttempts).where(eq(paymentAttempts.orderId, fixture.orderId))).toHaveLength(1);

    // A further redelivery is a pure duplicate.
    const replay = await processEupagoWebhook(await signedWebhook(paidPayload({ trid, reference })));
    expect(replay.outcome).toBe("duplicate");
    expect(await paidPayments(fixture.orderId)).toHaveLength(1);
  });

  it("still treats an unmatched IDENTIFIER as a definitive divergence", async () => {
    const fixture = await createPendingOrder({ prefix: PREFIX });
    const result = await processEupagoWebhook(
      await signedWebhook(paidPayload({ trid: `T-${unique()}`, identifier: `ID-${unique()}` }))
    );
    expect(result.outcome).toBe("mismatch");
    expect(result.code).toBe("ATTEMPT_NOT_FOUND");
    expect((await orderRow(fixture.orderId)).status).toBe("pending_payment");
  });
});

describe("H3 — capped budget and audited administrative recovery", () => {
  async function exhaustBudget(): Promise<{ eventId: number; trid: string }> {
    const trid = `T-${unique()}`;
    for (let index = 0; index < DEFAULT_MAX_WEBHOOK_ATTEMPTS; index += 1) {
      const result = await processEupagoWebhook(
        await signedWebhook(paidPayload({ trid, reference: `REF-${unique()}` }))
      );
      expect(result.outcome).toBe("deferred");
    }
    const [event] = await db
      .select()
      .from(providerWebhookEvents)
      .where(eq(providerWebhookEvents.providerEventId, trid))
      .limit(1);
    expect(event.attempts).toBe(DEFAULT_MAX_WEBHOOK_ATTEMPTS);
    expect(isDeferredWebhookEvent(event)).toBe(true);
    return { eventId: event.id, trid };
  }

  it("stops claiming after the cap and resumes only after a grant", async () => {
    const { eventId, trid } = await exhaustBudget();

    // 6th delivery: refused by the budget, nothing changes.
    const exhausted = await processEupagoWebhook(await signedWebhook(paidPayload({ trid, reference: `REF-${unique()}` })));
    expect(exhausted.outcome).toBe("deferred");
    expect(exhausted.code).toBe("CLAIM_BUDGET_EXHAUSTED");

    const granted = await grantWebhookRecoveryBudget({ eventId });
    expect(granted.outcome).toBe("granted");
    if (granted.outcome !== "granted") return;
    expect(granted.grants).toBe(1);
    expect(recoveryGrants(granted.event)).toBe(1);
    expect(effectiveMaxAttempts({ extraGrantedAttempts: 1 })).toBe(DEFAULT_MAX_WEBHOOK_ATTEMPTS * 2);

    // A NEW authenticated delivery can be claimed again… and settles nothing by
    // itself (the reference still matches no local attempt → deferred again).
    const afterGrant = await processEupagoWebhook(await signedWebhook(paidPayload({ trid, reference: `REF-${unique()}` })));
    expect(afterGrant.outcome).toBe("deferred");
    expect(afterGrant.code).toContain("DEFERRED");
    const [event] = await db.select().from(providerWebhookEvents).where(eq(providerWebhookEvents.id, eventId)).limit(1);
    expect(event.attempts).toBe(DEFAULT_MAX_WEBHOOK_ATTEMPTS + 1);
    expect(event.status).toBe("pending");
  });

  it("caps the number of grants", async () => {
    const { eventId } = await exhaustBudget();
    expect((await grantWebhookRecoveryBudget({ eventId })).outcome).toBe("granted");
    expect((await grantWebhookRecoveryBudget({ eventId })).outcome).toBe("granted");
    const third = await grantWebhookRecoveryBudget({ eventId });
    expect(third.outcome).toBe("rejected");
    if (third.outcome !== "rejected") return;
    expect(third.code).toBe("GRANT_LIMIT_REACHED");
    expect(MAX_RECOVERY_GRANTS).toBe(2);
  });

  it("never grants to a processed event and never touches its settlement", async () => {
    const fixture = await createPendingOrder({ prefix: PREFIX });
    const created = await createEupagoPayment({
      orderId: fixture.orderId,
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
    const trid = `T-${unique()}`;
    const settled = await processEupagoWebhook(
      await signedWebhook(paidPayload({ trid, identifier: created.attempt.providerIdentifier }))
    );
    expect(settled.outcome).toBe("payment_confirmed");

    const [event] = await db
      .select()
      .from(providerWebhookEvents)
      .where(eq(providerWebhookEvents.providerEventId, trid))
      .limit(1);
    const refused = await grantWebhookRecoveryBudget({ eventId: event.id });
    expect(refused.outcome).toBe("rejected");
    if (refused.outcome !== "rejected") return;
    expect(refused.code).toBe("ALREADY_PROCESSED");

    const [after] = await db.select().from(providerWebhookEvents).where(eq(providerWebhookEvents.id, event.id)).limit(1);
    expect(after.status).toBe("processed");
    expect(recoveryGrants(after)).toBe(0);
    expect((await orderRow(fixture.orderId)).status).toBe("paid");
  });

  it("exposes the grant only through a restricted, CSRF-protected, audited route", async () => {
    const { eventId } = await exhaustBudget();
    const event = await getWebhookEvent(eventId);
    expect(event).not.toBeNull();

    const call = (origin = "http://loja.mdtech.pt") =>
      grantRecoveryPOST(
        new NextRequest(`http://loja.mdtech.pt/api/admin/webhook-anomalies/${eventId}/grant-recovery`, {
          method: "POST",
          headers: { origin, host: "loja.mdtech.pt" },
          body: "{}",
        }),
        { params: Promise.resolve({ id: String(eventId) }) }
      );

    // Unauthenticated → 401. Non-privileged → 403. Cross-origin → refused.
    authState.user = null;
    expect((await call()).status).toBe(401);

    const customer = await createUser(PREFIX, "customer");
    authState.user = { id: customer.id, role: "customer" };
    expect((await call()).status).toBe(403);

    const manager = await createUser(PREFIX, "manager");
    authState.user = { id: manager.id, role: "manager" };
    expect((await call("http://evil.example")).status).toBeGreaterThanOrEqual(400);

    // The concession is granted, audited, and explicitly demands a NEW delivery.
    const paymentsBefore = await db.select({ id: payments.id }).from(payments);
    const attemptsBefore = await db.select({ id: paymentAttempts.id }).from(paymentAttempts);
    const granted = await call();
    expect(granted.status).toBe(200);
    const body = await granted.json();
    expect(body).toMatchObject({ outcome: "granted", grants: 1, nextStep: "NEW_AUTHENTICATED_DELIVERY_REQUIRED" });

    const audits = await db.select().from(auditLogs).where(eq(auditLogs.action, "webhook.recovery_budget_granted"));
    expect(audits).toHaveLength(1);
    expect(audits[0].entityId).toBe(eventId);

    // The grant created nothing: no payment, no attempt, no provider traffic.
    expect(await db.select({ id: payments.id }).from(payments)).toHaveLength(paymentsBefore.length);
    expect(await db.select({ id: paymentAttempts.id }).from(paymentAttempts)).toHaveLength(attemptsBefore.length);
    const [afterGrant] = await db.select().from(providerWebhookEvents).where(eq(providerWebhookEvents.id, eventId)).limit(1);
    expect(afterGrant.status).not.toBe("processed");
  });
});
