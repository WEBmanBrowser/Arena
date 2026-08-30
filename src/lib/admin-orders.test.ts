import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/db";
import { auditLogs, orderItems, orders, payments, products, users } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { getAdminOrderDetail, listAdminOrders, updateAdminOrderStatus, updateOrderTracking } from "@/lib/services/admin-orders-service";

async function reset() {
  await db.execute(sql`DELETE FROM order_status_history WHERE order_id IN (SELECT id FROM orders WHERE order_number LIKE 'B21-%')`);
  await db.execute(sql`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE order_number LIKE 'B21-%')`);
  await db.execute(sql`DELETE FROM payments WHERE order_id IN (SELECT id FROM orders WHERE order_number LIKE 'B21-%')`);
  await db.execute(sql`DELETE FROM stock_movements WHERE product_id IN (SELECT id FROM products WHERE sku LIKE 'B21-%') OR user_id IN (SELECT id FROM users WHERE email LIKE 'b21-%@test.local')`);
  await db.execute(sql`DELETE FROM audit_logs WHERE action LIKE 'order.%' OR user_id IN (SELECT id FROM users WHERE email LIKE 'b21-%@test.local')`);
  await db.execute(sql`DELETE FROM orders WHERE order_number LIKE 'B21-%'`);
  await db.execute(sql`DELETE FROM users WHERE email LIKE 'b21-%@test.local'`);
  await db.execute(sql`DELETE FROM products WHERE sku LIKE 'B21-%'`);
}

async function fixture() {
  const [actor] = await db.insert(users).values({ email: `b21-actor-${Date.now()}@test.local`, password: "hash", name: "B21 Actor", role: "admin" }).returning();
  const [customer] = await db.insert(users).values({ email: `b21-customer-${Date.now()}@test.local`, password: "hash", name: "B21 Customer", role: "customer", phone: "912345678", nif: "123456789" }).returning();
  const [product] = await db.insert(products).values({ name: "B21 Product", slug: `b21-product-${Date.now()}`, sku: `B21-P-${Date.now()}`, price: "100.00", vatRate: "23.00", stock: 10, reservedStock: 1 }).returning();
  const [order] = await db.insert(orders).values({
    orderNumber: `B21-${Date.now()}`,
    userId: customer.id,
    status: "pending_payment",
    paymentStatus: "pending",
    subtotal: "100.00",
    discount: "0.00",
    shipping: "0.00",
    vat: "18.70",
    total: "100.00",
    deliveryType: "pickup",
    paymentMethod: "bank_transfer",
    billingAddress: { name: "B21 Customer", city: "Esposende" },
  }).returning();
  await db.insert(orderItems).values({
    orderId: order.id,
    productId: product.id,
    productName: "Snapshot Name",
    productSku: "SNAP-SKU",
    quantity: 1,
    unitPriceGross: "100.00",
    unitPriceNet: "81.30",
    vatRate: "23.00",
    vatAmount: "18.70",
    discountAmount: "0.00",
    lineTotalGross: "100.00",
  });
  await db.insert(payments).values({ orderId: order.id, provider: "manual", method: "bank_transfer", amount: "100.00", currency: "EUR", status: "pending" });
  return { actor, customer, product, order };
}

describe("Admin orders service", () => {
  beforeEach(reset);

  it("pagination", async () => {
    await fixture();
    const result = await listAdminOrders({ page: 1, pageSize: 25 });
    expect(result.pagination.page).toBe(1);
    expect(result.pagination.pageSize).toBe(25);
    expect(result.orders.length).toBeGreaterThanOrEqual(1);
  });

  it("status filter", async () => {
    const { order } = await fixture();
    const result = await listAdminOrders({ status: "pending_payment" });
    expect(result.orders.some(o => o.id === order.id)).toBe(true);
  });

  it("paymentStatus filter", async () => {
    const { order } = await fixture();
    const result = await listAdminOrders({ paymentStatus: "pending" });
    expect(result.orders.some(o => o.id === order.id)).toBe(true);
  });

  it("search by orderNumber", async () => {
    const { order } = await fixture();
    const result = await listAdminOrders({ search: order.orderNumber });
    expect(result.orders.some(o => o.id === order.id)).toBe(true);
  });

  it("search by registered customer", async () => {
    const { order, customer } = await fixture();
    const result = await listAdminOrders({ search: customer.email });
    expect(result.orders.some(o => o.id === order.id)).toBe(true);
  });

  it("detail returns order/items/customer/payment/history", async () => {
    const { order, customer } = await fixture();
    const detail = await getAdminOrderDetail(order.id);
    expect(detail.order.id).toBe(order.id);
    expect(detail.items[0].productName).toBe("Snapshot Name");
    expect(detail.customer?.email).toBe(customer.email);
    expect(detail.payments[0].method).toBe("bank_transfer");
    expect(Array.isArray(detail.statusHistory)).toBe(true);
  });

  it("invalid transition pending_payment → shipped rejected", async () => {
    const { order, actor } = await fixture();
    await expect(updateAdminOrderStatus(order.id, "shipped", actor.id)).rejects.toThrow();
    const [check] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(check.status).toBe("pending_payment");
  });

  it("valid transition pending_payment → paid uses production state machine", async () => {
    const { order, actor, product } = await fixture();
    const detail = await updateAdminOrderStatus(order.id, "paid", actor.id, "Pago manualmente");
    expect(detail.order.status).toBe("paid");
    const [payment] = await db.select().from(payments).where(eq(payments.orderId, order.id));
    expect(payment.status).toBe("paid");
    const [p] = await db.select().from(products).where(eq(products.id, product.id));
    expect(p.stock).toBe(9);
    expect(p.reservedStock).toBe(0);
  });

  it("tracking update creates audit", async () => {
    const { order, actor } = await fixture();
    const result = await updateOrderTracking(order.id, "TRK123", actor.id);
    expect(result.changed).toBe(true);
    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.action, "order.tracking_updated"));
    expect(audit.userId).toBe(actor.id);
  });

  it("tracking clear works", async () => {
    const { order, actor } = await fixture();
    await updateOrderTracking(order.id, "TRK123", actor.id);
    const result = await updateOrderTracking(order.id, null, actor.id);
    expect(result.changed).toBe(true);
    const [check] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(check.trackingNumber).toBeNull();
  });

  it("tracking no-op does not audit", async () => {
    const { order, actor } = await fixture();
    await updateOrderTracking(order.id, null, actor.id);
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.action, "order.tracking_updated"));
    expect(audits.length).toBe(0);
  });

  it("snapshot preserved after product changes", async () => {
    const { order, product } = await fixture();
    await db.update(products).set({ name: "Changed", price: "999.00", vatRate: "6.00" }).where(eq(products.id, product.id));
    const detail = await getAdminOrderDetail(order.id);
    expect(detail.items[0].productName).toBe("Snapshot Name");
    expect(detail.items[0].lineTotalGross).toBe("100.00");
    expect(detail.items[0].vatRate).toBe("23.00");
  });
});
