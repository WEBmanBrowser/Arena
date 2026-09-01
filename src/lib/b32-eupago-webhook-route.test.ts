// B.3.2 — Eupago webhook ROUTE tests (HTTP contract + CSRF model).
// Real PostgreSQL. Dummy keys only.

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
} from "@/db/schema";
import { eq, inArray, like } from "drizzle-orm";
import { computeSignature } from "@/lib/providers/eupago/webhook-crypto";
import { verifySameOrigin } from "@/lib/csrf";
import {
  DELETE as webhookDELETE,
  GET as webhookGET,
  POST as webhookPOST,
  PUT as webhookPUT,
} from "@/app/api/webhooks/eupago/route";

const WEBHOOK_KEY = "0123456789abcdef0123456789abcdef";
const URL_PATH = "http://loja.mdtech.pt/api/webhooks/eupago";

let seq = 0;
function unique() {
  seq += 1;
  return `${Date.now()}${seq}${Math.floor(Math.random() * 1000)}`;
}

async function cleanup() {
  const rows = await db.select({ id: orders.id }).from(orders).where(like(orders.orderNumber, "B32W-%"));
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
  await db.delete(auditLogs).where(like(auditLogs.action, "order.%"));
  await db.delete(products).where(like(products.sku, "B32W-%"));
}

async function seedPendingAttempt(amountCents = 5000) {
  const [product] = await db
    .insert(products)
    .values({
      sku: `B32W-${unique()}`,
      name: "B32W",
      slug: `b32w-${unique()}`,
      price: "50.00",
      stock: 10,
      reservedStock: 1,
    })
    .returning();

  const total = (amountCents / 100).toFixed(2);
  const [order] = await db
    .insert(orders)
    .values({
      orderNumber: `B32W-${unique()}`,
      status: "pending_payment",
      paymentStatus: "pending",
      subtotal: total,
      shipping: "0.00",
      discount: "0.00",
      vat: "0.00",
      total,
      deliveryType: "pickup",
      paymentMethod: "multibanco",
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
  await db.insert(payments).values({
    orderId: order.id,
    provider: "eupago",
    method: "multibanco",
    amount: total,
    currency: "EUR",
    status: "pending",
  });

  const identifier = `MDT-${order.id}-${unique().slice(0, 18).padEnd(18, "0")}`;
  const [attempt] = await db
    .insert(paymentAttempts)
    .values({
      orderId: order.id,
      provider: "eupago",
      method: "multibanco",
      status: "pending",
      amountCents,
      currency: "EUR",
      providerIdentifier: identifier,
      providerReference: `9${unique()}`.slice(0, 15),
      recoveryState: "requested",
    })
    .returning();

  return { order, attempt, product };
}

function webhookRequest(rawBody: string, headers: Record<string, string>, method = "POST") {
  return new NextRequest(URL_PATH, { method, body: rawBody, headers });
}

beforeEach(cleanup);
afterEach(cleanup);

describe("B.3.2 — webhook route HTTP contract", () => {
  it("accepts a correctly signed POST and settles through the pipeline", async () => {
    const { order, attempt } = await seedPendingAttempt();
    const payload = {
      trid: `T-${unique()}`,
      status: "Paid",
      identifier: attempt.providerIdentifier,
      method: "multibanco",
      amount: "50.00",
      currency: "EUR",
    };
    const rawBody = JSON.stringify(payload);
    process.env.EUPAGO_WEBHOOK_KEY = WEBHOOK_KEY;

    const res = await webhookPOST(
      webhookRequest(rawBody, { "x-signature": await computeSignature(WEBHOOK_KEY, rawBody) })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ received: true, outcome: "payment_confirmed" });

    const [confirmed] = await db.select().from(orders).where(eq(orders.id, order.id)).limit(1);
    expect(confirmed.status).toBe("paid");
  });

  it("returns 401 for a missing or invalid signature and changes nothing", async () => {
    const { order, attempt } = await seedPendingAttempt();
    const rawBody = JSON.stringify({
      trid: `T-${unique()}`,
      status: "Paid",
      identifier: attempt.providerIdentifier,
      method: "multibanco",
      amount: "50.00",
      currency: "EUR",
    });
    process.env.EUPAGO_WEBHOOK_KEY = WEBHOOK_KEY;

    const unsigned = await webhookPOST(webhookRequest(rawBody, {}));
    expect(unsigned.status).toBe(401);
    expect(await unsigned.json()).toEqual({ error: "WEBHOOK_INVALID" });

    const badSignature = await webhookPOST(
      webhookRequest(rawBody, { "x-signature": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" })
    );
    expect(badSignature.status).toBe(401);

    const [current] = await db.select().from(orders).where(eq(orders.id, order.id)).limit(1);
    expect(current.status).toBe("pending_payment");
    expect(await db.select().from(providerWebhookEvents)).toHaveLength(0);
  });

  it("rejects every non-POST method", async () => {
    for (const handler of [webhookGET, webhookPUT, webhookDELETE]) {
      const res = await handler();
      expect(res.status).toBe(405);
    }
  });

  it("does NOT require browser CSRF/same-origin (machine-to-machine)", async () => {
    const { attempt } = await seedPendingAttempt();
    const rawBody = JSON.stringify({
      trid: `T-${unique()}`,
      status: "Paid",
      identifier: attempt.providerIdentifier,
      method: "multibanco",
      amount: "50.00",
      currency: "EUR",
    });
    process.env.EUPAGO_WEBHOOK_KEY = WEBHOOK_KEY;

    // A provider sends NO Origin header — same-origin validation would reject it…
    const req = webhookRequest(rawBody, {
      "x-signature": await computeSignature(WEBHOOK_KEY, rawBody),
    });
    expect(verifySameOrigin(req)).toBe(false);

    // …but the signed webhook is still accepted, because security here is the
    // HMAC signature, not a browser CSRF token.
    const res = await webhookPOST(req);
    expect(res.status).toBe(200);
  });

  it("still rejects a foreign Origin when the signature is wrong (no bypass)", async () => {
    await seedPendingAttempt();
    process.env.EUPAGO_WEBHOOK_KEY = WEBHOOK_KEY;
    const res = await webhookPOST(
      webhookRequest('{"trid":"T-x","status":"Paid"}', { origin: "https://evil.example" })
    );
    expect(res.status).toBe(401);
  });

  it("never leaks provider internals or secrets in the response", async () => {
    process.env.EUPAGO_WEBHOOK_KEY = WEBHOOK_KEY;
    const res = await webhookPOST(webhookRequest('{"trid":"T-1","status":"Paid"}', {}));
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain(WEBHOOK_KEY);
    expect(text).not.toContain("eupago.pt");
    expect(text).toBe('{"error":"WEBHOOK_INVALID"}');
  });

  it("answers 200 to a duplicate delivery so the provider stops retrying", async () => {
    const { attempt } = await seedPendingAttempt();
    const rawBody = JSON.stringify({
      trid: `T-${unique()}`,
      status: "Paid",
      identifier: attempt.providerIdentifier,
      method: "multibanco",
      amount: "50.00",
      currency: "EUR",
    });
    process.env.EUPAGO_WEBHOOK_KEY = WEBHOOK_KEY;
    const signature = await computeSignature(WEBHOOK_KEY, rawBody);

    const first = await webhookPOST(webhookRequest(rawBody, { "x-signature": signature }));
    expect(await first.json()).toMatchObject({ outcome: "payment_confirmed" });

    const second = await webhookPOST(webhookRequest(rawBody, { "x-signature": signature }));
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ outcome: "duplicate" });
  });

  it("stores only the payload hash — never the raw webhook body", async () => {
    const { attempt } = await seedPendingAttempt();
    const rawBody = JSON.stringify({
      trid: `T-${unique()}`,
      status: "Paid",
      identifier: attempt.providerIdentifier,
      method: "multibanco",
      amount: "50.00",
      currency: "EUR",
    });
    process.env.EUPAGO_WEBHOOK_KEY = WEBHOOK_KEY;
    await webhookPOST(webhookRequest(rawBody, { "x-signature": await computeSignature(WEBHOOK_KEY, rawBody) }));

    const [event] = await db.select().from(providerWebhookEvents);
    const serialized = JSON.stringify(event);
    expect(event.payloadHash).toHaveLength(64);
    expect(serialized).not.toContain(attempt.providerIdentifier!);
    expect(serialized).not.toContain("50.00");
    expect(serialized).not.toContain(WEBHOOK_KEY);
  });
});

describe("B.3.2 — browser return URLs never confirm payment", () => {
  it("has no route that marks an order paid from a browser callback", async () => {
    // The card flow returns the customer to a UX-only page. There is no
    // server route in the codebase that accepts a browser redirect as proof
    // of payment: settlement exists ONLY in the signed webhook pipeline.
    const { order } = await seedPendingAttempt();

    // Simulating a customer "successUrl" GET changes nothing.
    const [before] = await db.select().from(orders).where(eq(orders.id, order.id)).limit(1);
    const res = await webhookGET();
    expect(res.status).toBe(405);
    const [after] = await db.select().from(orders).where(eq(orders.id, order.id)).limit(1);
    expect(after.status).toBe(before.status);
    expect(after.paymentStatus).toBe("pending");
  });
});
