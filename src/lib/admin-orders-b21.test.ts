/**
 * B.2.1 — Admin Order Management: service-level tests (real database).
 * Covers list (pagination/COUNT, search fields, combinable filters, sorting,
 * date validation incl. full-day dateTo), detail (snapshots, customer/guest,
 * addresses, payments, status history, changedBy), state-machine reuse and
 * tracking (set/change/clear/no-op/audit/255 limit).
 *
 * Uses ONLY local test fixtures with a unique marker — no real secrets.
 */
process.env.TZ = "UTC";

import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/db";
import { auditLogs, orderItems, orderStatusHistory, orders, payments, products, users } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import {
  AdminOrderValidationError,
  getAdminOrderDetail,
  listAdminOrders,
  updateAdminOrderStatus,
  updateOrderTracking,
} from "@/lib/services/admin-orders-service";

const MARKER = `b21x-${Date.now()}`;
const ACTOR_EMAIL = `${MARKER}-actor@test.local`;
const CUSTOMER_EMAIL = `${MARKER}-customer@test.local`;
const PRODUCT_SKU = `${MARKER}-P1`;

async function reset() {
  const like = `b21x-%`; // cleans fixtures from THIS run and any previous run
  await db.execute(sql`DELETE FROM order_status_history WHERE order_id IN (SELECT id FROM orders WHERE order_number LIKE ${like})`);
  await db.execute(sql`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE order_number LIKE ${like})`);
  await db.execute(sql`DELETE FROM payments WHERE order_id IN (SELECT id FROM orders WHERE order_number LIKE ${like})`);
  await db.execute(sql`DELETE FROM stock_movements WHERE product_id IN (SELECT id FROM products WHERE sku LIKE ${like})`);
  await db.execute(sql`DELETE FROM audit_logs WHERE entity = 'order' AND entity_id IN (SELECT id FROM orders WHERE order_number LIKE ${like})`);
  await db.execute(sql`DELETE FROM orders WHERE order_number LIKE ${like}`);
  await db.execute(sql`DELETE FROM users WHERE email LIKE ${like}`);
  await db.execute(sql`DELETE FROM products WHERE sku LIKE ${like}`);
}

/** Insert-or-fetch shared fixture entities (idempotent across calls in one test). */
async function ensureEntities() {
  await db.insert(users).values({ email: ACTOR_EMAIL, password: "hash", name: "B21X Actor", role: "admin" }).onConflictDoNothing();
  await db.insert(users).values({
    email: CUSTOMER_EMAIL, password: "hash", name: `Cliente Registado ${MARKER}`, role: "customer",
    phone: "911111111", nif: "111111111",
  }).onConflictDoNothing();
  await db.insert(products).values({
    name: `Produto ${MARKER}`, slug: `${MARKER}-p`, sku: PRODUCT_SKU, price: "100.00", vatRate: "23.00", stock: 10, reservedStock: 1,
  }).onConflictDoNothing();

  const [actor] = await db.select().from(users).where(eq(users.email, ACTOR_EMAIL)).limit(1);
  const [customer] = await db.select().from(users).where(eq(users.email, CUSTOMER_EMAIL)).limit(1);
  const [product] = await db.select().from(products).where(eq(products.sku, PRODUCT_SKU)).limit(1);
  return { actor, customer, product };
}

type FixtureOrder = {
  orderNumber: string;
  status?: string;
  paymentStatus?: string;
  deliveryType?: string;
  total?: string;
  createdAt?: Date;
  userId?: number | null;
  guestName?: string | null;
  guestEmail?: string | null;
  guestPhone?: string | null;
};

async function fixture(overrides: FixtureOrder) {
  const entities = await ensureEntities();
  const o: FixtureOrder & { status: string; paymentStatus: string; deliveryType: string; total: string; createdAt: Date } = {
    status: "pending_payment",
    paymentStatus: "pending",
    deliveryType: "pickup",
    total: "100.00",
    createdAt: new Date("2026-03-01T10:00:00.000Z"),
    userId: entities.customer.id,
    guestName: null, guestEmail: null, guestPhone: null,
    ...overrides,
  };

  const [order] = await db.insert(orders).values({
    orderNumber: o.orderNumber,
    userId: o.userId,
    guestName: o.guestName, guestEmail: o.guestEmail, guestPhone: o.guestPhone,
    status: o.status, paymentStatus: o.paymentStatus,
    subtotal: o.total, discount: "0.00", shipping: "0.00", vat: "0.00", total: o.total,
    deliveryType: o.deliveryType, paymentMethod: "bank_transfer",
    billingAddress: { name: "Morada Faturação", address1: "Rua de Teste 1", address2: "Andar 2", postalCode: "4900-000", city: "Viana do Castelo", country: "Portugal" },
    shippingAddress: o.deliveryType === "shipping"
      ? { name: "Morada Envio", address1: "Av. do Envio 9", city: "Braga", postalCode: "4700-000", country: "Portugal" }
      : null,
    createdAt: o.createdAt, updatedAt: o.createdAt,
  }).returning();

  await db.insert(orderItems).values({
    orderId: order.id, productId: entities.product.id,
    productName: `Snapshot ${MARKER}`, productSku: `${MARKER}-SNAP`,
    quantity: 1, unitPriceGross: o.total, unitPriceNet: "81.30", vatRate: "23.00",
    vatAmount: "18.70", discountAmount: "0.00", lineTotalGross: o.total,
  });
  await db.insert(payments).values({
    orderId: order.id, provider: "manual", method: "bank_transfer",
    amount: o.total, currency: "EUR", status: o.paymentStatus === "paid" ? "paid" : "pending",
  });
  return { ...entities, order };
}

function trackingAudits(orderId: number) {
  return db.select().from(auditLogs)
    .where(sql`${auditLogs.action} = 'order.tracking_updated' AND ${auditLogs.entityId} = ${orderId}`);
}

describe("B.2.1 Admin orders — list", () => {
  beforeEach(reset);

  it("pagination: server-side paging with correct COUNT and totalPages", async () => {
    const { customer } = await fixture({ orderNumber: `${MARKER}-1` });
    await fixture({ orderNumber: `${MARKER}-2`, userId: customer.id, createdAt: new Date("2026-03-02T10:00:00.000Z") });
    await fixture({ orderNumber: `${MARKER}-3`, userId: customer.id, createdAt: new Date("2026-03-03T10:00:00.000Z") });

    const search = customer.email; // unique marker — finds exactly these 3 orders
    const p1 = await listAdminOrders({ search, page: 1, pageSize: 2 });
    expect(p1.orders).toHaveLength(2);
    expect(p1.pagination.total).toBe(3); // COUNT correct (not inflated by the users join)
    expect(p1.pagination.totalPages).toBe(2);
    expect(p1.pagination.page).toBe(1);
    expect(p1.pagination.pageSize).toBe(2);

    const p2 = await listAdminOrders({ search, page: 2, pageSize: 2 });
    expect(p2.orders).toHaveLength(1);
  });

  it("search: by orderNumber", async () => {
    const { order } = await fixture({ orderNumber: `${MARKER}-1` });
    const r = await listAdminOrders({ search: order.orderNumber });
    expect(r.orders.some(o => o.id === order.id)).toBe(true);
  });

  it("search: by guestEmail and guestName", async () => {
    const { order } = await fixture({
      orderNumber: `${MARKER}-1`,
      guestName: `Guest Nome ${MARKER}`, guestEmail: `guest-${MARKER}@mail.test`, guestPhone: "922222222", userId: null,
    });
    const byEmail = await listAdminOrders({ search: `guest-${MARKER}@mail.test` });
    expect(byEmail.orders.some(o => o.id === order.id)).toBe(true);
    const byName = await listAdminOrders({ search: `Guest Nome ${MARKER}` });
    expect(byName.orders.some(o => o.id === order.id)).toBe(true);
  });

  it("search: by registered users.email and users.name", async () => {
    const { order, customer } = await fixture({ orderNumber: `${MARKER}-1` });
    const byEmail = await listAdminOrders({ search: customer.email });
    expect(byEmail.orders.some(o => o.id === order.id)).toBe(true);
    const byName = await listAdminOrders({ search: `Cliente Registado ${MARKER}` });
    expect(byName.orders.some(o => o.id === order.id)).toBe(true);
  });

  it("search with unknown marker term returns empty result", async () => {
    await fixture({ orderNumber: `${MARKER}-1` });
    const r = await listAdminOrders({ search: `nao-existe-${MARKER}` });
    expect(r.pagination.total).toBe(0);
    expect(r.orders).toHaveLength(0);
  });

  it("filters: status, paymentStatus, deliveryType", async () => {
    const { order, customer } = await fixture({ orderNumber: `${MARKER}-1` }); // pending/pending/pickup
    const paid = await fixture({
      orderNumber: `${MARKER}-2`, userId: customer.id, status: "paid", paymentStatus: "paid",
      deliveryType: "shipping", createdAt: new Date("2026-03-02T10:00:00.000Z"),
    });
    const search = customer.email;

    expect((await listAdminOrders({ search, status: "paid" })).orders.map(o => o.id)).toContain(paid.order.id);
    expect((await listAdminOrders({ search, status: "paid" })).orders.map(o => o.id)).not.toContain(order.id);
    expect((await listAdminOrders({ search, paymentStatus: "pending" })).orders.map(o => o.id)).toContain(order.id);
    expect((await listAdminOrders({ search, deliveryType: "shipping" })).orders.map(o => o.id)).toContain(paid.order.id);
    expect((await listAdminOrders({ search, deliveryType: "pickup" })).orders.map(o => o.id)).toContain(order.id);
  });

  it("filters: combinable (status + paymentStatus + deliveryType + date range)", async () => {
    const { customer } = await fixture({ orderNumber: `${MARKER}-1` }); // pending/pending/pickup — 2026-03-01
    const target = await fixture({
      orderNumber: `${MARKER}-2`, userId: customer.id, status: "paid", paymentStatus: "paid",
      deliveryType: "shipping", createdAt: new Date("2026-03-05T12:00:00.000Z"),
    });
    await fixture({
      orderNumber: `${MARKER}-3`, userId: customer.id, status: "cancelled", paymentStatus: "cancelled",
      deliveryType: "shipping", createdAt: new Date("2026-03-06T12:00:00.000Z"),
    });

    const r = await listAdminOrders({
      search: customer.email,
      status: "paid", paymentStatus: "paid", deliveryType: "shipping",
      dateFrom: "2026-03-04", dateTo: "2026-03-06",
    });
    expect(r.orders.map(o => o.id)).toEqual([target.order.id]);
  });

  it("sorting whitelist: newest / oldest / total_desc / total_asc", async () => {
    const { customer } = await fixture({ orderNumber: `${MARKER}-a`, total: "100.00", createdAt: new Date("2026-03-01T10:00:00.000Z") });
    await fixture({ orderNumber: `${MARKER}-b`, userId: customer.id, total: "300.00", createdAt: new Date("2026-03-02T10:00:00.000Z") });
    await fixture({ orderNumber: `${MARKER}-c`, userId: customer.id, total: "200.00", createdAt: new Date("2026-03-03T10:00:00.000Z") });
    const search = customer.email;

    expect((await listAdminOrders({ search, sort: "newest" })).orders.map(o => o.orderNumber)).toEqual([`${MARKER}-c`, `${MARKER}-b`, `${MARKER}-a`]);
    expect((await listAdminOrders({ search, sort: "oldest" })).orders.map(o => o.orderNumber)).toEqual([`${MARKER}-a`, `${MARKER}-b`, `${MARKER}-c`]);
    expect((await listAdminOrders({ search, sort: "total_desc" })).orders.map(o => o.total)).toEqual(["300.00", "200.00", "100.00"]);
    expect((await listAdminOrders({ search, sort: "total_asc" })).orders.map(o => o.total)).toEqual(["100.00", "200.00", "300.00"]);
  });

  it("query validation: invalid enum filters are rejected server-side", async () => {
    await expect(listAdminOrders({ status: "bogus" })).rejects.toBeInstanceOf(AdminOrderValidationError);
    await expect(listAdminOrders({ paymentStatus: "bogus" })).rejects.toBeInstanceOf(AdminOrderValidationError);
    await expect(listAdminOrders({ deliveryType: "teleport" })).rejects.toBeInstanceOf(AdminOrderValidationError);
    await expect(listAdminOrders({ sort: "random" })).rejects.toBeInstanceOf(AdminOrderValidationError);
  });

  it("date validation: invalid format → error", async () => {
    await expect(listAdminOrders({ dateFrom: "31-12-2026" })).rejects.toThrow(AdminOrderValidationError);
    await expect(listAdminOrders({ dateTo: "2026/12/31" })).rejects.toThrow(AdminOrderValidationError);
  });

  it("date validation: non-existent calendar date → error", async () => {
    await expect(listAdminOrders({ dateFrom: "2026-02-30" })).rejects.toThrow(AdminOrderValidationError);
    await expect(listAdminOrders({ dateTo: "2026-13-01" })).rejects.toThrow(AdminOrderValidationError);
  });

  it("date validation: dateFrom > dateTo → error", async () => {
    await expect(listAdminOrders({ dateFrom: "2026-03-10", dateTo: "2026-03-01" })).rejects.toThrow(AdminOrderValidationError);
  });

  it("dateTo includes the ENTIRE final day (23:59:59.999)", async () => {
    const { customer } = await fixture({ orderNumber: `${MARKER}-1` }); // 2026-03-01T10:00
    const lateNight = await fixture({
      orderNumber: `${MARKER}-late`, userId: customer.id, createdAt: new Date("2026-03-05T23:30:00.000Z"),
    });
    const nextDay = await fixture({
      orderNumber: `${MARKER}-next`, userId: customer.id, createdAt: new Date("2026-03-06T00:10:00.000Z"),
    });

    const r = await listAdminOrders({ search: customer.email, dateFrom: "2026-03-01", dateTo: "2026-03-05" });
    const ids = r.orders.map(o => o.id);
    expect(ids).toContain(lateNight.order.id);  // whole final day included
    expect(ids).toContain((await orderRow(`${MARKER}-1`))!.id);
    expect(ids).not.toContain(nextDay.order.id); // the day after is excluded
  });

  it("dateFrom starts at 00:00:00.000 of its day (order on the same day is included)", async () => {
    await fixture({ orderNumber: `${MARKER}-1` }); // createdAt 2026-03-01T10:00
    const r = await listAdminOrders({ search: MARKER, dateFrom: "2026-03-01", dateTo: "2026-03-01" });
    expect(r.orders.map(o => o.orderNumber)).toContain(`${MARKER}-1`);
  });
});

async function orderRow(orderNumber: string) {
  const [row] = await db.select().from(orders).where(eq(orders.orderNumber, orderNumber)).limit(1);
  return row ?? null;
}

describe("B.2.1 Admin orders — detail", () => {
  beforeEach(reset);

  it("returns order, items (snapshots), payments, history and allowed transitions for registered customer", async () => {
    const { order, customer } = await fixture({ orderNumber: `${MARKER}-1` });
    const detail = await getAdminOrderDetail(order.id);
    expect(detail.order.id).toBe(order.id);
    expect(detail.order.allowedTransitions).toEqual(["paid", "cancelled", "expired"]);
    expect(detail.items[0].productName).toBe(`Snapshot ${MARKER}`);
    expect(detail.items[0].productSku).toBe(`${MARKER}-SNAP`);
    expect(detail.payments[0].method).toBe("bank_transfer");
    expect(detail.customer?.id).toBe(customer.id);
    expect(detail.customer?.email).toBe(customer.email);
    expect(detail.customer?.phone).toBe("911111111");
    expect(detail.customer?.nif).toBe("111111111");
  });

  it("guest order: customer is null and guest fields are on the order", async () => {
    const { order } = await fixture({
      orderNumber: `${MARKER}-1`, userId: null,
      guestName: `Guest ${MARKER}`, guestEmail: `guest-${MARKER}@mail.test`, guestPhone: "933333333",
    });
    const detail = await getAdminOrderDetail(order.id);
    expect(detail.customer).toBeNull();
    expect(detail.order.guestName).toBe(`Guest ${MARKER}`);
    expect(detail.order.guestEmail).toBe(`guest-${MARKER}@mail.test`);
    expect(detail.order.guestPhone).toBe("933333333");
  });

  it("addresses are structured objects (billing + shipping)", async () => {
    const { order } = await fixture({ orderNumber: `${MARKER}-1`, deliveryType: "shipping" });
    const detail = await getAdminOrderDetail(order.id);
    expect(detail.order.billingAddress).toMatchObject({ city: "Viana do Castelo", postalCode: "4900-000", country: "Portugal" });
    expect(detail.order.shippingAddress).toMatchObject({ city: "Braga" });
  });

  it("item snapshots are NEVER replaced with current product data", async () => {
    const { order, product } = await fixture({ orderNumber: `${MARKER}-1` });
    await db.update(products).set({ name: "NOME ATUAL ALTERADO", price: "999.00", vatRate: "6.00" }).where(eq(products.id, product.id));
    const detail = await getAdminOrderDetail(order.id);
    expect(detail.items[0].productName).toBe(`Snapshot ${MARKER}`);
    expect(detail.items[0].unitPriceGross).toBe("100.00");
    expect(detail.items[0].vatRate).toBe("23.00");
    expect(detail.items[0].lineTotalGross).toBe("100.00");
  });

  it("status history includes the user who made the change (changedBy join)", async () => {
    const { order, actor } = await fixture({ orderNumber: `${MARKER}-1` });
    await db.insert(orderStatusHistory).values({
      orderId: order.id, fromStatus: "pending_payment", toStatus: "paid", changedBy: actor.id, comment: "Pago via admin",
    });
    const detail = await getAdminOrderDetail(order.id);
    expect(detail.statusHistory[0].toStatus).toBe("paid");
    expect(detail.statusHistory[0].changedByName).toBe("B21X Actor");
    expect(detail.statusHistory[0].changedBy).toBe(actor.id);
  });

  it("unknown order throws ORDER_NOT_FOUND", async () => {
    await expect(getAdminOrderDetail(999999999)).rejects.toThrow("ORDER_NOT_FOUND");
  });
});

describe("B.2.1 Admin orders — state machine reuse", () => {
  beforeEach(reset);

  it("invalid transition is rejected by the CENTRAL state machine and status is unchanged", async () => {
    const { order, actor } = await fixture({ orderNumber: `${MARKER}-1` });
    await expect(updateAdminOrderStatus(order.id, "shipped", actor.id)).rejects.toThrow();
    const check = await orderRow(order.orderNumber);
    expect(check!.status).toBe("pending_payment");
  });

  it("valid transition pending_payment → paid runs the real confirmOrderPayment flow", async () => {
    const { order, actor, product } = await fixture({ orderNumber: `${MARKER}-1` });
    const detail = await updateAdminOrderStatus(order.id, "paid", actor.id, "Pago manualmente");
    expect(detail.order.status).toBe("paid");
    const [payment] = await db.select().from(payments).where(eq(payments.orderId, order.id));
    expect(payment.status).toBe("paid");
    const [p] = await db.select().from(products).where(eq(products.id, product.id));
    expect(p.stock).toBe(9); // reservation converted to sale (Phase A logic)
    expect(p.reservedStock).toBe(0);
    expect(detail.statusHistory.some(h => h.fromStatus === "pending_payment" && h.toStatus === "paid")).toBe(true);
  });

  it("expired is system-only — the admin service refuses it", async () => {
    const { order, actor } = await fixture({ orderNumber: `${MARKER}-1` });
    await expect(updateAdminOrderStatus(order.id, "expired", actor.id)).rejects.toThrow(AdminOrderValidationError);
    const check = await orderRow(order.orderNumber);
    expect(check!.status).toBe("pending_payment");
  });

  it("invalid status value is rejected", async () => {
    const { order, actor } = await fixture({ orderNumber: `${MARKER}-1` });
    await expect(updateAdminOrderStatus(order.id, "bogus", actor.id)).rejects.toThrow(AdminOrderValidationError);
  });
});

describe("B.2.1 Admin orders — tracking", () => {
  beforeEach(reset);

  it("set tracking → changed + audit with old/new", async () => {
    const { order, actor } = await fixture({ orderNumber: `${MARKER}-1` });
    const r = await updateOrderTracking(order.id, "TRK-001", actor.id);
    expect(r.changed).toBe(true);
    const [audit] = await trackingAudits(order.id);
    expect(audit).toBeTruthy();
    expect(audit.details).toMatchObject({ oldTrackingNumber: null, newTrackingNumber: "TRK-001" });
    expect(r.order.order.trackingNumber).toBe("TRK-001");
  });

  it("change tracking → audit records previous value", async () => {
    const { order, actor } = await fixture({ orderNumber: `${MARKER}-1` });
    await updateOrderTracking(order.id, "TRK-001", actor.id);
    const r = await updateOrderTracking(order.id, "TRK-002", actor.id);
    expect(r.changed).toBe(true);
    const rows = await trackingAudits(order.id);
    expect(rows).toHaveLength(2);
    expect(rows[1].details).toMatchObject({ oldTrackingNumber: "TRK-001", newTrackingNumber: "TRK-002" });
  });

  it("clear tracking with empty string → null + audit", async () => {
    const { order, actor } = await fixture({ orderNumber: `${MARKER}-1` });
    await updateOrderTracking(order.id, "TRK-001", actor.id);
    const r = await updateOrderTracking(order.id, "", actor.id);
    expect(r.changed).toBe(true);
    const check = await orderRow(order.orderNumber);
    expect(check!.trackingNumber).toBeNull();
    const rows = await trackingAudits(order.id);
    expect(rows[rows.length - 1].details).toMatchObject({ oldTrackingNumber: "TRK-001", newTrackingNumber: null });
  });

  it("no-op (same value) → changed=false and NO audit entry", async () => {
    const { order, actor } = await fixture({ orderNumber: `${MARKER}-1` });
    await updateOrderTracking(order.id, "TRK-001", actor.id);
    const before = await trackingAudits(order.id);
    const r = await updateOrderTracking(order.id, "TRK-001", actor.id);
    expect(r.changed).toBe(false);
    const after = await trackingAudits(order.id);
    expect(after).toHaveLength(before.length); // no new audit on no-op
  });

  it("tracking longer than 255 chars → TRACKING_TOO_LONG, no audit", async () => {
    const { order, actor } = await fixture({ orderNumber: `${MARKER}-1` });
    await expect(updateOrderTracking(order.id, "X".repeat(256), actor.id)).rejects.toThrow("TRACKING_TOO_LONG");
    const rows = await trackingAudits(order.id);
    expect(rows).toHaveLength(0);
  });

  it("255 chars is accepted (boundary)", async () => {
    const { order, actor } = await fixture({ orderNumber: `${MARKER}-1` });
    const r = await updateOrderTracking(order.id, "X".repeat(255), actor.id);
    expect(r.changed).toBe(true);
  });
});
