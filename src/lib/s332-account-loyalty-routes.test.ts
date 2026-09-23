import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/db";
import {
  loyaltyPointMovements,
  loyaltyVouchers,
  orders,
  users,
} from "@/db/schema";
import { eq, like } from "drizzle-orm";

const getCurrentUserMock = vi.fn();

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    getCurrentUser: () => getCurrentUserMock(),
  };
});

import { GET as loyaltyGET } from "@/app/api/account/loyalty/route";
import { POST as voucherPOST } from "@/app/api/account/loyalty/vouchers/route";

let seq = 0;

async function createCustomer(prefix = "main") {
  seq += 1;
  const [user] = await db
    .insert(users)
    .values({
      email: `s332-${prefix}-${Date.now()}-${seq}@test.local`,
      password: "x",
      name: `S33.2 ${prefix}`,
      role: "customer",
    })
    .returning();

  return user;
}

function mockUser(user: { id: number; email: string } | null) {
  getCurrentUserMock.mockResolvedValue(
    user
      ? {
          id: user.id,
          email: user.email,
          name: "S33.2 Customer",
          role: "customer",
          phone: null,
          nif: null,
          company: null,
        }
      : null
  );
}

function postReq(body: unknown, origin = "http://localhost") {
  return new NextRequest("http://localhost/api/account/loyalty/vouchers", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
    },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  getCurrentUserMock.mockReset();

  const testUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(like(users.email, "s332-%@test.local"));

  for (const user of testUsers) {
    await db.delete(loyaltyVouchers).where(eq(loyaltyVouchers.userId, user.id));
    await db
      .delete(loyaltyPointMovements)
      .where(eq(loyaltyPointMovements.userId, user.id));
  }

  await db.delete(orders).where(like(orders.orderNumber, "S332-%"));
  await db.delete(users).where(like(users.email, "s332-%@test.local"));
});

describe("S33.2 account loyalty routes", () => {
  it("GET requires an authenticated customer", async () => {
    mockUser(null);

    const res = await loyaltyGET();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Sessão requerida" });
  });

  it("GET returns only the authenticated customer's loyalty data and exposes the public order number", async () => {
    const customer = await createCustomer("owner");
    const other = await createCustomer("other");

    const [order] = await db
      .insert(orders)
      .values({
        orderNumber: `S332-PUBLIC-${Date.now()}`,
        userId: customer.id,
        status: "paid",
        paymentStatus: "paid",
        subtotal: "5.00",
        shipping: "0.00",
        total: "5.00",
        deliveryType: "shipping",
        paymentMethod: "bank_transfer",
      })
      .returning();

    await db.insert(loyaltyPointMovements).values([
      {
        userId: customer.id,
        orderId: order.id,
        type: "earn",
        pointsDelta: 500,
        eligibleAmountCents: 50000,
        idempotencyKey: `s332-owner-${Date.now()}-${seq}`,
        reason: "S33.2 route test",
      },
      {
        userId: other.id,
        type: "adjustment",
        pointsDelta: 900,
        idempotencyKey: `s332-other-${Date.now()}-${seq}`,
        reason: "Must not leak",
      },
    ]);

    await db.insert(loyaltyVouchers).values([
      {
        userId: customer.id,
        code: `MDT-S332-OWNER-${seq}`,
        points: 100,
        valueCents: 100,
        status: "active",
      },
      {
        userId: other.id,
        code: `MDT-S332-OTHER-${seq}`,
        points: 100,
        valueCents: 100,
        status: "active",
      },
    ]);

    mockUser(customer);

    const res = await loyaltyGET();
    expect(res.status).toBe(200);

    const json = await res.json();

    expect(json.summary.balancePoints).toBe(500);
    expect(json.summary.redemptionValueCents).toBe(500);
    expect(json.summary.earnedPoints).toBe(500);
    expect(json.summary.redeemedPoints).toBe(0);
    expect(json.summary.reversedPoints).toBe(0);

    expect(json.movements).toHaveLength(1);
    expect(json.movements[0].orderNumber).toBe(order.orderNumber);
    expect(json.movements[0].orderId).toBe(order.id);
    expect(json.movements[0].pointsDelta).toBe(500);

    expect(json.vouchers).toHaveLength(1);
    expect(json.vouchers[0].userId).toBe(customer.id);
    expect(json.vouchers[0].code).toContain("S332-OWNER");
  });

  it("POST rejects a cross-origin request before creating a voucher", async () => {
    const customer = await createCustomer("csrf");

    await db.insert(loyaltyPointMovements).values({
      userId: customer.id,
      type: "adjustment",
      pointsDelta: 500,
      idempotencyKey: `s332-csrf-balance-${Date.now()}-${seq}`,
      reason: "S33.2 CSRF test",
    });

    mockUser(customer);

    const res = await voucherPOST(
      postReq({ points: 100 }, "https://evil.example")
    );

    expect(res.status).toBe(403);

    const vouchers = await db
      .select()
      .from(loyaltyVouchers)
      .where(eq(loyaltyVouchers.userId, customer.id));

    expect(vouchers).toHaveLength(0);
  });

  it("POST requires authentication for a valid same-origin request", async () => {
    mockUser(null);

    const res = await voucherPOST(postReq({ points: 100 }));

    expect(res.status).toBe(401);
  });

  it.each([
    0,
    99,
    101,
    150,
    1.5,
    "100",
    null,
  ])("POST rejects invalid point amount %s", async (points) => {
    const customer = await createCustomer("invalid");
    mockUser(customer);

    const res = await voucherPOST(postReq({ points }));

    expect(res.status).toBe(400);
  });

  it("POST creates a one-time loyalty voucher for the authenticated user and debits points immediately", async () => {
    const customer = await createCustomer("create");
    const other = await createCustomer("other-create");

    await db.insert(loyaltyPointMovements).values([
      {
        userId: customer.id,
        type: "adjustment",
        pointsDelta: 500,
        idempotencyKey: `s332-create-balance-${Date.now()}-${seq}`,
        reason: "S33.2 voucher creation test",
      },
      {
        userId: other.id,
        type: "adjustment",
        pointsDelta: 900,
        idempotencyKey: `s332-other-balance-${Date.now()}-${seq}`,
        reason: "Other customer balance",
      },
    ]);

    mockUser(customer);

    const res = await voucherPOST(postReq({ points: 300 }));

    expect(res.status).toBe(201);
    const json = await res.json();

    expect(json.voucher.userId).toBe(customer.id);
    expect(json.voucher.points).toBe(300);
    expect(json.voucher.valueCents).toBe(300);
    expect(json.voucher.status).toBe("active");
    expect(json.voucher.code).toMatch(/^MDT-[23456789A-HJ-NP-Z]{4}-[23456789A-HJ-NP-Z]{4}-[23456789A-HJ-NP-Z]{4}$/);

    const ownerMovements = await db
      .select()
      .from(loyaltyPointMovements)
      .where(eq(loyaltyPointMovements.userId, customer.id));

    expect(ownerMovements.reduce((sum, row) => sum + row.pointsDelta, 0)).toBe(200);

    const redeem = ownerMovements.find(
      (row) => row.type === "redeem" && row.pointsDelta === -300
    );

    expect(redeem).toBeTruthy();
    expect(redeem!.actorUserId).toBe(customer.id);
    expect(redeem!.idempotencyKey).toBe(`voucher:${json.voucher.id}:redeem`);

    const otherMovements = await db
      .select()
      .from(loyaltyPointMovements)
      .where(eq(loyaltyPointMovements.userId, other.id));

    expect(otherMovements.reduce((sum, row) => sum + row.pointsDelta, 0)).toBe(900);
  });

  it("POST refuses to generate a voucher when the customer has insufficient points", async () => {
    const customer = await createCustomer("insufficient");

    await db.insert(loyaltyPointMovements).values({
      userId: customer.id,
      type: "adjustment",
      pointsDelta: 100,
      idempotencyKey: `s332-insufficient-${Date.now()}-${seq}`,
      reason: "S33.2 insufficient balance test",
    });

    mockUser(customer);

    const res = await voucherPOST(postReq({ points: 200 }));

    expect(res.status).toBe(400);

    const vouchers = await db
      .select()
      .from(loyaltyVouchers)
      .where(eq(loyaltyVouchers.userId, customer.id));

    expect(vouchers).toHaveLength(0);
  });
});
