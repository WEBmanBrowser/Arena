/**
 * PAYMENT P0 (CYCLE 3) — C2 and C3.
 *
 * C2 — CONTRACT-INDEPENDENT FAIL-CLOSED SEMANTICS.
 *   The `trid` is the delivery identity. When a delivery that ALREADY CONCLUDED
 *   (`processed` / `anomaly`) is redelivered with an authenticated payload that
 *   differs in a PERSISTED field (status/kind, amount, currency, method, original
 *   trid), the two statements are not interchangeable. The delivery is escalated
 *   to `anomaly` with `PROVIDER_EVENT_CONFLICT` — never answered as a plain
 *   `duplicate`, and never re-settled. This behaviour does NOT depend on any
 *   unverified Eupago guarantee (see the open contract questions in
 *   `docs/integrations/eupago-p0-rollout.md`): if Eupago reuses a `trid`, the
 *   divergence is recorded instead of being silently accepted; if it never does,
 *   this path is simply never exercised.
 *
 * C3 — AN AUTHENTICATED MOVEMENT THAT CLAIMS MONEY CANNOT VANISH.
 *   Amount / currency / method / identifier / reference contradictions on a
 *   `Paid` movement, and refund callbacks that cannot be correlated, produce a
 *   durable, auditable reconciliation anomaly bound to the local candidate. No
 *   confirmation, no stock change, no refund, never `processed`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
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
  refundAttempts,
  stockMovements,
} from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";
import type { EupagoConfig } from "@/lib/providers/eupago/config";
import { createEupagoPayment } from "@/lib/services/eupago-payment-service";
import { processEupagoWebhook } from "@/lib/services/eupago-settlement-service";
import { POST as webhookPOST } from "@/app/api/webhooks/eupago/route";
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

const PREFIX = "P0C3B";

const CONFIG: EupagoConfig = {
  environment: "sandbox",
  apiKey: "dummy-api-key",
  oauthClientId: "dummy-client-id",
  oauthClientSecret: "dummy-client-secret",
  webhookKey: TEST_WEBHOOK_KEY,
};

async function createAttempt(orderId: number, method: "mbway" | "multibanco" = "mbway") {
  const providerResponse =
    method === "multibanco"
      ? { sucesso: true, estado: 0, referencia: `9${unique()}`.slice(0, 15), entidade: "12345" }
      : { transactionStatus: "Success", transactionID: `TX-${unique()}`, reference: `REF-${unique()}` };
  return createEupagoPayment({
    orderId,
    method,
    amountCents: 5000,
    config: CONFIG,
    customerPhone: "912345678",
    countryCode: "351",
    fetchImpl: stubFetch(providerResponse),
  });
}

const observationsFor = async (orderId: number) =>
  db.select().from(reconciliationObservations).where(eq(reconciliationObservations.orderId, orderId));
const eventRow = async (trid: string) =>
  (
    await db
      .select()
      .from(providerWebhookEvents)
      .where(eq(providerWebhookEvents.providerEventId, trid))
      .limit(1)
  )[0];
const orderRow = async (id: number) => (await db.select().from(orders).where(eq(orders.id, id)).limit(1))[0];
const productRow = async (id: number) =>
  (await db.select().from(products).where(eq(products.id, id)).limit(1))[0];

beforeEach(async () => {
  await cleanupByPrefix(PREFIX);
  await resetEupagoLedgerSlice();
});
afterEach(async () => {
  await cleanupByPrefix(PREFIX);
});

// ─── C2 ───────────────────────────────────────────────────

describe("C2 — a concluded trid cannot silently change meaning", () => {
  it("escalates a DIFFERENT payload for an already processed trid instead of answering duplicate", async () => {
    const fixture = await createPendingOrder({ prefix: PREFIX });
    const created = await createAttempt(fixture.orderId);
    if (created.outcome !== "created") throw new Error("attempt not created");
    const identifier = created.attempt.providerIdentifier!;
    const trid = `T-C2-${unique()}`;

    const settled = await processEupagoWebhook(await signedWebhook(paidWebhookPayload({ trid, identifier })));
    expect(settled.outcome).toBe("payment_confirmed");
    expect((await orderRow(fixture.orderId)).status).toBe("paid");
    const emailsAfterSettlement = (
      await db
        .select()
        .from(emailNotifications)
        .where(and(eq(emailNotifications.referenceType, "order"), eq(emailNotifications.referenceId, fixture.orderId)))
    ).length;
    const stockAfterSettlement = await productRow(fixture.productId);

    // The SAME trid comes back with a DIFFERENT authenticated amount.
    const conflicting = await processEupagoWebhook(
      await signedWebhook(paidWebhookPayload({ trid, identifier, amount: "99.99" }))
    );
    expect(conflicting.outcome).toBe("payment_anomaly");
    expect(conflicting.code).toBe("PROVIDER_EVENT_CONFLICT");

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

    const audit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "payment.provider_anomaly_recorded"), eq(auditLogs.entityId, created.attempt.id)));
    expect(audit).toHaveLength(1);
    expect(audit[0].details).toMatchObject({
      trid,
      code: "PROVIDER_EVENT_CONFLICT",
      settled: false,
    });
    expect((audit[0].details as { conflictFields?: string[] }).conflictFields).toContain("amount");

    // The event no longer claims to be a settled success.
    const event = await eventRow(trid);
    expect(event.status).toBe("anomaly");
    expect(String(event.metadata?.anomalyCode)).toContain("PROVIDER_EVENT_CONFLICT");

    // Nothing about the ORIGINAL settlement changes, and nothing new settles.
    expect((await orderRow(fixture.orderId)).status).toBe("paid");
    expect(await productRow(fixture.productId)).toMatchObject({
      stock: stockAfterSettlement.stock,
      soldCount: stockAfterSettlement.soldCount,
    });
    expect(
      (
        await db
          .select()
          .from(emailNotifications)
          .where(and(eq(emailNotifications.referenceType, "order"), eq(emailNotifications.referenceId, fixture.orderId)))
      ).length
    ).toBe(emailsAfterSettlement);
    expect(
      (
        await db
          .select()
          .from(payments)
          .where(and(eq(payments.orderId, fixture.orderId), eq(payments.status, "paid")))
      ).length
    ).toBe(1);

    // Redelivering the CONFLICTING payload stays idempotent: one anomaly, one audit.
    const replay = await processEupagoWebhook(
      await signedWebhook(paidWebhookPayload({ trid, identifier, amount: "99.99" }))
    );
    expect(replay.outcome).toBe("payment_anomaly");
    expect(replay.code).toBe("PROVIDER_EVENT_CONFLICT");
    expect(await observationsFor(fixture.orderId)).toHaveLength(1);
    expect(
      (
        await db
          .select()
          .from(auditLogs)
          .where(and(eq(auditLogs.action, "payment.provider_anomaly_recorded"), eq(auditLogs.entityId, created.attempt.id)))
      ).length
    ).toBe(1);

    // A byte-identical redelivery of the ORIGINAL payload would still be a plain
    // duplicate — proven separately in the C1 suite; here the event is anomalous,
    // so the identical payload returns the recorded anomaly.
    const identical = await processEupagoWebhook(await signedWebhook(paidWebhookPayload({ trid, identifier })));
    expect(identical.outcome).toBe("payment_anomaly");
  });

  it("escalates a STATUS change for the same trid (payment.paid → payment.expired)", async () => {
    const fixture = await createPendingOrder({ prefix: PREFIX });
    const created = await createAttempt(fixture.orderId);
    if (created.outcome !== "created") throw new Error("attempt not created");
    const identifier = created.attempt.providerIdentifier!;
    const trid = `T-C2S-${unique()}`;

    expect((await processEupagoWebhook(await signedWebhook(paidWebhookPayload({ trid, identifier })))).outcome).toBe(
      "payment_confirmed"
    );

    const conflicting = await processEupagoWebhook(
      await signedWebhook({ trid, status: "Expired", identifier, method: "mbway", amount: "50.00", currency: "EUR" })
    );
    expect(conflicting.outcome).toBe("payment_anomaly");
    expect(conflicting.code).toBe("PROVIDER_EVENT_CONFLICT");

    const audit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "payment.provider_anomaly_recorded"), eq(auditLogs.entityId, created.attempt.id)));
    expect(audit).toHaveLength(1);
    expect((audit[0].details as { conflictFields?: string[] }).conflictFields).toContain("event_type");
    // The settled attempt is untouched: the conflict did not rewrite the money.
    const attempt = (
      await db.select().from(paymentAttempts).where(eq(paymentAttempts.id, created.attempt.id)).limit(1)
    )[0];
    expect(attempt.status).toBe("paid");
    expect(attempt.providerTransactionId).toBe(trid);
  });

  it("does NOT touch an `ignored` delivery: its own re-evaluation semantics are preserved", async () => {
    const fixture = await createPendingOrder({ prefix: PREFIX });
    const created = await createAttempt(fixture.orderId);
    if (created.outcome !== "created") throw new Error("attempt not created");
    const identifier = created.attempt.providerIdentifier!;
    const trid = `T-C2I-${unique()}`;

    // Definitive divergence: wrong amount → ignored / AMOUNT_MISMATCH (C3 records
    // the durable anomaly, the event stays re-evaluable by the audited paths).
    const ignored = await processEupagoWebhook(
      await signedWebhook(paidWebhookPayload({ trid, identifier, amount: "49.99" }))
    );
    expect(ignored.outcome).toBe("mismatch");
    expect((await eventRow(trid)).status).toBe("ignored");

    // The same trid with a different payload is NOT escalated (no C2 escalation
    // on `ignored` rows): the delivery is answered coherently from the state that
    // really exists, without a pointless 503.
    const again = await processEupagoWebhook(await signedWebhook(paidWebhookPayload({ trid, identifier })));
    expect(again.outcome).toBe("mismatch");
    expect(again.code).toBe("AMOUNT_MISMATCH");
    expect((await eventRow(trid)).status).toBe("ignored");
    expect(await observationsFor(fixture.orderId)).toHaveLength(1);
  });

  it("the HTTP answer marks an anomalous outcome explicitly (never a normal duplicate)", async () => {
    // The route resolves the webhook key from the Backoffice/env fallback.
    process.env.EUPAGO_WEBHOOK_KEY = TEST_WEBHOOK_KEY;
    const fixture = await createPendingOrder({ prefix: PREFIX });
    const created = await createAttempt(fixture.orderId);
    if (created.outcome !== "created") throw new Error("attempt not created");
    const identifier = created.attempt.providerIdentifier!;
    const trid = `T-C2H-${unique()}`;
    await processEupagoWebhook(await signedWebhook(paidWebhookPayload({ trid, identifier })));

    const conflictingRaw = JSON.stringify(paidWebhookPayload({ trid, identifier, amount: "99.99" }));
    const conflicting = await webhookPOST(
      new NextRequest("https://arena.test/api/webhooks/eupago", {
        method: "POST",
        headers: { "x-signature": (await signedWebhook(paidWebhookPayload({ trid, identifier, amount: "99.99" }))).headers["x-signature"] },
        body: conflictingRaw,
      })
    );
    expect(conflicting.status).toBe(200);
    expect(await conflicting.json()).toMatchObject({
      received: true,
      anomaly: true,
      outcome: "payment_anomaly",
      code: "PROVIDER_EVENT_CONFLICT",
    });
  });
});

// ─── C3 ───────────────────────────────────────────────────

describe("C3 — authenticated money contradictions stay visible", () => {
  it("records a durable anomaly for every payload contradiction of a Paid movement", async () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["wrong amount", { amount: "49.99" }, "AMOUNT_MISMATCH"],
      ["wrong currency", { currency: "USD" }, "CURRENCY_MISMATCH"],
      ["wrong method", { method: "multibanco" }, "METHOD_MISMATCH"],
      ["missing method", { method: undefined }, "METHOD_MISSING"],
    ];

    for (const [label, override, expectedCode] of cases) {
      const fixture = await createPendingOrder({ prefix: PREFIX });
      const created = await createAttempt(fixture.orderId);
      if (created.outcome !== "created") throw new Error(`${label}: attempt not created`);
      const identifier = created.attempt.providerIdentifier!;
      const trid = `T-C3-${unique()}`;

      const productBefore = await productRow(fixture.productId);
      const result = await processEupagoWebhook(
        await signedWebhook(paidWebhookPayload({ trid, identifier, ...override }))
      );

      expect(result.outcome).toBe("mismatch");
      expect(result.code).toBe(expectedCode);

      // Durable + auditable, bound to the candidate attempt/payment.
      const anomalies = await observationsFor(fixture.orderId);
      expect(anomalies).toHaveLength(1);
      expect(anomalies[0]).toMatchObject({
        anomalyCode: expectedCode,
        provider: "eupago",
        providerReference: trid,
        paymentId: created.attempt.paymentId,
        status: "open",
        recordedBy: null,
      });

      const audit = await db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.action, "payment.provider_anomaly_recorded"), eq(auditLogs.entityId, created.attempt.id)));
      expect(audit).toHaveLength(1);
      expect(audit[0].details).toMatchObject({ code: expectedCode, trid, settled: false, previousState: "pending" });

      // Understood, dismissed, and NOT settled: the event is never `processed`.
      expect((await eventRow(trid)).status).toBe("ignored");
      expect((await eventRow(trid)).lastError).toBe(expectedCode);

      // No confirmation, no stock, no email, no refund; the attempt stays open.
      expect((await orderRow(fixture.orderId))).toMatchObject({ status: "pending_payment", paymentStatus: "pending" });
      expect((await db.select().from(paymentAttempts).where(eq(paymentAttempts.id, created.attempt.id)).limit(1))[0].status).toBe("pending");
      expect(await productRow(fixture.productId)).toMatchObject({
        stock: productBefore.stock,
        soldCount: productBefore.soldCount,
        reservedStock: productBefore.reservedStock,
      });
      expect(
        (await db.select().from(payments).where(and(eq(payments.orderId, fixture.orderId), eq(payments.status, "paid")))).length
      ).toBe(0);
      expect((await db.select().from(refundAttempts).where(eq(refundAttempts.orderId, fixture.orderId))).length).toBe(0);
      expect(
        (
          await db
            .select()
            .from(emailNotifications)
            .where(and(eq(emailNotifications.referenceType, "order"), eq(emailNotifications.referenceId, fixture.orderId)))
        ).length
      ).toBe(0);
      expect(
        (await db.select().from(stockMovements).where(eq(stockMovements.referenceId, fixture.orderId))).length
      ).toBe(0);
    }
  });

  it("records IDENTIFIER / REFERENCE contradictions of a Paid movement", async () => {
    const fixture = await createPendingOrder({ prefix: PREFIX });
    const created = await createAttempt(fixture.orderId);
    if (created.outcome !== "created") throw new Error("attempt not created");
    const identifier = created.attempt.providerIdentifier!;
    const reference = created.attempt.providerReference!;

    // Wrong identifier, correct reference: the candidate is still found.
    const identifierTrid = `T-C3I-${unique()}`;
    const identifierResult = await processEupagoWebhook(
      await signedWebhook(paidWebhookPayload({ trid: identifierTrid, identifier: "MDT-999-deadbeefdeadbeef01", reference }))
    );
    expect(identifierResult.outcome).toBe("mismatch");
    expect(identifierResult.code).toBe("IDENTIFIER_MISMATCH");

    // Correct identifier, wrong reference.
    const referenceTrid = `T-C3R-${unique()}`;
    const referenceResult = await processEupagoWebhook(
      await signedWebhook(paidWebhookPayload({ trid: referenceTrid, identifier, reference: "REF-BELONGS-ELSEWHERE" }))
    );
    expect(referenceResult.outcome).toBe("mismatch");
    expect(referenceResult.code).toBe("REFERENCE_MISMATCH");

    const anomalies = await observationsFor(fixture.orderId);
    expect(anomalies.map((row) => row.anomalyCode).sort()).toEqual(["IDENTIFIER_MISMATCH", "REFERENCE_MISMATCH"]);
    expect(anomalies.every((row) => row.status === "open" && row.paymentId === created.attempt.paymentId)).toBe(true);
  });

  it("makes an unattributable Paid movement visible in the audit trail", async () => {
    const fixture = await createPendingOrder({ prefix: PREFIX });
    const trid = `T-C3U-${unique()}`;

    const result = await processEupagoWebhook(
      await signedWebhook(paidWebhookPayload({ trid, identifier: "MDT-999-unknownidentifier" }))
    );
    expect(result.outcome).toBe("mismatch");
    expect(result.code).toBe("ATTEMPT_NOT_FOUND");

    // No local candidate → no order to attribute a reconciliation row to, but the
    // movement is durably recorded for the operator (plus the existing dashboard
    // `IGNORED_PAYMENT_WEBHOOK` signal).
    expect(await observationsFor(fixture.orderId)).toHaveLength(0);
    const audit = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, "payment.provider_unattributed_movement"),
          sql`${auditLogs.details} ->> 'trid' = ${trid}`
        )
      );
    expect(audit).toHaveLength(1);
    expect(audit[0].details).toMatchObject({
      trid,
      reason: "ATTEMPT_NOT_FOUND",
      attributed: false,
      amountCents: 5000,
      currency: "EUR",
    });
  });

  it("makes an authenticated, non-correlatable REFUND visible without disturbing refund recovery", async () => {
    const fixture = await createPendingOrder({ prefix: PREFIX });
    const created = await createAttempt(fixture.orderId);
    if (created.outcome !== "created") throw new Error("attempt not created");
    const identifier = created.attempt.providerIdentifier!;
    const paidTrid = `T-C3RP-${unique()}`;
    expect((await processEupagoWebhook(await signedWebhook(paidWebhookPayload({ trid: paidTrid, identifier })))).outcome).toBe(
      "payment_confirmed"
    );

    // A refund callback for the settled movement, with no matching refund attempt.
    const refundTrid = `R-C3-${unique()}`;
    const refund = await processEupagoWebhook(
      await signedWebhook({ trid: refundTrid, originalTrid: paidTrid, status: "Refund", amount: "25.00", currency: "EUR" })
    );
    expect(refund.outcome).toBe("ignored");
    expect(refund.code).toBe("REFUND_ATTEMPT_NOT_FOUND");

    // Durable anomaly for the operator…
    const anomalies = await observationsFor(fixture.orderId);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({
      anomalyCode: "REFUND_ATTEMPT_NOT_FOUND",
      providerReference: refundTrid,
      status: "open",
      observedPaidCents: 2500,
    });

    // …while the EVENT keeps the state the audited refund-recovery path requires.
    const event = await eventRow(refundTrid);
    expect(event.status).toBe("ignored");
    expect(event.lastError).toBe("REFUND_ATTEMPT_NOT_FOUND");
    expect((await eventRow(paidTrid)).status).toBe("processed");
  });
});
