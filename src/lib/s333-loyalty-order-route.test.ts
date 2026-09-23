import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/db";
import {
  auditLogs, coupons, emailNotifications, loyaltyPointMovements, loyaltyPointReservations,
  loyaltyVouchers, orderItems, orderStatusHistory, orders, payments, products, rateLimits, users,
} from "@/db/schema";
import { eq, inArray, like, or } from "drizzle-orm";
import { confirmOrderPayment } from "@/lib/orders";
import { createLoyaltyVoucher } from "@/lib/services/loyalty-voucher-service";

const getCurrentUserMock = vi.fn();
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getCurrentUser: () => getCurrentUserMock() };
});

const sendEmailMock = vi.fn(async () => true);
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return { ...actual, sendEmail: (...args: unknown[]) => sendEmailMock(...(args as [])) };
});

import { POST as ordersPOST } from "@/app/api/orders/route";

const MARKER = `s333route-${Date.now()}`;
let seq = 0;
let productId = 0;
const createdUserIds: number[] = [];

async function makeUser(points = 1000) {
  seq += 1;
  const [user] = await db.insert(users).values({
    email: `${MARKER}-${seq}@test.local`, password: "x", name: "S33.3 Route", role: "customer",
  }).returning();
  createdUserIds.push(user.id);
  if (points > 0) {
    await db.insert(loyaltyPointMovements).values({
      userId: user.id, type: "adjustment", pointsDelta: points,
      idempotencyKey: `${MARKER}:seed:${user.id}`, reason: "S33.3 route test seed",
    });
  }
  return user;
}

function authUser(user: { id: number; email: string; name: string | null }) {
  getCurrentUserMock.mockResolvedValue({
    id: user.id, email: user.email, name: user.name, role: "customer", phone: null, nif: null, company: null,
  });
}

function request(body: Record<string, unknown>, ip: string) {
  return new NextRequest("http://localhost/api/orders", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify({
      items: [{ productId, quantity: 1 }],
      deliveryType: "pickup",
      paymentMethod: "bank_transfer",
      billingAddress: { name: "Cliente", address1: "Rua Teste 1", city: "Esposende", postalCode: "4740-000", country: "Portugal", phone: "912345678" },
      ...body,
    }),
  });
}

async function cleanup() {
  await db.delete(rateLimits).where(or(like(rateLimits.key, "orders:create:ip:198.51.100.%"), like(rateLimits.key, "orders:create:user:%")));
  const testOrders = await db.select({ id: orders.id }).from(orders).where(like(orders.orderNumber, "%"));
  const ownedOrderIds = createdUserIds.length
    ? (await db.select({ id: orders.id }).from(orders).where(inArray(orders.userId, createdUserIds))).map((r) => r.id)
    : [];
  if (createdUserIds.length) {
    await db.delete(loyaltyVouchers).where(inArray(loyaltyVouchers.userId, createdUserIds));
  }
  if (ownedOrderIds.length) {
    await db.delete(loyaltyPointReservations).where(inArray(loyaltyPointReservations.orderId, ownedOrderIds));
    await db.delete(loyaltyPointMovements).where(inArray(loyaltyPointMovements.orderId, ownedOrderIds));
    await db.delete(orderStatusHistory).where(inArray(orderStatusHistory.orderId, ownedOrderIds));
    await db.delete(orderItems).where(inArray(orderItems.orderId, ownedOrderIds));
    await db.delete(payments).where(inArray(payments.orderId, ownedOrderIds));
    await db.delete(orders).where(inArray(orders.id, ownedOrderIds));
  }
  if (createdUserIds.length) {
    await db.delete(loyaltyPointReservations).where(inArray(loyaltyPointReservations.userId, createdUserIds));
    await db.delete(loyaltyPointMovements).where(inArray(loyaltyPointMovements.userId, createdUserIds));
    await db.delete(auditLogs).where(inArray(auditLogs.userId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
    createdUserIds.length = 0;
  }
  await db.delete(coupons).where(like(coupons.code, `${MARKER}%`));
  await db.delete(emailNotifications).where(like(emailNotifications.recipient, `${MARKER}-%`));
  if (productId) {
    await db.delete(products).where(eq(products.id, productId));
    productId = 0;
  }
  void testOrders;
}

beforeEach(async () => {
  await cleanup();
  const fixtureSeq = ++seq;
  const [product] = await db.insert(products).values({
    id: 900000 + fixtureSeq,
    name: `${MARKER} Service`, slug: `${MARKER}-${fixtureSeq}`, sku: `${MARKER}-SKU-${fixtureSeq}`,
    price: "100.00", vatRate: "23.00", stock: 0, reservedStock: 0, isActive: true, isService: true,
  }).returning();
  productId = product.id;
  sendEmailMock.mockClear();
});
afterEach(cleanup);

describe("S33.3 loyalty at POST /api/orders", () => {
  it("applies coupon then voucher, persists the split snapshot, and consumes the voucher only on payment", async () => {
    const user = await makeUser(1000);
    authUser(user);
    const voucher = await createLoyaltyVoucher(user.id, 500, user.id);
    const [coupon] = await db.insert(coupons).values({
      code: `${MARKER}10`.toUpperCase(), type: "percentage", value: "10.00", isActive: true, usedCount: 0,
    }).returning();

    const res = await ordersPOST(request({ couponCode: coupon.code, loyaltyVoucherCode: voucher.code }, "198.51.100.31"));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.order.total).toBe("85.00");

    const [order] = await db.select().from(orders).where(eq(orders.id, body.order.id));
    expect(order.subtotal).toBe("100.00");
    expect(order.couponDiscount).toBe("10.00");
    expect(order.loyaltyDiscount).toBe("5.00");
    expect(order.discount).toBe("15.00");
    expect(order.loyaltyType).toBe("voucher");
    expect(order.loyaltyPoints).toBe(500);
    expect(order.total).toBe("85.00");

    const [item] = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
    expect(item.discountAmount).toBe("15.00");
    expect(item.lineTotalGross).toBe("85.00");

    const [reserved] = await db.select().from(loyaltyVouchers).where(eq(loyaltyVouchers.id, voucher.id));
    expect(reserved.status).toBe("reserved");
    expect(reserved.reservedOrderId).toBe(order.id);
    const beforePayRedeems = await db.select().from(loyaltyPointMovements).where(eq(loyaltyPointMovements.userId, user.id));
    expect(beforePayRedeems.filter((m) => m.type === "redeem")).toHaveLength(1); // voucher generation only

    expect((await confirmOrderPayment(order.id, user.id, { source: "manual" })).changed).toBe(true);
    const [used] = await db.select().from(loyaltyVouchers).where(eq(loyaltyVouchers.id, voucher.id));
    expect(used.status).toBe("used");
    expect(used.usedOrderId).toBe(order.id);
    const afterPayRedeems = await db.select().from(loyaltyPointMovements).where(eq(loyaltyPointMovements.userId, user.id));
    expect(afterPayRedeems.filter((m) => m.type === "redeem")).toHaveLength(1); // no second debit
  });

  it("reserves direct points at order creation and debits them only after payment", async () => {
    const user = await makeUser(500);
    authUser(user);
    const res = await ordersPOST(request({ loyaltyPoints: 500 }, "198.51.100.32"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.order.total).toBe("95.00");

    const [order] = await db.select().from(orders).where(eq(orders.id, body.order.id));
    expect(order.couponDiscount).toBe("0.00");
    expect(order.loyaltyDiscount).toBe("5.00");
    expect(order.discount).toBe("5.00");
    expect(order.loyaltyType).toBe("points");
    expect(order.loyaltyPoints).toBe(500);
    const [reservation] = await db.select().from(loyaltyPointReservations).where(eq(loyaltyPointReservations.orderId, order.id));
    expect(reservation.status).toBe("reserved");
    expect((await db.select().from(loyaltyPointMovements).where(eq(loyaltyPointMovements.idempotencyKey, `order:${order.id}:loyalty:redeem`)))).toHaveLength(0);

    expect((await confirmOrderPayment(order.id, user.id, { source: "manual" })).changed).toBe(true);
    const [usedReservation] = await db.select().from(loyaltyPointReservations).where(eq(loyaltyPointReservations.orderId, order.id));
    expect(usedReservation.status).toBe("used");
    const [redeem] = await db.select().from(loyaltyPointMovements).where(eq(loyaltyPointMovements.idempotencyKey, `order:${order.id}:loyalty:redeem`));
    expect(redeem.pointsDelta).toBe(-500);
  });

  it("rejects a voucher owned by another customer without creating an order", async () => {
    const owner = await makeUser(500);
    const other = await makeUser(0);
    const voucher = await createLoyaltyVoucher(owner.id, 500, owner.id);
    authUser(other);
    const res = await ordersPOST(request({ loyaltyVoucherCode: voucher.code }, "198.51.100.33"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(String(body.error)).toMatch(/vale|voucher|cliente|pertence/i);
    const [stillActive] = await db.select().from(loyaltyVouchers).where(eq(loyaltyVouchers.id, voucher.id));
    expect(stillActive.status).toBe("active");
    expect((await db.select().from(orders).where(eq(orders.userId, other.id)))).toHaveLength(0);
  });
});
