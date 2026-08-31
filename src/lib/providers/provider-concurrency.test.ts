// B.3.1 — Provider concurrency regression tests (real PostgreSQL, real production services)
//
// These cover the audit findings on PR #4: check-then-act races where a stale
// SELECT was used as the safety boundary instead of the UPDATE predicate.
// Every race below is run with genuinely concurrent promises — nothing is
// artificially serialized — and repeated enough times to expose last-write-wins
// behaviour deterministically (the pre-fix code failed these in >50% of trials).

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { db } from "@/db";
import { orders, paymentAttempts, shipments, invoiceDocuments } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  createPaymentAttempt,
  updatePaymentAttemptStatus,
  listPaymentAttempts,
  getPaymentAttempt,
} from "@/lib/providers/payment-attempts";
import {
  createShipmentRecord,
  updateShipment,
  getShipment,
  listShipmentsForOrder,
  isTerminalShipmentStatus,
  TERMINAL_SHIPMENT_STATUSES,
} from "@/lib/providers/shipping-provider";
import {
  createInvoiceDocument,
  markInvoiceDocumentIssued,
  markInvoiceDocumentFailed,
  cancelInvoiceDocument,
  getInvoiceDocument,
  listInvoiceDocumentsForOrder,
} from "@/lib/providers/invoice-provider";
import { ProviderError } from "@/lib/providers/errors";

/** Enough repetitions to expose a real race, small enough to stay fast. */
const TRIALS = 15;

async function createTestOrder(status = "pending_payment") {
  const [order] = await db
    .insert(orders)
    .values({
      orderNumber: `B31C-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`,
      status,
      paymentStatus: "pending",
      subtotal: "100.00",
      total: "100.00",
      deliveryType: "shipping",
    })
    .returning();
  return order;
}

function summarize(results: PromiseSettledResult<unknown>[]) {
  return {
    fulfilled: results.filter((r) => r.status === "fulfilled").length,
    rejected: results.filter((r) => r.status === "rejected").length,
    reasons: results.flatMap((r) => (r.status === "rejected" ? [r.reason] : [])),
  };
}

beforeEach(async () => {
  await db.delete(paymentAttempts);
  await db.delete(shipments);
  await db.delete(invoiceDocuments);
});

describe("B.3.1 concurrency — payment attempt terminal states", () => {
  it("lets exactly one concurrent terminal transition win, every trial", async () => {
    const order = await createTestOrder();

    for (let trial = 0; trial < TRIALS; trial++) {
      const attempt = await createPaymentAttempt({
        orderId: order.id, provider: "eupago", method: "mbway", amountCents: 10_000,
      });

      const results = await Promise.allSettled([
        updatePaymentAttemptStatus(attempt.id, { status: "paid" }),
        updatePaymentAttemptStatus(attempt.id, { status: "failed" }),
        updatePaymentAttemptStatus(attempt.id, { status: "expired" }),
      ]);
      const { fulfilled, rejected, reasons } = summarize(results);

      expect(fulfilled).toBe(1);
      expect(rejected).toBe(2);
      for (const reason of reasons) {
        expect(reason).toBeInstanceOf(ProviderError);
        expect((reason as ProviderError).code).toBe("OPERATION_NOT_SUPPORTED");
      }

      // The winner is the state that persisted.
      const winner = results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ status: string }>;
      const stored = await getPaymentAttempt(attempt.id);
      expect(stored!.status).toBe(winner.value.status);
      expect(["paid", "failed", "expired"]).toContain(stored!.status);
      expect(stored!.completedAt).toBeInstanceOf(Date);
    }

    // One row per trial — no duplication, full history preserved.
    expect(await listPaymentAttempts(order.id)).toHaveLength(TRIALS);
  });

  it("never lets a later terminal transition overwrite a settled attempt", async () => {
    const order = await createTestOrder();
    const attempt = await createPaymentAttempt({
      orderId: order.id, provider: "eupago", method: "card", amountCents: 5_000,
    });
    const paid = await updatePaymentAttemptStatus(attempt.id, { status: "paid" });
    expect(paid.status).toBe("paid");

    for (const status of ["failed", "expired", "cancelled", "refunded", "pending"] as const) {
      await expect(updatePaymentAttemptStatus(attempt.id, { status })).rejects.toMatchObject({
        code: "OPERATION_NOT_SUPPORTED",
      });
    }
    const stored = await getPaymentAttempt(attempt.id);
    expect(stored!.status).toBe("paid");
    expect(stored!.completedAt?.getTime()).toBe(paid.completedAt?.getTime());
  });

  it("treats a duplicate callback repeating the winning status as idempotent", async () => {
    const order = await createTestOrder();
    const attempt = await createPaymentAttempt({
      orderId: order.id, provider: "eupago", method: "mbway", amountCents: 2_500,
    });
    const first = await updatePaymentAttemptStatus(attempt.id, { status: "expired" });
    const replay = await updatePaymentAttemptStatus(attempt.id, { status: "expired" });

    expect(replay.status).toBe("expired");
    expect(replay.completedAt?.getTime()).toBe(first.completedAt?.getTime());
    expect(await listPaymentAttempts(order.id)).toHaveLength(1);
  });

  it("still reports PAYMENT_NOT_FOUND rather than a rejected transition", async () => {
    await expect(updatePaymentAttemptStatus(999_999_999, { status: "paid" })).rejects.toMatchObject({
      code: "PAYMENT_NOT_FOUND",
    });
  });

  it("does not touch the order while attempts race", async () => {
    const order = await createTestOrder();
    const attempt = await createPaymentAttempt({
      orderId: order.id, provider: "eupago", method: "card", amountCents: 10_000,
    });
    await Promise.allSettled([
      updatePaymentAttemptStatus(attempt.id, { status: "paid" }),
      updatePaymentAttemptStatus(attempt.id, { status: "failed" }),
    ]);
    const [reloaded] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(reloaded.status).toBe("pending_payment");
    expect(reloaded.paymentStatus).toBe("pending");
  });
});

describe("B.3.1 concurrency — issued fiscal document immutability", () => {
  it("never lets a racing failed/cancel overwrite an issued document", async () => {
    const order = await createTestOrder("paid");
    let issuedWins = 0;

    for (let trial = 0; trial < TRIALS; trial++) {
      const doc = await createInvoiceDocument({ orderId: order.id, provider: "xd", documentType: "invoice" });

      const results = await Promise.allSettled([
        markInvoiceDocumentIssued(doc.id, {
          providerDocumentId: `XD-RACE-${trial}`,
          documentNumber: `FT 2026/${trial}`,
          series: "2026",
        }),
        markInvoiceDocumentFailed(doc.id),
        cancelInvoiceDocument(doc.id),
      ]);
      const { fulfilled, rejected } = summarize(results);

      expect(fulfilled).toBe(1);
      expect(rejected).toBe(2);

      const stored = await getInvoiceDocument(doc.id);
      const issueSucceeded = results[0].status === "fulfilled";
      if (issueSucceeded) {
        issuedWins++;
        // The audit reproduced exactly this being violated: issue succeeded but
        // a concurrent cancel/fail rewrote the row.
        expect(stored!.status).toBe("issued");
        expect(stored!.documentNumber).toBe(`FT 2026/${trial}`);
        expect(stored!.providerDocumentId).toBe(`XD-RACE-${trial}`);
        expect(stored!.issuedAt).toBeInstanceOf(Date);
      } else {
        // If issuing lost the race the document must NOT carry fiscal identity.
        expect(["failed", "cancelled"]).toContain(stored!.status);
        expect(stored!.documentNumber).toBeNull();
        expect(stored!.providerDocumentId).toBeNull();
        expect(stored!.issuedAt).toBeNull();
      }
    }

    expect(await listInvoiceDocumentsForOrder(order.id)).toHaveLength(TRIALS);
    expect(issuedWins).toBeGreaterThan(0); // the issue path really is exercised
  });

  it("rejects every post-issue mutation, sequentially and repeatedly", async () => {
    const order = await createTestOrder("paid");
    const doc = await createInvoiceDocument({ orderId: order.id, provider: "xd", documentType: "invoice" });
    await markInvoiceDocumentIssued(doc.id, {
      providerDocumentId: "XD-IMMUTABLE", documentNumber: "FT 2026/500", series: "2026",
    });

    for (let i = 0; i < 3; i++) {
      await expect(markInvoiceDocumentFailed(doc.id)).rejects.toMatchObject({ code: "OPERATION_NOT_SUPPORTED" });
      await expect(cancelInvoiceDocument(doc.id)).rejects.toMatchObject({ code: "OPERATION_NOT_SUPPORTED" });
      await expect(
        markInvoiceDocumentIssued(doc.id, { providerDocumentId: "XD-OTHER", documentNumber: "FT 2026/999" })
      ).rejects.toMatchObject({ code: "OPERATION_NOT_SUPPORTED" });
    }

    const stored = await getInvoiceDocument(doc.id);
    expect(stored!.status).toBe("issued");
    expect(stored!.documentNumber).toBe("FT 2026/500");
    expect(stored!.providerDocumentId).toBe("XD-IMMUTABLE");
    // The row is never removed — cancellation/failure are states, not deletes.
    expect(await listInvoiceDocumentsForOrder(order.id)).toHaveLength(1);
  });

  it("distinguishes missing documents from rejected transitions", async () => {
    await expect(markInvoiceDocumentFailed(999_999_999)).rejects.toMatchObject({ code: "INVOICE_NOT_FOUND" });
    await expect(cancelInvoiceDocument(999_999_999)).rejects.toMatchObject({ code: "INVOICE_NOT_FOUND" });
  });

  it("does not touch the order while documents race", async () => {
    const order = await createTestOrder("paid");
    const doc = await createInvoiceDocument({ orderId: order.id, provider: "xd", documentType: "invoice" });
    await Promise.allSettled([
      markInvoiceDocumentIssued(doc.id, { providerDocumentId: "XD-O", documentNumber: "FT 1" }),
      cancelInvoiceDocument(doc.id),
    ]);
    const [reloaded] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(reloaded.status).toBe("paid");
  });
});

describe("B.3.1 concurrency — shipment terminal states", () => {
  it("lets exactly one concurrent terminal carrier outcome win", async () => {
    const order = await createTestOrder("processing");
    expect([...TERMINAL_SHIPMENT_STATUSES]).toEqual(["delivered", "cancelled"]);

    for (let trial = 0; trial < TRIALS; trial++) {
      const shipment = await createShipmentRecord({ orderId: order.id, provider: "mrw", status: "in_transit" });

      const results = await Promise.allSettled([
        updateShipment(shipment.id, { status: "delivered" }),
        updateShipment(shipment.id, { status: "cancelled" }),
      ]);
      const { fulfilled, rejected } = summarize(results);

      expect(fulfilled).toBe(1);
      expect(rejected).toBe(1);

      const stored = await getShipment(shipment.id);
      expect(isTerminalShipmentStatus(stored!.status)).toBe(true);

      // A later competing terminal update cannot overwrite the settled one.
      const other = stored!.status === "delivered" ? "cancelled" : "delivered";
      await expect(updateShipment(shipment.id, { status: other })).rejects.toMatchObject({
        code: "OPERATION_NOT_SUPPORTED",
      });
      expect((await getShipment(shipment.id))!.status).toBe(stored!.status);
    }

    expect(await listShipmentsForOrder(order.id)).toHaveLength(TRIALS);
  });

  it("keeps non-terminal progress updates working", async () => {
    const order = await createTestOrder("processing");
    const shipment = await createShipmentRecord({ orderId: order.id, provider: "ctt" });
    expect((await updateShipment(shipment.id, { status: "created" })).status).toBe("created");
    expect((await updateShipment(shipment.id, { status: "label_ready", labelReference: "L" })).labelReference).toBe("L");
    const transit = await updateShipment(shipment.id, { status: "in_transit", trackingNumber: "T" });
    expect(transit.status).toBe("in_transit");
    expect(transit.trackingNumber).toBe("T");
    // Metadata-only update on a live shipment is allowed
    expect((await updateShipment(shipment.id, { trackingNumber: "T2" })).status).toBe("in_transit");
  });

  it("treats repeating the terminal status as idempotent and reports missing shipments", async () => {
    const order = await createTestOrder("processing");
    const shipment = await createShipmentRecord({ orderId: order.id, provider: "mrw", status: "in_transit" });
    await updateShipment(shipment.id, { status: "delivered" });
    expect((await updateShipment(shipment.id, { status: "delivered" })).status).toBe("delivered");

    await expect(updateShipment(999_999_999, { status: "delivered" })).rejects.toMatchObject({
      code: "SHIPMENT_NOT_FOUND",
    });
  });

  it("does not touch the order while shipments race", async () => {
    const order = await createTestOrder("processing");
    const shipment = await createShipmentRecord({ orderId: order.id, provider: "mrw", status: "in_transit" });
    await Promise.allSettled([
      updateShipment(shipment.id, { status: "delivered" }),
      updateShipment(shipment.id, { status: "cancelled" }),
    ]);
    const [reloaded] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(reloaded.status).toBe("processing");
    expect(reloaded.trackingNumber).toBeNull();
  });
});

// Leave no order-referencing provider rows behind: other suites truncate
// `orders`, which fails while child rows still reference it.
afterAll(async () => {
  await db.delete(paymentAttempts);
  await db.delete(shipments);
  await db.delete(invoiceDocuments);
});
