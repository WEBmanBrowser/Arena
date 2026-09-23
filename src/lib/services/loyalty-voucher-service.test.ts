import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import { auditLogs, loyaltyPointMovements, loyaltyVouchers, orderStatusHistory, orders, users } from "@/db/schema";
import { eq, inArray, like } from "drizzle-orm";
import { createLoyaltyVoucher, consumeLoyaltyVoucherForOrder, releaseLoyaltyVoucherReservationForOrder, reserveLoyaltyVoucher } from "@/lib/services/loyalty-voucher-service";
import { getLoyaltySummary } from "@/lib/services/loyalty-service";
import { cancelOrder, confirmOrderPayment, releaseExpiredReservations } from "@/lib/orders";

async function cleanup() {
  const testUsers = await db.select({ id: users.id }).from(users).where(like(users.email, "s331-%@test.local"));
  const userIds = testUsers.map((row) => row.id);
  if (userIds.length) {
    await db.delete(loyaltyVouchers).where(inArray(loyaltyVouchers.userId, userIds));
    await db.delete(loyaltyPointMovements).where(inArray(loyaltyPointMovements.userId, userIds));
  }
  const testOrders = await db.select({ id: orders.id }).from(orders).where(like(orders.orderNumber, "S331-%"));
  const orderIds = testOrders.map((row) => row.id);
  if (orderIds.length) {
    await db.delete(orderStatusHistory).where(inArray(orderStatusHistory.orderId, orderIds));
    await db.delete(orders).where(inArray(orders.id, orderIds));
  }
  if (userIds.length) {
    await db.delete(auditLogs).where(inArray(auditLogs.userId, userIds));
    await db.delete(users).where(inArray(users.id, userIds));
  }
}

async function customer(points = 500) {
  const [user] = await db.insert(users).values({ email: `s331-${Date.now()}-${Math.random()}@test.local`, password: "x", name: "S331", role: "customer" }).returning();
  await db.insert(loyaltyPointMovements).values({ userId: user.id, type: "adjustment", pointsDelta: points, idempotencyKey: `s331-seed-${user.id}-${Date.now()}`, reason: "S33.1 test seed" });
  return user;
}

async function pendingOrder(userId: number, expired = false) {
  const [order] = await db.insert(orders).values({ orderNumber: `S331-${Date.now()}-${Math.random()}`, userId, status: "pending_payment", paymentStatus: "pending", subtotal: "10.00", shipping: "0.00", discount: "0.00", vat: "0.00", total: "10.00", deliveryType: "pickup", paymentMethod: "bank_transfer", reservationExpiresAt: expired ? new Date(Date.now() - 60_000) : new Date(Date.now() + 3_600_000) }).returning();
  return order;
}

beforeEach(cleanup);
afterEach(cleanup);

describe("S33.1 loyalty vouchers", () => {
  it("creates a cryptographically-random-shaped voucher and debits points immediately", async () => {
    const user = await customer(500);
    const voucher = await createLoyaltyVoucher(user.id, 500);
    expect(voucher.code).toMatch(/^MDT-[23456789A-HJ-NP-Z]{4}-[23456789A-HJ-NP-Z]{4}-[23456789A-HJ-NP-Z]{4}$/);
    expect(voucher).toMatchObject({ userId: user.id, points: 500, valueCents: 500, status: "active" });
    expect((await getLoyaltySummary(user.id)).balancePoints).toBe(0);
  });

  it("rejects non-100-point increments and insufficient balance", async () => {
    const user = await customer(500);
    await expect(createLoyaltyVoucher(user.id, 550)).rejects.toThrow(/múltiplo inteiro de 100/);
    await expect(createLoyaltyVoucher(user.id, 600)).rejects.toThrow(/Saldo de pontos insuficiente/);
  });

  it("serializes concurrent redemption so the same balance cannot be spent twice", async () => {
    const user = await customer(500);
    const results = await Promise.allSettled([createLoyaltyVoucher(user.id, 500), createLoyaltyVoucher(user.id, 500)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect((await getLoyaltySummary(user.id)).balancePoints).toBe(0);
  });

  it("reserves idempotently, releases, then can reserve again", async () => {
    const user = await customer(500);
    const voucher = await createLoyaltyVoucher(user.id, 500);
    const order = await pendingOrder(user.id);
    expect((await reserveLoyaltyVoucher(voucher.code, user.id, order.id)).status).toBe("reserved");
    expect((await reserveLoyaltyVoucher(voucher.code, user.id, order.id)).status).toBe("reserved");
    const released = await releaseLoyaltyVoucherReservationForOrder(order.id);
    expect(released).toHaveLength(1);
    expect((await reserveLoyaltyVoucher(voucher.code, user.id, order.id)).status).toBe("reserved");
  });

  it("consumes once and cannot be reused", async () => {
    const user = await customer(500);
    const voucher = await createLoyaltyVoucher(user.id, 500);
    const first = await pendingOrder(user.id);
    await reserveLoyaltyVoucher(voucher.code, user.id, first.id);
    await db.update(orders).set({ status: "paid", paymentStatus: "paid" }).where(eq(orders.id, first.id));
    expect((await consumeLoyaltyVoucherForOrder(first.id)).changed).toBe(true);
    expect((await consumeLoyaltyVoucherForOrder(first.id)).changed).toBe(false);
    const second = await pendingOrder(user.id);
    await expect(reserveLoyaltyVoucher(voucher.code, user.id, second.id)).rejects.toThrow(/indisponível ou já utilizado/);
  });
  it("consumes a reserved voucher atomically when the canonical payment flow confirms the order", async () => {
    const user = await customer(500);
    const voucher = await createLoyaltyVoucher(user.id, 500);
    const order = await pendingOrder(user.id);

    await reserveLoyaltyVoucher(voucher.code, user.id, order.id);

    const first = await confirmOrderPayment(order.id, user.id, { source: "manual" });
    expect(first.success).toBe(true);
    expect(first.changed).toBe(true);

    const [used] = await db.select().from(loyaltyVouchers).where(eq(loyaltyVouchers.id, voucher.id));
    expect(used.status).toBe("used");
    expect(used.reservedOrderId).toBeNull();
    expect(used.usedOrderId).toBe(order.id);
    expect(used.usedAt).not.toBeNull();

    const second = await confirmOrderPayment(order.id, user.id, { source: "manual" });
    expect(second.success).toBe(true);
    expect(second.changed).toBe(false);

    const [afterRepeat] = await db.select().from(loyaltyVouchers).where(eq(loyaltyVouchers.id, voucher.id));
    expect(afterRepeat.status).toBe("used");
    expect(afterRepeat.usedOrderId).toBe(order.id);
  });

  it("releases a reserved voucher when a pending order is cancelled", async () => {
    const user = await customer(500);
    const voucher = await createLoyaltyVoucher(user.id, 500);
    const order = await pendingOrder(user.id);
    await reserveLoyaltyVoucher(voucher.code, user.id, order.id);
    expect((await cancelOrder(order.id, user.id)).success).toBe(true);
    const [after] = await db.select().from(loyaltyVouchers).where(eq(loyaltyVouchers.id, voucher.id));
    expect(after.status).toBe("active");
    expect(after.reservedOrderId).toBeNull();
  });

  it("releases a reserved voucher when a pending order expires", async () => {
    const user = await customer(500);
    const voucher = await createLoyaltyVoucher(user.id, 500);
    const order = await pendingOrder(user.id, true);
    await reserveLoyaltyVoucher(voucher.code, user.id, order.id);
    expect((await releaseExpiredReservations()).expired).toBeGreaterThanOrEqual(1);
    const [after] = await db.select().from(loyaltyVouchers).where(eq(loyaltyVouchers.id, voucher.id));
    expect(after.status).toBe("active");
    expect(after.reservedOrderId).toBeNull();
  });

});
