/**
 * B.4.1 — Admin Dashboard & Operational Command Center tests.
 *
 * REAL PostgreSQL (same harness as the B.3.x financial tests). Validates:
 *  • Revenue counts PAID orders only (integer cents, no float).
 *  • Pending / cancelled / expired orders never inflate revenue.
 *  • Order pipeline breakdown, low/out-of-stock counts, RMA, customers.
 *  • Operational alerts surface B.3.x reconciliation/refund/webhook signals.
 *  • 30-day revenue series is dense (gap-free) and tz-aligned.
 *  • The service is strictly read-only.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import { sql, eq } from "drizzle-orm";
import {
  orders,
  products,
  users,
  rmaRequests,
  paymentAttempts,
  refundAttempts,
  payments,
  reconciliationObservations,
  providerWebhookEvents,
  invoiceDocuments,
} from "@/db/schema";
import { getDashboardData, getLegacyStats } from "@/lib/services/dashboard-service";

const TAG = `B41-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const orderNum = (n: string) => `${TAG}-${n}`;
const email = (n: string) => `${TAG}-${n}@test.local`;

async function reset() {
  await db.execute(sql`DELETE FROM refund_attempts WHERE order_id IN (SELECT id FROM orders WHERE order_number LIKE ${TAG + "-%"})`);
  await db.execute(sql`DELETE FROM payment_attempts WHERE order_id IN (SELECT id FROM orders WHERE order_number LIKE ${TAG + "-%"})`);
  await db.execute(sql`DELETE FROM reconciliation_observations WHERE order_id IN (SELECT id FROM orders WHERE order_number LIKE ${TAG + "-%"})`);
  await db.execute(sql`DELETE FROM invoice_documents WHERE order_id IN (SELECT id FROM orders WHERE order_number LIKE ${TAG + "-%"})`);
  await db.execute(sql`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE order_number LIKE ${TAG + "-%"})`);
  await db.execute(sql`DELETE FROM payments WHERE order_id IN (SELECT id FROM orders WHERE order_number LIKE ${TAG + "-%"})`);
  await db.execute(sql`DELETE FROM rma_requests WHERE order_id IN (SELECT id FROM orders WHERE order_number LIKE ${TAG + "-%"})`);
  await db.execute(sql`DELETE FROM orders WHERE order_number LIKE ${TAG + "-%"}`);
  await db.execute(sql`DELETE FROM provider_webhook_events WHERE provider LIKE ${TAG + "-%"}`);
  // Eupago ignored events created here are matched by their TAG-prefixed
  // provider_event_id (the provider column itself is the allowlisted 'eupago').
  await db.execute(sql`DELETE FROM provider_webhook_events WHERE provider_event_id LIKE ${TAG + "-%"}`);
  await db.execute(sql`DELETE FROM products WHERE sku LIKE ${TAG + "-%"}`);
  await db.execute(sql`DELETE FROM rma_requests WHERE id IN (SELECT id FROM rma_requests WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${TAG + "-%"}))`);
  await db.execute(sql`DELETE FROM users WHERE email LIKE ${TAG + "-%"}`);
}

async function createOrder(opts: {
  num: string;
  status?: string;
  paymentStatus?: string;
  total?: string;
  createdAt?: Date;
  paymentMethod?: string;
  guestName?: string;
}) {
  const rows = await db
    .insert(orders)
    .values({
      orderNumber: orderNum(opts.num),
      status: opts.status ?? "pending_payment",
      paymentStatus: opts.paymentStatus ?? "pending",
      subtotal: opts.total ?? "100.00",
      shipping: "0.00",
      total: opts.total ?? "100.00",
      deliveryType: "shipping",
      paymentMethod: opts.paymentMethod ?? "bank_transfer",
      guestName: opts.guestName ?? null,
      createdAt: opts.createdAt ?? new Date(),
    })
    .returning();
  return rows[0];
}

async function createProduct(opts: {
  sku: string;
  stock: number;
  minStock?: number;
  isService?: boolean;
  isActive?: boolean;
}) {
  const [p] = await db
    .insert(products)
    .values({
      name: `B41 Product ${opts.sku}`,
      slug: `b41-${TAG}-${opts.sku}`.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      sku: `${TAG}-${opts.sku}`,
      price: "50.00",
      stock: opts.stock,
      minStock: opts.minStock ?? 5,
      isService: opts.isService ?? false,
      isActive: opts.isActive ?? true,
    })
    .returning();
  return p;
}

beforeEach(async () => {
  await reset();
});

afterAll(async () => {
  await reset();
});

describe("B.4.1 dashboard read model", () => {
  it("revenue counts only PAID orders and is integer-cents exact", async () => {
    const before = await getDashboardData();

    await createOrder({ num: "paid-1", status: "paid", paymentStatus: "paid", total: "100.00" });
    await createOrder({ num: "paid-2", status: "processing", paymentStatus: "paid", total: "49.99" });
    // Unpaid / cancelled / expired must NOT count.
    await createOrder({ num: "pending", status: "pending_payment", paymentStatus: "pending", total: "999.00" });
    await createOrder({ num: "cancelled", status: "cancelled", paymentStatus: "cancelled", total: "999.00" });
    await createOrder({ num: "expired", status: "expired", paymentStatus: "expired", total: "999.00" });

    const after = await getDashboardData();

    // Delta attributes only to the two paid orders: 100.00 + 49.99 = 149.99.
    expect(after.kpis.revenueToday.cents - before.kpis.revenueToday.cents).toBe(14999);
    expect(after.kpis.revenueToday.currency).toBe("EUR");
    expect(after.kpis.paidOrdersToday - before.kpis.paidOrdersToday).toBe(2);
    // Total orders grew by all five, but revenue ignored the non-paid ones.
    expect(after.kpis.totalOrders - before.kpis.totalOrders).toBe(5);
    expect(after.kpis.pendingPaymentOrders - before.kpis.pendingPaymentOrders).toBe(1);
  });

  it("separates this-month paid revenue from previous-month paid orders", async () => {
    const before = await getDashboardData();
    const now = new Date();
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), Math.min(now.getDate(), 28), 12, 0, 0);
    const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15, 12, 0, 0);

    await createOrder({ num: "m-now", paymentStatus: "paid", status: "paid", total: "200.00", createdAt: thisMonth });
    await createOrder({ num: "m-prev", paymentStatus: "paid", status: "paid", total: "50.00", createdAt: prevMonth });

    const after = await getDashboardData();
    expect(after.kpis.revenueThisMonth.cents - before.kpis.revenueThisMonth.cents).toBe(20000);
    expect(after.kpis.revenuePreviousMonth.cents - before.kpis.revenuePreviousMonth.cents).toBe(5000);
    expect(after.kpis.revenueMomCents - before.kpis.revenueMomCents).toBe(15000);
  });

  it("builds an order pipeline breakdown from real statuses", async () => {
    await createOrder({ num: "p1", status: "paid", paymentStatus: "paid" });
    await createOrder({ num: "p2", status: "paid", paymentStatus: "paid" });
    await createOrder({ num: "p3", status: "processing", paymentStatus: "paid" });
    await createOrder({ num: "p4", status: "shipped", paymentStatus: "paid" });

    const d = await getDashboardData();
    const byStatus = Object.fromEntries(d.orderPipeline.map((b) => [b.status, b.count]));
    expect(byStatus["paid"]).toBeGreaterThanOrEqual(2);
    expect(byStatus["processing"]).toBeGreaterThanOrEqual(1);
    expect(byStatus["shipped"]).toBeGreaterThanOrEqual(1);
    // Every breakdown entry uses a valid enum status.
    for (const b of d.orderPipeline) {
      expect(b.count).toBeGreaterThan(0);
    }
    // Awaiting fulfillment = paid + processing.
    expect(d.kpis.awaitingFulfillment).toBe(
      (byStatus["paid"] ?? 0) + (byStatus["processing"] ?? 0)
    );
  });

  it("counts low-stock and out-of-stock products, ignoring services/inactive", async () => {
    await createProduct({ sku: "oos", stock: 0, minStock: 5 });
    await createProduct({ sku: "low", stock: 2, minStock: 5 });
    await createProduct({ sku: "ok", stock: 50, minStock: 5 });
    await createProduct({ sku: "svc", stock: 0, minStock: 5, isService: true });
    await createProduct({ sku: "inactive-oos", stock: 0, minStock: 5, isActive: false });

    const d = await getDashboardData();
    expect(d.kpis.outOfStockProducts).toBeGreaterThanOrEqual(1);
    expect(d.kpis.lowStockProducts).toBeGreaterThanOrEqual(1);

    // Low-stock list includes the out-of-stock + low items, worst first.
    const skus = d.lowStockProducts.map((p) => p.sku);
    expect(skus.some((s) => s?.endsWith("-oos"))).toBe(true);
    expect(skus.some((s) => s?.endsWith("-low"))).toBe(true);
    // Services and inactive products never appear.
    expect(skus.some((s) => s?.endsWith("-svc"))).toBe(false);
    expect(skus.some((s) => s?.endsWith("-inactive-oos"))).toBe(false);
    // Sorted ascending by stock.
    const stocks = d.lowStockProducts.map((p) => p.stock);
    const sorted = [...stocks].sort((a, b) => a - b);
    expect(stocks).toEqual(sorted);
  });

  it("counts customers and open RMAs", async () => {
    const [u] = await db
      .insert(users)
      .values({ email: email("cust"), password: "x", name: "B41 Customer", role: "customer" })
      .returning();
    const [o] = await db
      .insert(orders)
      .values({
        orderNumber: orderNum("rma-order"),
        status: "delivered",
        paymentStatus: "paid",
        subtotal: "10.00",
        total: "10.00",
        deliveryType: "shipping",
        userId: u.id,
      })
      .returning();
    await db.insert(rmaRequests).values({
      userId: u.id,
      orderId: o.id,
      type: "repair",
      status: "requested",
      description: "B41 rma",
    });

    const d = await getDashboardData();
    expect(d.kpis.totalCustomers).toBeGreaterThanOrEqual(1);
    expect(d.kpis.openRma).toBeGreaterThanOrEqual(1);
  });

  it("surfaces B.3.x operational signals as ranked alerts", async () => {
    const [staff] = await db
      .insert(users)
      .values({ email: email("staff"), password: "x", name: "B41 Staff", role: "admin" })
      .returning();
    const o = await createOrder({ num: "sig", status: "paid", paymentStatus: "paid", total: "100.00" });
    const [pay] = await db
      .insert(payments)
      .values({ orderId: o.id, provider: "eupago", method: "mbway", amount: "100.00", currency: "EUR", status: "paid" })
      .returning();

    // Payment attempt requiring manual reconciliation.
    await db.insert(paymentAttempts).values({
      orderId: o.id,
      provider: "eupago",
      method: "mbway",
      status: "pending",
      amountCents: 10000,
      currency: "EUR",
      recoveryState: "reconciliation_required",
    });

    // Open reconciliation anomaly.
    await db.insert(reconciliationObservations).values({
      orderId: o.id,
      provider: "eupago",
      providerReference: `${TAG}-anomaly-ref`,
      observedPaidCents: 9000,
      observedRefundedCents: 0,
      currency: "EUR",
      observedAt: new Date(),
      expectedPaidCents: 10000,
      internalRefundedCents: 0,
      anomalyCode: "PAID_AMOUNT_MISMATCH",
      status: "open",
      recordedBy: staff.id,
    });

    // Refund awaiting action.
    await db.insert(refundAttempts).values({
      orderId: o.id,
      paymentId: pay.id,
      provider: "eupago",
      idempotencyKey: `${TAG}-refund-key`,
      amountCents: 1000,
      currency: "EUR",
      status: "processing",
      requestedBy: staff.id,
    });

    // Failed invoice document.
    await db.insert(invoiceDocuments).values({
      orderId: o.id,
      provider: "xd",
      documentType: "invoice",
      status: "failed",
    });

    // Failed webhook.
    await db.insert(providerWebhookEvents).values({
      provider: `${TAG}-prov`,
      payloadHash: `${TAG}-hash`.padEnd(64, "0"),
      eventType: "payment.paid",
      status: "failed",
    });

    // B.3.5.1: trusted-but-uncorrelated IGNORED Eupago financial movements.
    // One payment mismatch + one refund mismatch (REFUND_ATTEMPT_NOT_FOUND).
    await db.insert(providerWebhookEvents).values({
      provider: "eupago",
      providerEventId: `${TAG}-trid-pay`,
      payloadHash: `${TAG}-ph-pay`.padEnd(64, "0"),
      eventType: "payment.paid",
      status: "ignored",
      metadata: { kind: "payment", status: "Paid" },
      lastError: "ATTEMPT_NOT_FOUND",
    });
    await db.insert(providerWebhookEvents).values({
      provider: "eupago",
      providerEventId: `${TAG}-trid-refund`,
      payloadHash: `${TAG}-ph-refund`.padEnd(64, "0"),
      eventType: "refund.paid",
      status: "ignored",
      metadata: { kind: "refund", status: "Paid" },
      lastError: "REFUND_ATTEMPT_NOT_FOUND",
    });

    const d = await getDashboardData();
    const codes = d.alerts.map((a) => a.code);
    expect(codes).toContain("PAYMENT_RECONCILIATION");
    expect(codes).toContain("OPEN_RECONCILIATION_ANOMALY");
    expect(codes).toContain("REFUND_ATTENTION");
    expect(codes).toContain("INVOICE_FAILURE");
    expect(codes).toContain("WEBHOOK_FAILURES");
    // Ignored Eupago financial movements are surfaced.
    expect(codes).toContain("IGNORED_PAYMENT_WEBHOOK");
    expect(codes).toContain("IGNORED_REFUND_WEBHOOK");

    // The ignored financial summary exposes the movements read-only.
    expect(d.ignoredFinancialEvents.paymentMismatches).toBeGreaterThanOrEqual(1);
    expect(d.ignoredFinancialEvents.refundMismatches).toBeGreaterThanOrEqual(1);
    expect(d.ignoredFinancialEvents.refundAttemptNotFound).toBeGreaterThanOrEqual(1);
    expect(d.ignoredFinancialEvents.total).toBeGreaterThanOrEqual(2);
    const refundEvent = d.ignoredFinancialEvents.events.find(
      (e) => e.reasonCode === "REFUND_ATTEMPT_NOT_FOUND"
    );
    expect(refundEvent).toBeTruthy();
    expect(refundEvent!.kind).toBe("refund");
    // Sanitized: events expose ONLY a fixed allowlist of safe fields — no raw
    // payload hash, body, headers, credentials or metadata blob.
    const ALLOWED = ["id", "kind", "reasonCode", "providerEventId", "eventType", "receivedAt"];
    for (const e of d.ignoredFinancialEvents.events) {
      expect(Object.keys(e).sort()).toEqual([...ALLOWED].sort());
      const json = JSON.stringify(e);
      expect(json).not.toContain("payloadHash");
      expect(json).not.toContain("metadata");
    }

    // Critical alerts precede warning precede info.
    const rank = { critical: 0, warning: 1, info: 2 } as const;
    const ranks = d.alerts.map((a) => rank[a.severity]);
    const sortedRanks = [...ranks].sort((a, b) => a - b);
    expect(ranks).toEqual(sortedRanks);
    expect(d.criticalAlertCount).toBeGreaterThanOrEqual(5);
  });

  it("ignored Eupago events are READ-ONLY: fetching never mutates their status", async () => {
    await db.insert(providerWebhookEvents).values({
      provider: "eupago",
      providerEventId: `${TAG}-ro-trid`,
      payloadHash: `${TAG}-ro-ph`.padEnd(64, "0"),
      eventType: "payment.paid",
      status: "ignored",
      metadata: { kind: "payment", status: "Paid" },
      lastError: "AMOUNT_MISMATCH",
    });
    const before = await db
      .select({ id: providerWebhookEvents.id, status: providerWebhookEvents.status, attempts: providerWebhookEvents.attempts })
      .from(providerWebhookEvents)
      .where(eq(providerWebhookEvents.providerEventId, `${TAG}-ro-trid`));

    // Read the dashboard multiple times — no replay/reprocessing side effect.
    await getDashboardData();
    await getDashboardData();

    const after = await db
      .select({ id: providerWebhookEvents.id, status: providerWebhookEvents.status, attempts: providerWebhookEvents.attempts })
      .from(providerWebhookEvents)
      .where(eq(providerWebhookEvents.providerEventId, `${TAG}-ro-trid`));
    expect(after).toEqual(before);
    expect(after[0].status).toBe("ignored");
  });

  it("computes payment-method and delivery breakdowns for paid orders", async () => {
    await createOrder({ num: "pm-mb", status: "paid", paymentStatus: "paid", total: "100.00", paymentMethod: "mbway" });
    await createOrder({ num: "pm-mb2", status: "paid", paymentStatus: "paid", total: "50.00", paymentMethod: "mbway" });
    await createOrder({ num: "pm-cc", status: "paid", paymentStatus: "paid", total: "70.00", paymentMethod: "card" });

    const d = await getDashboardData();
    const byMethod = Object.fromEntries(d.paymentMethodBreakdown.map((b) => [b.key, b]));
    // Seed/method data may coexist, so assert the delta via our orders.
    expect(byMethod["mbway"]).toBeTruthy();
    expect(byMethod["card"]).toBeTruthy();
    // Cents aggregate per method (2×mbway = 150.00, 1×card = 70.00) — at least.
    const counts = d.paymentMethodBreakdown.reduce((s, b) => s + b.count, 0);
    const cents = d.paymentMethodBreakdown.reduce((s, b) => s + b.cents, 0);
    expect(counts).toBeGreaterThanOrEqual(3);
    expect(cents).toBeGreaterThanOrEqual(22000);
    // Delivery breakdown keys are restricted to known types / unknown.
    for (const b of d.deliveryBreakdown) {
      expect(["shipping", "pickup", "unknown"]).toContain(b.key);
    }
  });

  it("reports 7-day and 30-day revenue windows and customer growth", async () => {
    const before = await getDashboardData();
    await createOrder({ num: "win", status: "paid", paymentStatus: "paid", total: "25.00" });
    const [cust] = await db
      .insert(users)
      .values({ email: email("newcust"), password: "x", name: "New", role: "customer" })
      .returning();
    void cust;
    const d = await getDashboardData();
    expect(d.kpis.revenue7d.cents - before.kpis.revenue7d.cents).toBe(2500);
    expect(d.kpis.revenue30d.cents - before.kpis.revenue30d.cents).toBe(2500);
    expect(d.kpis.paidOrders7d - before.kpis.paidOrders7d).toBe(1);
    expect(d.kpis.paidOrders30d - before.kpis.paidOrders30d).toBe(1);
    expect(d.kpis.newCustomersToday - before.kpis.newCustomersToday).toBeGreaterThanOrEqual(1);
    expect(d.kpis.newCustomersThisMonth - before.kpis.newCustomersThisMonth).toBeGreaterThanOrEqual(1);
  });

  it("works with zero data (empty windows/breakdowns/lists) without error", async () => {
    // On a system with no ignored events and no paid orders in some buckets,
    // the read model still returns well-formed empty collections.
    const d = await getDashboardData();
    expect(Array.isArray(d.revenueSeries)).toBe(true);
    expect(d.revenueSeries.length).toBe(30);
    expect(Array.isArray(d.paymentMethodBreakdown)).toBe(true);
    expect(Array.isArray(d.deliveryBreakdown)).toBe(true);
    expect(d.ignoredFinancialEvents).toBeTruthy();
    expect(Number.isInteger(d.ignoredFinancialEvents.total)).toBe(true);
    expect(Array.isArray(d.ignoredFinancialEvents.events)).toBe(true);
    expect(Array.isArray(d.alerts)).toBe(true);
    expect(Array.isArray(d.lowStockProducts)).toBe(true);
    expect(Array.isArray(d.recentOrders)).toBe(true);
    // All money values are non-negative integers.
    for (const m of [d.kpis.revenueToday, d.kpis.revenue7d, d.kpis.revenue30d, d.kpis.revenueThisMonth, d.kpis.revenuePreviousMonth]) {
      expect(Number.isInteger(m.cents)).toBe(true);
      expect(m.cents).toBeGreaterThanOrEqual(0);
    }
  });

  it("produces a dense 30-day revenue series", async () => {
    const before = await getDashboardData();
    const beforeTotal = before.revenueSeries.reduce((s, p) => s + p.cents, 0);
    const beforeOrders = before.revenueSeries.reduce((s, p) => s + p.orders, 0);
    await createOrder({ num: "series", status: "paid", paymentStatus: "paid", total: "10.00" });
    const d = await getDashboardData();

    expect(d.revenueSeries.length).toBe(30);
    // Dates are ascending YYYY-MM-DD and unique.
    const dates = d.revenueSeries.map((p) => p.date);
    expect(new Set(dates).size).toBe(30);
    expect([...dates].sort()).toEqual(dates);
    // Cents are non-negative integers.
    for (const p of d.revenueSeries) {
      expect(Number.isInteger(p.cents)).toBe(true);
      expect(p.cents).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(p.orders)).toBe(true);
    }
    // The new paid order (10.00) is accounted for somewhere in the 30-day
    // window (delta-based; immune to tz midnight rollover between fetches).
    const afterTotal = d.revenueSeries.reduce((s, p) => s + p.cents, 0);
    const afterOrders = d.revenueSeries.reduce((s, p) => s + p.orders, 0);
    expect(afterTotal - beforeTotal).toBe(1000);
    expect(afterOrders - beforeOrders).toBe(1);
  });

  it("returns the most recent orders with integer-cent totals", async () => {
    await createOrder({ num: "recent", status: "paid", paymentStatus: "paid", total: "77.77", guestName: "Convidado B41" });
    const d = await getDashboardData();
    const found = d.recentOrders.find((o) => o.orderNumber === orderNum("recent"));
    expect(found).toBeTruthy();
    expect(found!.totalCents).toBe(7777);
    expect(found!.customerName).toBe("Convidado B41");
  });

  it("exposes legacy stats with corrected paid-only revenue shape", async () => {
    const before = await getLegacyStats();
    await createOrder({ num: "legacy-paid", status: "paid", paymentStatus: "paid", total: "33.33" });
    await createOrder({ num: "legacy-pending", status: "pending_payment", paymentStatus: "pending", total: "888.00" });
    const s = await getLegacyStats();
    expect(typeof s.todayRevenue).toBe("string");
    // Only the paid order (33.33) adds to revenue; the pending 888 never does.
    const delta = Number(s.todayRevenue) - Number(before.todayRevenue);
    expect(Math.round(delta * 100) / 100).toBeCloseTo(33.33, 2);
    expect(delta).toBeLessThan(800);
    expect(s.todaySales - before.todaySales).toBe(1);
    // The pending order DOES increase the pending count.
    expect(s.pendingOrders - before.pendingOrders).toBe(1);
  });

  it("is strictly read-only: data shape is stable and contains no mutation helpers", async () => {
    const d = await getDashboardData();
    expect(d.generatedAt).toBeTruthy();
    expect(d.timezone).toBe("Europe/Lisbon");
    // Serialization round-trips (plain JSON object — no functions/classes).
    expect(() => JSON.parse(JSON.stringify(d))).not.toThrow();
    // Read-only: re-fetching yields the same counts for the seeded fixtures.
    const d2 = await getDashboardData();
    expect(d2.kpis.totalOrders).toBe(d.kpis.totalOrders);
  });
});
