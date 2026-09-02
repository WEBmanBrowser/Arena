/**
 * B.4.1 — Admin dashboard ROUTE tests (HTTP auth contract).
 *
 * Both /api/admin/dashboard and /api/admin/stats must be staff-gated.
 * getCurrentUser is mocked so no real session/JWT is required; the service
 * runs against real PostgreSQL.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { orders } from "@/db/schema";
import { sql } from "drizzle-orm";

const getCurrentUserMock = vi.fn();
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getCurrentUser: () => getCurrentUserMock() };
});

import { GET as dashboardGET } from "@/app/api/admin/dashboard/route";
import { GET as statsGET } from "@/app/api/admin/stats/route";

function user(role: string | null) {
  if (!role) return null;
  return { id: 1, email: `b41-${role}@test.local`, name: `B41 ${role}`, role, phone: null, nif: null, company: null };
}

beforeEach(async () => {
  getCurrentUserMock.mockReset();
  await db.execute(sql`DELETE FROM orders WHERE order_number LIKE 'B41ROUTE-%'`);
});

describe("B.4.1 dashboard route RBAC", () => {
  it("rejects unauthenticated and customer users", async () => {
    getCurrentUserMock.mockResolvedValue(user(null));
    expect((await dashboardGET()).status).toBe(403);
    getCurrentUserMock.mockResolvedValue(user("customer"));
    expect((await dashboardGET()).status).toBe(403);
  });

  it("allows staff, manager and admin", async () => {
    await db.insert(orders).values({
      orderNumber: `B41ROUTE-${Date.now()}`,
      status: "paid",
      paymentStatus: "paid",
      subtotal: "10.00",
      total: "10.00",
      deliveryType: "shipping",
    });
    for (const role of ["staff", "manager", "admin"]) {
      getCurrentUserMock.mockResolvedValue(user(role));
      const res = await dashboardGET();
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.kpis).toBeTruthy();
      expect(json.alerts).toBeInstanceOf(Array);
      expect(json.revenueSeries.length).toBe(30);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
  });
});

describe("B.4.1 legacy stats route RBAC", () => {
  it("rejects unauthenticated and customer users", async () => {
    getCurrentUserMock.mockResolvedValue(user(null));
    expect((await statsGET()).status).toBe(403);
    getCurrentUserMock.mockResolvedValue(user("customer"));
    expect((await statsGET()).status).toBe(403);
  });

  it("returns the legacy card shape for staff+", async () => {
    getCurrentUserMock.mockResolvedValue(user("admin"));
    const res = await statsGET();
    expect(res.status).toBe(200);
    const json = await res.json();
    // Legacy fields preserved.
    for (const key of [
      "totalOrders", "todaySales", "todayRevenue", "monthSales", "monthRevenue",
      "pendingOrders", "totalProducts", "lowStock", "outOfStock", "totalCustomers", "openRma",
    ]) {
      expect(json).toHaveProperty(key);
    }
    expect(typeof json.todayRevenue).toBe("string");
  });
});
