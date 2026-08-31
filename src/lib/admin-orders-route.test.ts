/**
 * B.2.1 — Admin Order Management: ROUTE-level tests.
 * Executes the REAL route handlers (GET/PUT /api/admin/orders and
 * GET /api/admin/orders/[id]). Only `getCurrentUser` is mocked (session
 * injection) and the service functions are stubbed — except where a test
 * explicitly delegates to the real service implementation for validation
 * paths that never touch the database.
 *
 * Proves RBAC through the real handler: unauthenticated → 401,
 * customer → 403, staff read/normal ops, manager/admin critical ops.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { AdminOrderDetail, AdminOrderListResult } from "@/lib/services/admin-orders-service";

// ── Session injection: mock ONLY getCurrentUser — isStaff/isManager stay real ──
const getCurrentUserMock = vi.fn();
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getCurrentUser: () => getCurrentUserMock() };
});

// ── Service stubs (real class + real implementations kept available) ──
const listAdminOrdersMock = vi.fn();
const getAdminOrderDetailMock = vi.fn();
const updateAdminOrderStatusMock = vi.fn();
const updateOrderTrackingMock = vi.fn();
vi.mock("@/lib/services/admin-orders-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/services/admin-orders-service")>();
  return {
    ...actual,
    listAdminOrders: (...a: unknown[]) => listAdminOrdersMock(...a),
    getAdminOrderDetail: (...a: unknown[]) => getAdminOrderDetailMock(...a),
    updateAdminOrderStatus: (...a: unknown[]) => updateAdminOrderStatusMock(...a),
    updateOrderTracking: (...a: unknown[]) => updateOrderTrackingMock(...a),
  };
});

import { GET as listGET, PUT as listPUT } from "@/app/api/admin/orders/route";
import { GET as detailGET } from "@/app/api/admin/orders/[id]/route";

const emptyList: AdminOrderListResult = {
  orders: [],
  pagination: { page: 1, pageSize: 25, total: 0, totalPages: 1 },
};
const detailStub = { order: { id: 7, orderNumber: "T-7", allowedTransitions: [] } } as unknown as AdminOrderDetail;

function makeUser(role: "customer" | "staff" | "manager" | "admin") {
  return { id: 42, email: `user-${role}@test.local`, name: `User ${role}`, role, phone: null, nif: null, company: null };
}

function listRequest(query = "") {
  return new NextRequest(`http://localhost/api/admin/orders${query}`);
}

function putRequest(body: unknown) {
  return new NextRequest(`http://localhost/api/admin/orders`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function detailRequest(id: string) {
  return new NextRequest(`http://localhost/api/admin/orders/${id}`);
}

beforeEach(() => {
  getCurrentUserMock.mockReset();
  listAdminOrdersMock.mockReset().mockResolvedValue(emptyList);
  getAdminOrderDetailMock.mockReset().mockResolvedValue(detailStub);
  updateAdminOrderStatusMock.mockReset().mockResolvedValue(detailStub);
  updateOrderTrackingMock.mockReset().mockResolvedValue({ changed: true, order: detailStub });
});

describe("B.2.1 route — GET /api/admin/orders (list)", () => {
  it("unauthenticated → 401", async () => {
    getCurrentUserMock.mockResolvedValue(null);
    const res = await listGET(listRequest());
    expect(res.status).toBe(401);
    expect(listAdminOrdersMock).not.toHaveBeenCalled();
  });

  it("customer → 403 (real handler)", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser("customer"));
    const res = await listGET(listRequest());
    expect(res.status).toBe(403);
    expect(listAdminOrdersMock).not.toHaveBeenCalled();
  });

  it("staff → 200 and service receives the validated query", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser("staff"));
    const res = await listGET(listRequest("?page=2&pageSize=50&status=paid&paymentStatus=paid&deliveryType=shipping&sort=oldest&search=x"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pagination).toEqual(emptyList.pagination);
    expect(listAdminOrdersMock).toHaveBeenCalledWith({
      page: 2, pageSize: 50, status: "paid", paymentStatus: "paid",
      deliveryType: "shipping", sort: "oldest", search: "x",
    });
  });

  it("invalid status enum → 400, service not called", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser("staff"));
    const res = await listGET(listRequest("?status=bogus"));
    expect(res.status).toBe(400);
    expect(listAdminOrdersMock).not.toHaveBeenCalled();
  });

  it("invalid paymentStatus / deliveryType / sort → 400", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser("staff"));
    expect((await listGET(listRequest("?paymentStatus=nope"))).status).toBe(400);
    expect((await listGET(listRequest("?deliveryType=teleport"))).status).toBe(400);
    expect((await listGET(listRequest("?sort=random"))).status).toBe(400);
    expect(listAdminOrdersMock).not.toHaveBeenCalled();
  });

  it("page=0 or pageSize=101 → 400", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser("staff"));
    expect((await listGET(listRequest("?page=0"))).status).toBe(400);
    expect((await listGET(listRequest("?pageSize=101"))).status).toBe(400);
    expect(listAdminOrdersMock).not.toHaveBeenCalled();
  });

  it("invalid date format (31-12-2026) → 400", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser("staff"));
    const res = await listGET(listRequest("?dateFrom=31-12-2026"));
    expect(res.status).toBe(400);
    expect(listAdminOrdersMock).not.toHaveBeenCalled();
  });

  it("dateFrom > dateTo → 400 via REAL service validation (no DB access needed)", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser("staff"));
    const actual = await vi.importActual<typeof import("@/lib/services/admin-orders-service")>("@/lib/services/admin-orders-service");
    listAdminOrdersMock.mockImplementationOnce(actual.listAdminOrders);
    const res = await listGET(listRequest("?dateFrom=2026-03-10&dateTo=2026-03-01"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("DATE_FROM_AFTER_DATE_TO");
  });

  it("non-existent calendar date (2026-02-30) → 400 via REAL service validation", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser("staff"));
    const actual = await vi.importActual<typeof import("@/lib/services/admin-orders-service")>("@/lib/services/admin-orders-service");
    listAdminOrdersMock.mockImplementationOnce(actual.listAdminOrders);
    const res = await listGET(listRequest("?dateTo=2026-02-30"));
    expect(res.status).toBe(400);
  });
});

describe("B.2.1 route — PUT /api/admin/orders (status/tracking)", () => {
  it("unauthenticated → 401", async () => {
    getCurrentUserMock.mockResolvedValue(null);
    const res = await listPUT(putRequest({ id: 7, status: "processing" }));
    expect(res.status).toBe(401);
    expect(updateAdminOrderStatusMock).not.toHaveBeenCalled();
  });

  it("customer → 403, service not called (real handler)", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser("customer"));
    const res = await listPUT(putRequest({ id: 7, status: "processing" }));
    expect(res.status).toBe(403);
    expect(updateAdminOrderStatusMock).not.toHaveBeenCalled();
  });

  it("staff + normal status (processing) → 200, called with actor id", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser("staff"));
    const res = await listPUT(putRequest({ id: 7, status: "processing", comment: "avancar" }));
    expect(res.status).toBe(200);
    expect(updateAdminOrderStatusMock).toHaveBeenCalledWith(7, "processing", 42, "avancar");
  });

  it("staff + cancelled → 403 (critical requires manager/admin)", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser("staff"));
    const res = await listPUT(putRequest({ id: 7, status: "cancelled" }));
    expect(res.status).toBe(403);
    expect(updateAdminOrderStatusMock).not.toHaveBeenCalled();
  });

  it("staff + refunded → 403 (critical requires manager/admin)", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser("staff"));
    const res = await listPUT(putRequest({ id: 7, status: "refunded" }));
    expect(res.status).toBe(403);
    expect(updateAdminOrderStatusMock).not.toHaveBeenCalled();
  });

  it("manager + cancelled → 200", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser("manager"));
    const res = await listPUT(putRequest({ id: 7, status: "cancelled" }));
    expect(res.status).toBe(200);
    expect(updateAdminOrderStatusMock).toHaveBeenCalledWith(7, "cancelled", 42, undefined);
  });

  it("admin + refunded → 200", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser("admin"));
    const res = await listPUT(putRequest({ id: 7, status: "refunded" }));
    expect(res.status).toBe(200);
    expect(updateAdminOrderStatusMock).toHaveBeenCalledWith(7, "refunded", 42, undefined);
  });

  it("staff + expired → 400 via REAL service (system-only)", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser("admin")); // even admin cannot set expired manually
    const actual = await vi.importActual<typeof import("@/lib/services/admin-orders-service")>("@/lib/services/admin-orders-service");
    updateAdminOrderStatusMock.mockImplementationOnce(actual.updateAdminOrderStatus);
    const res = await listPUT(putRequest({ id: 7, status: "expired" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("EXPIRED_IS_SYSTEM_ONLY");
  });

  it("invalid status value → 400 (Zod), service not called", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser("admin"));
    const res = await listPUT(putRequest({ id: 7, status: "bogus" }));
    expect(res.status).toBe(400);
    expect(updateAdminOrderStatusMock).not.toHaveBeenCalled();
  });

  it("staff can set tracking (normal operation) → 200", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser("staff"));
    const res = await listPUT(putRequest({ id: 7, trackingNumber: "TRK-1" }));
    expect(res.status).toBe(200);
    expect(updateOrderTrackingMock).toHaveBeenCalledWith(7, "TRK-1", 42);
  });

  it("tracking longer than 255 → 400", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser("staff"));
    const actual = await vi.importActual<typeof import("@/lib/services/admin-orders-service")>("@/lib/services/admin-orders-service");
    updateOrderTrackingMock.mockImplementationOnce(actual.updateOrderTracking); // length check runs before any DB access
    const res = await listPUT(putRequest({ id: 7, trackingNumber: "X".repeat(256) }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("TRACKING_TOO_LONG");
  });

  it("ORDER_NOT_FOUND → 404", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser("admin"));
    updateAdminOrderStatusMock.mockRejectedValueOnce(new Error("ORDER_NOT_FOUND"));
    const res = await listPUT(putRequest({ id: 999, status: "processing" }));
    expect(res.status).toBe(404);
  });

  it("invalid JSON body → 400", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser("staff"));
    const res = await listPUT(putRequest("not-json{"));
    expect(res.status).toBe(400);
  });
});

describe("B.2.1 route — GET /api/admin/orders/[id] (detail)", () => {
  it("unauthenticated → 401", async () => {
    getCurrentUserMock.mockResolvedValue(null);
    const res = await detailGET(detailRequest("7"), { params: Promise.resolve({ id: "7" }) });
    expect(res.status).toBe(401);
    expect(getAdminOrderDetailMock).not.toHaveBeenCalled();
  });

  it("customer → 403 (real handler)", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser("customer"));
    const res = await detailGET(detailRequest("7"), { params: Promise.resolve({ id: "7" }) });
    expect(res.status).toBe(403);
    expect(getAdminOrderDetailMock).not.toHaveBeenCalled();
  });

  it("staff → 200 with parsed numeric id", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser("staff"));
    const res = await detailGET(detailRequest("7"), { params: Promise.resolve({ id: "7" }) });
    expect(res.status).toBe(200);
    expect(getAdminOrderDetailMock).toHaveBeenCalledWith(7);
  });

  it("invalid id → 400", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser("staff"));
    const res = await detailGET(detailRequest("abc"), { params: Promise.resolve({ id: "abc" }) });
    expect(res.status).toBe(400);
    expect(getAdminOrderDetailMock).not.toHaveBeenCalled();
  });

  it("ORDER_NOT_FOUND → 404", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser("staff"));
    getAdminOrderDetailMock.mockRejectedValueOnce(new Error("ORDER_NOT_FOUND"));
    const res = await detailGET(detailRequest("999"), { params: Promise.resolve({ id: "999" }) });
    expect(res.status).toBe(404);
  });
});
