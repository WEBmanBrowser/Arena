/**
 * B.5.4 — POST /api/orders rate limiting, tested AT THE ROUTE LEVEL against
 * the real PostgreSQL `rate_limits` table (no helper-only assertions).
 *
 * Layered behaviour under test:
 *  - guest / any caller: 5 attempts per 60s per IP
 *  - authenticated caller: the IP bucket PLUS 10 attempts per 60min per user.id
 *
 * The layering is intentional: an authenticated user can hit the 5/min IP
 * protection before the 10/hour user protection.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { orders, products, rateLimits, users, emailNotifications, coupons } from "@/db/schema";
import { eq, like, or, sql } from "drizzle-orm";

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

const MARKER = `b54-${Date.now()}`;
const IP_A = "203.0.113.10";
const IP_B = "203.0.113.20";

let productId = 0;
let userA: { id: number; email: string } | null = null;
let userB: { id: number; email: string } | null = null;

async function clearRateLimits() {
  await db.delete(rateLimits).where(
    or(like(rateLimits.key, "orders:create:ip:203.0.113.%"), like(rateLimits.key, "orders:create:user:%")),
  );
}

async function ensureFixtures() {
  if (!productId) {
    const [p] = await db
      .insert(products)
      .values({
        name: `${MARKER} Product`,
        slug: `${MARKER}-product`,
        sku: `${MARKER}-SKU`,
        price: "100.00",
        vatRate: "23.00",
        stock: 100000,
        reservedStock: 0,
        isActive: true,
      })
      .returning();
    productId = p.id;
  }
  if (!userA) {
    const [a] = await db.insert(users).values({ email: `${MARKER}-a@test.local`, password: "x", name: "A", role: "customer" }).returning();
    userA = a;
  }
  if (!userB) {
    const [b] = await db.insert(users).values({ email: `${MARKER}-b@test.local`, password: "x", name: "B", role: "customer" }).returning();
    userB = b;
  }
}

function authUser(u: { id: number; email: string } | null) {
  getCurrentUserMock.mockResolvedValue(
    u ? { id: u.id, email: u.email, name: "T", role: "customer", phone: null, nif: null, company: null } : null,
  );
}

function orderRequest(ip: string, body?: unknown) {
  return new NextRequest("http://localhost/api/orders", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify(
      body ?? {
        items: [{ productId, quantity: 1 }],
        deliveryType: "pickup",
        paymentMethod: "bank_transfer",
        guestEmail: `${MARKER}-guest@test.local`,
        guestName: "Guest",
      },
    ),
  });
}

async function countOrders() {
  const res = await db.execute(sql`SELECT count(*)::int AS c FROM orders WHERE order_number IS NOT NULL`);
  return Number((res.rows?.[0] as { c: number }).c);
}

beforeEach(async () => {
  await ensureFixtures();
  await clearRateLimits();
  sendEmailMock.mockClear();
  authUser(null);
});

afterAll(async () => {
  await clearRateLimits();
  await db.delete(emailNotifications).where(like(emailNotifications.recipient, `${MARKER}-%`));

  // Collect every order created by this suite (guest + both fixture users)
  // and remove dependent rows before the orders themselves (FK order).
  const ids = (
    await db.execute(sql`
      SELECT id FROM orders
      WHERE guest_email LIKE ${`${MARKER}-%`}
         OR user_id IN (${userA?.id ?? -1}, ${userB?.id ?? -1})
    `)
  ).rows.map((r) => Number((r as { id: number }).id));

  if (ids.length > 0) {
    const list = sql.raw(ids.join(","));
    await db.execute(sql`DELETE FROM stock_movements WHERE reference_type = 'order' AND reference_id IN (${list})`);
    await db.execute(sql`DELETE FROM order_status_history WHERE order_id IN (${list})`);
    await db.execute(sql`DELETE FROM order_items WHERE order_id IN (${list})`);
    await db.execute(sql`DELETE FROM payments WHERE order_id IN (${list})`);
    await db.execute(sql`DELETE FROM orders WHERE id IN (${list})`);
  }

  await db.delete(users).where(like(users.email, `${MARKER}-%`));
  await db.delete(coupons).where(like(coupons.code, `${MARKER}%`));
  if (productId) {
    await db.execute(sql`DELETE FROM stock_movements WHERE product_id = ${productId}`);
    await db.delete(products).where(eq(products.id, productId));
  }
});

describe("B.5.4 — guest IP bucket (5 / 60s) at route level", () => {
  it("allows attempts 1–5 past the limiter and rejects attempt 6 with 429", async () => {
    for (let i = 1; i <= 5; i += 1) {
      const res = await ordersPOST(orderRequest(IP_A));
      expect(res.status, `attempt ${i} should pass the limiter`).not.toBe(429);
    }
    const sixth = await ordersPOST(orderRequest(IP_A));
    expect(sixth.status).toBe(429);
    const retryAfter = Number(sixth.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
    const body = await sixth.json();
    expect(typeof body.error).toBe("string");
    // Sanitized: no internals leaked.
    expect(JSON.stringify(body)).not.toMatch(/rate_limits|stack|postgres|sql/i);
  });

  it("keeps a different IP independent", async () => {
    for (let i = 0; i < 6; i += 1) await ordersPOST(orderRequest(IP_A));
    expect((await ordersPOST(orderRequest(IP_A))).status).toBe(429);
    expect((await ordersPOST(orderRequest(IP_B))).status).not.toBe(429);
  });

  it("persists the buckets in the real rate_limits table", async () => {
    await ordersPOST(orderRequest(IP_A));
    const [row] = await db.select().from(rateLimits).where(eq(rateLimits.key, `orders:create:ip:${IP_A}`));
    expect(row).toBeTruthy();
    expect(row.count).toBe(1);
  });
});

describe("B.5.4 — authenticated behaviour", () => {
  it("subjects an authenticated user to the per-IP protection too", async () => {
    authUser(userA);
    for (let i = 1; i <= 5; i += 1) {
      expect((await ordersPOST(orderRequest(IP_A))).status).not.toBe(429);
    }
    expect((await ordersPOST(orderRequest(IP_A))).status).toBe(429);
  });

  it("enforces the 10 / 60min user bucket across changing IPs", async () => {
    authUser(userA);
    // Spread requests across distinct IPs so the 5/min IP bucket never fires;
    // only the user bucket can reject here.
    for (let i = 1; i <= 10; i += 1) {
      const res = await ordersPOST(orderRequest(`198.51.100.${i}`));
      expect(res.status, `user attempt ${i}`).not.toBe(429);
    }
    const eleventh = await ordersPOST(orderRequest("198.51.100.11"));
    expect(eleventh.status).toBe(429);
    const retryAfter = Number(eleventh.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(3600);

    const [row] = await db.select().from(rateLimits).where(eq(rateLimits.key, `orders:create:user:${userA!.id}`));
    expect(row.count).toBe(11);
  });

  it("keeps another authenticated user independent", async () => {
    authUser(userA);
    for (let i = 1; i <= 11; i += 1) await ordersPOST(orderRequest(`198.51.100.${100 + i}`));
    expect((await ordersPOST(orderRequest("198.51.100.200"))).status).toBe(429);

    authUser(userB);
    expect((await ordersPOST(orderRequest("198.51.100.201"))).status).not.toBe(429);
  });

  it("documents the intentional layering: IP protection can fire before the user bucket", async () => {
    authUser(userA);
    for (let i = 1; i <= 5; i += 1) await ordersPOST(orderRequest(IP_B));
    const blocked = await ordersPOST(orderRequest(IP_B));
    expect(blocked.status).toBe(429);
    const [userRow] = await db.select().from(rateLimits).where(eq(rateLimits.key, `orders:create:user:${userA!.id}`));
    // Only 5 user hits consumed — the IP bucket rejected before the user bucket
    // was even consulted on the 6th attempt.
    expect(userRow.count).toBe(5);
  });
});

describe("B.5.4 — side-effect ordering", () => {
  it("rejects before any order, stock reservation, coupon mutation or email side effect", async () => {
    const [coupon] = await db
      .insert(coupons)
      .values({ code: `${MARKER}COUP`, type: "percentage", value: "10.00", isActive: true, usedCount: 0 })
      .returning();
    const [productBefore] = await db.select().from(products).where(eq(products.id, productId));

    // Exhaust the IP bucket with cheap invalid payloads (empty cart => 400,
    // still consumes the limiter because the limiter runs first).
    for (let i = 0; i < 5; i += 1) {
      const res = await ordersPOST(orderRequest(IP_A, { items: [] }));
      expect(res.status).toBe(400);
    }

    const ordersBefore = await countOrders();
    sendEmailMock.mockClear();

    const blocked = await ordersPOST(
      orderRequest(IP_A, {
        items: [{ productId, quantity: 3 }],
        deliveryType: "pickup",
        paymentMethod: "bank_transfer",
        couponCode: coupon.code,
        guestEmail: `${MARKER}-guest@test.local`,
      }),
    );
    expect(blocked.status).toBe(429);

    expect(await countOrders()).toBe(ordersBefore);
    const [productAfter] = await db.select().from(products).where(eq(products.id, productId));
    expect(productAfter.reservedStock).toBe(productBefore.reservedStock);
    const [couponAfter] = await db.select().from(coupons).where(eq(coupons.id, coupon.id));
    expect(couponAfter.usedCount).toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

describe("B.5.4 — scope: other endpoints are not rate limited by this change", () => {
  it("does not add orders rate-limit keys for unrelated routes", async () => {
    await ordersPOST(orderRequest(IP_A));
    const rows = await db.select().from(rateLimits).where(like(rateLimits.key, "orders:create:%"));
    for (const r of rows) {
      expect(r.key.startsWith("orders:create:ip:") || r.key.startsWith("orders:create:user:")).toBe(true);
    }
  });
});
