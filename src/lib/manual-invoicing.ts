import { db } from "@/db";
import { invoiceDocuments, orders, settings, type InvoiceDocumentType } from "@/db/schema";
import { createAuditLog } from "@/lib/audit";
import { and, eq } from "drizzle-orm";

const SAFE_REFERENCE = /^[\p{L}\p{N}][\p{L}\p{N}\s./_:@#-]{1,99}$/u;

function eurosStringToCents(value: string): number {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) throw new Error("INVALID_ORDER_TOTAL");
  const [euros, cents = ""] = value.split(".");
  return Number(euros) * 100 + Number(cents.padEnd(2, "0"));
}

export class ManualInvoicingError extends Error {
  constructor(readonly code: "ORDER_NOT_FOUND" | "AUTOMATIC_INVOICING_UNAVAILABLE" | "INVALID_REFERENCE" | "DUPLICATE_INVOICE" | "INVALID_DOCUMENT_TYPE", message: string) {
    super(message);
    this.name = "ManualInvoicingError";
  }
}

async function getInvoiceMode(): Promise<string> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, "invoice_mode")).limit(1);
  return row?.value || "manual";
}

export async function assertManualInvoiceMode(): Promise<void> {
  const mode = await getInvoiceMode();
  if (mode !== "manual") {
    // Fail closed: automatic mode is deliberately unavailable until XD exists.
    throw new ManualInvoicingError("AUTOMATIC_INVOICING_UNAVAILABLE", "Emissão automática indisponível nesta fase");
  }
}

export async function recordManualInvoice(input: {
  orderId: number;
  actorUserId: number;
  officialReference: string;
  issuedAt: Date;
  documentType?: InvoiceDocumentType;
}) {
  await assertManualInvoiceMode();
  const documentType = input.documentType || "invoice";
  if (documentType !== "invoice") throw new ManualInvoicingError("INVALID_DOCUMENT_TYPE", "Tipo de documento inválido");

  const officialReference = input.officialReference.trim();
  if (!SAFE_REFERENCE.test(officialReference)) {
    throw new ManualInvoicingError("INVALID_REFERENCE", "Referência fiscal inválida");
  }

  const [order] = await db.select().from(orders).where(eq(orders.id, input.orderId)).limit(1);
  if (!order) throw new ManualInvoicingError("ORDER_NOT_FOUND", "Encomenda não encontrada");

  try {
    const [doc] = await db.insert(invoiceDocuments).values({
      orderId: order.id,
      provider: "manual",
      source: "manual",
      documentType,
      providerDocumentId: officialReference,
      documentNumber: officialReference,
      status: "issued",
      issuedAt: input.issuedAt,
      documentReference: officialReference,
      amountCents: eurosStringToCents(order.total),
      currency: "EUR",
    }).returning();

    await createAuditLog({
      userId: input.actorUserId,
      action: "manual_invoice.recorded",
      entity: "invoice_document",
      entityId: doc.id,
      details: { orderId: order.id, documentType, amountCents: doc.amountCents, currency: doc.currency },
    });
    return doc;
  } catch (e) {
    const message = e instanceof Error ? e.message : "";
    const code = typeof e === "object" && e !== null && "code" in e ? String((e as { code?: unknown }).code) : "";
    const causeCode = typeof e === "object" && e !== null && "cause" in e && typeof (e as { cause?: unknown }).cause === "object" && (e as { cause?: { code?: unknown } }).cause
      ? String((e as { cause: { code?: unknown } }).cause.code || "")
      : "";
    if (code === "23505" || causeCode === "23505" || message.includes("invoice_documents_one_manual_invoice_per_order") || message.includes("invoice_documents_provider_document_unique")) {
      throw new ManualInvoicingError("DUPLICATE_INVOICE", "Já existe uma fatura manual emitida para esta encomenda ou referência");
    }
    throw e;
  }
}

export async function getIssuedInvoiceForOrder(orderId: number) {
  const [doc] = await db.select().from(invoiceDocuments).where(and(
    eq(invoiceDocuments.orderId, orderId),
    eq(invoiceDocuments.documentType, "invoice"),
    eq(invoiceDocuments.status, "issued"),
  )).limit(1);
  return doc ?? null;
}
