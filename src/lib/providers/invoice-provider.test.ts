// B.3.1 — Invoice provider foundation tests (real PostgreSQL, real production service)

import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/db";
import { invoiceDocuments, orders } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  createInvoiceDocument,
  markInvoiceDocumentIssued,
  markInvoiceDocumentFailed,
  cancelInvoiceDocument,
  getInvoiceDocument,
  listInvoiceDocumentsForOrder,
  findInvoiceDocumentByProviderId,
  getInvoiceAdapter,
  isInvoiceDocumentType,
  isInvoiceDocumentStatus,
} from "@/lib/providers/invoice-provider";
import * as invoiceModule from "@/lib/providers/invoice-provider";
import { ProviderError } from "@/lib/providers/errors";

async function createTestOrder() {
  const [order] = await db
    .insert(orders)
    .values({
      orderNumber: `B31I-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
      status: "paid",
      paymentStatus: "paid",
      subtotal: "100.00",
      total: "100.00",
      deliveryType: "shipping",
    })
    .returning();
  return order;
}

beforeEach(async () => {
  await db.delete(invoiceDocuments);
});

describe("B.3.1 — invoicing: registry and adapters", () => {
  it("accepts xd as the allowlisted invoice provider", async () => {
    const order = await createTestOrder();
    const doc = await createInvoiceDocument({ orderId: order.id, provider: "xd", documentType: "invoice" });
    expect(doc.provider).toBe("xd");
    expect(doc.status).toBe("pending");
  });

  it("rejects unsupported invoice providers", async () => {
    const order = await createTestOrder();
    await expect(
      createInvoiceDocument({ orderId: order.id, provider: "moloni", documentType: "invoice" })
    ).rejects.toMatchObject({ code: "UNSUPPORTED_PROVIDER" });
    expect(() => getInvoiceAdapter("moloni")).toThrow(ProviderError);
  });

  it("makes no live XD calls in this phase", () => {
    try {
      getInvoiceAdapter("xd", "createInvoice");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ProviderError).code).toBe("PROVIDER_UNAVAILABLE");
    }
    try {
      getInvoiceAdapter("xd", "quote");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ProviderError).code).toBe("OPERATION_NOT_SUPPORTED");
    }
  });

  it("validates document types and statuses", async () => {
    const order = await createTestOrder();
    expect(isInvoiceDocumentType("invoice")).toBe(true);
    expect(isInvoiceDocumentType("credit_note")).toBe(true);
    expect(isInvoiceDocumentType("receipt")).toBe(false);
    for (const status of ["pending", "issued", "failed", "cancelled"] as const) {
      expect(isInvoiceDocumentStatus(status)).toBe(true);
    }
    expect(isInvoiceDocumentStatus("paid")).toBe(false);

    await expect(
      createInvoiceDocument({ orderId: order.id, provider: "xd", documentType: "receipt" })
    ).rejects.toMatchObject({ code: "OPERATION_NOT_SUPPORTED" });
  });
});

describe("B.3.1 — invoicing: document persistence", () => {
  it("stores an issued invoice with provider reference, number, series and issuedAt", async () => {
    const order = await createTestOrder();
    const pending = await createInvoiceDocument({ orderId: order.id, provider: "xd", documentType: "invoice" });
    const issuedAt = new Date("2026-08-31T10:00:00.000Z");

    const issued = await markInvoiceDocumentIssued(pending.id, {
      providerDocumentId: "XD-DOC-1",
      documentNumber: "FT 2026/125",
      series: "2026",
      issuedAt,
      documentReference: "xd/documents/XD-DOC-1",
    });

    expect(issued.status).toBe("issued");
    expect(issued.providerDocumentId).toBe("XD-DOC-1");
    expect(issued.documentNumber).toBe("FT 2026/125");
    expect(issued.series).toBe("2026");
    expect(issued.issuedAt?.toISOString()).toBe(issuedAt.toISOString());
    expect(issued.documentReference).toBe("xd/documents/XD-DOC-1");
    expect(issued.orderId).toBe(order.id);

    const found = await findInvoiceDocumentByProviderId("xd", "XD-DOC-1");
    expect(found!.id).toBe(issued.id);
  });

  it("stores credit notes alongside invoices for the same order", async () => {
    const order = await createTestOrder();
    const invoice = await createInvoiceDocument({ orderId: order.id, provider: "xd", documentType: "invoice" });
    await markInvoiceDocumentIssued(invoice.id, { providerDocumentId: "XD-FT-2", documentNumber: "FT 2026/126", series: "2026" });

    const creditNote = await createInvoiceDocument({ orderId: order.id, provider: "xd", documentType: "credit_note" });
    const issuedCredit = await markInvoiceDocumentIssued(creditNote.id, {
      providerDocumentId: "XD-NC-1",
      documentNumber: "NC 2026/7",
      series: "2026",
    });

    const documents = await listInvoiceDocumentsForOrder(order.id);
    expect(documents).toHaveLength(2);
    expect(documents.map((d) => d.documentType)).toEqual(["invoice", "credit_note"]);
    expect(issuedCredit.status).toBe("issued");
    expect(issuedCredit.issuedAt).toBeInstanceOf(Date);
  });

  it("enforces database constraints", async () => {
    const order = await createTestOrder();
    await createInvoiceDocument({
      orderId: order.id, provider: "xd", documentType: "invoice", providerDocumentId: "XD-UNIQUE",
    });
    await expect(
      createInvoiceDocument({
        orderId: order.id, provider: "xd", documentType: "credit_note", providerDocumentId: "XD-UNIQUE",
      })
    ).rejects.toThrow();

    await expect(
      createInvoiceDocument({ orderId: 999_999_999, provider: "xd", documentType: "invoice" })
    ).rejects.toThrow();
  });

  it("reports INVOICE_NOT_FOUND for unknown documents", async () => {
    expect(await getInvoiceDocument(999_999_999)).toBeNull();
    await expect(
      markInvoiceDocumentIssued(999_999_999, { providerDocumentId: "X", documentNumber: "Y" })
    ).rejects.toMatchObject({ code: "INVOICE_NOT_FOUND" });
  });
});

describe("B.3.1 — invoicing: issued-document safety", () => {
  it("never rewrites an issued fiscal document", async () => {
    const order = await createTestOrder();
    const doc = await createInvoiceDocument({ orderId: order.id, provider: "xd", documentType: "invoice" });
    await markInvoiceDocumentIssued(doc.id, { providerDocumentId: "XD-FIX-1", documentNumber: "FT 2026/200", series: "2026" });

    await expect(
      markInvoiceDocumentIssued(doc.id, { providerDocumentId: "XD-FIX-2", documentNumber: "FT 2026/999" })
    ).rejects.toMatchObject({ code: "OPERATION_NOT_SUPPORTED" });
    await expect(markInvoiceDocumentFailed(doc.id)).rejects.toMatchObject({ code: "OPERATION_NOT_SUPPORTED" });
    await expect(cancelInvoiceDocument(doc.id)).rejects.toMatchObject({ code: "OPERATION_NOT_SUPPORTED" });

    const stored = await getInvoiceDocument(doc.id);
    expect(stored!.documentNumber).toBe("FT 2026/200");
    expect(stored!.status).toBe("issued");
  });

  it("exposes no destructive deletion for fiscal references", () => {
    const exported = Object.keys(invoiceModule);
    expect(exported.filter((name) => /delete|destroy|purge|remove|drop/i.test(name))).toEqual([]);
  });

  it("allows failure and cancellation only while still pending", async () => {
    const order = await createTestOrder();
    const failing = await createInvoiceDocument({ orderId: order.id, provider: "xd", documentType: "invoice" });
    expect((await markInvoiceDocumentFailed(failing.id)).status).toBe("failed");

    const cancelling = await createInvoiceDocument({ orderId: order.id, provider: "xd", documentType: "invoice" });
    expect((await cancelInvoiceDocument(cancelling.id)).status).toBe("cancelled");
    await expect(
      markInvoiceDocumentIssued(cancelling.id, { providerDocumentId: "XD-C", documentNumber: "FT 1" })
    ).rejects.toMatchObject({ code: "OPERATION_NOT_SUPPORTED" });

    // The rows still exist — cancellation is a state change, not a delete
    expect(await listInvoiceDocumentsForOrder(order.id)).toHaveLength(2);
  });

  it("does not mutate the order when documents are issued", async () => {
    const order = await createTestOrder();
    const doc = await createInvoiceDocument({ orderId: order.id, provider: "xd", documentType: "invoice" });
    await markInvoiceDocumentIssued(doc.id, { providerDocumentId: "XD-NOORD", documentNumber: "FT 2026/300" });
    const [reloaded] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(reloaded.status).toBe("paid");
  });
});
