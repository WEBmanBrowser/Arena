import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { auditLogs, invoiceDocuments, orders, payments, settings } from "@/db/schema";
import { and, eq, like } from "drizzle-orm";

const getCurrentUserMock = vi.fn();
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getCurrentUser: () => getCurrentUserMock() };
});

import { POST as manualInvoicePOST } from "@/app/api/admin/orders/[id]/manual-invoice/route";

function makeUser(role: "customer" | "staff" | "manager" | "admin") {
  return { id: 1, email: `b34a-${role}@test.local`, name: `B34A ${role}`, role, phone: null, nif: null, company: null };
}

function postReq(body: unknown) {
  return new NextRequest("http://localhost/api/admin/orders/1/manual-invoice", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function createOrder(total = "44.44") {
  const [order] = await db.insert(orders).values({
    orderNumber: `B34A-ROUTE-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    status: "pending_payment",
    paymentStatus: "pending",
    subtotal: total,
    shipping: "0.00",
    total,
    deliveryType: "shipping",
    paymentMethod: "bank_transfer",
  }).returning();
  await db.insert(payments).values({ orderId: order.id, provider: "manual", method: "bank_transfer", amount: total, currency: "EUR", status: "pending" });
  return order;
}

beforeEach(async () => {
  getCurrentUserMock.mockReset();
  const rows = await db.select({ id: orders.id }).from(orders).where(like(orders.orderNumber, "B34A-ROUTE%"));
  for (const row of rows) {
    await db.delete(invoiceDocuments).where(eq(invoiceDocuments.orderId, row.id));
    await db.delete(payments).where(eq(payments.orderId, row.id));
    await db.delete(orders).where(eq(orders.id, row.id));
  }
  await db.delete(auditLogs).where(eq(auditLogs.action, "manual_invoice.recorded"));
  await db.update(settings).set({ value: "manual" }).where(eq(settings.key, "invoice_mode"));
});

describe("B.3.4A manual invoice route", () => {
  it("blocks unauthenticated, customer and staff users", async () => {
    const order = await createOrder();
    getCurrentUserMock.mockResolvedValue(null);
    expect((await manualInvoicePOST(postReq({ officialReference: "FT ROUTE/NOAUTH" }), { params: Promise.resolve({ id: String(order.id) }) })).status).toBe(401);
    getCurrentUserMock.mockResolvedValue(makeUser("customer"));
    expect((await manualInvoicePOST(postReq({ officialReference: "FT ROUTE/CUST" }), { params: Promise.resolve({ id: String(order.id) }) })).status).toBe(403);
    getCurrentUserMock.mockResolvedValue(makeUser("staff"));
    expect((await manualInvoicePOST(postReq({ officialReference: "FT ROUTE/STAFF" }), { params: Promise.resolve({ id: String(order.id) }) })).status).toBe(403);
  });

  it("allows manager, ignores tampered amount/currency, and creates one non-PII audit", async () => {
    const order = await createOrder("44.44");
    getCurrentUserMock.mockResolvedValue(makeUser("manager"));
    const res = await manualInvoicePOST(postReq({ officialReference: "FT ROUTE/OK", issuedAt: "2026-09-01", amountCents: 1, currency: "USD" }), { params: Promise.resolve({ id: String(order.id) }) });
    expect(res.status).toBe(201);
    const [doc] = await db.select().from(invoiceDocuments).where(eq(invoiceDocuments.orderId, order.id));
    expect(doc.amountCents).toBe(4444);
    expect(doc.currency).toBe("EUR");
    const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.action, "manual_invoice.recorded"), eq(auditLogs.entityId, doc.id)));
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0].details)).not.toContain("FT ROUTE/OK");
  });

  it("rejects malformed issued date and duplicate invoice deterministically", async () => {
    const order = await createOrder("20.00");
    getCurrentUserMock.mockResolvedValue(makeUser("admin"));
    expect((await manualInvoicePOST(postReq({ officialReference: "FT ROUTE/BADDATE", issuedAt: "not-a-date" }), { params: Promise.resolve({ id: String(order.id) }) })).status).toBe(400);
    expect((await manualInvoicePOST(postReq({ officialReference: "FT ROUTE/ONE" }), { params: Promise.resolve({ id: String(order.id) }) })).status).toBe(201);
    expect((await manualInvoicePOST(postReq({ officialReference: "FT ROUTE/TWO" }), { params: Promise.resolve({ id: String(order.id) }) })).status).toBe(409);
    const rows = await db.select().from(invoiceDocuments).where(eq(invoiceDocuments.orderId, order.id));
    expect(rows).toHaveLength(1);
  });
});
