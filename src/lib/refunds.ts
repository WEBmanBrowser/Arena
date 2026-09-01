/**
 * B.3.5 — Refund domain service (provider-agnostic).
 *
 * DESIGN DECISIONS:
 *
 * 1. APPEND-ONLY FINANCIAL TRUTH — refund history lives in `refund_attempts`.
 *    Successful `payments` rows are never rewritten (no "refunded" status
 *    mutation): historical payment confirmation stays auditable and derived
 *    refund totals always come from the refund ledger.
 *
 * 2. ORDER LIFECYCLE — refunds deliberately do NOT mutate orders.status.
 *    The central Phase A state machine (ORDER_TRANSITIONS +
 *    transitionOrderStatus) stays the ONLY way to reach `refunded`, and it
 *    already allows paid→refunded / returned→refunded as EXPLICIT
 *    operational transitions. Financial refund state and order lifecycle
 *    state are related but not identical (a fully refunded "shipped" order,
 *    for example, has no direct transition to refunded), so B.3.5 exposes
 *    the financial state independently (getOrderRefundState) and requires
 *    an explicit admin order transition through the existing service.
 *
 * 3. OVER-REFUND PROTECTION — enforced twice:
 *      a) application level: the payment row is locked with SELECT … FOR
 *         UPDATE inside the creation transaction BEFORE committed refund
 *         totals are computed;
 *      b) database level: the `refund_attempts_balance_guard` trigger
 *         (drizzle/0007) re-locks the payment and re-verifies the invariant
 *         for every INSERT/UPDATE, making over-refund impossible even for
 *         transactions that bypass this service.
 *    Committed balance = pending + processing + succeeded refund attempts.
 *
 * 4. MONEY — integer cents only. The single decimal→cents conversion
 *    (payments.amount) uses the deterministic string parser decimalToCents
 *    (no binary floating-point). Currency must explicitly match the
 *    payment currency (also enforced by the DB trigger).
 *
 * 5. INVENTORY — refunds never restock and never touch reservations.
 *    Physical returns/restock flow exclusively through the existing
 *    inventory/RMA workflows. B.3.5 introduces no second stock mechanism.
 *
 * 6. PROVIDER EXECUTION — only `manual` refunds can complete (external
 *    evidence recorded by an authorized admin). Registry payment providers
 *    are recorded as pending intent and stay fail-closed
 *    (OPERATION_NOT_SUPPORTED) until a live adapter exists.
 */

import { db } from "@/db";
import {
  invoiceDocuments,
  orders,
  payments,
  refundAttempts,
  REFUND_COMMITTED_STATUSES,
  REFUND_STATUSES,
} from "@/db/schema";
import { and, desc, eq, inArray, lte } from "drizzle-orm";
import { createAuditLog } from "@/lib/audit";
import { decimalToCents } from "@/lib/money";
import { PAYMENT_PROVIDERS } from "@/lib/providers/registry";

// ─── Vocabulary ───────────────────────────────────────────

/** Providers that may own a refund attempt. */
export const REFUND_ATTEMPT_PROVIDERS = ["manual", ...PAYMENT_PROVIDERS] as const;
export type RefundAttemptProvider = (typeof REFUND_ATTEMPT_PROVIDERS)[number];

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export class RefundError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "RefundError";
  }
}

function fail(code: string, message: string): never {
  throw new RefundError(code, message);
}

// ─── Shared internal helpers ──────────────────────────────

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

interface PaymentSnapshot {
  id: number;
  orderId: number;
  provider: string;
  currency: string;
  paidCents: number;
}

async function loadPaidPayment(
  tx: Tx,
  orderId: number,
  paymentId?: number,
  lock = false
): Promise<PaymentSnapshot> {
  const conditions = [eq(payments.orderId, orderId), eq(payments.status, "paid")];
  if (paymentId != null) conditions.push(eq(payments.id, paymentId));

  const rows = lock
    ? await tx.select().from(payments).where(and(...conditions)).orderBy(payments.id).limit(1).for("update")
    : await tx.select().from(payments).where(and(...conditions)).orderBy(payments.id).limit(1);
  const payment = rows[0];

  if (!payment) {
    fail("PAYMENT_NOT_FOUND", "Pagamento confirmado não encontrado para esta encomenda");
  }
  const paidCents = decimalToCents(payment.amount);
  if (paidCents == null) {
    fail("PAYMENT_AMOUNT_INVALID", "Montante de pagamento inválido");
  }
  return {
    id: payment.id,
    orderId: payment.orderId,
    provider: payment.provider,
    currency: payment.currency,
    paidCents,
  };
}

async function committedRefundCents(tx: Tx, paymentId: number): Promise<number> {
  const rows = await tx
    .select({ amountCents: refundAttempts.amountCents })
    .from(refundAttempts)
    .where(
      and(eq(refundAttempts.paymentId, paymentId), inArray(refundAttempts.status, [...REFUND_COMMITTED_STATUSES]))
    );
  return rows.reduce((sum, r) => sum + r.amountCents, 0);
}

async function loadRefundForUpdate(tx: Tx, refundId: number) {
  const [refund] = await tx
    .select()
    .from(refundAttempts)
    .where(eq(refundAttempts.id, refundId))
    .limit(1)
    .for("update");
  if (!refund) fail("REFUND_NOT_FOUND", "Reembolso não encontrado");
  return refund;
}

// ─── Idempotent refund request / manual record ────────────

export interface RequestRefundInput {
  orderId: number;
  amountCents: number;
  /** Server-validated stable operation identity (required). */
  idempotencyKey: string;
  requestedBy: number;
  provider?: string;
  currency?: string;
  reason?: string | null;
  /**
   * External completion evidence: records that the money has ALREADY been
   * returned outside the platform (bank transfer etc.). Creates the refund
   * directly in `succeeded` state. Only valid for provider "manual".
   */
  manualCompletion?: { externalReference: string; completedAt: Date } | null;
}

export async function requestRefund(input: RequestRefundInput): Promise<{
  refund: typeof refundAttempts.$inferSelect;
  created: boolean;
  /** False when provider execution is unavailable (fail-closed registry providers). */
  executionSupported: boolean;
}> {
  if (!Number.isInteger(input.orderId) || input.orderId < 1) fail("INVALID_ORDER", "Encomenda inválida");
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    fail("INVALID_AMOUNT", "Montante de reembolso inválido");
  }
  if (typeof input.idempotencyKey !== "string" || !IDEMPOTENCY_KEY_RE.test(input.idempotencyKey)) {
    fail("INVALID_IDEMPOTENCY_KEY", "Chave de idempotência inválida");
  }
  if (input.reason != null && (typeof input.reason !== "string" || input.reason.length > 500)) {
    fail("INVALID_REASON", "Motivo inválido");
  }

  const provider = input.provider ?? "manual";
  if (!(REFUND_ATTEMPT_PROVIDERS as readonly string[]).includes(provider)) {
    fail("PROVIDER_NOT_ALLOWED", "Fornecedor de reembolso não permitido");
  }

  const wantsManualCompletion = input.manualCompletion != null;
  if (wantsManualCompletion && provider !== "manual") {
    fail("MANUAL_COMPLETION_REQUIRES_MANUAL_PROVIDER", "Registo manual apenas para reembolsos manuais");
  }
  if (wantsManualCompletion) {
    const ref = input.manualCompletion!.externalReference;
    if (typeof ref !== "string" || ref.trim().length < 1 || ref.trim().length > 255) {
      fail("INVALID_REFERENCE", "Referência externa inválida");
    }
    const at = input.manualCompletion!.completedAt;
    if (!(at instanceof Date) || Number.isNaN(at.getTime())) fail("INVALID_DATE", "Data de conclusão inválida");
    if (at.getTime() > Date.now() + 60_000) fail("INVALID_DATE", "Data de conclusão não pode ser futura");
  }

  let result:
    | { kind: "created"; refund: typeof refundAttempts.$inferSelect }
    | { kind: "existing"; refund: typeof refundAttempts.$inferSelect };

  try {
    result = await db.transaction(async (tx) => {
      const [order] = await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, input.orderId)).limit(1);
      if (!order) fail("ORDER_NOT_FOUND", "Encomenda não encontrada");

      // Idempotent replay — resolve before touching balance.
      const [existing] = await tx
        .select()
        .from(refundAttempts)
        .where(eq(refundAttempts.idempotencyKey, input.idempotencyKey))
        .limit(1)
        .for("update");
      if (existing) {
        assertSameOperation(existing, input);
        return { kind: "existing" as const, refund: existing };
      }

      // Lock the payment row FIRST, then compute committed balance.
      const payment = await loadPaidPayment(tx, input.orderId, undefined, true);
      if (input.currency != null && input.currency !== payment.currency) {
        fail("CURRENCY_MISMATCH", `Moeda de reembolso difere do pagamento (${payment.currency})`);
      }

      const committed = await committedRefundCents(tx, payment.id);
      if (committed + input.amountCents > payment.paidCents) {
        fail("REFUND_EXCEEDS_REFUNDABLE", "Reembolso excede o montante reembolsável disponível");
      }

      const [refund] = await tx
        .insert(refundAttempts)
        .values({
          orderId: input.orderId,
          paymentId: payment.id,
          provider,
          idempotencyKey: input.idempotencyKey,
          providerRefundId: wantsManualCompletion ? input.manualCompletion!.externalReference.trim() : null,
          amountCents: input.amountCents,
          currency: payment.currency,
          status: wantsManualCompletion ? "succeeded" : "pending",
          reason: input.reason?.trim() || null,
          requestedBy: input.requestedBy,
          completedAt: wantsManualCompletion ? input.manualCompletion!.completedAt : null,
        })
        .returning();
      return { kind: "created" as const, refund };
    });
  } catch (e) {
    // Concurrent duplicate idempotency key — resolve deterministically.
    const duplicate = await findExistingByIdempotencyKey(input.idempotencyKey);
    if (duplicate) {
      assertSameOperation(duplicate, input);
      result = { kind: "existing", refund: duplicate };
    } else {
      throw mapDatabaseGuardError(e);
    }
  }

  if (result.kind === "created") {
    await createAuditLog({
      userId: input.requestedBy,
      action: wantsManualCompletion ? "refund.manual_recorded" : "refund.requested",
      entity: "refund",
      entityId: result.refund.id,
      details: {
        orderId: input.orderId,
        paymentId: result.refund.paymentId,
        amountCents: result.refund.amountCents,
        currency: result.refund.currency,
        provider: result.refund.provider,
        status: result.refund.status,
      },
    });
  }

  return {
    refund: result.refund,
    created: result.kind === "created",
    executionSupported: provider === "manual",
  };
}

function assertSameOperation(
  existing: typeof refundAttempts.$inferSelect,
  input: RequestRefundInput
): void {
  if (
    existing.orderId !== input.orderId ||
    existing.amountCents !== input.amountCents ||
    existing.provider !== (input.provider ?? "manual") ||
    (input.currency != null && existing.currency !== input.currency)
  ) {
    fail("IDEMPOTENCY_KEY_CONFLICT", "Chave de idempotência já usada para operação diferente");
  }
}

/**
 * Map database-level guard exceptions (balance trigger) to normalized
 * RefundErrors so HTTP layers return correct status codes instead of 500s.
 */
function mapDatabaseGuardError(e: unknown): unknown {
  const message = e instanceof Error ? `${e.message} ${String((e as { cause?: { message?: string } }).cause?.message ?? "")}` : String(e);
  if (message.includes("REFUND_EXCEEDS_REFUNDABLE_AMOUNT")) {
    return new RefundError("REFUND_EXCEEDS_REFUNDABLE", "Reembolso excede o montante reembolsável disponível");
  }
  if (message.includes("REFUND_CURRENCY_MISMATCH")) {
    return new RefundError("CURRENCY_MISMATCH", "Moeda de reembolso difere do pagamento");
  }
  return e;
}

async function findExistingByIdempotencyKey(key: string) {
  const [existing] = await db
    .select()
    .from(refundAttempts)
    .where(eq(refundAttempts.idempotencyKey, key))
    .limit(1);
  return existing ?? null;
}

// ─── Refund lifecycle transitions ─────────────────────────

export interface ManualCompletionInput {
  refundId: number;
  externalReference: string;
  completedAt: Date;
  actorId: number;
}

/** Record that an externally-executed manual refund has actually occurred. */
export async function completeManualRefund(input: ManualCompletionInput) {
  if (typeof input.externalReference !== "string" || input.externalReference.trim().length < 1 || input.externalReference.trim().length > 255) {
    fail("INVALID_REFERENCE", "Referência externa inválida");
  }
  if (!(input.completedAt instanceof Date) || Number.isNaN(input.completedAt.getTime())) {
    fail("INVALID_DATE", "Data de conclusão inválida");
  }
  if (input.completedAt.getTime() > Date.now() + 60_000) fail("INVALID_DATE", "Data de conclusão não pode ser futura");

  const refund = await db.transaction(async (tx) => {
    const current = await loadRefundForUpdate(tx, input.refundId);
    if (current.provider !== "manual") fail("NOT_A_MANUAL_REFUND", "Reembolso não é manual");
    if (current.status === "succeeded") fail("REFUND_IMMUTABLE", "Reembolso já concluído — não pode ser executado novamente");
    if (current.status !== "pending" && current.status !== "processing") {
      fail("INVALID_REFUND_STATE", `Estado de reembolso inválido: ${current.status}`);
    }
    const [updated] = await tx
      .update(refundAttempts)
      .set({
        status: "succeeded",
        providerRefundId: input.externalReference.trim(),
        completedAt: input.completedAt,
        errorCode: null,
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(and(eq(refundAttempts.id, input.refundId), eq(refundAttempts.status, current.status)))
      .returning();
    if (!updated) fail("REFUND_STATE_CONFLICT", "Conflito de estado — tentar novamente");
    return updated;
  });

  await createAuditLog({
    userId: input.actorId,
    action: "refund.manual_completed",
    entity: "refund",
    entityId: refund.id,
    details: { orderId: refund.orderId, amountCents: refund.amountCents, currency: refund.currency },
  });
  return refund;
}

export async function cancelRefund(refundId: number, actorId: number, reason?: string | null) {
  const refund = await db.transaction(async (tx) => {
    const current = await loadRefundForUpdate(tx, refundId);
    if (current.status === "succeeded") fail("REFUND_IMMUTABLE", "Reembolso concluído é imutável");
    if (current.status !== "pending" && current.status !== "processing") {
      fail("INVALID_REFUND_STATE", `Estado de reembolso inválido: ${current.status}`);
    }
    const [updated] = await tx
      .update(refundAttempts)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(and(eq(refundAttempts.id, refundId), eq(refundAttempts.status, current.status)))
      .returning();
    if (!updated) fail("REFUND_STATE_CONFLICT", "Conflito de estado — tentar novamente");
    return updated;
  });

  await createAuditLog({
    userId: actorId,
    action: "refund.cancelled",
    entity: "refund",
    entityId: refund.id,
    details: { orderId: refund.orderId, amountCents: refund.amountCents, reason: reason ?? null },
  });
  return refund;
}

export async function markRefundFailed(
  refundId: number,
  actorId: number,
  failure?: { code?: string; message?: string }
) {
  const errorCode =
    failure?.code != null && /^[A-Z0-9_]{1,60}$/.test(failure.code) ? failure.code : "REFUND_FAILED";
  const rawMessage = failure?.message ?? "Falha na operação de reembolso";
  const errorMessage = rawMessage.slice(0, 500);

  const refund = await db.transaction(async (tx) => {
    const current = await loadRefundForUpdate(tx, refundId);
    if (current.status === "succeeded") fail("REFUND_IMMUTABLE", "Reembolso concluído é imutável");
    if (current.status !== "pending" && current.status !== "processing") {
      fail("INVALID_REFUND_STATE", `Estado de reembolso inválido: ${current.status}`);
    }
    const [updated] = await tx
      .update(refundAttempts)
      .set({ status: "failed", errorCode, errorMessage, updatedAt: new Date() })
      .where(and(eq(refundAttempts.id, refundId), eq(refundAttempts.status, current.status)))
      .returning();
    if (!updated) fail("REFUND_STATE_CONFLICT", "Conflito de estado — tentar novamente");
    return updated;
  });

  await createAuditLog({
    userId: actorId,
    action: "refund.failed",
    entity: "refund",
    entityId: refund.id,
    details: { orderId: refund.orderId, amountCents: refund.amountCents, errorCode },
  });
  return refund;
}

/**
 * Explicit, bounded retry of a FAILED attempt. Reuses the SAME row and
 * idempotency key (operation identity preserved); the database balance
 * guard re-verifies the over-refund invariant before the commitment is
 * re-armed. No automatic retry loop exists — retry is always an explicit
 * administrative action.
 */
export async function retryRefund(refundId: number, actorId: number) {
  let refund: typeof refundAttempts.$inferSelect;
  try {
    refund = await db.transaction(async (tx) => {
      const current = await loadRefundForUpdate(tx, refundId);
      if (current.status === "succeeded") fail("REFUND_IMMUTABLE", "Reembolso concluído não pode ser re-executado");
      if (current.status !== "failed") fail("INVALID_REFUND_STATE", "Apenas reembolsos falhados podem ser reintentados");
      const [updated] = await tx
        .update(refundAttempts)
        .set({ status: "pending", errorCode: null, errorMessage: null, updatedAt: new Date() })
        .where(and(eq(refundAttempts.id, refundId), eq(refundAttempts.status, "failed")))
        .returning();
      if (!updated) fail("REFUND_STATE_CONFLICT", "Conflito de estado — tentar novamente");
      return updated;
    });
  } catch (e) {
    // The DB balance guard re-verifies the invariant when the commitment is
    // re-armed — map it to a normalized error (e.g. balance consumed since).
    throw mapDatabaseGuardError(e);
  }

  await createAuditLog({
    userId: actorId,
    action: "refund.retry_requested",
    entity: "refund",
    entityId: refund.id,
    details: { orderId: refund.orderId, amountCents: refund.amountCents },
  });
  return refund;
}

// ─── Derived financial state ──────────────────────────────

export interface OrderRefundState {
  orderId: number;
  currency: string;
  paidCents: number;
  refundedCents: number;
  committedCents: number;
  remainingRefundableCents: number;
  fullyRefunded: boolean;
  /** Refunded > 0 and no manual credit note recorded yet for the order. */
  fiscalCreditNotePending: boolean;
  refunds: Array<typeof refundAttempts.$inferSelect>;
}

/**
 * Financial refund state for an order — derived exclusively from the
 * authoritative payments/refund ledger. Never mutates order state.
 */
export async function getOrderRefundState(orderId: number): Promise<OrderRefundState> {
  const [order] = await db.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) fail("ORDER_NOT_FOUND", "Encomenda não encontrada");

  const paidPayments = await db
    .select()
    .from(payments)
    .where(and(eq(payments.orderId, orderId), eq(payments.status, "paid")))
    .orderBy(payments.id);

  let paidCents = 0;
  let currency = "EUR";
  for (const p of paidPayments) {
    const cents = decimalToCents(p.amount);
    if (cents == null) fail("PAYMENT_AMOUNT_INVALID", "Montante de pagamento inválido");
    paidCents += cents;
    currency = p.currency;
  }

  const refunds = await db
    .select()
    .from(refundAttempts)
    .where(eq(refundAttempts.orderId, orderId))
    .orderBy(desc(refundAttempts.createdAt), desc(refundAttempts.id));

  const refundedCents = refunds
    .filter((r) => r.status === "succeeded")
    .reduce((s, r) => s + r.amountCents, 0);
  const committedCents = refunds
    .filter((r) => (REFUND_COMMITTED_STATUSES as readonly string[]).includes(r.status))
    .reduce((s, r) => s + r.amountCents, 0);

  const creditNotes = refundedCents > 0
    ? await db
        .select({ id: invoiceDocuments.id })
        .from(invoiceDocuments)
        .where(
          and(
            eq(invoiceDocuments.orderId, orderId),
            eq(invoiceDocuments.documentType, "credit_note"),
            eq(invoiceDocuments.status, "issued")
          )
        )
        .limit(1)
    : [];

  return {
    orderId,
    currency,
    paidCents,
    refundedCents,
    committedCents,
    remainingRefundableCents: Math.max(0, paidCents - committedCents),
    fullyRefunded: paidCents > 0 && refundedCents === paidCents,
    fiscalCreditNotePending: refundedCents > 0 && creditNotes.length === 0,
    refunds,
  };
}

// ─── Manual credit note recording (fiscal reference only) ──

export interface ManualCreditNoteInput {
  orderId: number;
  originalDocumentId: number;
  officialReference: string;
  issuedAt: Date;
  amountCents: number;
  actorId: number;
  currency?: string;
}

/**
 * Record a credit note that was issued EXTERNALLY (by the accountant/XD
 * outside the platform). This stores only the official document reference —
 * the platform never claims to have issued a fiscal document itself.
 * Issued documents are immutable (never updated/deleted by this service).
 */
export async function recordManualCreditNote(input: ManualCreditNoteInput) {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    fail("INVALID_AMOUNT", "Montante de nota de crédito inválido");
  }
  if (typeof input.officialReference !== "string" || input.officialReference.trim().length < 1 || input.officialReference.trim().length > 255) {
    fail("INVALID_REFERENCE", "Referência oficial inválida");
  }
  if (!(input.issuedAt instanceof Date) || Number.isNaN(input.issuedAt.getTime())) {
    fail("INVALID_DATE", "Data de emissão inválida");
  }

  const document = await db.transaction(async (tx) => {
    const [order] = await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, input.orderId)).limit(1);
    if (!order) fail("ORDER_NOT_FOUND", "Encomenda não encontrada");

    const [original] = await tx
      .select()
      .from(invoiceDocuments)
      .where(eq(invoiceDocuments.id, input.originalDocumentId))
      .limit(1)
      .for("update");
    if (!original || original.orderId !== input.orderId) {
      fail("ORIGINAL_DOCUMENT_INVALID", "Fatura original inválida para esta encomenda");
    }
    if (original.documentType !== "invoice" || original.source !== "manual" || original.status !== "issued") {
      fail("ORIGINAL_DOCUMENT_INVALID", "Documento original não é uma fatura manual emitida");
    }
    if (original.amountCents == null) fail("ORIGINAL_DOCUMENT_INVALID", "Fatura original sem montante");

    if (input.currency != null && input.currency !== original.currency) {
      fail("CURRENCY_MISMATCH", `Moeda difere da fatura original (${original.currency})`);
    }

    // Operational accounting guard: cumulative manual credit notes may not
    // exceed the original invoice amount.
    const existingCredits = await tx
      .select({ amountCents: invoiceDocuments.amountCents })
      .from(invoiceDocuments)
      .where(
        and(
          eq(invoiceDocuments.originalDocumentId, original.id),
          eq(invoiceDocuments.documentType, "credit_note"),
          eq(invoiceDocuments.status, "issued")
        )
      );
    const credited = existingCredits.reduce((s, c) => s + (c.amountCents ?? 0), 0);
    if (credited + input.amountCents > original.amountCents) {
      fail("CREDIT_NOTE_EXCEEDS_INVOICE", "Notas de crédito excedem o montante da fatura original");
    }

    try {
      const [doc] = await tx
        .insert(invoiceDocuments)
        .values({
          orderId: input.orderId,
          provider: "manual",
          documentType: "credit_note",
          providerDocumentId: input.officialReference.trim(),
          status: "issued",
          issuedAt: input.issuedAt,
          amountCents: input.amountCents,
          currency: original.currency,
          source: "manual",
          originalDocumentId: original.id,
        })
        .returning();
      return doc;
    } catch (e) {
      const message = e instanceof Error ? `${e.message} ${String((e as { cause?: { message?: string } }).cause?.message ?? "")}` : String(e);
      if (message.includes("invoice_documents_provider_document_unique")) {
        fail("DUPLICATE_DOCUMENT", "Nota de crédito com esta referência já existe");
      }
      throw e;
    }
  });

  await createAuditLog({
    userId: input.actorId,
    action: "credit_note.recorded",
    entity: "invoice_document",
    entityId: document.id,
    details: {
      orderId: input.orderId,
      originalDocumentId: input.originalDocumentId,
      amountCents: input.amountCents,
      currency: document.currency,
    },
  });
  return document;
}

// ─── Operational maintenance ──────────────────────────────

/** Pending/processing refund attempts older than the threshold (report only). */
export async function findStaleRefundAttempts(olderThanMinutes = 60): Promise<
  Array<typeof refundAttempts.$inferSelect>
> {
  const threshold = new Date(Date.now() - olderThanMinutes * 60_000);
  return db
    .select()
    .from(refundAttempts)
    .where(and(inArray(refundAttempts.status, ["pending", "processing"]), lte(refundAttempts.createdAt, threshold)))
    .orderBy(desc(refundAttempts.createdAt))
    .limit(200);
}

export { REFUND_STATUSES };
