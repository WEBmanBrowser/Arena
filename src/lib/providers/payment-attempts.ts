/**
 * B.3.1 — Payment provider contract + multi-attempt persistence.
 *
 * NO live provider calls, NO endpoints, NO signatures, NO SDK.
 *
 * KEY INVARIANTS
 *  • One order can have MANY payment attempts. Attempts are append-only:
 *    creating a new attempt NEVER overwrites or deletes previous attempts.
 *  • Payment status is NOT order status. This module never touches
 *    orders.status — the Phase A centralized lifecycle
 *    (transitionOrderStatus / confirmOrderPayment) stays authoritative.
 *  • Amounts cross the provider boundary as INTEGER CENTS in EUR.
 *  • The internal `bank_transfer` method is NOT a provider attempt: it keeps
 *    using the existing `payments` table and manual confirmation flow.
 */

import { db } from "@/db";
import {
  paymentAttempts,
  PAYMENT_ATTEMPT_STATUSES,
  PAYMENT_ATTEMPT_METHODS,
  type PaymentAttemptStatus,
  type PaymentAttemptMethod,
} from "@/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { ProviderError, sanitizeErrorMessage } from "./errors";
import { getPaymentProvider, type PaymentProviderId } from "./registry";
import { MAX_PROVIDER_AMOUNT_CENTS, PROVIDER_CURRENCY, assertSupportedCurrency } from "./money-boundary";

export type PaymentAttemptRecord = typeof paymentAttempts.$inferSelect;

/** Terminal states — a completed attempt is never reopened. */
const TERMINAL_STATUSES: ReadonlySet<PaymentAttemptStatus> = new Set<PaymentAttemptStatus>([
  "paid", "failed", "expired", "cancelled", "refunded",
]);

export function isPaymentAttemptStatus(value: string): value is PaymentAttemptStatus {
  return (PAYMENT_ATTEMPT_STATUSES as readonly string[]).includes(value);
}

export function isPaymentAttemptMethod(value: string): value is PaymentAttemptMethod {
  return (PAYMENT_ATTEMPT_METHODS as readonly string[]).includes(value);
}

// ─── Provider contract (foundation) ───────────────────────

export interface PaymentIntentRequest {
  orderId: number;
  method: PaymentAttemptMethod;
  amountCents: number;
  currency: typeof PROVIDER_CURRENCY;
  /** Opaque, non-sensitive customer reference (e.g. order number). */
  reference?: string;
}

export interface PaymentIntentResult {
  providerReference: string;
  status: PaymentAttemptStatus;
  /** Provider-side expiry (e.g. MB WAY request timeout). */
  expiresAt?: Date | null;
}

/**
 * Contract every future payment adapter (Eupago, …) implements.
 * B.3.1 ships no implementation: nothing here performs I/O.
 */
export interface PaymentProviderAdapter {
  readonly provider: PaymentProviderId;
  createPayment(request: PaymentIntentRequest): Promise<PaymentIntentResult>;
  getPayment(providerReference: string): Promise<PaymentIntentResult>;
  cancelPayment?(providerReference: string): Promise<PaymentIntentResult>;
  refundPayment?(providerReference: string, amountCents: number): Promise<PaymentIntentResult>;
}

const ADAPTERS = new Map<PaymentProviderId, PaymentProviderAdapter>();

/** Registration hook for a future phase (B.3.2+). */
export function registerPaymentAdapter(adapter: PaymentProviderAdapter): void {
  getPaymentProvider(adapter.provider); // allowlist check
  ADAPTERS.set(adapter.provider, adapter);
}

/**
 * Resolve an adapter. In B.3.1 no adapter is registered, so this reports the
 * normalized PROVIDER_UNAVAILABLE instead of attempting any network call.
 */
export function getPaymentAdapter(providerId: string): PaymentProviderAdapter {
  const descriptor = getPaymentProvider(providerId); // throws UNSUPPORTED_PROVIDER
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

export interface CreatePaymentAttemptInput {
  orderId: number;
  provider: string;
  method: string;
  amountCents: number;
  currency?: string;
  providerReference?: string | null;
  status?: PaymentAttemptStatus;
  expiresAt?: Date | null;
}

function validateAmount(amountCents: number, provider: string): number {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents > MAX_PROVIDER_AMOUNT_CENTS) {
    throw new ProviderError("INVALID_PROVIDER_RESPONSE", {
      provider,
      internalDetail: "amountCents out of range",
    });
  }
  return amountCents;
}

/**
 * Append a new payment attempt. Existing attempts for the same order are
 * left untouched — the full history is preserved.
 */
export async function createPaymentAttempt(input: CreatePaymentAttemptInput): Promise<PaymentAttemptRecord> {
  const descriptor = getPaymentProvider(input.provider); // UNSUPPORTED_PROVIDER
  if (!isPaymentAttemptMethod(input.method)) {
    throw new ProviderError("OPERATION_NOT_SUPPORTED", {
      provider: descriptor.id,
      internalDetail: `unknown payment method: ${String(input.method).slice(0, 32)}`,
    });
  }
  const status = input.status ?? "pending";
  if (!isPaymentAttemptStatus(status)) {
    throw new ProviderError("INVALID_PROVIDER_RESPONSE", {
      provider: descriptor.id,
      internalDetail: "unknown payment status",
    });
  }

  const [row] = await db
    .insert(paymentAttempts)
    .values({
      orderId: input.orderId,
      provider: descriptor.id,
      method: input.method,
      status,
      providerReference: input.providerReference ?? null,
      amountCents: validateAmount(input.amountCents, descriptor.id),
      currency: assertSupportedCurrency(input.currency ?? PROVIDER_CURRENCY),
      expiresAt: input.expiresAt ?? null,
    })
    .returning();
  return row;
}

export interface UpdatePaymentAttemptStatusInput {
  status: PaymentAttemptStatus;
  providerReference?: string | null;
  failureReason?: unknown;
}

/**
 * Update the status of ONE attempt (never of the order).
 * Terminal attempts are immutable, so a late duplicate provider callback
 * cannot resurrect or rewrite settled history.
 */
export async function updatePaymentAttemptStatus(
  attemptId: number,
  input: UpdatePaymentAttemptStatusInput
): Promise<PaymentAttemptRecord> {
  if (!isPaymentAttemptStatus(input.status)) {
    throw new ProviderError("INVALID_PROVIDER_RESPONSE", { internalDetail: "unknown payment status" });
  }

  const existing = await getPaymentAttempt(attemptId);
  if (!existing) throw new ProviderError("PAYMENT_NOT_FOUND", { internalDetail: `attempt ${attemptId}` });
  if (TERMINAL_STATUSES.has(existing.status as PaymentAttemptStatus) && existing.status !== input.status) {
    throw new ProviderError("OPERATION_NOT_SUPPORTED", {
      provider: existing.provider,
      internalDetail: `attempt already terminal: ${existing.status}`,
    });
  }

  const now = new Date();
  const [row] = await db
    .update(paymentAttempts)
    .set({
      status: input.status,
      providerReference: input.providerReference ?? existing.providerReference,
      failureReason: input.failureReason !== undefined ? sanitizeErrorMessage(input.failureReason, 255) : existing.failureReason,
      completedAt: TERMINAL_STATUSES.has(input.status) ? (existing.completedAt ?? now) : existing.completedAt,
      updatedAt: now,
    })
    .where(eq(paymentAttempts.id, attemptId))
    .returning();
  return row;
}

export async function getPaymentAttempt(attemptId: number): Promise<PaymentAttemptRecord | null> {
  const [row] = await db.select().from(paymentAttempts).where(eq(paymentAttempts.id, attemptId)).limit(1);
  return row ?? null;
}

/** Full attempt history for an order, oldest first. */
export async function listPaymentAttempts(orderId: number): Promise<PaymentAttemptRecord[]> {
  return db.select().from(paymentAttempts).where(eq(paymentAttempts.orderId, orderId)).orderBy(paymentAttempts.id);
}

export async function getLatestPaymentAttempt(orderId: number): Promise<PaymentAttemptRecord | null> {
  const [row] = await db
    .select()
    .from(paymentAttempts)
    .where(eq(paymentAttempts.orderId, orderId))
    .orderBy(desc(paymentAttempts.id))
    .limit(1);
  return row ?? null;
}

export async function findPaymentAttemptByReference(
  provider: string,
  providerReference: string
): Promise<PaymentAttemptRecord | null> {
  const descriptor = getPaymentProvider(provider);
  const [row] = await db
    .select()
    .from(paymentAttempts)
    .where(and(eq(paymentAttempts.provider, descriptor.id), eq(paymentAttempts.providerReference, providerReference)))
    .limit(1);
  return row ?? null;
}

/** True when the order has a settled (paid) external attempt. */
export async function hasSuccessfulPaymentAttempt(orderId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: paymentAttempts.id })
    .from(paymentAttempts)
    .where(and(eq(paymentAttempts.orderId, orderId), eq(paymentAttempts.status, "paid")))
    .limit(1);
  return Boolean(row);
}
