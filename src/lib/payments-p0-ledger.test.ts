/**
 * PAYMENT P0 — ledger integrity: canonical linkage, guards, M2/M4 evidence and
 * the B1 rollout matrix.
 *
 * Everything here runs against a real PostgreSQL (the disposable one started by
 * the test runner) with the real migrations applied. No provider is contacted.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import { emailNotifications, orders, paymentAttempts, payments, refundAttempts, settings as settingsRow } from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";
import {
  assertEupagoLedgerReady,
  probeEupagoLedgerHistory,
  resolveEupagoLedgerEnvironment,
  resetEupagoLedgerReadinessCache,
  EUPAGO_LEDGER_ENVIRONMENT_KEY,
} from "@/lib/services/eupago-ledger-service";
import { createEupagoPayment } from "@/lib/services/eupago-payment-service";
import { processEupagoWebhook } from "@/lib/services/eupago-settlement-service";
import { GET as settingsGET, PUT as settingsPUT } from "@/app/api/admin/settings/route";
import { NextRequest } from "next/server";
import { EUPAGO_PROVIDER_ID } from "@/lib/providers/eupago/config";
import {
  cleanupByPrefix,
  resetEupagoLedgerSlice,
  createPendingOrder,
  createUser,
  countRows,
  paidWebhookPayload,
  signedWebhook,
  stubFetch,
} from "@/test-support/fixtures";

const PREFIX = "P0L";

class RollbackSignal extends Error {
  constructor() {
    super("ROLLBACK");
  }
}

/**
 * Drizzle wraps database failures ("Failed query: …") and ProviderError keeps
 * diagnostics in `internalDetail`; this collects every layer so an assertion can
 * target the REAL PostgreSQL guard name (SQLSTATE message) or internal code.
 */
async function rejection(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    const err = error as {
      message?: string;
      internalDetail?: string;
      cause?: { message?: string; detail?: string };
    };
    return [err.message, err.internalDetail, err.cause?.message, err.cause?.detail].filter(Boolean).join(" | ");
  }
  throw new Error("expected the statement to be rejected, but it succeeded");
}

async function clearLedgerEnvironment() {
  await db.delete(settingsRow).where(eq(settingsRow.key, EUPAGO_LEDGER_ENVIRONMENT_KEY));
}

beforeEach(async () => {
  await cleanupByPrefix(PREFIX);
  await resetEupagoLedgerSlice();
  await clearLedgerEnvironment();
  resetEupagoLedgerReadinessCache();
});
afterEach(async () => {
  await clearLedgerEnvironment();
  await cleanupByPrefix(PREFIX);
});

function fetchOk(reference = "REF-X") {
  return stubFetch({ transactionStatus: "Success", transactionID: "TX-X", reference }, 201);
}

describe("P0 items 1/4/5 — canonical orders → payments → payment_attempts linkage", () => {
  it("links every new Eupago attempt to the canonical Eupago payment of the same order", async () => {
    const { orderId } = await createPendingOrder({ prefix: PREFIX });
    const created = await createEupagoPayment({
      orderId,
      method: "mbway",
      amountCents: 5000,
      config: { environment: "sandbox", apiKey: "k", oauthClientId: "c", oauthClientSecret: "s", webhookKey: "0123456789abcdef0123456789abcdef" },
      customerPhone: "912345678",
      countryCode: "351",
      fetchImpl: fetchOk(),
    });
    expect(created.outcome).toBe("created");

    const attempt = created.attempt;
    expect(attempt.paymentId).not.toBeNull();

    const [payment] = await db.select().from(payments).where(eq(payments.id, attempt.paymentId!)).limit(1);
    expect(payment.provider).toBe(EUPAGO_PROVIDER_ID);
    expect(payment.orderId).toBe(orderId);
    // Non-secret provenance (item 17) — the environment travels with the money.
    expect(payment.metadata).toMatchObject({ eupagoEnvironment: "sandbox" });

    // The canonical chain is complete and singular: the manual placeholder stays
    // untouched and exactly one Eupago payment exists.
    const allPayments = await db.select().from(payments).where(eq(payments.orderId, orderId));
    expect(allPayments).toHaveLength(2);
    expect(allPayments.filter((row) => row.provider === EUPAGO_PROVIDER_ID)).toHaveLength(1);
    expect(allPayments.filter((row) => row.provider === "manual" && row.status === "pending")).toHaveLength(1);
  });

  it("rejects an attempt linked to a payment of ANOTHER order (composite FK + guard)", async () => {
    const a = await createPendingOrder({ prefix: PREFIX });
    const b = await createPendingOrder({ prefix: PREFIX });
    const [paymentB] = await db.select().from(payments).where(eq(payments.orderId, b.orderId)).limit(1);

    const message = await rejection(() =>
      db.insert(paymentAttempts).values({
        orderId: a.orderId,
        paymentId: paymentB.id, // belongs to order B
        provider: EUPAGO_PROVIDER_ID,
        method: "mbway",
        amountCents: 5000,
        currency: "EUR",
        status: "pending",
        providerIdentifier: `ID-${Date.now()}`,
      })
    );
    expect(message).toMatch(/FOREIGN KEY|payment_attempts_payment_order_fk|PAYMENT_ATTEMPT/);
  });

  it("rejects a linked attempt whose snapshot disagrees with the payment", async () => {
    const { orderId } = await createPendingOrder({ prefix: PREFIX, totalCents: 5000 });
    const created = await createEupagoPayment({
      orderId,
      method: "mbway",
      amountCents: 5000,
      config: { environment: "sandbox", apiKey: "k", oauthClientId: "c", oauthClientSecret: "s", webhookKey: "0123456789abcdef0123456789abcdef" },
      customerPhone: "912345678",
      countryCode: "351",
      fetchImpl: fetchOk(),
    });

    // PAYMENT_ATTEMPT_SNAPSHOT_MISMATCH — a 10.00€ attempt may not point at a
    // 50.00€ payment.
    const mismatch = await rejection(() =>
      db
        .update(paymentAttempts)
        .set({ amountCents: 1000 })
        .where(eq(paymentAttempts.id, created.attempt.id))
    );
    expect(mismatch).toContain("PAYMENT_ATTEMPT_SNAPSHOT_MISMATCH");

    const [unchanged] = await db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.id, created.attempt.id))
      .limit(1);
    expect(unchanged.amountCents).toBe(5000);
  });

  it("keeps refund_attempts bound to the canonical payment (item 6/23)", async () => {
    const { orderId } = await createPendingOrder({ prefix: PREFIX, totalCents: 5000 });
    const other = await createPendingOrder({ prefix: PREFIX, totalCents: 5000 });
    const [otherPayment] = await db.select().from(payments).where(eq(payments.orderId, other.orderId)).limit(1);
    const operator = await createUser(PREFIX);

    const message = await rejection(() =>
      db.insert(refundAttempts).values({
        orderId,
        paymentId: otherPayment.id, // payment of another order
        provider: "manual",
        idempotencyKey: `P0L-${Date.now()}`,
        amountCents: 1000,
        currency: "EUR",
        requestedBy: operator.id,
      })
    );
    expect(message).toMatch(/FOREIGN KEY|refund_attempts_payment_order_fk/);
  });
});

describe("P0 item 7 / M2 — the identity guard closes the provider-promotion hole", () => {
  it("refuses to mint an uncorrelated Eupago attempt", async () => {
    const { orderId } = await createPendingOrder({ prefix: PREFIX });
    const message = await rejection(() =>
      db.insert(paymentAttempts).values({
        orderId,
        paymentId: null,
        provider: EUPAGO_PROVIDER_ID,
        method: "mbway",
        amountCents: 5000,
        currency: "EUR",
        status: "pending",
        providerIdentifier: `ID-${Date.now()}`,
      })
    );
    expect(message).toContain("PAYMENT_ATTEMPT_EUPAGO_PAYMENT_REQUIRED");
  });

  it("refuses to PROMOTE a non-Eupago row into a Eupago row while payment_id is NULL", async () => {
    const { orderId } = await createPendingOrder({ prefix: PREFIX });
    const [manual] = await db
      .insert(paymentAttempts)
      .values({
        orderId,
        paymentId: null,
        provider: "manual",
        method: "bank_transfer",
        amountCents: 5000,
        currency: "EUR",
        status: "pending",
        providerIdentifier: `ID-${Date.now()}`,
      })
      .returning();

    const message = await rejection(() =>
      db.update(paymentAttempts).set({ provider: EUPAGO_PROVIDER_ID }).where(eq(paymentAttempts.id, manual.id))
    );
    expect(message).toContain("PAYMENT_ATTEMPT_EUPAGO_PAYMENT_REQUIRED");

    // …and the row is untouched.
    const [after] = await db.select().from(paymentAttempts).where(eq(paymentAttempts.id, manual.id)).limit(1);
    expect(after.provider).toBe("manual");
  });

  it("keeps the LEGACY exception: a historical Eupago row with NULL payment_id stays updatable and is never retro-linked", async () => {
    const { orderId } = await createPendingOrder({ prefix: PREFIX });

    // Simulate a row that predates 0017. The ONLY legitimate way such a row can
    // exist is a pre-migration insert, so the guard is suspended *inside a single
    // transaction* (`SET LOCAL session_replication_role = replica`) and restored
    // automatically when it commits — no schema DDL, nothing left disabled.
    const legacyId = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      const [inserted] = await tx
        .insert(paymentAttempts)
        .values({
          orderId,
          paymentId: null,
          provider: EUPAGO_PROVIDER_ID,
          method: "mbway",
          amountCents: 5000,
          currency: "EUR",
          status: "pending",
          providerIdentifier: `LEGACY-${Date.now()}`,
        })
        .returning({ id: paymentAttempts.id });
      return inserted.id;
    });
    expect(legacyId).not.toBeNull();

    // The legacy row may still be updated while keeping NULL (operational
    // fields), and it is never automatically linked to a payment.
    await db
      .update(paymentAttempts)
      .set({ failureReason: "legacy touch", updatedAt: new Date() })
      .where(eq(paymentAttempts.id, legacyId!));

    const [after] = await db.select().from(paymentAttempts).where(eq(paymentAttempts.id, legacyId!)).limit(1);
    expect(after.paymentId).toBeNull();
    expect(after.provider).toBe(EUPAGO_PROVIDER_ID);
  });

  it("still allows a legacy row to gain its canonical payment explicitly (no automatic backfill)", async () => {
    const { orderId } = await createPendingOrder({ prefix: PREFIX });
    const created = await createEupagoPayment({
      orderId,
      method: "mbway",
      amountCents: 5000,
      config: { environment: "sandbox", apiKey: "k", oauthClientId: "c", oauthClientSecret: "s", webhookKey: "0123456789abcdef0123456789abcdef" },
      customerPhone: "912345678",
      countryCode: "351",
      fetchImpl: fetchOk(),
    });
    const [manual] = await db
      .insert(paymentAttempts)
      .values({
        orderId,
        paymentId: null,
        provider: "manual",
        method: "bank_transfer",
        amountCents: 5000,
        currency: "EUR",
        status: "pending",
        providerIdentifier: `ID-${Date.now()}`,
      })
      .returning();

    // An EXPLICIT, operator-driven link is allowed…
    await db.update(paymentAttempts).set({ paymentId: created.attempt.paymentId }).where(eq(paymentAttempts.id, manual.id));
    // …but the migration itself performed none: the historical row was NULL
    // until this statement.
    const [linked] = await db.select().from(paymentAttempts).where(eq(paymentAttempts.id, manual.id)).limit(1);
    expect(linked.paymentId).toBe(created.attempt.paymentId);
  });
});

describe("P0 items 18/19 + B1 — ledger environment is internal and fail-closed", () => {
  it("is NOT exposed as an editable Backoffice setting", async () => {
    expect(EUPAGO_LEDGER_ENVIRONMENT_KEY).toBe("eupago_ledger_environment");

    // The service is INTERNAL: the generic settings surface never returns it and
    // never accepts it, so an operator cannot rewrite ledger provenance.
    const read = await settingsGET();
    const payload = await read.json();
    expect(JSON.stringify(payload)).not.toContain(EUPAGO_LEDGER_ENVIRONMENT_KEY);

    const write = await settingsPUT(
      new NextRequest("http://loja.mdtech.pt/api/admin/settings", {
        method: "PUT",
        headers: { origin: "http://loja.mdtech.pt", host: "loja.mdtech.pt", "content-type": "application/json" },
        body: JSON.stringify({ [EUPAGO_LEDGER_ENVIRONMENT_KEY]: "production" }),
      })
    );
    expect(write.status).toBeGreaterThanOrEqual(400);
  });

  it("reports a READ-ONLY history probe (used by the B1 rollout matrix)", async () => {
    // Virgin ledger for Eupago before anything happens.
    const before = await probeEupagoLedgerHistory();
    expect(before).toMatchObject({ any: false });

    const { orderId } = await createPendingOrder({ prefix: PREFIX });
    const created = await createEupagoPayment({
      orderId,
      method: "mbway",
      amountCents: 5000,
      config: { environment: "sandbox", apiKey: "k", oauthClientId: "c", oauthClientSecret: "s", webhookKey: "0123456789abcdef0123456789abcdef" },
      customerPhone: "912345678",
      countryCode: "351",
      fetchImpl: fetchOk(),
    });
    expect(created.outcome).toBe("created");

    const after = await probeEupagoLedgerHistory();
    expect(after.any).toBe(true);
  });

  it("fails closed when Eupago history has no recorded ledger environment (B1 non-virgin)", async () => {
    const { orderId } = await createPendingOrder({ prefix: PREFIX });
    // A pre-existing Eupago attempt with no ledger environment recorded: exactly
    // the state B1 says must STOP and get a dedicated cutover plan.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.insert(paymentAttempts).values({
        orderId,
        paymentId: null,
        provider: EUPAGO_PROVIDER_ID,
        method: "mbway",
        amountCents: 5000,
        currency: "EUR",
        status: "pending",
        providerIdentifier: `HIST-${Date.now()}`,
      });
    });
    await db.delete(settingsRow).where(eq(settingsRow.key, EUPAGO_LEDGER_ENVIRONMENT_KEY));

    const resolution = await resolveEupagoLedgerEnvironment();
    expect(resolution.status).toBe("unavailable");
    if (resolution.status !== "unavailable") return;
    expect(resolution.code).toBe("LEDGER_ENVIRONMENT_NOT_RECORDED_FOR_EXISTING_HISTORY");
  });

  it("fails closed on unrecordable or mismatched environments", async () => {
    // (a) unreadable stored value
    await db
      .insert(settingsRow)
      .values({ key: EUPAGO_LEDGER_ENVIRONMENT_KEY, value: "staging", group: "eupago" })
      .onConflictDoUpdate({ target: settingsRow.key, set: { value: "staging" } });
    let resolution = await resolveEupagoLedgerEnvironment();
    expect(resolution.status === "unavailable" && resolution.code).toBe("LEDGER_ENVIRONMENT_UNREADABLE");

    // (b) recorded environment different from the runtime environment
    await db
      .update(settingsRow)
      .set({ value: "production" })
      .where(eq(settingsRow.key, EUPAGO_LEDGER_ENVIRONMENT_KEY));
    resolution = await resolveEupagoLedgerEnvironment();
    expect(resolution.status === "unavailable" && resolution.code).toBe("LEDGER_ENVIRONMENT_MISMATCH");

    // (c) a matching recorded value is accepted (origin = ledger)
    await db
      .update(settingsRow)
      .set({ value: "sandbox" })
      .where(eq(settingsRow.key, EUPAGO_LEDGER_ENVIRONMENT_KEY));
    resolution = await resolveEupagoLedgerEnvironment();
    expect(resolution).toMatchObject({ status: "ready", environment: "sandbox", origin: "ledger" });
  });

  it("fails closed with MIGRATION_REQUIRED_0017 when a required object is missing (rollout state C)", async () => {
    // Simulate "code deployed BEFORE the migration" on this disposable database
    // by hiding one of the guarded objects inside a transaction that ROLLS BACK:
    // the schema is left exactly as it was.
    const { orderId } = await createPendingOrder({ prefix: PREFIX });

    let gateError: unknown = null;
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`DROP TRIGGER "refund_attempts_payment_binding_guard" ON "refund_attempts"`);
        try {
          await assertEupagoLedgerReady(tx as never);
        } catch (error) {
          gateError = error;
        }
        // Roll the simulation back: the trigger is restored by discarding the tx.
        throw new RollbackSignal();
      })
    ).rejects.toThrow(RollbackSignal);
    const gate = gateError as { internalDetail?: string; message?: string };
    expect([gate?.internalDetail, gate?.message].filter(Boolean).join(" | ")).toContain("MIGRATION_REQUIRED_0017");

    // The gate refused, and after the rollback the schema is intact again.
    resetEupagoLedgerReadinessCache();
    await expect(assertEupagoLedgerReady()).resolves.toBeUndefined();
    expect(await countRows("payment_attempts", orderId)).toBe(0);
  });
});

describe("M4 — the historical `bank_transfer` payment is the MANUAL wrapper", () => {
  it("never interprets the manual payment as a Eupago payment", async () => {
    const { orderId } = await createPendingOrder({ prefix: PREFIX });

    // A Paid webhook cannot settle the manual payment: there is no attempt, and
    // the reference is not persisted → it stays deferred/uncorrelated instead of
    // being attributed to the bank transfer.
    const result = await processEupagoWebhook(
      await signedWebhook(paidWebhookPayload({ trid: `T-${Date.now()}`, reference: `REF-${Date.now()}` }))
    );
    expect(result.outcome).toBe("deferred");

    const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    expect(order.status).toBe("pending_payment");
    const rows = await db.select().from(payments).where(eq(payments.orderId, orderId));
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe("manual");
    expect(rows[0].method).toBe("bank_transfer");
    expect(rows[0].status).toBe("pending");
  });
});
