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
import { EUPAGO_PROVIDER_ID, type EupagoConfig } from "@/lib/providers/eupago/config";
import { resolveEupagoConfig } from "@/lib/services/eupago-config-service";
import {
  createCardRequest,
  createMbwayRequest,
  createMultibancoReference,
  type EupagoCreateResult,
} from "@/lib/providers/eupago/payments";
import { lookupByIdentifier, type RecoveryLookupResult } from "@/lib/providers/eupago/recovery";
import { assertEupagoLedgerReady, prepareEupagoLedgerContext } from "@/lib/services/eupago-ledger-service";
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
  const amountCents = assertAmount(input.amountCents);

  return db.transaction(async (tx) => {
    const [order] = await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, input.orderId)).limit(1);
    if (!order) {
      throw new ProviderError("PAYMENT_NOT_FOUND", {
        provider: descriptor.id,
        internalDetail: "order not found",
      });
    }

    // Serialize creation for the same logical provider request. Without this,
    // two concurrent checkout submissions for the same order/method/amount can
    // append two local attempts and issue two Eupago creates with two distinct
    // identifiers. The advisory lock is transaction-scoped and PostgreSQL-side,
    // so it protects all workers sharing the database.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${descriptor.id}:${input.orderId}:${input.method}:${amountCents}:${currency}`}, 0))`
    );

    const [existing] = await tx
      .select()
      .from(paymentAttempts)
      .where(
        and(
          eq(paymentAttempts.orderId, input.orderId),
          eq(paymentAttempts.provider, descriptor.id),
          eq(paymentAttempts.method, input.method),
          eq(paymentAttempts.amountCents, amountCents),
          eq(paymentAttempts.currency, currency),
          eq(paymentAttempts.status, "pending"),
          sql`${paymentAttempts.recoveryState} IS NOT NULL`
        )
      )
      .limit(1);
    if (existing) return existing;

    // PAYMENT P0 (items 1/4/17/18) — a NEW Eupago attempt always settles the
    // canonical `payments` row of the same order, and the ledger environment is
    // provisioned/verified before the attempt exists.
    const { payment } = await prepareEupagoLedgerContext(tx, {
      orderId: input.orderId,
      method: input.method,
      amountCents,
      currency,
    });

    const [row] = await tx
      .insert(paymentAttempts)
      .values({
        orderId: input.orderId,
        paymentId: payment.id,
        provider: descriptor.id,
        method: input.method,
        status: "pending",
        amountCents,
        currency,
        providerIdentifier: generateStableIdentifier(input.orderId),
        recoveryState: "armed",
        // Explicit (the column defaults to 0): the fencing baseline for any
        // provider response belonging to this create attempt.
        operationRevision: 0,
      })
      .returning();
    return row;
  });
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
    .set({
      recoveryState: "requested",
      providerRequestedAt: new Date(),
      // The claim itself is a state transition → it advances the fencing
      // revision. Every later writer must present this revision.
      operationRevision: sql`${paymentAttempts.operationRevision} + 1`,
      updatedAt: new Date(),
    })
    .where(and(eq(paymentAttempts.id, attemptId), eq(paymentAttempts.recoveryState, "armed")))
    .returning();
  return row ?? null;
}

/**
 * Ambiguous provider outcome → `reconciliation_required`.
 *
 * PAYMENT P0 (item 13): the commitment is KEPT. Nothing here ever re-arms the
 * attempt, and there is deliberately no code path that turns an UNKNOWN outcome
 * back into `armed`. Two guards apply:
 *   • a SETTLED attempt (`paid`) is never moved back to reconciliation;
 *   • the transition is refused while the attempt is already in
 *     `reconciliation_required` **unless** the caller is recording a new, more
 *     specific cause (which is what the operator log shows).
 */
async function markReconciliationRequired(
  attemptId: number,
  code: string
): Promise<PaymentAttemptRow> {
  const [row] = await db
    .update(paymentAttempts)
    .set({
      recoveryState: "reconciliation_required",
      operatorActionCode: code.slice(0, 60),
      operationRevision: sql`${paymentAttempts.operationRevision} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(paymentAttempts.id, attemptId),
        sql`${paymentAttempts.status} <> 'paid'`
      )
    )
    .returning();
  if (row) return row;
  const [existing] = await db.select().from(paymentAttempts).where(eq(paymentAttempts.id, attemptId)).limit(1);
  return existing;
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
  const config = input.config ?? await resolveEupagoConfig();
  const attempt = await armPaymentAttempt({
    orderId: input.orderId,
    method: input.method,
    amountCents: input.amountCents,
    currency: input.currency,
  });

  const claimed = await claimProviderCall(attempt.id);
  if (!claimed) {
    // Someone else already issued (or is issuing) the single permitted call for
    // this logical provider request. If it has already persisted provider data,
    // return that same pending intent; otherwise require reconciliation/waiting,
    // but never create a second local attempt or provider request.
    if (attempt.providerReference) {
      return { outcome: "created", attempt, redirectUrl: null };
    }
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
  //
  // PAYMENT P0 (item 16) — FENCING. The write-back is conditional on the
  // revision this call observed (`claimed.operationRevision`). If a webhook or
  // a recovery already advanced the attempt, this response is STALE: it may
  // still contribute the additive provider fields it uniquely knows
  // (reference/entity/expiry) but it can never downgrade a settled state.
  const [row] = await db
    .update(paymentAttempts)
    .set({
      providerReference: result.reference,
      providerEntity: result.entity ?? null,
      providerTransactionId: result.transactionId ?? null,
      expiresAt: result.expiresAt ?? null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(paymentAttempts.id, claimed.id),
        eq(paymentAttempts.operationRevision, claimed.operationRevision)
      )
    )
    .returning();

  if (!row) {
    const [current] = await db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.id, claimed.id))
      .limit(1);

    // Additive-only repair: the reference is the correlation anchor the
    // customer-facing reference needs, so it is persisted when still absent,
    // WITHOUT touching status/recovery_state/completed_at.
    if (current && current.providerReference === null) {
      await db
        .update(paymentAttempts)
        .set({ providerReference: result.reference, providerEntity: result.entity ?? null, updatedAt: new Date() })
        .where(and(eq(paymentAttempts.id, claimed.id), sql`${paymentAttempts.providerReference} IS NULL`));
    }

    await createAuditLog({
      userId: input.actorId ?? null,
      action: "payment.provider_response_stale",
      entity: "payment_attempt",
      entityId: claimed.id,
      details: {
        orderId: input.orderId,
        provider: EUPAGO_PROVIDER_ID,
        method: input.method,
        observedRevision: claimed.operationRevision,
        currentRevision: current?.operationRevision ?? null,
        currentStatus: current?.status ?? null,
      },
    });

    return { outcome: "created", attempt: current ?? claimed, redirectUrl: result.redirectUrl ?? null };
  }

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

/**
 * PAYMENT P0 (items 13/14/15) — recovery outcomes.
 *
 *   found          → the provider CONFIRMS the movement exists; its correlation
 *                    data is adopted. No new create is ever issued.
 *   proven_absent  → a POSITIVE absence proof authorized a new create. No
 *                    production code path can produce this: `absenceProof` is an
 *                    explicit, injected proof (tests only), so a real HTTP
 *                    response can never re-arm an attempt.
 *   unknown        → anything else, including a provider that merely REPORTS
 *                    absence. The commitment is KEPT, the attempt stays in
 *                    `reconciliation_required` and is never re-armed.
 */
export type RecoverAttemptResult =
  /**
   * The provider CONFIRMS the movement exists for our identifier. Its
   * correlation data is adopted; nothing is settled (only a verified webhook or
   * reconciliation can do that) and no create is ever re-issued.
   */
  | { readonly outcome: "found"; readonly attempt: PaymentAttemptRow; readonly code?: string }
  /**
   * A POSITIVE absence proof authorized re-arming the attempt for a NEW create.
   *
   * No production code path can produce this: `absenceProof` is an explicitly
   * injected predicate (see below), so a network response can never re-arm a
   * commitment and risk a double charge.
   */
  | { readonly outcome: "proven_absent"; readonly attempt: PaymentAttemptRow; readonly code?: string }
  /** Anything else — keep the commitment, keep reconciliation. */
  | { readonly outcome: "unknown"; readonly attempt: PaymentAttemptRow; readonly code: string };

/**
 * Resolve an attempt stuck in `reconciliation_required` by asking the provider
 * about our stable identifier.
 *
 * UNKNOWN is the default and the safe outcome: a lookup that times out, 5xxs,
 * fails OAuth, returns garbage, or merely reports "nothing found" keeps the
 * attempt in reconciliation and preserves the commitment.
 */
export async function recoverPaymentAttempt(input: {
  readonly attemptId: number;
  readonly config?: EupagoConfig;
  readonly fetchImpl?: typeof fetch;
  /**
   * POSITIVE absence proof (item 15) — an injected predicate, TESTS ONLY.
   *
   * The provider REPORTING that nothing exists for our identifier is an
   * observation, not proof: Eupago may answer from a replica, an index may
   * lag, and a create request may still be in flight. Production therefore never
   * supplies this predicate, which makes `proven_absent` unreachable from a real
   * HTTP response — no automatic re-create can ever be triggered by the network.
   */
  readonly absenceProof?: (lookup: RecoveryLookupResult) => boolean | Promise<boolean>;
}): Promise<RecoverAttemptResult> {
  // L5 — recovery writes the 0017 operation revision (and may adopt provider
  // references): the migration gate is enforced before anything else, with an
  // explicit operational error rather than a raw SQL failure.
  await assertEupagoLedgerReady();
  const config = input.config ?? (await resolveEupagoConfig());
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
    return { outcome: "unknown", attempt: row, code: row.operatorActionCode ?? "LOOKUP_AMBIGUOUS" };
  }

  if (lookup.kind === "not_found") {
    const proved = input.absenceProof ? Boolean(await input.absenceProof(lookup)) : false;
    if (!proved) {
      // FAIL CLOSED. The commitment is KEPT, the attempt stays in
      // reconciliation and is NEVER re-armed automatically.
      const row = await markReconciliationRequired(attempt.id, "ABSENCE_NOT_ACCEPTED");
      return { outcome: "unknown", attempt: row, code: row.operatorActionCode ?? "ABSENCE_NOT_ACCEPTED" };
    }

    // Positive proof: re-arm for a NEW create. Bumps the revision so any stale
    // in-flight response from the previous operation is fenced out.
    const [rearmed] = await db
      .update(paymentAttempts)
      .set({
        recoveryState: "armed",
        operatorActionCode: null,
        operationRevision: sql`${paymentAttempts.operationRevision} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(paymentAttempts.id, attempt.id), sql`${paymentAttempts.status} NOT IN ('paid','succeeded')`))
      .returning();

    await createAuditLog({
      userId: null,
      action: "payment.provider_absence_proven",
      entity: "payment_attempt",
      entityId: attempt.id,
      details: { orderId: attempt.orderId, provider: EUPAGO_PROVIDER_ID, source: "injected_proof" },
    });

    return { outcome: "proven_absent", attempt: rearmed ?? attempt };
  }

  // FOUND — adopt the provider's correlation data. A settled attempt is NEVER
  // rewritten (the additive fields are still recorded so the reference stays
  // operationally visible).
  const [live] = await db
    .update(paymentAttempts)
    .set({
      providerReference: lookup.reference ?? attempt.providerReference,
      providerTransactionId: lookup.transactionId ?? attempt.providerTransactionId,
      recoveryState: attempt.status === "paid" ? attempt.recoveryState : "requested",
      operatorActionCode: attempt.status === "paid" ? attempt.operatorActionCode : null,
      operationRevision: sql`${paymentAttempts.operationRevision} + 1`,
      updatedAt: new Date(),
    })
    .where(and(eq(paymentAttempts.id, attempt.id), sql`${paymentAttempts.status} NOT IN ('paid','succeeded')`))
    .returning();

  if (live) return { outcome: "found", attempt: live };

  const [settledRow] = await db
    .update(paymentAttempts)
    .set({
      providerReference: lookup.reference ?? attempt.providerReference,
      providerTransactionId: lookup.transactionId ?? attempt.providerTransactionId,
      updatedAt: new Date(),
    })
    .where(eq(paymentAttempts.id, attempt.id))
    .returning();
  return { outcome: "found", attempt: settledRow ?? attempt };
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
