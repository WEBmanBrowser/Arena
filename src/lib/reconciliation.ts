/**
 * B.3.5 — Provider-agnostic reconciliation infrastructure.
 *
 * Minimal model: `reconciliation_observations` stores NORMALIZED external
 * observations (integer cents, explicit currency, observation timestamp) —
 * never raw provider payloads, secrets or credentials. At ingest, each
 * observation is compared against the authoritative INTERNAL financial
 * state (payments + refund_attempts) and classified:
 *
 *   - exact match          → no anomaly, observation auto-resolved
 *   - currency mismatch    → CURRENCY_MISMATCH (open anomaly)
 *   - paid amount differs  → PAID_AMOUNT_MISMATCH (open anomaly)
 *   - refund amount differs→ REFUND_AMOUNT_MISMATCH (open anomaly)
 *
 * Anomalies are NEVER auto-fixed: resolution is an explicit, audited
 * administrative action. Duplicate normalized observations (same provider +
 * provider reference) are deduplicated by a unique constraint.
 *
 * No provider polling exists — observations are pushed/recorded, not
 * fetched, because all external provider integrations remain FROZEN.
 */

import { db } from "@/db";
import {
  orders,
  payments,
  reconciliationObservations,
  refundAttempts,
  RECONCILIATION_ANOMALY_CODES,
} from "@/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { createAuditLog } from "@/lib/audit";
import { decimalToCents } from "@/lib/money";
import { PAYMENT_PROVIDERS, SHIPPING_PROVIDERS, INVOICE_PROVIDERS } from "@/lib/providers/registry";

/** Allowlisted observation sources (registry providers + manual). */
export const RECONCILIATION_SOURCES = ["manual", ...PAYMENT_PROVIDERS, ...SHIPPING_PROVIDERS, ...INVOICE_PROVIDERS] as const;

export class ReconciliationError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ReconciliationError";
  }
}

function fail(code: string, message: string): never {
  throw new ReconciliationError(code, message);
}

interface InternalFinancialState {
  paidCents: number;
  refundedCents: number;
  currency: string;
}

async function internalFinancialState(orderId: number): Promise<InternalFinancialState> {
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

  const succeeded = await db
    .select({ amountCents: refundAttempts.amountCents })
    .from(refundAttempts)
    .where(and(eq(refundAttempts.orderId, orderId), eq(refundAttempts.status, "succeeded")));

  return { paidCents, refundedCents: succeeded.reduce((s, r) => s + r.amountCents, 0), currency };
}

// ─── Observation ingest ───────────────────────────────────

export interface IngestObservationInput {
  orderId: number;
  provider: string;
  providerReference?: string | null;
  observedPaidCents: number;
  observedRefundedCents: number;
  currency: string;
  observedAt: Date;
  recordedBy: number;
}

export async function ingestReconciliationObservation(input: IngestObservationInput): Promise<{
  observation: typeof reconciliationObservations.$inferSelect;
  created: boolean;
}> {
  if (!Number.isInteger(input.orderId) || input.orderId < 1) fail("INVALID_ORDER", "Encomenda inválida");
  if (!(RECONCILIATION_SOURCES as readonly string[]).includes(input.provider)) {
    fail("PROVIDER_NOT_ALLOWED", "Fonte de observação não permitida");
  }
  if (!Number.isInteger(input.observedPaidCents) || input.observedPaidCents < 0) fail("INVALID_AMOUNT", "Montante observado inválido");
  if (!Number.isInteger(input.observedRefundedCents) || input.observedRefundedCents < 0) fail("INVALID_AMOUNT", "Montante observado inválido");
  if (!/^[A-Z]{3}$/.test(input.currency)) fail("INVALID_CURRENCY", "Moeda inválida");
  if (!(input.observedAt instanceof Date) || Number.isNaN(input.observedAt.getTime())) fail("INVALID_DATE", "Data de observação inválida");
  if (input.providerReference != null && (typeof input.providerReference !== "string" || input.providerReference.trim().length < 1 || input.providerReference.trim().length > 255)) {
    fail("INVALID_REFERENCE", "Referência externa inválida");
  }

  let result:
    | { kind: "created"; observation: typeof reconciliationObservations.$inferSelect }
    | { kind: "existing"; observation: typeof reconciliationObservations.$inferSelect };

  try {
    result = await db.transaction(async (tx) => {
      const [order] = await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, input.orderId)).limit(1);
      if (!order) fail("ORDER_NOT_FOUND", "Encomenda não encontrada");

      // Duplicate normalized observation — idempotent ingest.
      if (input.providerReference != null) {
        const [existing] = await tx
          .select()
          .from(reconciliationObservations)
          .where(
            and(
              eq(reconciliationObservations.provider, input.provider),
              eq(reconciliationObservations.providerReference, input.providerReference.trim())
            )
          )
          .limit(1)
          .for("update");
        if (existing) return { kind: "existing" as const, observation: existing };
      }

      const internal = await internalFinancialState(input.orderId);

      let anomalyCode: string | null = null;
      if (input.currency !== internal.currency) {
        anomalyCode = "CURRENCY_MISMATCH";
      } else if (input.observedPaidCents !== internal.paidCents) {
        anomalyCode = "PAID_AMOUNT_MISMATCH";
      } else if (input.observedRefundedCents !== internal.refundedCents) {
        anomalyCode = "REFUND_AMOUNT_MISMATCH";
      }

      const [observation] = await tx
        .insert(reconciliationObservations)
        .values({
          orderId: input.orderId,
          provider: input.provider,
          providerReference: input.providerReference?.trim() ?? null,
          observedPaidCents: input.observedPaidCents,
          observedRefundedCents: input.observedRefundedCents,
          currency: input.currency,
          observedAt: input.observedAt,
          expectedPaidCents: internal.paidCents,
          internalRefundedCents: internal.refundedCents,
          anomalyCode,
          status: anomalyCode ? "open" : "resolved",
          recordedBy: input.recordedBy,
        })
        .returning();
      return { kind: "created" as const, observation };
    });
  } catch (e) {
    if (input.providerReference != null) {
      const [existing] = await db
        .select()
        .from(reconciliationObservations)
        .where(
          and(
            eq(reconciliationObservations.provider, input.provider),
            eq(reconciliationObservations.providerReference, input.providerReference.trim())
          )
        )
        .limit(1);
      if (existing) {
        result = { kind: "existing", observation: existing };
      } else {
        throw e;
      }
    } else {
      throw e;
    }
  }

  if (result.kind === "created") {
    await createAuditLog({
      userId: input.recordedBy,
      action: "reconciliation.observation_ingested",
      entity: "reconciliation_observation",
      entityId: result.observation.id,
      details: {
        orderId: input.orderId,
        provider: input.provider,
        anomalyCode: result.observation.anomalyCode,
      },
    });
  }

  return { observation: result.observation, created: result.kind === "created" };
}

// ─── Anomaly reporting / resolution ───────────────────────

export async function listOpenAnomalies(): Promise<Array<typeof reconciliationObservations.$inferSelect>> {
  return db
    .select()
    .from(reconciliationObservations)
    .where(eq(reconciliationObservations.status, "open"))
    .orderBy(desc(reconciliationObservations.createdAt))
    .limit(200);
}

export async function resolveReconciliationAnomaly(
  observationId: number,
  actorId: number,
  note: string
): Promise<typeof reconciliationObservations.$inferSelect> {
  if (typeof note !== "string" || note.trim().length < 3 || note.trim().length > 500) {
    fail("INVALID_NOTE", "Nota de resolução obrigatória (3–500 caracteres)");
  }

  const observation = await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(reconciliationObservations)
      .where(eq(reconciliationObservations.id, observationId))
      .limit(1)
      .for("update");
    if (!current) fail("OBSERVATION_NOT_FOUND", "Observação não encontrada");
    if (current.status !== "open") fail("OBSERVATION_NOT_OPEN", "Observação não está aberta");

    const [updated] = await tx
      .update(reconciliationObservations)
      .set({
        status: "resolved",
        resolvedBy: actorId,
        resolvedAt: new Date(),
        resolutionNote: note.trim(),
      })
      .where(and(eq(reconciliationObservations.id, observationId), eq(reconciliationObservations.status, "open")))
      .returning();
    if (!updated) fail("OBSERVATION_STATE_CONFLICT", "Conflito de estado — tentar novamente");
    return updated;
  });

  await createAuditLog({
    userId: actorId,
    action: "reconciliation.anomaly_resolved",
    entity: "reconciliation_observation",
    entityId: observation.id,
    details: { orderId: observation.orderId, anomalyCode: observation.anomalyCode },
  });
  return observation;
}

export { RECONCILIATION_ANOMALY_CODES };
