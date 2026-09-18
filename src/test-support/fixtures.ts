/**
 * Shared test fixtures for the PAYMENT P0 suites.
 *
 * These helpers only create ORDINARY store data (orders, stock, users) plus the
 * manual `bank_transfer` payment the checkout writes today. They never talk to a
 * provider and never use the network — provider behaviour is always simulated
 * with an injected `fetchImpl`.
 */

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
  settings,
  stockMovements,
  users,
} from "@/db/schema";
import { eq, inArray, like, or } from "drizzle-orm";
import { computeSignature } from "@/lib/providers/eupago/webhook-crypto";

export const TEST_WEBHOOK_KEY = "0123456789abcdef0123456789abcdef"; // 32 bytes, dummy

let seq = 0;
export function unique(): string {
  seq += 1;
  return `${Date.now()}${seq}${Math.floor(Math.random() * 1000)}`;
}

export interface OrderFixture {
  orderId: number;
  productId: number;
  total: string;
  orderNumber: string;
}

/** Order in `pending_payment` with one reserved stock line + manual payment. */
export async function createPendingOrder(input: {
  prefix: string;
  totalCents?: number;
  stock?: number;
  guestEmail?: string | null;
  reservedStock?: number;
  paymentMethod?: string;
}): Promise<OrderFixture> {
  const { prefix, totalCents = 5000, stock = 10, reservedStock = 1 } = input;
  const [product] = await db
    .insert(products)
    .values({
      sku: `${prefix}-${unique()}`,
      name: `${prefix} product`,
      slug: `${prefix.toLowerCase()}-${unique()}`,
      price: (totalCents / 100).toFixed(2),
      stock,
      reservedStock,
    })
    .returning();

  const total = (totalCents / 100).toFixed(2);
  const orderNumber = `${prefix}-${unique()}`;
  const [order] = await db
    .insert(orders)
    .values({
      orderNumber,
      status: "pending_payment",
      paymentStatus: "pending",
      subtotal: total,
      shipping: "0.00",
      discount: "0.00",
      vat: "0.00",
      total,
      deliveryType: "pickup",
      paymentMethod: input.paymentMethod ?? "mbway",
      guestEmail: input.guestEmail === undefined ? `cliente-${unique()}@test.local` : input.guestEmail,
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

  // Exactly what the bank_transfer-only checkout writes today (M4).
  await db.insert(payments).values({
    orderId: order.id,
    provider: "manual",
    method: input.paymentMethod ?? "bank_transfer",
    amount: total,
    currency: "EUR",
    status: "pending",
  });

  return { orderId: order.id, productId: product.id, total, orderNumber };
}

/**
 * Reset the EUPAGO ledger slice of the shared test database.
 *
 * Several suites assert ledger-environment invariants (virgin ledger, fail-closed
 * history, canonical provisioning), and the suite shares ONE database across
 * files: rows left behind by a previous file would otherwise decide the outcome.
 * Only Eupago-scoped financial rows and the internal ledger setting are touched.
 */
export async function resetEupagoLedgerSlice(): Promise<void> {
  await db.delete(settings).where(eq(settings.key, "eupago_ledger_environment"));
  await db.delete(refundAttempts).where(eq(refundAttempts.provider, "eupago"));
  await db.delete(paymentAttempts).where(eq(paymentAttempts.provider, "eupago"));
  await db.delete(payments).where(eq(payments.provider, "eupago"));
  await db.delete(providerWebhookEvents);
}

export async function createUser(prefix: string, role: "admin" | "manager" | "customer" | "staff" = "admin") {
  const [user] = await db
    .insert(users)
    .values({ email: `${prefix}-${unique()}@test.local`, password: "x", name: prefix, role })
    .returning();
  return user;
}

/** Remove everything a fixture created, scoped by the order-number prefix. */
export async function cleanupByPrefix(prefix: string): Promise<void> {
  const rows = await db
    .select({ id: orders.id })
    .from(orders)
    .where(like(orders.orderNumber, `${prefix}-%`));
  const ids = rows.map((row) => row.id);
  if (ids.length) {
    await db.delete(reconciliationObservations).where(inArray(reconciliationObservations.orderId, ids));
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
  await db.delete(products).where(like(products.sku, `${prefix}-%`));

  // audit_logs references users: detach the actors before removing them so the
  // cleanup itself cannot fail mid-suite.
  const actors = await db
    .select({ id: users.id })
    .from(users)
    .where(or(like(users.email, `${prefix}-%`), like(users.email, `cliente-${prefix}%`)));
  const actorIds = actors.map((actor) => actor.id);
  if (actorIds.length) {
    await db.update(auditLogs).set({ userId: null }).where(inArray(auditLogs.userId, actorIds));
  }
  await db.delete(users).where(or(like(users.email, `${prefix}-%`), like(users.email, `cliente-${prefix}%`)));
}

/** Signed Eupago webhook delivery (HMAC over the exact raw body). */
export async function signedWebhook(payload: Record<string, unknown>) {
  const rawBody = JSON.stringify(payload);
  const signature = await computeSignature(TEST_WEBHOOK_KEY, rawBody);
  return { rawBody, headers: { "x-signature": signature }, webhookKey: TEST_WEBHOOK_KEY };
}

export function paidWebhookPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { status: "Paid", method: "mbway", amount: "50.00", currency: "EUR", ...overrides };
}

/** Deterministic network stub: always answers with the given body. */
export function stubFetch(body: unknown, status = 201, counter?: { calls: number }): typeof fetch {
  return (async () => {
    if (counter) counter.calls += 1;
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

export async function countRows(table: "payments" | "payment_attempts", orderId: number): Promise<number> {
  const rows =
    table === "payments"
      ? await db.select({ id: payments.id }).from(payments).where(eq(payments.orderId, orderId))
      : await db.select({ id: paymentAttempts.id }).from(paymentAttempts).where(eq(paymentAttempts.orderId, orderId));
  return rows.length;
}

export async function auditActions(prefix: string): Promise<string[]> {
  const rows = await db.select({ action: auditLogs.action }).from(auditLogs).where(like(auditLogs.action, `${prefix}%`));
  return rows.map((row) => row.action);
}
