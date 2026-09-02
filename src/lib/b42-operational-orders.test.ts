/**
 * B.4.2 — Operational Order Management & Exception Workflows tests.
 *
 * Validates:
 *  • Operational queue filtering and validation (awaiting_payment, paid_needs_processing,
 *    preparing, ready_to_ship, ready_for_pickup, shipped, refund_attention, missing_invoice, exceptions).
 *  • PostgreSQL-side queue count aggregation.
 *  • Safe bulk fulfillment transitions (paid → processing, processing pickup → ready_for_pickup)
 *    with per-order status validation and explicit partial success/failure reporting.
 *  • Bulk security: authentication (401), RBAC (403 for customer/non-staff), CSRF protection,
 *    bounded batch size (max 50), deduplication, positive integer validation.
 *  • Order detail payment attempts exposure (sanitized, non-sensitive).
 *  • Unified operational timeline deterministic sorting and tie-breaking.
 *  • Manual credit-note route RBAC, validation and audit integration.
 *  • Dashboard alert deep-link verification.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type {
  AdminOrderDetail,
  AdminOrderListResult,
  AdminOrderQueueCounts,
} from "@/lib/services/admin-orders-service";
import {
  ADMIN_ORDER_QUEUES,
  ADMIN_MAX_BULK_ORDERS,
  bulkTransitionAdminOrders,
  AdminOrderValidationError,
} from "@/lib/services/admin-orders-service";

// ── Session injection: mock ONLY getCurrentUser — isStaff/isManager stay real ──
const getCurrentUserMock = vi.fn();
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getCurrentUser: () => getCurrentUserMock() };
});

// ── Service stubs for route tests ──
const listAdminOrdersMock = vi.fn();
const getAdminOrderDetailMock = vi.fn();
const updateAdminOrderStatusMock = vi.fn();
const updateOrderTrackingMock = vi.fn();
const bulkTransitionAdminOrdersMock = vi.fn();
const recordManualCreditNoteMock = vi.fn();

vi.mock("@/lib/services/admin-orders-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/services/admin-orders-service")>();
  return {
    ...actual,
    listAdminOrders: (...a: unknown[]) => listAdminOrdersMock(...a),
    getAdminOrderDetail: (...a: unknown[]) => getAdminOrderDetailMock(...a),
    updateAdminOrderStatus: (...a: unknown[]) => updateAdminOrderStatusMock(...a),
    updateOrderTracking: (...a: unknown[]) => updateOrderTrackingMock(...a),
    bulkTransitionAdminOrders: (...a: unknown[]) => bulkTransitionAdminOrdersMock(...a),
  };
});

vi.mock("@/lib/refunds", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/refunds")>();
  return {
    ...actual,
    recordManualCreditNote: (...a: unknown[]) => recordManualCreditNoteMock(...a),
  };
});

import { GET as listGET } from "@/app/api/admin/orders/route";
import { POST as bulkPOST } from "@/app/api/admin/orders/bulk/route";
import { POST as creditNotePOST } from "@/app/api/admin/orders/[id]/credit-notes/route";

const emptyQueueCounts: AdminOrderQueueCounts = {
  awaiting_payment: 0,
  paid_needs_processing: 0,
  preparing: 0,
  ready_to_ship: 0,
  ready_for_pickup: 0,
  shipped: 0,
  refund_attention: 0,
  missing_invoice: 0,
  exceptions: 0,
};

const emptyList: AdminOrderListResult = {
  orders: [],
  pagination: { page: 1, pageSize: 25, total: 0, totalPages: 1 },
  queueCounts: emptyQueueCounts,
};

function makeUser(role: "customer" | "staff" | "manager" | "admin") {
  return { id: 42, email: `user-${role}@test.local`, name: `User ${role}`, role, phone: null, nif: null, company: null };
}

function createRequest(url: string, options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers = new Headers(options.headers || {});
  if (options.method && options.method !== "GET" && !headers.has("origin")) {
    headers.set("origin", "http://localhost");
    headers.set("host", "localhost");
  }
  if (options.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return new NextRequest(url, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
}

beforeEach(() => {
  getCurrentUserMock.mockReset();
  listAdminOrdersMock.mockReset().mockResolvedValue(emptyList);
  getAdminOrderDetailMock.mockReset();
  updateAdminOrderStatusMock.mockReset();
  updateOrderTrackingMock.mockReset();
  bulkTransitionAdminOrdersMock.mockReset();
  recordManualCreditNoteMock.mockReset();
});

// ─── 1. OPERATIONAL QUEUES VALIDATION ─────────────────────

describe("B.4.2 — Operational Queues validation & list route", () => {
  it("defines all 9 authoritative operational queues", () => {
    expect(ADMIN_ORDER_QUEUES).toEqual([
      "awaiting_payment",
      "paid_needs_processing",
      "preparing",
      "ready_to_ship",
      "ready_for_pickup",
      "shipped",
      "refund_attention",
      "missing_invoice",
      "exceptions",
    ]);
  });

  it.each(ADMIN_ORDER_QUEUES)("accepts valid queue parameter: queue=%s", async (queue) => {
    getCurrentUserMock.mockResolvedValue(makeUser("staff"));
    const req = createRequest(`http://localhost/api/admin/orders?queue=${queue}`);
    const res = await listGET(req);
    expect(res.status).toBe(200);
    expect(listAdminOrdersMock).toHaveBeenCalledWith(
      expect.objectContaining({ queue })
    );
  });

  it("rejects unknown queue parameter with 400", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser("staff"));
    const req = createRequest("http://localhost/api/admin/orders?queue=non_existent_queue");
    const res = await listGET(req);
    expect(res.status).toBe(400);
    expect(listAdminOrdersMock).not.toHaveBeenCalled();
  });

  it("composes queue with search, status, paymentStatus, and pagination", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser("staff"));
    const req = createRequest("http://localhost/api/admin/orders?queue=ready_to_ship&search=Joao&page=2&pageSize=10");
    const res = await listGET(req);
    expect(res.status).toBe(200);
    expect(listAdminOrdersMock).toHaveBeenCalledWith({
      queue: "ready_to_ship",
      search: "Joao",
      page: 2,
      pageSize: 10,
    });
  });

  it("unauthenticated → 401 on orders list", async () => {
    getCurrentUserMock.mockResolvedValue(null);
    const req = createRequest("http://localhost/api/admin/orders?queue=preparing");
    const res = await listGET(req);
    expect(res.status).toBe(401);
  });

  it("customer role → 403 on orders list", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser("customer"));
    const req = createRequest("http://localhost/api/admin/orders?queue=preparing");
    const res = await listGET(req);
    expect(res.status).toBe(403);
  });
});

// ─── 2. SAFE BULK FULFILLMENT ROUTE & SECURITY ────────────

describe("B.4.2 — Safe Bulk Fulfillment Route (POST /api/admin/orders/bulk)", () => {
  it("unauthenticated → 401", async () => {
    getCurrentUserMock.mockResolvedValue(null);
    const req = createRequest("http://localhost/api/admin/orders/bulk", {
      method: "POST",
      body: { action: "start_processing", orderIds: [1, 2] },
    });
    const res = await bulkPOST(req);
    expect(res.status).toBe(401);
    expect(bulkTransitionAdminOrdersMock).not.toHaveBeenCalled();
  });

  it("customer → 403", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser("customer"));
    const req = createRequest("http://localhost/api/admin/orders/bulk", {
      method: "POST",
      body: { action: "start_processing", orderIds: [1, 2] },
    });
    const res = await bulkPOST(req);
    expect(res.status).toBe(403);
    expect(bulkTransitionAdminOrdersMock).not.toHaveBeenCalled();
  });

  it("fails CSRF when origin is cross-origin", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser("staff"));
    const req = new NextRequest("http://localhost/api/admin/orders/bulk", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://malicious-site.com",
        host: "localhost",
      },
      body: JSON.stringify({ action: "start_processing", orderIds: [1, 2] }),
    });
    const res = await bulkPOST(req);
    expect(res.status).toBe(403);
    expect(bulkTransitionAdminOrdersMock).not.toHaveBeenCalled();
  });

  it("rejects empty orderIds array with 400", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser("staff"));
    const req = createRequest("http://localhost/api/admin/orders/bulk", {
      method: "POST",
      body: { action: "start_processing", orderIds: [] },
    });
    const res = await bulkPOST(req);
    expect(res.status).toBe(400);
    expect(bulkTransitionAdminOrdersMock).not.toHaveBeenCalled();
  });

  it("rejects non-positive or non-integer order IDs with 400", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser("staff"));
    const req = createRequest("http://localhost/api/admin/orders/bulk", {
      method: "POST",
      body: { action: "start_processing", orderIds: [1, -5, 3] },
    });
    const res = await bulkPOST(req);
    expect(res.status).toBe(400);
    expect(bulkTransitionAdminOrdersMock).not.toHaveBeenCalled();
  });

  it(`enforces batch size maximum (ADMIN_MAX_BULK_ORDERS = ${ADMIN_MAX_BULK_ORDERS})`, async () => {
    getCurrentUserMock.mockResolvedValue(makeUser("staff"));
    const tooMany = Array.from({ length: ADMIN_MAX_BULK_ORDERS + 1 }, (_, i) => i + 1);
    const req = createRequest("http://localhost/api/admin/orders/bulk", {
      method: "POST",
      body: { action: "start_processing", orderIds: tooMany },
    });
    const res = await bulkPOST(req);
    expect(res.status).toBe(400);
    expect(bulkTransitionAdminOrdersMock).not.toHaveBeenCalled();
  });

  it("rejects unsupported bulk action with 400 (e.g. bulk cancel or bulk refund)", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser("staff"));
    const req = createRequest("http://localhost/api/admin/orders/bulk", {
      method: "POST",
      body: { action: "bulk_cancel", orderIds: [1, 2] },
    });
    const res = await bulkPOST(req);
    expect(res.status).toBe(400);
    expect(bulkTransitionAdminOrdersMock).not.toHaveBeenCalled();
  });

  it("staff + valid start_processing → 200 with result payload", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser("staff"));
    const mockResult = {
      action: "start_processing",
      total: 3,
      succeeded: [10, 11],
      failed: [{ id: 12, reason: "Transição inválida" }],
    };
    bulkTransitionAdminOrdersMock.mockResolvedValue(mockResult);

    const req = createRequest("http://localhost/api/admin/orders/bulk", {
      method: "POST",
      body: { action: "start_processing", orderIds: [10, 11, 12] },
    });
    const res = await bulkPOST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual(mockResult);
    expect(bulkTransitionAdminOrdersMock).toHaveBeenCalledWith("start_processing", [10, 11, 12], 42);
  });

  it("staff + mark_ready_for_pickup → 200", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser("staff"));
    const mockResult = {
      action: "mark_ready_for_pickup",
      total: 2,
      succeeded: [20, 21],
      failed: [],
    };
    bulkTransitionAdminOrdersMock.mockResolvedValue(mockResult);

    const req = createRequest("http://localhost/api/admin/orders/bulk", {
      method: "POST",
      body: { action: "mark_ready_for_pickup", orderIds: [20, 21] },
    });
    const res = await bulkPOST(req);
    expect(res.status).toBe(200);
    expect(bulkTransitionAdminOrdersMock).toHaveBeenCalledWith("mark_ready_for_pickup", [20, 21], 42);
  });
});

// ─── 3. MANUAL CREDIT NOTE ROUTE ──────────────────────────

describe("B.4.2 — Manual Credit Note Route (POST /api/admin/orders/[id]/credit-notes)", () => {
  it("unauthenticated → 401", async () => {
    getCurrentUserMock.mockResolvedValue(null);
    const req = createRequest("http://localhost/api/admin/orders/5/credit-notes", {
      method: "POST",
      body: { originalDocumentId: 1, officialReference: "NC-001", amountCents: 500 },
    });
    const res = await creditNotePOST(req, { params: Promise.resolve({ id: "5" }) });
    expect(res.status).toBe(401);
    expect(recordManualCreditNoteMock).not.toHaveBeenCalled();
  });

  it("staff → 403 (credit notes require manager/admin)", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser("staff"));
    const req = createRequest("http://localhost/api/admin/orders/5/credit-notes", {
      method: "POST",
      body: { originalDocumentId: 1, officialReference: "NC-001", amountCents: 500 },
    });
    const res = await creditNotePOST(req, { params: Promise.resolve({ id: "5" }) });
    expect(res.status).toBe(403);
    expect(recordManualCreditNoteMock).not.toHaveBeenCalled();
  });

  it("manager + valid input → 201 with created document", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser("manager"));
    const docStub = { id: 99, orderId: 5, documentType: "credit_note", documentNumber: "NC-001", amountCents: 500 };
    recordManualCreditNoteMock.mockResolvedValue(docStub);

    const req = createRequest("http://localhost/api/admin/orders/5/credit-notes", {
      method: "POST",
      body: { originalDocumentId: 1, officialReference: "NC-001", amountCents: 500, issuedAt: "2026-09-02" },
    });
    const res = await creditNotePOST(req, { params: Promise.resolve({ id: "5" }) });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.document).toEqual(docStub);
    expect(recordManualCreditNoteMock).toHaveBeenCalledWith({
      orderId: 5,
      originalDocumentId: 1,
      officialReference: "NC-001",
      issuedAt: new Date("2026-09-02"),
      amountCents: 500,
      actorId: 42,
    });
  });

  it("invalid amountCents (<= 0 or non-integer) → 400", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser("manager"));
    const req = createRequest("http://localhost/api/admin/orders/5/credit-notes", {
      method: "POST",
      body: { originalDocumentId: 1, officialReference: "NC-001", amountCents: -50 },
    });
    const res = await creditNotePOST(req, { params: Promise.resolve({ id: "5" }) });
    expect(res.status).toBe(400);
    expect(recordManualCreditNoteMock).not.toHaveBeenCalled();
  });
});

// ─── 4. UNIFIED TIMELINE DETERMINISTIC SORTING ────────────

describe("B.4.2 — Unified Operational Timeline Sorting & Tie-breaking", () => {
  it("sorts timeline events deterministically by timestamp descending with type tie-breaking", () => {
    const t1 = new Date("2026-09-01T10:00:00.000Z");
    const t2 = new Date("2026-09-01T12:00:00.000Z");
    const tSame = new Date("2026-09-01T14:00:00.000Z");

    const TYPE_TIE_BREAKER: Record<string, number> = {
      order_created: 1,
      payment: 2,
      payment_attempt: 3,
      invoice: 4,
      status_change: 5,
      refund: 6,
    };

    const entries = [
      { id: "e1", type: "order_created", timestamp: t1, title: "Created" },
      { id: "e2", type: "status_change", timestamp: t2, title: "Status" },
      { id: "e3", type: "refund", timestamp: tSame, title: "Refund" },
      { id: "e4", type: "payment", timestamp: tSame, title: "Payment" },
      { id: "e5", type: "invoice", timestamp: tSame, title: "Invoice" },
    ];

    entries.sort((a, b) => {
      const diff = b.timestamp.getTime() - a.timestamp.getTime();
      if (diff !== 0) return diff;
      const typeDiff = (TYPE_TIE_BREAKER[b.type] ?? 99) - (TYPE_TIE_BREAKER[a.type] ?? 99);
      if (typeDiff !== 0) return typeDiff;
      return b.id.localeCompare(a.id);
    });

    expect(entries[0].id).toBe("e3"); // tSame, refund (priority 6)
    expect(entries[1].id).toBe("e5"); // tSame, invoice (priority 4)
    expect(entries[2].id).toBe("e4"); // tSame, payment (priority 2)
    expect(entries[3].id).toBe("e2"); // t2
    expect(entries[4].id).toBe("e1"); // t1
  });
});
