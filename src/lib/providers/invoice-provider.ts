/**
 * B.3.1 — Invoice provider contract + fiscal document reference persistence.
 *
 * XD Software ("xd") is the future fiscal document provider. This shop does
 * NOT issue certified Portuguese fiscal documents itself: the rows stored here
 * are synchronization/reference metadata for documents issued by XD.
 *
 * NO live XD calls, NO invented endpoints, NO invented payload formats.
 *
 * FISCAL SAFETY: there is deliberately no delete/destroy function for issued
 * documents. An issued fiscal reference can only be superseded (credit note)
 * or marked cancelled — never silently removed.
 */

import { db } from "@/db";
import {
  invoiceDocuments,
  INVOICE_DOCUMENT_STATUSES,
  INVOICE_DOCUMENT_TYPES,
  type InvoiceDocumentStatus,
  type InvoiceDocumentType,
} from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { ProviderError } from "./errors";
import { assertCapability, getInvoiceProvider, type InvoiceProviderId } from "./registry";

export type InvoiceDocumentRecord = typeof invoiceDocuments.$inferSelect;

export function isInvoiceDocumentType(value: string): value is InvoiceDocumentType {
  return (INVOICE_DOCUMENT_TYPES as readonly string[]).includes(value);
}

export function isInvoiceDocumentStatus(value: string): value is InvoiceDocumentStatus {
  return (INVOICE_DOCUMENT_STATUSES as readonly string[]).includes(value);
}

// ─── Provider contract (foundation) ───────────────────────

export interface InvoiceLineInput {
  description: string;
  quantity: number;
  /** Integer cents, EUR. */
  unitPriceCents: number;
  vatRate: string;
}

export interface CreateInvoiceRequest {
  orderId: number;
  documentType: InvoiceDocumentType;
  lines: InvoiceLineInput[];
  customerName: string;
  customerNif?: string | null;
}

export interface InvoiceProviderResult {
  providerDocumentId: string;
  documentNumber?: string | null;
  series?: string | null;
  status: InvoiceDocumentStatus;
  issuedAt?: Date | null;
  documentReference?: string | null;
}

/** Contract every future invoice adapter (XD, …) implements. */
export interface InvoiceProviderAdapter {
  readonly provider: InvoiceProviderId;
  createInvoice(request: CreateInvoiceRequest): Promise<InvoiceProviderResult>;
  getDocument(providerDocumentId: string): Promise<InvoiceProviderResult>;
  createCreditNote?(providerDocumentId: string, request: CreateInvoiceRequest): Promise<InvoiceProviderResult>;
  sendDocument?(providerDocumentId: string, email: string): Promise<{ sent: boolean }>;
  getStatus?(providerDocumentId: string): Promise<{ status: InvoiceDocumentStatus }>;
}

const ADAPTERS = new Map<InvoiceProviderId, InvoiceProviderAdapter>();

export function registerInvoiceAdapter(adapter: InvoiceProviderAdapter): void {
  getInvoiceProvider(adapter.provider);
  ADAPTERS.set(adapter.provider, adapter);
}

export function getInvoiceAdapter(providerId: string, capability?: string): InvoiceProviderAdapter {
  const descriptor = getInvoiceProvider(providerId);
  if (capability) assertCapability(descriptor, capability);
  const adapter = ADAPTERS.get(descriptor.id);
  if (!adapter) {
    throw new ProviderError("PROVIDER_UNAVAILABLE", {
      provider: descriptor.id,
      internalDetail: "no adapter registered in this phase",
    });
  }
  return adapter;
}

// ─── Persistence ──────────────────────────────────────────

export interface CreateInvoiceDocumentInput {
  orderId: number;
  provider: string;
  documentType: string;
  providerDocumentId?: string | null;
  documentNumber?: string | null;
  series?: string | null;
  status?: InvoiceDocumentStatus;
  issuedAt?: Date | null;
  documentReference?: string | null;
}

export async function createInvoiceDocument(input: CreateInvoiceDocumentInput): Promise<InvoiceDocumentRecord> {
  const descriptor = getInvoiceProvider(input.provider); // UNSUPPORTED_PROVIDER
  if (!isInvoiceDocumentType(input.documentType)) {
    throw new ProviderError("OPERATION_NOT_SUPPORTED", {
      provider: descriptor.id,
      internalDetail: `unknown document type: ${String(input.documentType).slice(0, 32)}`,
    });
  }
  const status = input.status ?? "pending";
  if (!isInvoiceDocumentStatus(status)) {
    throw new ProviderError("INVALID_PROVIDER_RESPONSE", {
      provider: descriptor.id,
      internalDetail: "unknown document status",
    });
  }

  const [row] = await db
    .insert(invoiceDocuments)
    .values({
      orderId: input.orderId,
      provider: descriptor.id,
      documentType: input.documentType,
      providerDocumentId: input.providerDocumentId ?? null,
      documentNumber: input.documentNumber ?? null,
      series: input.series ?? null,
      status,
      issuedAt: input.issuedAt ?? null,
      documentReference: input.documentReference ?? null,
    })
    .returning();
  return row;
}

export interface MarkInvoiceIssuedInput {
  providerDocumentId: string;
  documentNumber: string;
  series?: string | null;
  issuedAt?: Date;
  documentReference?: string | null;
}

/**
 * Record that the fiscal provider issued the document.
 * Only a pending document can become issued; an already-issued document is
 * never rewritten (fiscal references are immutable once issued).
 */
export async function markInvoiceDocumentIssued(
  documentId: number,
  input: MarkInvoiceIssuedInput
): Promise<InvoiceDocumentRecord> {
  const existing = await requireInvoiceDocument(documentId);
  if (existing.status === "issued") {
    throw new ProviderError("OPERATION_NOT_SUPPORTED", {
      provider: existing.provider,
      internalDetail: "issued fiscal document is immutable",
    });
  }
  if (existing.status === "cancelled") {
    throw new ProviderError("OPERATION_NOT_SUPPORTED", {
      provider: existing.provider,
      internalDetail: "cancelled document cannot be issued",
    });
  }

  const [row] = await db
    .update(invoiceDocuments)
    .set({
      status: "issued",
      providerDocumentId: input.providerDocumentId,
      documentNumber: input.documentNumber,
      series: input.series ?? existing.series,
      issuedAt: input.issuedAt ?? new Date(),
      documentReference: input.documentReference ?? existing.documentReference,
      updatedAt: new Date(),
    })
    .where(and(eq(invoiceDocuments.id, documentId), eq(invoiceDocuments.status, "pending")))
    .returning();

  if (!row) {
    throw new ProviderError("OPERATION_NOT_SUPPORTED", {
      provider: existing.provider,
      internalDetail: "document no longer pending",
    });
  }
  return row;
}

export async function markInvoiceDocumentFailed(documentId: number): Promise<InvoiceDocumentRecord> {
  const existing = await requireInvoiceDocument(documentId);
  if (existing.status === "issued") {
    throw new ProviderError("OPERATION_NOT_SUPPORTED", {
      provider: existing.provider,
      internalDetail: "issued fiscal document cannot be marked failed",
    });
  }
  const [row] = await db
    .update(invoiceDocuments)
    .set({ status: "failed", updatedAt: new Date() })
    .where(eq(invoiceDocuments.id, documentId))
    .returning();
  return row;
}

/**
 * Mark a document cancelled. Cancellation is a state change, never a delete:
 * the fiscal reference remains auditable. Issued documents must be corrected
 * with a credit note at the provider, not cancelled locally.
 */
export async function cancelInvoiceDocument(documentId: number): Promise<InvoiceDocumentRecord> {
  const existing = await requireInvoiceDocument(documentId);
  if (existing.status === "issued") {
    throw new ProviderError("OPERATION_NOT_SUPPORTED", {
      provider: existing.provider,
      internalDetail: "issued document requires a credit note, not cancellation",
    });
  }
  const [row] = await db
    .update(invoiceDocuments)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(eq(invoiceDocuments.id, documentId))
    .returning();
  return row;
}

export async function getInvoiceDocument(documentId: number): Promise<InvoiceDocumentRecord | null> {
  const [row] = await db.select().from(invoiceDocuments).where(eq(invoiceDocuments.id, documentId)).limit(1);
  return row ?? null;
}

async function requireInvoiceDocument(documentId: number): Promise<InvoiceDocumentRecord> {
  const row = await getInvoiceDocument(documentId);
  if (!row) throw new ProviderError("INVOICE_NOT_FOUND", { internalDetail: `document ${documentId}` });
  return row;
}

export async function listInvoiceDocumentsForOrder(orderId: number): Promise<InvoiceDocumentRecord[]> {
  return db.select().from(invoiceDocuments).where(eq(invoiceDocuments.orderId, orderId)).orderBy(invoiceDocuments.id);
}

export async function findInvoiceDocumentByProviderId(
  provider: string,
  providerDocumentId: string
): Promise<InvoiceDocumentRecord | null> {
  const descriptor = getInvoiceProvider(provider);
  const [row] = await db
    .select()
    .from(invoiceDocuments)
    .where(
      and(eq(invoiceDocuments.provider, descriptor.id), eq(invoiceDocuments.providerDocumentId, providerDocumentId))
    )
    .limit(1);
  return row ?? null;
}
