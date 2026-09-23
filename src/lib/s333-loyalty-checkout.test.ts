import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import { auditLogs, loyaltyPointMovements, loyaltyPointReservations, orderStatusHistory, orders, users } from "@/db/schema";
import { eq, inArray, like } from "drizzle-orm";
import { checkoutOrderSchema } from "@/lib/checkout-order-schema";
import { cancelOrder, confirmOrderPayment, releaseExpiredReservations } from "@/lib/orders";
import { consumeLoyaltyPointsForOrderTx, getAvailableLoyaltyPointsTx, reserveLoyaltyPointsForOrderTx } from "@/lib/services/loyalty-point-reservation-service";

let seq = 0;

async function cleanup() {
  const testUsers = await db.select({ id: users.id }).from(users).where(like(users.email, "s333-%@test.local"));
  const userIds = testUsers.map((row) => row.id);
  const testOrders = await db.select({ id: orders.id }).from(orders).where(like(orders.orderNumber, "S333-%"));
  const orderIds = testOrders.map((row) => row.id);
  if (orderIds.length) {
    await db.delete(loyaltyPointReservations).where(inArray(loyaltyPointReservations.orderId, orderIds));
    await db.delete(loyaltyPointMovements).where(inArray(loyaltyPointMovements.orderId, orderIds));
    await db.delete(orderStatusHistory).where(inArray(orderStatusHistory.orderId, orderIds));
    await db.delete(orders).where(inArray(orders.id, orderIds));
  }
  if (userIds.length) {
    await db.delete(loyaltyPointReservations).where(inArray(loyaltyPointReservations.userId, userIds));
    await db.delete(loyaltyPointMovements).where(inArray(loyaltyPointMovements.userId, userIds));
    await db.delete(auditLogs).where(inArray(auditLogs.userId, userIds));
    await db.delete(users).where(inArray(users.id, userIds));
  }
}

async function customer(points = 500) {
  seq += 1;
  const [user] = await db.insert(users).values({ email: `s333-${Date.now()}-${seq}@test.local`, password: "x", name: "S33.3", role: "customer" }).returning();
  await db.insert(loyaltyPointMovements).values({ userId: user.id, type: "adjustment", pointsDelta: points, idempotencyKey: `s333-seed-${user.id}-${Date.now()}-${seq}`, reason: "S33.3 test seed" });
  return user;
}

async function pendingOrder(userId: number, expired = false) {
  seq += 1;
  const [order] = await db.insert(orders).values({
    orderNumber: `S333-${Date.now()}-${seq}`, userId, status: "pending_payment", paymentStatus: "pending",
    subtotal: "10.00", shipping: "0.00", discount: "5.00", couponDiscount: "0.00", loyaltyDiscount: "5.00",
    loyaltyType: "points", loyaltyPoints: 500, vat: "0.00", total: "5.00", deliveryType: "pickup", paymentMethod: "bank_transfer",
    reservationExpiresAt: expired ? new Date(Date.now() - 60_000) : new Date(Date.now() + 3_600_000),
  }).returning();
  return order;
}

beforeEach(cleanup);
afterEach(cleanup);

describe("S33.3 checkout loyalty contract", () => {
  const base = { items:[{productId:1,quantity:1}], billingAddress:{name:"A",address1:"R",city:"E",postalCode:"4740-001",country:"Portugal"}, shippingAddress:null, deliveryType:"pickup", paymentMethod:"bank_transfer" };
  it("accepts a voucher", () => expect(checkoutOrderSchema.safeParse({...base, loyaltyVoucherCode:"MDT-2345-6789-ABCD"}).success).toBe(true));
  it("accepts whole 100-point increments", () => expect(checkoutOrderSchema.safeParse({...base, loyaltyPoints:500}).success).toBe(true));
  it("rejects partial increments", () => expect(checkoutOrderSchema.safeParse({...base, loyaltyPoints:150}).success).toBe(false));
  it("rejects voucher and points together", () => expect(checkoutOrderSchema.safeParse({...base, loyaltyVoucherCode:"MDT-2345-6789-ABCD", loyaltyPoints:500}).success).toBe(false));
});

describe("S33.3 direct-point reservation lifecycle", () => {
  it("reserves points without debiting the ledger and subtracts reservations from availability", async () => {
    const user = await customer(500);
    const order = await pendingOrder(user.id);
    await db.transaction((tx) => reserveLoyaltyPointsForOrderTx(tx, user.id, order.id, 500));
    expect(await getAvailableLoyaltyPointsTx(db, user.id)).toBe(0);
    const movements = await db.select().from(loyaltyPointMovements).where(eq(loyaltyPointMovements.userId, user.id));
    expect(movements.filter((row) => row.type === "redeem")).toHaveLength(0);
  });

  it("serializes concurrent reservations so one balance cannot fund two orders", async () => {
    const user = await customer(500);
    const first = await pendingOrder(user.id);
    const second = await pendingOrder(user.id);
    const results = await Promise.allSettled([
      db.transaction((tx) => reserveLoyaltyPointsForOrderTx(tx, user.id, first.id, 500)),
      db.transaction((tx) => reserveLoyaltyPointsForOrderTx(tx, user.id, second.id, 500)),
    ]);
    expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((row) => row.status === "rejected")).toHaveLength(1);
  });

  it("consumes exactly once through canonical payment confirmation", async () => {
    const user = await customer(500);
    const order = await pendingOrder(user.id);
    await db.transaction((tx) => reserveLoyaltyPointsForOrderTx(tx, user.id, order.id, 500));
    expect((await confirmOrderPayment(order.id, user.id, { source: "manual" })).changed).toBe(true);
    const [reservation] = await db.select().from(loyaltyPointReservations).where(eq(loyaltyPointReservations.orderId, order.id));
    expect(reservation.status).toBe("used");
    const redeems = await db.select().from(loyaltyPointMovements).where(eq(loyaltyPointMovements.idempotencyKey, `order:${order.id}:loyalty:redeem`));
    expect(redeems).toHaveLength(1);
    expect(redeems[0].pointsDelta).toBe(-500);
    expect((await confirmOrderPayment(order.id, user.id, { source: "manual" })).changed).toBe(false);
    expect(await db.select().from(loyaltyPointMovements).where(eq(loyaltyPointMovements.idempotencyKey, `order:${order.id}:loyalty:redeem`))).toHaveLength(1);
  });

  it("releases a pending reservation on cancellation without debiting points", async () => {
    const user = await customer(500);
    const order = await pendingOrder(user.id);
    await db.transaction((tx) => reserveLoyaltyPointsForOrderTx(tx, user.id, order.id, 500));
    expect((await cancelOrder(order.id, user.id)).success).toBe(true);
    const [reservation] = await db.select().from(loyaltyPointReservations).where(eq(loyaltyPointReservations.orderId, order.id));
    expect(reservation.status).toBe("released");
    expect(await getAvailableLoyaltyPointsTx(db, user.id)).toBe(500);
    expect(await db.select().from(loyaltyPointMovements).where(eq(loyaltyPointMovements.idempotencyKey, `order:${order.id}:loyalty:redeem`))).toHaveLength(0);
  });

  it("releases an expired reservation without debiting points", async () => {
    const user = await customer(500);
    const order = await pendingOrder(user.id, true);
    await db.transaction((tx) => reserveLoyaltyPointsForOrderTx(tx, user.id, order.id, 500));
    expect((await releaseExpiredReservations()).expired).toBeGreaterThanOrEqual(1);
    const [reservation] = await db.select().from(loyaltyPointReservations).where(eq(loyaltyPointReservations.orderId, order.id));
    expect(reservation.status).toBe("released");
    expect(await getAvailableLoyaltyPointsTx(db, user.id)).toBe(500);
  });

  it("fails closed when an idempotency-key collision does not match the reservation", async () => {
    const user = await customer(500);
    const order = await pendingOrder(user.id);
    await db.transaction((tx) => reserveLoyaltyPointsForOrderTx(tx, user.id, order.id, 500));
    await db.update(orders).set({ status: "paid", paymentStatus: "paid" }).where(eq(orders.id, order.id));
    await db.insert(loyaltyPointMovements).values({ userId: user.id, orderId: order.id, type: "redeem", pointsDelta: -100, idempotencyKey: `order:${order.id}:loyalty:redeem`, reason: "collision fixture" });
    await expect(db.transaction((tx) => consumeLoyaltyPointsForOrderTx(tx, order.id, user.id))).rejects.toThrow(/LOYALTY_INCONSISTENCY/);
    const [reservation] = await db.select().from(loyaltyPointReservations).where(eq(loyaltyPointReservations.orderId, order.id));
    expect(reservation.status).toBe("reserved");
  });
});
