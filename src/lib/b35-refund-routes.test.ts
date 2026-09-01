import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/db";
import {
  auditLogs,
  orderItems,
  orderStatusHistory,
  orders,
  payments,
  products,
  refundAttempts,
  stockMovements,
  users,
} from "@/db/schema";
import { eq, inArray, like } from "drizzle-orm";
import { confirmOrderPayment } from "@/lib/orders";

const getCurrentUserMock = vi.fn();
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getCurrentUser: () => getCurrentUserMock() };
});

import { GET as accountRefundsGET } from "@/app/api/account/refunds/route";
import { GET as adminRefundsGET, POST as adminRefundsPOST } from "@/app/api/admin/orders/[id]/refunds/route";
import { POST as refundActionPOST } from "@/app/api/admin/refunds/[id]/route";
import { POST as refundMaintenancePOST } from "@/app/api/cron/refund-maintenance/route";

let userSeq = 0;

async function createRealUser(role: "customer" | "staff" | "manager" | "admin") {
  userSeq += 1;
  const [u] = await db
    .insert(users)
    .values({
      email: `b35r-${role}-${Date.now()}-${userSeq}@test.local`,
      password: "x",
      name: `B35R ${role}`,
      role,
    })
    .returning();
  return u;
}

function mockUser(user: { id: number; role: string } | null) {
  getCurrentUserMock.mockResolvedValue(
    user ? { id: user.id, email: `b35r-${user.role}@test.local`, name: "B35R", role: user.role, phone: null, nif: null, company: null } : null
  );
}

async function createPaidOrder(opts: { total?: string; userId?: number | null; status?: string; paymentStatus?: string } = {}) {
  const total = opts.total ?? "100.00";
  const [order] = await db
    .insert(orders)
    .values({
      orderNumber: `B35R-ORD-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
      userId: opts.userId ?? null,
      status: opts.status ?? "paid",
      paymentStatus: opts.paymentStatus ?? "paid",
      subtotal: total,
      shipping: "0.00",
      total,
      deliveryType: "shipping",
      paymentMethod: "bank_transfer",
    })
    .returning();
  await db.insert(payments).values({
    orderId: order.id,
    provider: "manual",
    method: "bank_transfer",
    amount: total,
    currency: "EUR",
    status: opts.paymentStatus ?? "paid",
    paidAt: (opts.paymentStatus ?? "paid") === "paid" ? new Date() : null,
  });
  return order;
}

function postReq(url: string, body: unknown) {
  // Same-origin Origin header, exactly as a browser sends for same-site fetch.
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json", origin: new URL(url).origin },
    body: JSON.stringify(body),
  });
}

/** Cross-site POST (attacker page) — must be rejected by the CSRF guard. */
function crossOriginPostReq(url: string, body: unknown) {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example" },
    body: JSON.stringify(body),
  });
}

function getReq(url: string) {
  return new NextRequest(url, { method: "GET" });
}

beforeEach(async () => {
  getCurrentUserMock.mockReset();
  const rows = await db.select({ id: orders.id }).from(orders).where(like(orders.orderNumber, "B35R-%"));
  const orderIds = rows.map((o) => o.id);
  if (orderIds.length) {
    await db.delete(refundAttempts).where(inArray(refundAttempts.orderId, orderIds));
    await db.delete(payments).where(inArray(payments.orderId, orderIds));
    await db.delete(orderStatusHistory).where(inArray(orderStatusHistory.orderId, orderIds));
    await db.delete(orderItems).where(inArray(orderItems.orderId, orderIds));
    await db.delete(stockMovements).where(inArray(stockMovements.referenceId, orderIds));
    await db.delete(orders).where(inArray(orders.id, orderIds));
  }
  // strays from interrupted runs: stock movements / audit logs referencing b35r test users
  const b35rUsers = await db.select({ id: users.id }).from(users).where(like(users.email, "b35r-%@test.local"));
  if (b35rUsers.length) {
    const ids = b35rUsers.map((u) => u.id);
    await db.delete(stockMovements).where(inArray(stockMovements.userId, ids));
    await db.delete(auditLogs).where(inArray(auditLogs.userId, ids));
  }
  await db.delete(products).where(like(products.sku, "B35R-%"));
  await db.delete(auditLogs).where(like(auditLogs.action, "refund.%"));
  await db.delete(users).where(like(users.email, "b35r-%@test.local"));
});

async function cleanupRoutesLeftovers() {
  getCurrentUserMock.mockReset();
  const rows = await db.select({ id: orders.id }).from(orders).where(like(orders.orderNumber, "B35R-%"));
  const orderIds = rows.map((o) => o.id);
  if (orderIds.length) {
    await db.delete(refundAttempts).where(inArray(refundAttempts.orderId, orderIds));
    await db.delete(payments).where(inArray(payments.orderId, orderIds));
    await db.delete(orderStatusHistory).where(inArray(orderStatusHistory.orderId, orderIds));
    await db.delete(orderItems).where(inArray(orderItems.orderId, orderIds));
    await db.delete(stockMovements).where(inArray(stockMovements.referenceId, orderIds));
    await db.delete(orders).where(inArray(orders.id, orderIds));
  }
  // strays from interrupted runs: stock movements / audit logs referencing b35r test users
  const b35rUsers = await db.select({ id: users.id }).from(users).where(like(users.email, "b35r-%@test.local"));
  if (b35rUsers.length) {
    const ids = b35rUsers.map((u) => u.id);
    await db.delete(stockMovements).where(inArray(stockMovements.userId, ids));
    await db.delete(auditLogs).where(inArray(auditLogs.userId, ids));
  }
  await db.delete(products).where(like(products.sku, "B35R-%"));
  await db.delete(auditLogs).where(like(auditLogs.action, "refund.%"));
  await db.delete(users).where(like(users.email, "b35r-%@test.local"));
}

afterEach(async () => {
  await cleanupRoutesLeftovers();
});


describe("B.3.5 admin refund routes — RBAC", () => {
  it("blocks unauthenticated, customer and staff users from refund state and creation", async () => {
    const admin = await createRealUser("admin");
    const order = await createPaidOrder({ userId: admin.id });

    for (const role of ["customer", "staff"] as const) {
      const u = await createRealUser(role);
      mockUser(u);
      const getUrl = `http://localhost/api/admin/orders/${order.id}/refunds`;
      expect((await adminRefundsGET(getReq(getUrl), { params: Promise.resolve({ id: String(order.id) }) })).status).toBe(403);
      expect(
        (await adminRefundsPOST(postReq(getUrl, { amountCents: 100, idempotencyKey: "b35r-rbac-12345678" }), { params: Promise.resolve({ id: String(order.id) }) })).status
      ).toBe(403);
    }

    mockUser(null);
    expect((await adminRefundsGET(getReq(`http://localhost/api/admin/orders/${order.id}/refunds`), { params: Promise.resolve({ id: String(order.id) }) })).status).toBe(401);
    expect(
      (await adminRefundsPOST(postReq(`http://localhost/api/admin/orders/${order.id}/refunds`, { amountCents: 100, idempotencyKey: "b35r-rbac-12345678" }), { params: Promise.resolve({ id: String(order.id) }) })).status
    ).toBe(401);
  });

  it("manager and admin can read refund state and create refunds; audit logged", async () => {
    const manager = await createRealUser("manager");
    const order = await createPaidOrder({ userId: manager.id });
    mockUser(manager);

    const getUrl = `http://localhost/api/admin/orders/${order.id}/refunds`;
    const stateRes = await adminRefundsGET(getReq(getUrl), { params: Promise.resolve({ id: String(order.id) }) });
    expect(stateRes.status).toBe(200);
    const state = await stateRes.json();
    expect(state.refundState.paidCents).toBe(10000);

    const createRes = await adminRefundsPOST(
      postReq(getUrl, { amountCents: 2500, idempotencyKey: "b35r-manager-12345678", reason: "devolução parcial" }),
      { params: Promise.resolve({ id: String(order.id) }) }
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.refund.status).toBe("pending");
    expect(created.executionSupported).toBe(true);

    const audit = await db.select().from(auditLogs).where(like(auditLogs.action, "refund.requested"));
    expect(audit.length).toBe(1);
    expect(audit[0].userId).toBe(manager.id);

    // refund action route: manager can cancel
    const cancelRes = await refundActionPOST(
      postReq(`http://localhost/api/admin/refunds/${created.refund.id}`, { action: "cancel" }),
      { params: Promise.resolve({ id: String(created.refund.id) }) }
    );
    expect(cancelRes.status).toBe(200);
    expect((await cancelRes.json()).refund.status).toBe("cancelled");
  });

  it("rejects non-manager refund actions", async () => {
    const customer = await createRealUser("customer");
    const order = await createPaidOrder({ userId: customer.id });
    mockUser(customer);
    const res = await refundActionPOST(
      postReq(`http://localhost/api/admin/refunds/1`, { action: "cancel" }),
      { params: Promise.resolve({ id: "1" }) }
    );
    expect(res.status).toBe(403);
    mockUser(null);
    expect((await refundActionPOST(postReq(`http://localhost/api/admin/refunds/1`, { action: "cancel" }), { params: Promise.resolve({ id: "1" }) })).status).toBe(401);
  });

  it("over-refund through the API returns 409 with customer-safe message", async () => {
    const admin = await createRealUser("admin");
    const order = await createPaidOrder({ userId: admin.id });
    mockUser(admin);
    const url = `http://localhost/api/admin/orders/${order.id}/refunds`;

    const first = await adminRefundsPOST(postReq(url, { amountCents: 10000, idempotencyKey: "b35r-over-1-12345678" }), { params: Promise.resolve({ id: String(order.id) }) });
    expect(first.status).toBe(201);

    const second = await adminRefundsPOST(postReq(url, { amountCents: 1, idempotencyKey: "b35r-over-2-12345678" }), { params: Promise.resolve({ id: String(order.id) }) });
    expect(second.status).toBe(409);
    const body = await second.json();
    expect(body.code).toBe("REFUND_EXCEEDS_REFUNDABLE");
    expect(body.error).not.toMatch(/select|insert|sql|stack|database/i);
  });
});

describe("B.3.5 customer refund visibility — ownership + safety", () => {
  it("customer sees ONLY own refunds with safe fields; other customers' refunds are invisible (IDOR)", async () => {
    const owner = await createRealUser("customer");
    const other = await createRealUser("customer");
    const ownOrder = await createPaidOrder({ userId: owner.id });
    const otherOrder = await createPaidOrder({ userId: other.id });

    // refunds on both orders
    mockUser({ id: (await createRealUser("admin")).id, role: "admin" });
    await adminRefundsPOST(
      postReq(`http://localhost/api/admin/orders/${ownOrder.id}/refunds`, { amountCents: 2500, idempotencyKey: "b35r-cust-1-1234567", manualCompletion: { externalReference: "TRF-OWN", completedAt: new Date().toISOString() } }),
      { params: Promise.resolve({ id: String(ownOrder.id) }) }
    );
    await adminRefundsPOST(
      postReq(`http://localhost/api/admin/orders/${otherOrder.id}/refunds`, { amountCents: 5000, idempotencyKey: "b35r-cust-2-1234567", manualCompletion: { externalReference: "TRF-OTHER", completedAt: new Date().toISOString() } }),
      { params: Promise.resolve({ id: String(otherOrder.id) }) }
    );

    // owner lists refunds
    mockUser(owner);
    const res = await accountRefundsGET(getReq("http://localhost/api/account/refunds"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.refunds.length).toBe(1);
    expect(data.refunds[0].amountCents).toBe(2500);
    expect(data.refunds[0].orderNumber).toBe(ownOrder.orderNumber);
    // safe fields only — no internal reason/error/provider diagnostics
    const r = data.refunds[0] as Record<string, unknown>;
    expect(Object.keys(r).sort()).toEqual(["amountCents", "completedAt", "createdAt", "currency", "orderId", "orderNumber", "status"]);
    expect(r.reason).toBeUndefined();
    expect(r.errorCode).toBeUndefined();

    // owner filters by other customer's order → empty (IDOR-safe: no leak, no 500)
    const byOther = await accountRefundsGET(getReq(`http://localhost/api/account/refunds?orderId=${otherOrder.id}`));
    expect(byOther.status).toBe(200);
    expect((await byOther.json()).refunds.length).toBe(0);

    // owner filters by own order → sees it
    const byOwn = await accountRefundsGET(getReq(`http://localhost/api/account/refunds?orderId=${ownOrder.id}`));
    expect((await byOwn.json()).refunds.length).toBe(1);

    // unauthenticated rejected
    mockUser(null);
    expect((await accountRefundsGET(getReq("http://localhost/api/account/refunds"))).status).toBe(401);

    // guests (userId null) never expose refunds to authenticated customers
    const guestOrder = await createPaidOrder({ userId: null });
    mockUser({ id: (await createRealUser("admin")).id, role: "admin" });
    await adminRefundsPOST(
      postReq(`http://localhost/api/admin/orders/${guestOrder.id}/refunds`, { amountCents: 100, idempotencyKey: "b35r-guest-1-12345678", manualCompletion: { externalReference: "TRF-GUEST", completedAt: new Date().toISOString() } }),
      { params: Promise.resolve({ id: String(guestOrder.id) }) }
    );
    mockUser(owner);
    const all = await accountRefundsGET(getReq("http://localhost/api/account/refunds"));
    expect((await all.json()).refunds.every((x: { orderId: number }) => x.orderId !== guestOrder.id)).toBe(true);
  });

  it("customer cannot access admin refund endpoints at all (defense in depth)", async () => {
    const customer = await createRealUser("customer");
    const order = await createPaidOrder({ userId: customer.id });
    mockUser(customer);
    const res = await adminRefundsGET(getReq(`http://localhost/api/admin/orders/${order.id}/refunds`), { params: Promise.resolve({ id: String(order.id) }) });
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(JSON.stringify(data)).not.toMatch(/reason|error_code|errorCode/i);
  });
});

describe("B.3.5 cron refund maintenance", () => {
  it("requires the cron secret and reports stale refunds without mutating them", async () => {
    process.env.CRON_SECRET = "b35r-cron-secret-test";
    try {
      const unauthorized = await refundMaintenancePOST(new NextRequest("http://localhost/api/cron/refund-maintenance", { method: "POST" }));
      expect(unauthorized.status).toBe(401);

      const admin = await createRealUser("admin");
      const order = await createPaidOrder({ userId: admin.id });
      mockUser(admin);
      const created = await adminRefundsPOST(
        postReq(`http://localhost/api/admin/orders/${order.id}/refunds`, { amountCents: 500, idempotencyKey: "b35r-cron-1-12345678" }),
        { params: Promise.resolve({ id: String(order.id) }) }
      );
      const refund = (await created.json()).refund;

      const authorized = await refundMaintenancePOST(
        new NextRequest("http://localhost/api/cron/refund-maintenance", { method: "POST", headers: { "x-cron-secret": "b35r-cron-secret-test" } })
      );
      expect(authorized.status).toBe(200);
      const data = await authorized.json();
      expect(data.ok).toBe(true);
      // fresh refund is NOT reported as stale (other rows may exist from other suites)
      expect(data.staleRefunds.some((r: { id: number }) => r.id === refund.id)).toBe(false);

      // age it and re-check — report only, status unchanged
      await db.update(refundAttempts).set({ createdAt: new Date(Date.now() - 3_600_000 * 3) }).where(eq(refundAttempts.id, refund.id));
      const staleRes = await refundMaintenancePOST(
        new NextRequest("http://localhost/api/cron/refund-maintenance", { method: "POST", headers: { "x-cron-secret": "b35r-cron-secret-test" } })
      );
      const staleData = await staleRes.json();
      expect(staleData.staleCount).toBeGreaterThanOrEqual(1);
      expect(staleData.staleRefunds.some((r: { id: number }) => r.id === refund.id)).toBe(true);
      const [row] = await db.select().from(refundAttempts).where(eq(refundAttempts.id, refund.id)).limit(1);
      expect(row.status).toBe("pending"); // never auto-mutated
    } finally {
      delete process.env.CRON_SECRET;
    }
  });
});

describe("B.3.5 bank transfer regression", () => {
  it("bank-transfer checkout/payment flow remains functional alongside refunds", async () => {
    const customer = await createRealUser("customer");
    const [product] = await db
      .insert(products)
      .values({
        name: "B35R Product",
        slug: `b35r-product-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
        sku: `B35R-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
        price: "20.00",
        vatRate: "23.00",
        stock: 5,
        reservedStock: 1,
        isActive: true,
      })
      .returning();

    const [order] = await db
      .insert(orders)
      .values({
        orderNumber: `B35R-BT-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
        userId: customer.id,
        status: "pending_payment",
        paymentStatus: "pending",
        subtotal: "20.00",
        shipping: "0.00",
        total: "20.00",
        deliveryType: "shipping",
        paymentMethod: "bank_transfer",
      })
      .returning();
    await db.insert(payments).values({ orderId: order.id, provider: "manual", method: "bank_transfer", amount: "20.00", currency: "EUR", status: "pending" });
    await db.insert(orderItems).values({ orderId: order.id, productId: product.id, productName: "B35R Product", quantity: 1, unitPriceGross: "20.00", unitPriceNet: "16.26", lineTotalGross: "20.00" });

    // bank transfer confirmation still works through the central lifecycle
    const result = await confirmOrderPayment(order.id, customer.id);
    expect(result.success).toBe(true);
    const [paid] = await db.select().from(orders).where(eq(orders.id, order.id)).limit(1);
    expect(paid.status).toBe("paid");
    expect(paid.paymentStatus).toBe("paid");

    // and the paid order is now refundable via B.3.5
    const admin = await createRealUser("admin");
    mockUser(admin);
    const refundRes = await adminRefundsPOST(
      postReq(`http://localhost/api/admin/orders/${order.id}/refunds`, { amountCents: 2000, idempotencyKey: "b35r-bt-1-123456789", manualCompletion: { externalReference: "TRF-BT-RETURN", completedAt: new Date().toISOString() } }),
      { params: Promise.resolve({ id: String(order.id) }) }
    );
    expect(refundRes.status).toBe(201);
    const [after] = await db.select().from(orders).where(eq(orders.id, order.id)).limit(1);
    expect(after.status).toBe("paid"); // lifecycle untouched
  });
});

// ─── Review hotfix regressions ────────────────────────────

describe("B.3.5 review hotfix — CSRF on state-changing endpoints", () => {
  it("cross-origin admin refund request is rejected before any financial effect", async () => {
    const admin = await createRealUser("admin");
    const order = await createPaidOrder({ userId: admin.id });
    mockUser(admin);

    const res = await adminRefundsPOST(
      crossOriginPostReq(`http://localhost/api/admin/orders/${order.id}/refunds`, {
        amountCents: 2500,
        idempotencyKey: "b35r-csrf-1-12345678",
      }),
      { params: Promise.resolve({ id: String(order.id) }) }
    );

    expect(res.status).toBe(403);
    // and NO refund row was created
    const rows = await db.select().from(refundAttempts).where(eq(refundAttempts.orderId, order.id));
    expect(rows.length).toBe(0);
  });

  it("cross-origin refund lifecycle action is rejected and leaves status untouched", async () => {
    const admin = await createRealUser("admin");
    const order = await createPaidOrder({ userId: admin.id });
    mockUser(admin);

    const created = await adminRefundsPOST(
      postReq(`http://localhost/api/admin/orders/${order.id}/refunds`, {
        amountCents: 1000,
        idempotencyKey: "b35r-csrf-2-12345678",
      }),
      { params: Promise.resolve({ id: String(order.id) }) }
    );
    expect(created.status).toBe(201);
    const refund = (await created.json()).refund;

    const res = await refundActionPOST(
      crossOriginPostReq(`http://localhost/api/admin/refunds/${refund.id}`, {
        action: "complete",
        externalReference: "TRF-CSRF",
        completedAt: new Date().toISOString(),
      }),
      { params: Promise.resolve({ id: String(refund.id) }) }
    );

    expect(res.status).toBe(403);
    const [row] = await db.select().from(refundAttempts).where(eq(refundAttempts.id, refund.id)).limit(1);
    expect(row.status).toBe("pending"); // no state change
  });

  it("same-origin admin refund request still succeeds", async () => {
    const admin = await createRealUser("admin");
    const order = await createPaidOrder({ userId: admin.id });
    mockUser(admin);

    const res = await adminRefundsPOST(
      postReq(`http://localhost/api/admin/orders/${order.id}/refunds`, {
        amountCents: 1500,
        idempotencyKey: "b35r-csrf-3-12345678",
      }),
      { params: Promise.resolve({ id: String(order.id) }) }
    );
    expect(res.status).toBe(201);
  });
});

describe("B.3.5 review hotfix — cron fails closed without CRON_SECRET", () => {
  it("does not fall back to JWT_SECRET", async () => {
    const prevCron = process.env.CRON_SECRET;
    const prevJwt = process.env.JWT_SECRET;
    delete process.env.CRON_SECRET;
    process.env.JWT_SECRET = "jwt-secret-must-not-authorize-cron-0123456789";
    try {
      const res = await refundMaintenancePOST(
        new NextRequest("http://localhost/api/cron/refund-maintenance", {
          method: "POST",
          headers: { "x-cron-secret": "jwt-secret-must-not-authorize-cron-0123456789" },
        })
      );
      expect(res.status).toBe(401);
    } finally {
      if (prevCron === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prevCron;
      if (prevJwt === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = prevJwt;
    }
  });

  it("rejects when CRON_SECRET is absent even with no header", async () => {
    const prevCron = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    try {
      const res = await refundMaintenancePOST(
        new NextRequest("http://localhost/api/cron/refund-maintenance", { method: "POST" })
      );
      expect(res.status).toBe(401);
    } finally {
      if (prevCron === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prevCron;
    }
  });
});
