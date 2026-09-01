// B.3.2 — Eupago payment lifecycle, settlement and refund integration tests.
// Real PostgreSQL, real production services. Network is stubbed; dummy keys only.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  reconciliationObservations,
  refundAttempts,
  stockMovements,
  users,
} from "@/db/schema";
import { and, eq, inArray, like } from "drizzle-orm";
import type { EupagoConfig } from "@/lib/providers/eupago/config";
import {
  bytesToBase64,
  computeSignature,
  assertAesKeyBytes,
} from "@/lib/providers/eupago/webhook-crypto";
import {
  armPaymentAttempt,
  createEupagoPayment,
  findAttemptByIdentifier,
  listAttemptsRequiringReconciliation,
  recoverPaymentAttempt,
} from "@/lib/services/eupago-payment-service";
import { processEupagoWebhook } from "@/lib/services/eupago-settlement-service";
import { executeEupagoRefund } from "@/lib/services/eupago-refund-service";
import { requestRefund, getOrderRefundState, RefundError } from "@/lib/refunds";
import { confirmOrderPayment } from "@/lib/orders";
import { registerEupago, eupagoPaymentAdapter } from "@/lib/providers/eupago/adapter";
import { getPaymentAdapter } from "@/lib/providers/payment-attempts";

const WEBHOOK_KEY = "0123456789abcdef0123456789abcdef"; // 32 bytes, dummy

const CONFIG: EupagoConfig = {
  environment: "sandbox",
  apiKey: "dummy-api-key",
  oauthClientId: "dummy-client-id",
  oauthClientSecret: "dummy-client-secret",
  webhookKey: WEBHOOK_KEY,
};

// ─── Test data helpers ────────────────────────────────────

async function cleanupB32() {
  const rows = await db.select({ id: orders.id }).from(orders).where(like(orders.orderNumber, "B32-%"));
  const orderIds = rows.map((o) => o.id);
  if (orderIds.length) {
    await db.delete(refundAttempts).where(inArray(refundAttempts.orderId, orderIds));
    await db.delete(reconciliationObservations).where(inArray(reconciliationObservations.orderId, orderIds));
    await db.delete(paymentAttempts).where(inArray(paymentAttempts.orderId, orderIds));
    await db.delete(payments).where(inArray(payments.orderId, orderIds));
    await db.delete(orderStatusHistory).where(inArray(orderStatusHistory.orderId, orderIds));
    await db.delete(orderItems).where(inArray(orderItems.orderId, orderIds));
    await db.delete(stockMovements).where(inArray(stockMovements.referenceId, orderIds));
    await db.delete(orders).where(inArray(orders.id, orderIds));
  }
  await db.delete(providerWebhookEvents);
  await db.delete(auditLogs).where(like(auditLogs.action, "payment.provider_%"));
  await db.delete(auditLogs).where(like(auditLogs.action, "refund.%"));
  await db.delete(auditLogs).where(like(auditLogs.action, "order.%"));
  await db.delete(emailNotifications).where(like(emailNotifications.eventKey, "%"));
  await db.delete(products).where(like(products.sku, "B32-%"));
  await db.delete(users).where(like(users.email, "b32-%@test.local"));
}

let seq = 0;
function unique() {
  seq += 1;
  return `${Date.now()}${seq}${Math.floor(Math.random() * 1000)}`;
}

async function createAdmin() {
  const [u] = await db
    .insert(users)
    .values({ email: `b32-admin-${unique()}@test.local`, password: "x", name: "B32", role: "admin" })
    .returning();
  return u;
}

async function createProduct(stock = 10) {
  const [p] = await db
    .insert(products)
    .values({
      sku: `B32-${unique()}`,
      name: "B32 Product",
      slug: `b32-${unique()}`,
      price: "50.00",
      stock,
      reservedStock: 0,
    })
    .returning();
  return p;
}

/** Order in pending_payment with a reserved stock line, ready to be paid. */
async function createPendingOrder(totalCents = 5000) {
  const product = await createProduct();
  const total = (totalCents / 100).toFixed(2);
  const [order] = await db
    .insert(orders)
    .values({
      orderNumber: `B32-${unique()}`,
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
  await db
    .update(products)
    .set({ reservedStock: 1 })
    .where(eq(products.id, product.id));

  await db.insert(payments).values({
    orderId: order.id,
    provider: "eupago",
    method: "mbway",
    amount: total,
    currency: "EUR",
    status: "pending",
  });

  return { order, product };
}

// ─── Network stubs ────────────────────────────────────────

function okFetch(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

function countingFetch(body: unknown, status = 200): { fetchImpl: typeof fetch; count: () => number } {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, count: () => calls };
}

function timeoutFetch(): { fetchImpl: typeof fetch; count: () => number } {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    const e = new Error("aborted");
    e.name = "AbortError";
    throw e;
  }) as unknown as typeof fetch;
  return { fetchImpl, count: () => calls };
}

/** Fresh provider payloads per call: references are unique per attempt. */
function multibancoOk() {
  return { sucesso: true, estado: 0, referencia: `9${unique()}`.slice(0, 15), entidade: "12345" };
}
function mbwayOk() {
  return { transactionStatus: "Success", transactionID: `TX-${unique()}`, reference: `REF-${unique()}` };
}

// ─── Webhook helpers ──────────────────────────────────────

async function plainWebhook(payload: Record<string, unknown>) {
  const rawBody = JSON.stringify(payload);
  const signature = await computeSignature(WEBHOOK_KEY, rawBody);
  return { rawBody, headers: { "x-signature": signature }, webhookKey: WEBHOOK_KEY };
}

async function encryptedWebhook(payload: Record<string, unknown>) {
  const iv = new Uint8Array(new ArrayBuffer(16));
  crypto.getRandomValues(iv);
  const keyBytes = assertAesKeyBytes(WEBHOOK_KEY);
  const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-CBC" }, false, ["encrypt"]);
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  const buf = new Uint8Array(new ArrayBuffer(encoded.length));
  buf.set(encoded);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-CBC", iv }, cryptoKey, buf);
  const data = bytesToBase64(new Uint8Array(ciphertext));
  const rawBody = JSON.stringify({ data });
  const signature = await computeSignature(WEBHOOK_KEY, data);
  return {
    rawBody,
    headers: { "x-signature": signature, "x-initialization-vector": bytesToBase64(iv) },
    webhookKey: WEBHOOK_KEY,
  };
}

/** Create + settle a Eupago payment, returning the paid order and its trid. */
async function createAndSettle(totalCents = 5000, trid = `T-${unique()}`) {
  const { order, product } = await createPendingOrder(totalCents);
  const created = await createEupagoPayment({
    orderId: order.id,
    method: "mbway",
    amountCents: totalCents,
    config: CONFIG,
    customerPhone: "912345678",
    countryCode: "351",
    fetchImpl: okFetch(mbwayOk(), 201),
  });
  expect(created.outcome).toBe("created");
  const attempt = created.attempt;

  const result = await processEupagoWebhook(
    await plainWebhook({
      trid,
      status: "Paid",
      identifier: attempt.providerIdentifier,
      method: "MBWAY",
      amount: (totalCents / 100).toFixed(2),
      currency: "EUR",
    })
  );
  expect(result.outcome).toBe("payment_confirmed");
  return { order, product, attempt, trid };
}

beforeEach(cleanupB32);
afterEach(cleanupB32);

// ─── Adapter registration ─────────────────────────────────

describe("B.3.2 — provider adapter registration", () => {
  it("registers the Eupago adapter EXPLICITLY (not via import side effects)", () => {
    registerEupago();
    const adapter = getPaymentAdapter("eupago");
    expect(adapter).toBe(eupagoPaymentAdapter);
    expect(adapter.provider).toBe("eupago");
  });
});

// ─── Creation: exactly-once-attempt semantics ─────────────

describe("B.3.2 — payment creation persistence and idempotency", () => {
  it("persists the stable identifier BEFORE the provider call", async () => {
    const { order } = await createPendingOrder();
    let identifierAtCallTime: string | null = null;

    const inspectingFetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body)) as { id?: string };
      // At the moment of the network call, the identifier must already be
      // committed and findable in the database.
      const row = await findAttemptByIdentifier(body.id!);
      identifierAtCallTime = row?.providerIdentifier ?? null;
      return new Response(JSON.stringify(multibancoOk()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await createEupagoPayment({
      orderId: order.id,
      method: "multibanco",
      amountCents: 5000,
      config: CONFIG,
      fetchImpl: inspectingFetch,
    });

    expect(result.outcome).toBe("created");
    expect(identifierAtCallTime).toBe(result.attempt.providerIdentifier);
    expect(result.attempt.providerIdentifier).toMatch(/^MDT-\d+-[0-9a-f]{18}$/);
  });

  it("issues EXACTLY ONE provider create request per local attempt", async () => {
    const { order } = await createPendingOrder();
    const { fetchImpl, count } = countingFetch(multibancoOk());
    const result = await createEupagoPayment({
      orderId: order.id,
      method: "multibanco",
      amountCents: 5000,
      config: CONFIG,
      fetchImpl,
    });
    expect(result.outcome).toBe("created");
    expect(count()).toBe(1);
    expect(result.attempt.recoveryState).toBe("requested");
  });

  it("serializes concurrent creates for the same logical order payment", async () => {
    const { order } = await createPendingOrder();
    const { fetchImpl, count } = countingFetch(multibancoOk());

    const results = await Promise.all([
      createEupagoPayment({ orderId: order.id, method: "multibanco", amountCents: 5000, config: CONFIG, fetchImpl }),
      createEupagoPayment({ orderId: order.id, method: "multibanco", amountCents: 5000, config: CONFIG, fetchImpl }),
    ]);

    expect(count()).toBe(1);
    const attempts = await db.select().from(paymentAttempts).where(eq(paymentAttempts.orderId, order.id));
    expect(attempts).toHaveLength(1);
    expect(new Set(results.map((r) => r.attempt.id))).toEqual(new Set([attempts[0].id]));
  });

  it("does NOT create a second provider request after an ambiguous timeout", async () => {
    const { order } = await createPendingOrder();
    const { fetchImpl, count } = timeoutFetch();

    const result = await createEupagoPayment({
      orderId: order.id,
      method: "multibanco",
      amountCents: 5000,
      config: CONFIG,
      fetchImpl,
    });

    expect(result.outcome).toBe("reconciliation_required");
    expect(count()).toBe(1);
    expect(result.attempt.recoveryState).toBe("reconciliation_required");
    expect(result.attempt.operatorActionCode).toBe("AMBIGUOUS_TIMEOUT");

    // The attempt is surfaced for operator/reconciliation attention.
    const pending = await listAttemptsRequiringReconciliation();
    expect(pending.some((a) => a.id === result.attempt.id)).toBe(true);
  });

  it("never regenerates the identifier for the same attempt", async () => {
    const { order } = await createPendingOrder();
    const armed = await armPaymentAttempt({ orderId: order.id, method: "multibanco", amountCents: 5000 });
    const original = armed.providerIdentifier;

    // Ambiguous lookup keeps the attempt in reconciliation with the SAME id.
    const lookupFetch = (async (url: string) => {
      if (String(url).includes("/auth/token")) {
        return new Response(JSON.stringify({ access_token: "t", expires_in: 300 }), { status: 200 });
      }
      return new Response("{}", { status: 500 });
    }) as unknown as typeof fetch;

    await db
      .update(paymentAttempts)
      .set({ recoveryState: "reconciliation_required" })
      .where(eq(paymentAttempts.id, armed.id));

    const recovered = await recoverPaymentAttempt({
      attemptId: armed.id,
      config: CONFIG,
      fetchImpl: lookupFetch,
    });
    expect(recovered.outcome).toBe("still_ambiguous");
    expect(recovered.attempt.providerIdentifier).toBe(original);
  });

  it("recovers by identifier lookup and only re-arms on PROVEN absence", async () => {
    const { order } = await createPendingOrder();
    const armed = await armPaymentAttempt({ orderId: order.id, method: "multibanco", amountCents: 5000 });
    await db
      .update(paymentAttempts)
      .set({ recoveryState: "reconciliation_required" })
      .where(eq(paymentAttempts.id, armed.id));

    // Provider PROVES absence → safe to recreate.
    const absentFetch = (async (url: string) =>
      String(url).includes("/auth/token")
        ? new Response(JSON.stringify({ access_token: "t", expires_in: 300 }), { status: 200 })
        : new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })) as unknown as typeof fetch;

    const absent = await recoverPaymentAttempt({
      attemptId: armed.id,
      config: CONFIG,
      fetchImpl: absentFetch,
    });
    expect(absent.outcome).toBe("safe_to_recreate");
    expect(absent.attempt.recoveryState).toBe("armed");

    // Provider FINDS the creation → adopt its reference, no new create.
    await db
      .update(paymentAttempts)
      .set({ recoveryState: "reconciliation_required" })
      .where(eq(paymentAttempts.id, armed.id));
    const foundFetch = (async (url: string) =>
      String(url).includes("/auth/token")
        ? new Response(JSON.stringify({ access_token: "t", expires_in: 300 }), { status: 200 })
        : new Response(JSON.stringify({ data: [{ reference: "987654321", trid: "T-REC" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })) as unknown as typeof fetch;

    const found = await recoverPaymentAttempt({
      attemptId: armed.id,
      config: CONFIG,
      fetchImpl: foundFetch,
    });
    expect(found.outcome).toBe("recovered");
    expect(found.attempt.providerReference).toBe("987654321");
    expect(found.attempt.providerTransactionId).toBe("T-REC");
  });

  it("creation alone NEVER marks the order or the attempt as paid", async () => {
    const { order } = await createPendingOrder();

    for (const [method, body, status] of [
      ["multibanco", multibancoOk(), 200],
      ["mbway", mbwayOk(), 201],
      [
        "card",
        {
          transactionStatus: "Success",
          reference: "REF-CARD",
          redirectUrl: "https://sandbox.eupago.pt/hosted/pay/x",
        },
        201,
      ],
    ] as const) {
      const result = await createEupagoPayment({
        orderId: order.id,
        method,
        amountCents: 5000,
        config: CONFIG,
        customerPhone: "912345678",
        countryCode: "351",
        customerEmail: "c@test.local",
        successUrl: "https://loja.mdtech.pt/ok",
        failUrl: "https://loja.mdtech.pt/ko",
        backUrl: "https://loja.mdtech.pt/back",
        fetchImpl: okFetch(body, status),
      });

      expect(result.outcome).toBe("created");
      expect(result.attempt.status).toBe("pending");

      const [current] = await db.select().from(orders).where(eq(orders.id, order.id)).limit(1);
      expect(current.status).toBe("pending_payment");
      expect(current.paymentStatus).toBe("pending");
    }
  });

  it("card creation returns an Eupago-hosted redirect and no card data", async () => {
    const { order } = await createPendingOrder();
    const result = await createEupagoPayment({
      orderId: order.id,
      method: "card",
      amountCents: 5000,
      config: CONFIG,
      customerEmail: "c@test.local",
      successUrl: "https://loja.mdtech.pt/ok",
      failUrl: "https://loja.mdtech.pt/ko",
      backUrl: "https://loja.mdtech.pt/back",
      fetchImpl: okFetch(
        {
          transactionStatus: "Success",
          reference: "REF-CARD",
          redirectUrl: "https://sandbox.eupago.pt/hosted/pay/x",
        },
        201
      ),
    });

    expect(result.outcome).toBe("created");
    if (result.outcome === "created") {
      expect(result.redirectUrl).toBe("https://sandbox.eupago.pt/hosted/pay/x");
    }
    // No card-secret column exists on the attempt at all.
    const serialized = JSON.stringify(result.attempt).toLowerCase();
    for (const forbidden of ["pan", "cvv", "cvc", "cardnumber", "expiry"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("records a semantic HTTP 200 failure as a failed attempt, not a payment", async () => {
    const { order } = await createPendingOrder();
    const result = await createEupagoPayment({
      orderId: order.id,
      method: "multibanco",
      amountCents: 5000,
      config: CONFIG,
      fetchImpl: okFetch({ sucesso: false, estado: 3, resposta: "Chave inválida" }, 200),
    });
    expect(result.outcome).toBe("rejected");
    expect(result.attempt.status).toBe("failed");

    const [current] = await db.select().from(orders).where(eq(orders.id, order.id)).limit(1);
    expect(current.status).toBe("pending_payment");
  });
});

// ─── Settlement ───────────────────────────────────────────

describe("B.3.2 — webhook settlement", () => {
  it("confirms payment through the centralized lifecycle on a matching Paid event", async () => {
    const { order, product } = await createAndSettle(5000);

    const [confirmed] = await db.select().from(orders).where(eq(orders.id, order.id)).limit(1);
    expect(confirmed.status).toBe("paid");
    expect(confirmed.paymentStatus).toBe("paid");

    // Stock conversion was performed by confirmOrderPayment (not by B.3.2).
    const [p] = await db.select().from(products).where(eq(products.id, product.id)).limit(1);
    expect(p.stock).toBe(9);
    expect(p.reservedStock).toBe(0);
    expect(p.soldCount).toBe(1);

    // History came from the centralized service.
    const history = await db
      .select()
      .from(orderStatusHistory)
      .where(eq(orderStatusHistory.orderId, order.id));
    expect(history.filter((h) => h.toStatus === "paid")).toHaveLength(1);
  });

  it("settles an ENCRYPTED (encrypt=true) Paid event identically", async () => {
    const { order } = await createPendingOrder(3000);
    const created = await createEupagoPayment({
      orderId: order.id,
      method: "multibanco",
      amountCents: 3000,
      config: CONFIG,
      fetchImpl: okFetch(multibancoOk()),
    });

    const result = await processEupagoWebhook(
      await encryptedWebhook({
        trid: `T-${unique()}`,
        status: "Paid",
        identifier: created.attempt.providerIdentifier,
        method: "multibanco",
        amount: "30.00",
        currency: "EUR",
      })
    );
    expect(result.outcome).toBe("payment_confirmed");

    const [confirmed] = await db.select().from(orders).where(eq(orders.id, order.id)).limit(1);
    expect(confirmed.status).toBe("paid");
  });

  it("is idempotent for a duplicate trid — no duplicated side effects", async () => {
    const { order, product, attempt, trid } = await createAndSettle(5000);

    const emailsAfterFirst = await db.select().from(emailNotifications);
    const auditAfterFirst = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "order.payment_confirmed"));
    const movementsAfterFirst = await db
      .select()
      .from(stockMovements)
      .where(eq(stockMovements.referenceId, order.id));

    // Same trid delivered twice more (provider retry).
    for (let i = 0; i < 2; i++) {
      const replay = await processEupagoWebhook(
        await plainWebhook({
          trid,
          status: "Paid",
          identifier: attempt.providerIdentifier,
          method: "MBWAY",
          amount: "50.00",
          currency: "EUR",
        })
      );
      expect(replay.outcome).toBe("duplicate");
    }

    // Exactly one ledger row for that trid.
    const events = await db
      .select()
      .from(providerWebhookEvents)
      .where(and(eq(providerWebhookEvents.provider, "eupago"), eq(providerWebhookEvents.providerEventId, trid)));
    expect(events).toHaveLength(1);

    // No duplicated transition / stock / email / audit.
    const history = await db
      .select()
      .from(orderStatusHistory)
      .where(eq(orderStatusHistory.orderId, order.id));
    expect(history.filter((h) => h.toStatus === "paid")).toHaveLength(1);

    const [p] = await db.select().from(products).where(eq(products.id, product.id)).limit(1);
    expect(p.stock).toBe(9);
    expect(p.soldCount).toBe(1);

    expect(await db.select().from(emailNotifications)).toHaveLength(emailsAfterFirst.length);
    expect(
      await db.select().from(auditLogs).where(eq(auditLogs.action, "order.payment_confirmed"))
    ).toHaveLength(auditAfterFirst.length);
    expect(
      await db.select().from(stockMovements).where(eq(stockMovements.referenceId, order.id))
    ).toHaveLength(movementsAfterFirst.length);
  });

  it("does not confirm on wrong amount, currency, method or identifier", async () => {
    const { order } = await createPendingOrder(5000);
    const created = await createEupagoPayment({
      orderId: order.id,
      method: "mbway",
      amountCents: 5000,
      config: CONFIG,
      customerPhone: "912345678",
      countryCode: "351",
      fetchImpl: okFetch(mbwayOk(), 201),
    });
    const identifier = created.attempt.providerIdentifier!;

    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["wrong amount", { amount: "49.99" }, "AMOUNT_MISMATCH"],
      ["wrong currency", { currency: "USD" }, "CURRENCY_MISMATCH"],
      ["missing currency", { currency: undefined }, "CURRENCY_MISMATCH"],
      ["wrong method", { method: "multibanco" }, "METHOD_MISMATCH"],
      ["missing method", { method: undefined }, "METHOD_MISSING"],
      ["unknown identifier", { identifier: "MDT-999-deadbeefdeadbeef01" }, "ATTEMPT_NOT_FOUND"],
      ["wrong identifier with correct reference", { identifier: "MDT-999-deadbeefdeadbeef01", reference: created.attempt.providerReference }, "IDENTIFIER_MISMATCH"],
      ["wrong reference with correct identifier", { reference: "REF-BELONGS-ELSEWHERE" }, "REFERENCE_MISMATCH"],
    ];

    for (const [, override, expectedCode] of cases) {
      const result = await processEupagoWebhook(
        await plainWebhook({
          trid: `T-${unique()}`,
          status: "Paid",
          identifier,
          method: "MBWAY",
          amount: "50.00",
          currency: "EUR",
          ...override,
        })
      );
      expect(result.outcome).toBe("mismatch");
      expect(result.code).toBe(expectedCode);
    }

    // The order was never confirmed by any of them.
    const [current] = await db.select().from(orders).where(eq(orders.id, order.id)).limit(1);
    expect(current.status).toBe("pending_payment");
    const [attempt] = await db.select().from(paymentAttempts).where(eq(paymentAttempts.id, created.attempt.id));
    expect(attempt.status).toBe("pending");
  });

  it("records Error/Cancel/Expired as provider state without inventing order transitions", async () => {
    for (const [providerStatus, expected] of [
      ["Error", "failed"],
      ["Cancel", "cancelled"],
      ["Expired", "expired"],
    ] as const) {
      const { order } = await createPendingOrder(5000);
      const created = await createEupagoPayment({
        orderId: order.id,
        method: "multibanco",
        amountCents: 5000,
        config: CONFIG,
        fetchImpl: okFetch(multibancoOk()),
      });

      const result = await processEupagoWebhook(
        await plainWebhook({
          trid: `T-${unique()}`,
          status: providerStatus,
          identifier: created.attempt.providerIdentifier,
          method: "multibanco",
          amount: "50.00",
          currency: "EUR",
        })
      );
      expect(result.outcome).toBe("payment_attempt_updated");

      const [attempt] = await db
        .select()
        .from(paymentAttempts)
        .where(eq(paymentAttempts.id, created.attempt.id));
      expect(attempt.status).toBe(expected);

      // The ORDER lifecycle was not touched.
      const [current] = await db.select().from(orders).where(eq(orders.id, order.id)).limit(1);
      expect(current.status).toBe("pending_payment");
    }
  });

  it("rejects unsigned and badly-signed deliveries before any state change", async () => {
    const { order } = await createPendingOrder(5000);
    const created = await createEupagoPayment({
      orderId: order.id,
      method: "multibanco",
      amountCents: 5000,
      config: CONFIG,
      fetchImpl: okFetch(multibancoOk()),
    });

    const payload = {
      trid: `T-${unique()}`,
      status: "Paid",
      identifier: created.attempt.providerIdentifier,
      method: "multibanco",
      amount: "50.00",
      currency: "EUR",
    };
    const rawBody = JSON.stringify(payload);

    await expect(
      processEupagoWebhook({ rawBody, headers: {}, webhookKey: WEBHOOK_KEY })
    ).rejects.toMatchObject({ code: "WEBHOOK_INVALID" });
    await expect(
      processEupagoWebhook({
        rawBody,
        headers: { "x-signature": bytesToBase64(new Uint8Array(32)) },
        webhookKey: WEBHOOK_KEY,
      })
    ).rejects.toMatchObject({ code: "WEBHOOK_INVALID" });

    // Nothing was recorded and nothing was confirmed.
    expect(await db.select().from(providerWebhookEvents)).toHaveLength(0);
    const [current] = await db.select().from(orders).where(eq(orders.id, order.id)).limit(1);
    expect(current.status).toBe("pending_payment");
  });

  it("keeps trid namespaces separate per provider", async () => {
    const { order } = await createPendingOrder(5000);
    const created = await createEupagoPayment({
      orderId: order.id,
      method: "multibanco",
      amountCents: 5000,
      config: CONFIG,
      fetchImpl: okFetch(multibancoOk()),
    });
    const trid = `T-${unique()}`;

    await processEupagoWebhook(
      await plainWebhook({
        trid,
        status: "Paid",
        identifier: created.attempt.providerIdentifier,
        method: "multibanco",
        amount: "50.00",
        currency: "EUR",
      })
    );

    // Another provider may legitimately reuse the same event id string.
    const { registerWebhookEvent } = await import("@/lib/providers/webhook-events");
    const other = await registerWebhookEvent({
      provider: "mrw",
      providerEventId: trid,
      rawBody: '{"x":1}',
    });
    expect(other.duplicate).toBe(false);
  });
});

// ─── Refunds (B.3.5 integration) ──────────────────────────

describe("B.3.2 — refunds integrate with the B.3.5 ledger", () => {
  async function paidOrderWithRefundBase(totalCents = 10000) {
    const settled = await createAndSettle(totalCents);
    const admin = await createAdmin();
    return { ...settled, admin };
  }

  it("submits a provider refund without marking it completed", async () => {
    const { order, admin, trid } = await paidOrderWithRefundBase();

    const requested = await requestRefund({
      orderId: order.id,
      amountCents: 2500,
      idempotencyKey: `b32-refund-${unique()}`,
      requestedBy: admin.id,
      provider: "eupago",
    });
    expect(requested.refund.status).toBe("pending");

    const { fetchImpl, count } = countingFetch(
      { transactionStatus: "Success", trid: `R-${unique()}` },
      201
    );
    const tokenAware = (async (url: string, init?: RequestInit) =>
      String(url).includes("/auth/token")
        ? new Response(JSON.stringify({ access_token: "t", expires_in: 300 }), { status: 200 })
        : fetchImpl(url, init)) as unknown as typeof fetch;

    const executed = await executeEupagoRefund({
      refundId: requested.refund.id,
      actorId: admin.id,
      config: CONFIG,
      fetchImpl: tokenAware,
    });

    expect(executed.outcome).toBe("submitted");
    // 201 is acceptance, NOT settlement.
    expect(executed.refund.status).not.toBe("succeeded");
    expect(executed.refund.providerOriginalTransactionId).toBe(trid);
    expect(count()).toBe(1);

    const state = await getOrderRefundState(order.id);
    expect(state.refundedCents).toBe(0);
    expect(state.committedCents).toBe(2500);
  });

  it("settles the refund only from a verified refund webhook with its OWN trid", async () => {
    const { order, admin, trid } = await paidOrderWithRefundBase();
    const requested = await requestRefund({
      orderId: order.id,
      amountCents: 2500,
      idempotencyKey: `b32-refund-${unique()}`,
      requestedBy: admin.id,
      provider: "eupago",
    });

    const tokenAware = (async (url: string) =>
      String(url).includes("/auth/token")
        ? new Response(JSON.stringify({ access_token: "t", expires_in: 300 }), { status: 200 })
        : new Response(JSON.stringify({ transactionStatus: "Success" }), {
            status: 201,
            headers: { "content-type": "application/json" },
          })) as unknown as typeof fetch;

    await executeEupagoRefund({
      refundId: requested.refund.id,
      actorId: admin.id,
      config: CONFIG,
      fetchImpl: tokenAware,
    });

    const refundTrid = `R-${unique()}`;
    expect(refundTrid).not.toBe(trid);

    const settled = await processEupagoWebhook(
      await plainWebhook({
        trid: refundTrid,
        originalTrid: trid,
        status: "Refund",
        amount: "25.00",
        currency: "EUR",
      })
    );
    expect(settled.outcome).toBe("refund_settled");

    const [row] = await db.select().from(refundAttempts).where(eq(refundAttempts.id, requested.refund.id));
    expect(row.status).toBe("succeeded");
    // Refund trid is DISTINCT from the payment trid and stored separately.
    expect(row.providerRefundId).toBe(refundTrid);
    expect(row.providerOriginalTransactionId).toBe(trid);

    const state = await getOrderRefundState(order.id);
    expect(state.refundedCents).toBe(2500);
  });

  it("is idempotent for a duplicate refund trid", async () => {
    const { order, admin, trid } = await paidOrderWithRefundBase();
    const requested = await requestRefund({
      orderId: order.id,
      amountCents: 2500,
      idempotencyKey: `b32-refund-${unique()}`,
      requestedBy: admin.id,
      provider: "eupago",
    });
    await db
      .update(refundAttempts)
      .set({ providerOriginalTransactionId: trid })
      .where(eq(refundAttempts.id, requested.refund.id));

    const refundTrid = `R-${unique()}`;
    const event = await plainWebhook({
      trid: refundTrid,
      originalTrid: trid,
      status: "Refund",
      amount: "25.00",
      currency: "EUR",
    });

    const first = await processEupagoWebhook(event);
    expect(first.outcome).toBe("refund_settled");
    const second = await processEupagoWebhook(event);
    expect(second.outcome).toBe("duplicate");

    const state = await getOrderRefundState(order.id);
    expect(state.refundedCents).toBe(2500);
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.action, "refund.provider_settled"));
    expect(audits).toHaveLength(1);
  });

  it("supports multiple partial refunds correlated by originalTrid", async () => {
    const { order, admin, trid } = await paidOrderWithRefundBase(10000);

    for (const amount of [2000, 3000]) {
      const requested = await requestRefund({
        orderId: order.id,
        amountCents: amount,
        idempotencyKey: `b32-refund-${unique()}`,
        requestedBy: admin.id,
        provider: "eupago",
      });
      await db
        .update(refundAttempts)
        .set({ providerOriginalTransactionId: trid })
        .where(eq(refundAttempts.id, requested.refund.id));

      const result = await processEupagoWebhook(
        await plainWebhook({
          trid: `R-${unique()}`,
          originalTrid: trid,
          status: "Refund",
          amount: (amount / 100).toFixed(2),
          currency: "EUR",
        })
      );
      expect(result.outcome).toBe("refund_settled");
    }

    const state = await getOrderRefundState(order.id);
    expect(state.refundedCents).toBe(5000);
    expect(state.remainingRefundableCents).toBe(5000);
    expect(state.fullyRefunded).toBe(false);
  });

  it("preserves B.3.5 over-refund protection", async () => {
    const { order, admin } = await paidOrderWithRefundBase(10000);
    await requestRefund({
      orderId: order.id,
      amountCents: 9000,
      idempotencyKey: `b32-refund-${unique()}`,
      requestedBy: admin.id,
      provider: "eupago",
    });

    await expect(
      requestRefund({
        orderId: order.id,
        amountCents: 2000,
        idempotencyKey: `b32-refund-${unique()}`,
        requestedBy: admin.id,
        provider: "eupago",
      })
    ).rejects.toBeInstanceOf(RefundError);
  });

  it("keeps an ambiguous refund request pending and reconciliation-required", async () => {
    const { order, admin } = await paidOrderWithRefundBase();
    const requested = await requestRefund({
      orderId: order.id,
      amountCents: 2500,
      idempotencyKey: `b32-refund-${unique()}`,
      requestedBy: admin.id,
      provider: "eupago",
    });

    let calls = 0;
    const ambiguous = (async (url: string) => {
      if (String(url).includes("/auth/token")) {
        return new Response(JSON.stringify({ access_token: "t", expires_in: 300 }), { status: 200 });
      }
      calls += 1;
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }) as unknown as typeof fetch;

    const result = await executeEupagoRefund({
      refundId: requested.refund.id,
      actorId: admin.id,
      config: CONFIG,
      fetchImpl: ambiguous,
    });

    expect(result.outcome).toBe("reconciliation_required");
    expect(result.refund.status).toBe("pending");
    expect(result.refund.recoveryState).toBe("reconciliation_required");
    // Exactly one provider request — no blind retry.
    expect(calls).toBe(1);
  });

  it("surfaces an IBAN/BIC requirement as explicit operator intervention", async () => {
    const { order, admin } = await paidOrderWithRefundBase();
    const requested = await requestRefund({
      orderId: order.id,
      amountCents: 2500,
      idempotencyKey: `b32-refund-${unique()}`,
      requestedBy: admin.id,
      provider: "eupago",
    });

    const needsIban = (async (url: string) =>
      String(url).includes("/auth/token")
        ? new Response(JSON.stringify({ access_token: "t", expires_in: 300 }), { status: 200 })
        : new Response(JSON.stringify({ message: "IBAN and BIC are required for this refund" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          })) as unknown as typeof fetch;

    const result = await executeEupagoRefund({
      refundId: requested.refund.id,
      actorId: admin.id,
      config: CONFIG,
      fetchImpl: needsIban,
    });

    expect(result.outcome).toBe("operator_required");
    if (result.outcome !== "operator_required") throw new Error("unreachable");
    expect(result.code).toBe("IBAN_BIC_REQUIRED");
    expect(result.refund.status).toBe("pending");
    expect(result.refund.operatorActionCode).toBe("IBAN_BIC_REQUIRED");

    const audits = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "refund.operator_intervention_required"));
    expect(audits).toHaveLength(1);
  });

  it("never mutates stock, order status or payments rows from refund settlement", async () => {
    const { order, product, admin, trid } = await paidOrderWithRefundBase();

    const [productBefore] = await db.select().from(products).where(eq(products.id, product.id));
    const [orderBefore] = await db.select().from(orders).where(eq(orders.id, order.id));
    const paymentsBefore = await db.select().from(payments).where(eq(payments.orderId, order.id));

    const requested = await requestRefund({
      orderId: order.id,
      amountCents: 2500,
      idempotencyKey: `b32-refund-${unique()}`,
      requestedBy: admin.id,
      provider: "eupago",
    });
    await db
      .update(refundAttempts)
      .set({ providerOriginalTransactionId: trid })
      .where(eq(refundAttempts.id, requested.refund.id));

    await processEupagoWebhook(
      await plainWebhook({
        trid: `R-${unique()}`,
        originalTrid: trid,
        status: "Refund",
        amount: "25.00",
        currency: "EUR",
      })
    );

    const [productAfter] = await db.select().from(products).where(eq(products.id, product.id));
    const [orderAfter] = await db.select().from(orders).where(eq(orders.id, order.id));
    const paymentsAfter = await db.select().from(payments).where(eq(payments.orderId, order.id));

    expect(productAfter.stock).toBe(productBefore.stock);
    expect(productAfter.reservedStock).toBe(productBefore.reservedStock);
    expect(productAfter.soldCount).toBe(productBefore.soldCount);
    expect(orderAfter.status).toBe(orderBefore.status);
    expect(orderAfter.paymentStatus).toBe(orderBefore.paymentStatus);
    expect(paymentsAfter.map((p) => p.status)).toEqual(paymentsBefore.map((p) => p.status));
  });

  it("rejects a refund event whose originalTrid is unknown", async () => {
    const result = await processEupagoWebhook(
      await plainWebhook({
        trid: `R-${unique()}`,
        originalTrid: `T-unknown-${unique()}`,
        status: "Refund",
        amount: "25.00",
        currency: "EUR",
      })
    );
    expect(result.outcome).toBe("mismatch");
    expect(result.code).toBe("ORIGINAL_PAYMENT_NOT_FOUND");
  });
});

// ─── Bank transfer regression ─────────────────────────────

describe("B.3.2 — bank transfer remains unchanged", () => {
  it("still confirms a manual bank transfer order without any provider involvement", async () => {
    const product = await createProduct();
    const [order] = await db
      .insert(orders)
      .values({
        orderNumber: `B32-${unique()}`,
        status: "pending_payment",
        paymentStatus: "pending",
        subtotal: "50.00",
        shipping: "0.00",
        discount: "0.00",
        vat: "0.00",
        total: "50.00",
        deliveryType: "pickup",
        paymentMethod: "bank_transfer",
        reservationExpiresAt: new Date(Date.now() + 3_600_000),
      })
      .returning();

    await db.insert(orderItems).values({
      orderId: order.id,
      productId: product.id,
      productName: product.name,
      productSku: product.sku,
      quantity: 1,
      unitPriceGross: "50.00",
      unitPriceNet: "50.00",
      vatRate: "0.00",
      vatAmount: "0.00",
      discountAmount: "0.00",
      lineTotalGross: "50.00",
    });
    await db.update(products).set({ reservedStock: 1 }).where(eq(products.id, product.id));
    await db.insert(payments).values({
      orderId: order.id,
      provider: "manual",
      method: "bank_transfer",
      amount: "50.00",
      currency: "EUR",
      status: "pending",
    });

    const result = await confirmOrderPayment(order.id, null);
    expect(result.success).toBe(true);
    expect(result.changed).toBe(true);

    const [confirmed] = await db.select().from(orders).where(eq(orders.id, order.id)).limit(1);
    expect(confirmed.status).toBe("paid");

    const [paymentRow] = await db.select().from(payments).where(eq(payments.orderId, order.id));
    expect(paymentRow.provider).toBe("manual");
    expect(paymentRow.method).toBe("bank_transfer");
    expect(paymentRow.status).toBe("paid");

    // No provider attempt or webhook ledger row was created for bank transfer.
    expect(await db.select().from(paymentAttempts).where(eq(paymentAttempts.orderId, order.id))).toHaveLength(0);
    expect(await db.select().from(providerWebhookEvents)).toHaveLength(0);
  });
});
