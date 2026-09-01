/**
 * B.3.2 — Eupago payment orchestration (server-side domain service).
 *
 * EXACTLY-ONCE-ATTEMPT SEMANTICS
 *  Eupago's creation endpoints expose no Idempotency-Key contract, so the
 *  guarantee is built locally:
 *
 *   1. a payment_attempt row + stable identifier are COMMITTED first
 *      (recovery_state = 'armed');
 *   2. the row is atomically moved 'armed' → 'requested' — the winner of that
 *      compare-and-swap is the ONLY caller allowed to issue the network call;
 *   3. exactly one create request is performed;
 *   4. an ambiguous outcome (timeout / 5xx / malformed / OAuth failure) sets
 *      recovery_state = 'reconciliation_required'. It is NEVER retried
 *      automatically;
 *   5. recovery asks the provider about the stable identifier. Another create
 *      is authorized ONLY when the provider positively proves absence.
 *
 * ORDER LIFECYCLE
 *  This service never writes orders.status and never touches stock. Creation
 *  is not settlement: only ./eupago-settlement-service.ts may confirm, and it
 *  does so exclusively through the existing centralized confirmOrderPayment().
 */

import { db } from "@/db";
import { orders, paymentAttempts, type PaymentAttemptMethod } from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { ProviderError } from "@/lib/providers/errors";
import { getPaymentProvider } from "@/lib/providers/registry";
import { MAX_PROVIDER_AMOUNT_CENTS, PROVIDER_CURRENCY } from "@/lib/providers/money-boundary";
import { EUPAGO_PROVIDER_ID, getEupagoConfig, type EupagoConfig } from "@/lib/providers/eupago/config";
import {
  createCardRequest,
  createMbwayRequest,
  createMultibancoReference,
  type EupagoCreateResult,
} from "@/lib/providers/eupago/payments";
import { lookupByIdentifier } from "@/lib/providers/eupago/recovery";
import { createAuditLog } from "@/lib/audit";

export type PaymentAttemptRow = typeof paymentAttempts.$inferSelect;

export interface CreateEupagoPaymentInput {
  readonly orderId: number;
  readonly method: PaymentAttemptMethod;
  readonly amountCents: number;
  readonly currency?: string;
  readonly actorId?: number | null;
  /** MB WAY only. */
  readonly customerPhone?: string;
  readonly countryCode?: string;
  readonly customerName?: string | null;
  /** Card requires an email; MB WAY may include one. */
  readonly customerEmail?: string | null;
  /** Card only — browser return targets (UX ONLY, they never confirm). */
  readonly successUrl?: string;
  readonly failUrl?: string;
  readonly backUrl?: string;
  readonly config?: EupagoConfig;
  readonly fetchImpl?: typeof fetch;
}

export type CreateEupagoPaymentResult =
  | {
      readonly outcome: "created";
      readonly attempt: PaymentAttemptRow;
      /** Eupago-hosted page (card only). Never a MDTech-collected card form. */
      readonly redirectUrl?: string | null;
    }
  | { readonly outcome: "rejected"; readonly attempt: PaymentAttemptRow; readonly code: string }
  | {
      readonly outcome: "reconciliation_required";
      readonly attempt: PaymentAttemptRow;
      readonly code: string;
    };

const IDENTIFIER_PREFIX = "MDT";

/**
 * Stable, collision-resistant, non-guessable identifier. Generated ONCE per
 * attempt and persisted before any network call; never regenerated.
 */
export function generateStableIdentifier(orderId: number): string {
  const random = crypto.getRandomValues(new Uint8Array(9));
  const suffix = Array.from(random)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${IDENTIFIER_PREFIX}-${orderId}-${suffix}`;
}

function assertAmount(amountCents: number): number {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents > MAX_PROVIDER_AMOUNT_CENTS) {
    throw new ProviderError("INVALID_PROVIDER_RESPONSE", {
      provider: EUPAGO_PROVIDER_ID,
      internalDetail: "amountCents out of range",
    });
  }
  return amountCents;
}

/**
 * STEP 1 — arm the attempt.
 *
 * Persists the attempt and its stable identifier in a committed transaction
 * BEFORE any provider communication, so a crash mid-flight always leaves a
 * durable record that recovery can key on.
 */
export async function armPaymentAttempt(input: {
  orderId: number;
  method: PaymentAttemptMethod;
  amountCents: number;
  currency?: string;
}): Promise<PaymentAttemptRow> {
  const descriptor = getPaymentProvider(EUPAGO_PROVIDER_ID);
  const currency = input.currency ?? PROVIDER_CURRENCY;
  if (currency !== PROVIDER_CURRENCY) {
    throw new ProviderError("INVALID_PROVIDER_RESPONSE", {
      provider: descriptor.id,
      internalDetail: "unsupported currency",
    });
  }

  const [order] = await db.select({ id: orders.id }).from(orders).where(eq(orders.id, input.orderId)).limit(1);
  if (!order) {
    throw new ProviderError("PAYMENT_NOT_FOUND", {
      provider: descriptor.id,
      internalDetail: "order not found",
    });
  }

  const [row] = await db
    .insert(paymentAttempts)
    .values({
      orderId: input.orderId,
      provider: descriptor.id,
      method: input.method,
      status: "pending",
      amountCents: assertAmount(input.amountCents),
      currency,
      providerIdentifier: generateStableIdentifier(input.orderId),
      recoveryState: "armed",
    })
    .returning();
  return row;
}

/**
 * STEP 2 — claim the single permitted provider call.
 *
 * Atomic compare-and-swap: only a row still in 'armed' can move to
 * 'requested'. Concurrent callers therefore cannot both reach the network.
 */
async function claimProviderCall(attemptId: number): Promise<PaymentAttemptRow | null> {
  const [row] = await db
    .update(paymentAttempts)
    .set({ recoveryState: "requested", providerRequestedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(paymentAttempts.id, attemptId), eq(paymentAttempts.recoveryState, "armed")))
    .returning();
  return row ?? null;
}

async function markReconciliationRequired(
  attemptId: number,
  code: string
): Promise<PaymentAttemptRow> {
  const [row] = await db
    .update(paymentAttempts)
    .set({
      recoveryState: "reconciliation_required",
      operatorActionCode: code.slice(0, 60),
      updatedAt: new Date(),
    })
    .where(eq(paymentAttempts.id, attemptId))
    .returning();
  return row;
}

/**
 * Create a Eupago payment for an order.
 *
 * NOTE: a successful return NEVER means the order is paid. Multibanco returns
 * a reference to be paid later; MB WAY returns a request awaiting customer
 * approval; card returns a hosted redirect. Settlement arrives separately.
 */
export async function createEupagoPayment(
  input: CreateEupagoPaymentInput
): Promise<CreateEupagoPaymentResult> {
  const config = input.config ?? getEupagoConfig();
  const attempt = await armPaymentAttempt({
    orderId: input.orderId,
    method: input.method,
    amountCents: input.amountCents,
    currency: input.currency,
  });

  const claimed = await claimProviderCall(attempt.id);
  if (!claimed) {
    // Someone else already issued (or is issuing) the single permitted call.
    return {
      outcome: "reconciliation_required",
      attempt,
      code: "CREATE_ALREADY_ISSUED",
    };
  }

  const identifier = claimed.providerIdentifier!;
  let result: EupagoCreateResult;

  if (input.method === "multibanco") {
    result = await createMultibancoReference({
      config,
      identifier,
      amountCents: claimed.amountCents,
      currency: claimed.currency,
      fetchImpl: input.fetchImpl,
    });
  } else if (input.method === "mbway") {
    result = await createMbwayRequest({
      config,
      identifier,
      amountCents: claimed.amountCents,
      currency: claimed.currency,
      customerPhone: input.customerPhone ?? "",
      countryCode: input.countryCode ?? "351",
      customerName: input.customerName ?? null,
      customerEmail: input.customerEmail ?? null,
      fetchImpl: input.fetchImpl,
    });
  } else {
    if (!input.successUrl || !input.failUrl || !input.backUrl || !input.customerEmail) {
      await markReconciliationRequired(claimed.id, "CARD_URLS_MISSING");
      throw new ProviderError("OPERATION_NOT_SUPPORTED", {
        provider: EUPAGO_PROVIDER_ID,
        internalDetail: "card creation requires return URLs and customer email",
      });
    }
    result = await createCardRequest({
      config,
      identifier,
      amountCents: claimed.amountCents,
      currency: claimed.currency,
      successUrl: input.successUrl,
      failUrl: input.failUrl,
      backUrl: input.backUrl,
      customerEmail: input.customerEmail,
      fetchImpl: input.fetchImpl,
    });
  }

  if (result.kind === "ambiguous") {
    // FAIL CLOSED — no automatic recreate. Recovery must resolve this.
    const row = await markReconciliationRequired(claimed.id, `AMBIGUOUS_${result.reason.toUpperCase()}`);
    await createAuditLog({
      userId: input.actorId ?? null,
      action: "payment.provider_create_ambiguous",
      entity: "payment_attempt",
      entityId: claimed.id,
      details: { orderId: input.orderId, provider: EUPAGO_PROVIDER_ID, reason: result.reason },
    });
    return { outcome: "reconciliation_required", attempt: row, code: row.operatorActionCode! };
  }

  if (result.kind === "rejected") {
    const [row] = await db
      .update(paymentAttempts)
      .set({
        status: "failed",
        failureReason: result.code.slice(0, 255),
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(paymentAttempts.id, claimed.id))
      .returning();
    return { outcome: "rejected", attempt: row, code: result.code };
  }

  // Created. Status stays `pending`: creation is not settlement.
  const [row] = await db
    .update(paymentAttempts)
    .set({
      providerReference: result.reference,
      providerEntity: result.entity ?? null,
      providerTransactionId: result.transactionId ?? null,
      expiresAt: result.expiresAt ?? null,
      updatedAt: new Date(),
    })
    .where(eq(paymentAttempts.id, claimed.id))
    .returning();

  await createAuditLog({
    userId: input.actorId ?? null,
    action: "payment.provider_created",
    entity: "payment_attempt",
    entityId: row.id,
    details: { orderId: input.orderId, provider: EUPAGO_PROVIDER_ID, method: input.method },
  });

  return { outcome: "created", attempt: row, redirectUrl: result.redirectUrl ?? null };
}

// ─── Recovery ─────────────────────────────────────────────

export type RecoverAttemptResult =
  | { readonly outcome: "recovered"; readonly attempt: PaymentAttemptRow }
  /** Provider proved nothing exists — a new create may now be authorized. */
  | { readonly outcome: "safe_to_recreate"; readonly attempt: PaymentAttemptRow }
  | { readonly outcome: "still_ambiguous"; readonly attempt: PaymentAttemptRow; readonly code: string };

/**
 * Resolve an attempt stuck in `reconciliation_required` by asking the provider
 * about our stable identifier.
 *
 * A lookup that times out, 5xxs, fails OAuth or returns garbage keeps the
 * attempt in reconciliation — it is NEVER interpreted as absence.
 */
export async function recoverPaymentAttempt(input: {
  attemptId: number;
  config?: EupagoConfig;
  fetchImpl?: typeof fetch;
}): Promise<RecoverAttemptResult> {
  const config = input.config ?? getEupagoConfig();
  const [attempt] = await db
    .select()
    .from(paymentAttempts)
    .where(eq(paymentAttempts.id, input.attemptId))
    .limit(1);
  if (!attempt || attempt.provider !== EUPAGO_PROVIDER_ID || !attempt.providerIdentifier) {
    throw new ProviderError("PAYMENT_NOT_FOUND", {
      provider: EUPAGO_PROVIDER_ID,
      internalDetail: "attempt not recoverable",
    });
  }

  const lookup = await lookupByIdentifier({
    config,
    identifier: attempt.providerIdentifier,
    fetchImpl: input.fetchImpl,
  });

  if (lookup.kind === "ambiguous") {
    const row = await markReconciliationRequired(attempt.id, `LOOKUP_${lookup.reason.toUpperCase()}`);
    return { outcome: "still_ambiguous", attempt: row, code: row.operatorActionCode! };
  }

  if (lookup.kind === "absent") {
    // Positive proof of absence: the attempt may be re-armed for ONE new call.
    const [row] = await db
      .update(paymentAttempts)
      .set({ recoveryState: "armed", operatorActionCode: null, updatedAt: new Date() })
      .where(eq(paymentAttempts.id, attempt.id))
      .returning();
    return { outcome: "safe_to_recreate", attempt: row };
  }

  const [row] = await db
    .update(paymentAttempts)
    .set({
      providerReference: lookup.reference ?? attempt.providerReference,
      providerTransactionId: lookup.transactionId ?? attempt.providerTransactionId,
      recoveryState: "requested",
      operatorActionCode: null,
      updatedAt: new Date(),
    })
    .where(eq(paymentAttempts.id, attempt.id))
    .returning();
  return { outcome: "recovered", attempt: row };
}

/** Attempts awaiting operator/reconciliation attention (report only). */
export async function listAttemptsRequiringReconciliation(limit = 100): Promise<PaymentAttemptRow[]> {
  return db
    .select()
    .from(paymentAttempts)
    .where(
      and(
        eq(paymentAttempts.provider, EUPAGO_PROVIDER_ID),
        eq(paymentAttempts.recoveryState, "reconciliation_required")
      )
    )
    .orderBy(sql`${paymentAttempts.updatedAt} desc`)
    .limit(limit);
}

/** Locate an attempt by the stable identifier we generated. */
export async function findAttemptByIdentifier(identifier: string): Promise<PaymentAttemptRow | null> {
  const [row] = await db
    .select()
    .from(paymentAttempts)
    .where(
      and(
        eq(paymentAttempts.provider, EUPAGO_PROVIDER_ID),
        eq(paymentAttempts.providerIdentifier, identifier)
      )
    )
    .limit(1);
  return row ?? null;
}

/** Locate an attempt by provider reference (Multibanco reference etc.). */
export async function findAttemptByReference(reference: string): Promise<PaymentAttemptRow | null> {
  const [row] = await db
    .select()
    .from(paymentAttempts)
    .where(
      and(
        eq(paymentAttempts.provider, EUPAGO_PROVIDER_ID),
        eq(paymentAttempts.providerReference, reference)
      )
    )
    .limit(1);
  return row ?? null;
}
