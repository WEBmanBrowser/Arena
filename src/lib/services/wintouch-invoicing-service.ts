import type { CreateInvoiceRequest } from "../providers/invoice-provider";
import { db } from "@/db";
import { invoiceDocuments, orderItems, orders, users } from "@/db/schema";
import { createAuditLog } from "@/lib/audit";
import { and, eq, sql } from "drizzle-orm";
import { wintouchInvoiceAdapter } from "@/lib/providers/wintouch/adapter";
import { registerInvoiceAdapter } from "@/lib/providers/invoice-provider";
import { resolveOrCreateWintouchEntity } from "@/lib/providers/wintouch/entity-resolver";

registerInvoiceAdapter(wintouchInvoiceAdapter);

function cents(v: string): number {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error("INVALID_MONEY");
  return Math.round(n * 100);
}

type Addr = { address?: string; address1?: string; address2?: string; postalCode?: string; postal_code?: string; city?: string; country?: string };

type FiscalSourceLine = {
  description: string;
  sku?: string | null;
  quantity: number;
  lineTotalCents: number;
  vatRate: string;
};

/**
 * Preserve the checkout total exactly, including allocated coupon discounts.
 * If a discounted line no longer divides evenly by its quantity, split only
 * the cents remainder into a second row. Quantity and gross total are both
 * retained without sending floating-point discount formulas to WINTOUCH.
 */
export function expandWintouchFiscalLines(source: FiscalSourceLine[]) {
  return source.flatMap((line) => {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new Error("WINTOUCH_INVALID_QUANTITY");
    }
    if (!Number.isInteger(line.lineTotalCents) || line.lineTotalCents < 0) {
      throw new Error("WINTOUCH_INVALID_LINE_TOTAL");
    }

    const lowUnit = Math.floor(line.lineTotalCents / line.quantity);
    const highUnits = line.lineTotalCents % line.quantity;
    const lowUnits = line.quantity - highUnits;
    const common = {
      description: line.description,
      sku: line.sku,
      vatRate: line.vatRate,
    };
    const result = [];

    if (lowUnits > 0) {
      result.push({ ...common, quantity: lowUnits, unitPriceCents: lowUnit });
    }
    if (highUnits > 0) {
      result.push({ ...common, quantity: highUnits, unitPriceCents: lowUnit + 1 });
    }
    return result;
  });
}

export function selectPaidWintouchDocumentKind(totalCents: number) {
  if (!Number.isInteger(totalCents) || totalCents < 0) {
    throw new Error("WINTOUCH_INVALID_ORDER_TOTAL");
  }
  return totalCents <= 100000
    ? "simplified_invoice" as const
    : "invoice_receipt" as const;
}

export async function issueWintouchInvoiceForOrder(orderId: number, actorUserId: number | null = null) {
  return db.transaction(async (tx) => {
    // Cross-process serialization for this order. The pending row is committed
    // before the provider call, so a second request can never blind-create.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(77421, ${orderId})`);

    const existing = await tx
      .select()
      .from(invoiceDocuments)
      .where(and(eq(invoiceDocuments.orderId, orderId), eq(invoiceDocuments.documentType, "invoice")));

    const issued = existing.find((d) => d.status === "issued");
    if (issued) {
      if (issued.provider === "wintouch") return issued;
      throw new Error("ORDER_ALREADY_INVOICED");
    }
    if (existing.some((d) => d.status === "pending")) {
      throw new Error("WINTOUCH_RECONCILIATION_REQUIRED");
    }

    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order) throw new Error("ORDER_NOT_FOUND");
    if (order.paymentStatus !== "paid") throw new Error("ORDER_NOT_PAID");

    const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId));
    if (!items.length) throw new Error("ORDER_HAS_NO_ITEMS");

    const sourceLines: FiscalSourceLine[] = items.map((i) => ({
      description: i.productName,
      sku: i.productSku,
      quantity: i.quantity,
      lineTotalCents: cents(i.lineTotalGross),
      vatRate: i.vatRate,
    }));

    const shippingCents = cents(order.shipping);
    if (shippingCents > 0) {
      sourceLines.push({
        description: "Portes de envio",
        sku: "SHIPPING",
        quantity: 1,
        lineTotalCents: shippingCents,
        vatRate: "23.00",
      });
    }

    const lines = expandWintouchFiscalLines(sourceLines);

    const expectedTotalCents = cents(order.total);
    const fiscalLinesTotal = lines.reduce((n, l) => n + l.unitPriceCents * l.quantity, 0);
    if (fiscalLinesTotal !== expectedTotalCents) throw new Error("WINTOUCH_TOTAL_MISMATCH");

    let email = order.guestEmail;
    let name = order.companyName || order.guestName || "Consumidor final";
    if (order.userId) {
      const [u] = await tx.select({ email: users.email, name: users.name }).from(users).where(eq(users.id, order.userId)).limit(1);
      email = email || u?.email || null;
      name = order.companyName || u?.name || name;
    }

    const [pending] = await tx.insert(invoiceDocuments).values({
      orderId, provider: "wintouch", source: "provider", documentType: "invoice",
      status: "pending", amountCents: expectedTotalCents, currency: "EUR",
    }).returning();

    const address = (order.billingAddress ?? {}) as Addr;
    return {
      pending,
      request: {
        orderId,
        documentType: "invoice" as const,

        /*
         * Retail ecommerce rule currently implemented:
         *
         * - paid total <= EUR 1,000.00:
         *     FS
         *
         * - paid total > EUR 1,000.00:
         *     FATREC (Fatura/Recibo)
         *
         * EUR 1,000.00 itself is eligible for FS;
         * EUR 1,000.01 is not.
         *
         * A supplied NIF is retained and resolved for either kind.
         * FT is deliberately excluded because checkout is already paid.
         */
        fiscalDocumentKind:
          selectPaidWintouchDocumentKind(expectedTotalCents),

        customerName: name,
        customerNif: order.nif,
        customerEmail: email,

        /*
         * Preserve the real checkout method all the way to
         * WINTOUCH. The adapter performs the strict mapping.
         */
        paymentMethod:
          order.paymentMethod,



        billingAddress: {
          address1:
            address.address1 ??
            address.address ??
            null,

          address2:
            address.address2 ??
            null,

          postalCode:
            address.postalCode ??
            address.postal_code ??
            null,

          city:
            address.city ??
            null,

          country:
            address.country ??
            null,
        },

        externalReference:
          order.orderNumber,

        expectedTotalCents,
        lines,
      },
    };
  }).then(async (state) => {
    if (!("pending" in state)) return state;

    try {
      /*
       * Customer resolution rules:
       *
       * FS without NIF:
       *   anonymous consumer-final path. Do not invent
       *   a NIF and do not require EntityID.
       *
       * Any document carrying a real NIF:
       *   resolve the exact WINTOUCH entity first.
       *
       * Entity creation is a separate controlled phase.
       * A missing identified customer fails closed.
       */
      const customerNif =
        state.request.customerNif?.trim() ||
        null;

      let request: CreateInvoiceRequest =
        state.request;

      if (customerNif) {
        const entity = await resolveOrCreateWintouchEntity({
          vatNumber: customerNif,
          name: state.request.customerName,
          email: state.request.customerEmail,
          address: state.request.billingAddress,
        });

        request = {
          ...state.request,
          customerNif,
          customerProviderEntityId:
            entity.id,
        };
      }

      const result =
        await wintouchInvoiceAdapter.createInvoice(
          request,
        );
      const [doc] = await db.update(invoiceDocuments).set({
        status: "issued", providerDocumentId: result.providerDocumentId, documentNumber: result.documentNumber ?? null,
        series: result.series ?? null, issuedAt: result.issuedAt ?? new Date(),
        documentReference: result.documentReference ?? result.providerDocumentId, updatedAt: new Date(),
      }).where(and(eq(invoiceDocuments.id, state.pending.id), eq(invoiceDocuments.status, "pending"))).returning();
      if (!doc) throw new Error("INVOICE_STATE_CHANGED");

      // Fiscal success must not be reported as failure merely because the
      // secondary audit sink is unavailable. The fiscal reference is durable.
      try {
        await createAuditLog({ userId: actorUserId, action: "wintouch.invoice.issued", entity: "invoice_document", entityId: doc.id, details: { orderId, providerDocumentId: doc.providerDocumentId, documentNumber: doc.documentNumber } });
      } catch {
        console.error("WINTOUCH invoice audit write failed");
      }
      return doc;
    } catch (e) {
      // Ambiguous create outcomes (timeout/network/5xx/malformed response) stay
      // pending. They require reconciliation and MUST NEVER be blind-retried.
      const msg = e instanceof Error ? e.message : "WINTOUCH_ERROR";
      if (!msg.includes("ambiguous provider outcome")) {
        await db.update(invoiceDocuments).set({ status: "failed", updatedAt: new Date() })
          .where(and(eq(invoiceDocuments.id, state.pending.id), eq(invoiceDocuments.status, "pending")));
      }
      throw e;
    }
  });
}
