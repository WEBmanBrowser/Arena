/**
 * B.3.1 — Provider webhook event foundation.
 *
 * Generic, provider-agnostic idempotency + processing ledger for inbound
 * provider notifications. It contains NO provider endpoints and NO provider
 * signature algorithms: real verification (e.g. Eupago) is added by the
 * provider adapter in a later phase through `WebhookVerifier`.
 *
 * SECURITY / PRIVACY
 *  • The raw webhook body is NEVER persisted — only its sha256 hash.
 *  • Headers (Authorization, API keys), credentials, secrets and card data are
 *    never accepted into `metadata`; metadata is sanitized and size-limited.
 *
 * CONCURRENCY / IDEMPOTENCY
 *  • Deduplication is enforced by DATABASE unique indexes, not by
 *    SELECT-before-INSERT:
 *      - (provider, provider_event_id) WHERE provider_event_id IS NOT NULL
 *      - (provider, payload_hash)      WHERE provider_event_id IS NULL
 *    Two providers may legitimately use the same event id — the provider
 *    column is part of both indexes, so they never collide.
 *  • Processing is claimed with a single conditional UPDATE, so a processed
 *    event can never be executed twice, even under concurrent delivery.
 *
 * ORDER LIFECYCLE
 *  • This module NEVER mutates orders.status. Provider state is not order
 *    state; the Phase A centralized lifecycle stays authoritative.
 *
 * RUNTIME
 *  • Uses Web Crypto (crypto.subtle) — Cloudflare Workers / OpenNext safe.
 */

import { db } from "@/db";
import { providerWebhookEvents, type WebhookEventStatus } from "@/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DbOrTx } from "@/lib/stock-locks";
import { ProviderError, sanitizeErrorMessage } from "./errors";

export type WebhookEventRecord = typeof providerWebhookEvents.$inferSelect;

/** Default cap for controlled retries — no uncontrolled retry loops. */
export const DEFAULT_MAX_WEBHOOK_ATTEMPTS = 5;

/** Keys never accepted into persisted metadata. */
const FORBIDDEN_METADATA_KEYS = [
  "authorization", "auth", "apikey", "api_key", "token", "secret", "password",
  "signature", "cookie", "card", "pan", "cvv", "iban", "payload", "body", "raw",
];

const MAX_METADATA_KEYS = 10;
const MAX_METADATA_VALUE_LENGTH = 200;

/**
 * Reduce caller-supplied metadata to a minimal, secret-free, size-limited map.
 * Anything that looks credential-bearing is dropped (not redacted) so it can
 * never reach the database.
 */
export function sanitizeWebhookMetadata(
  metadata: Record<string, unknown> | undefined
): Record<string, string | number | boolean> | null {
  if (!metadata) return null;
  const clean: Record<string, string | number | boolean> = {};
  let count = 0;
  for (const [key, value] of Object.entries(metadata)) {
    if (count >= MAX_METADATA_KEYS) break;
    const lower = key.toLowerCase();
    if (FORBIDDEN_METADATA_KEYS.some((k) => lower.includes(k))) continue;
    if (typeof value === "string") {
      clean[key] = value.slice(0, MAX_METADATA_VALUE_LENGTH);
    } else if (typeof value === "number" || typeof value === "boolean") {
      clean[key] = value;
    } else {
      continue; // objects/arrays could smuggle payloads — dropped
    }
    count++;
  }
  return Object.keys(clean).length > 0 ? clean : null;
}

/** sha256 hex of the raw body, via Web Crypto (Workers-compatible). */
export async function computePayloadHash(rawBody: string): Promise<string> {
  const data = new TextEncoder().encode(rawBody);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─── Verification contract (foundation only) ──────────────

export interface WebhookVerificationInput {
  provider: string;
  rawBody: string;
  /** Lower-cased header map. Secrets are used in-memory only, never stored. */
  headers: Record<string, string>;
}

export interface WebhookVerificationResult {
  valid: boolean;
  /** Stable provider event id, when the provider supplies one. */
  providerEventId?: string | null;
  eventType?: string | null;
}

/**
 * Contract for future provider-specific verification.
 *
 * Provider webhook routes are machine-to-machine: they are authenticated by
 * PROVIDER VERIFICATION (implementations of this interface), not by browser
 * CSRF tokens. No real algorithm is implemented in B.3.1.
 */
export interface WebhookVerifier {
  readonly provider: string;
  verify(input: WebhookVerificationInput): Promise<WebhookVerificationResult>;
}

/**
 * Default verifier used until a real provider adapter exists.
 * It never accepts a webhook, so no unverified provider traffic can be
 * processed by accident.
 */
export const rejectUnverifiedWebhook: WebhookVerifier = {
  provider: "unconfigured",
  async verify(): Promise<WebhookVerificationResult> {
    return { valid: false };
  },
};

export function assertWebhookVerified(result: WebhookVerificationResult, provider: string): void {
  if (!result.valid) {
    throw new ProviderError("WEBHOOK_INVALID", { provider, internalDetail: "verification failed" });
  }
}

// ─── Registration (idempotent) ────────────────────────────

export interface RegisterWebhookEventInput {
  provider: string;
  /** Omit/null when the provider has no stable event id → hash fallback. */
  providerEventId?: string | null;
  /** Raw body: hashed, never stored. */
  rawBody: string;
  eventType?: string | null;
  metadata?: Record<string, unknown>;
}

export interface RegisterWebhookEventResult {
  event: WebhookEventRecord;
  /** True when this delivery was already known (dedup hit). */
  duplicate: boolean;
}

/**
 * Register an inbound webhook delivery.
 *
 * Uses INSERT ... ON CONFLICT DO NOTHING against the DB unique indexes, so
 * concurrent duplicate deliveries can never both create a row.
 *
 * IDENTITY MODEL — deliberately two-tier, and per provider:
 *
 *   1. When the provider supplies a stable `providerEventId`, THAT is the
 *      authoritative identity: `(provider, provider_event_id)`. Two deliveries
 *      with the same id collapse even if their bodies differ (retry with an
 *      updated payload), and two deliveries with different ids stay distinct
 *      even if their bodies are byte-identical (two genuine events).
 *
 *   2. `payloadHash` is a FALLBACK identity used ONLY when no stable event id
 *      is supplied: `(provider, payload_hash) WHERE provider_event_id IS NULL`.
 *
 * ASSUMPTION: a given provider is consistent — it either always supplies a
 * stable event id or never does. Under mixed usage the same logical event
 * delivered once WITH an id and once WITHOUT one produces two rows, because
 * the two indexes cover disjoint sets of rows. This is intentional: a global
 * unique index on `(provider, payload_hash)` would be dangerous, as it would
 * permanently reject legitimate distinct events that happen to carry identical
 * bodies (e.g. two identical "pending" pings, or repeated fixed-format
 * notifications). See webhook-events.test.ts, "identity model" tests.
 */
export async function registerWebhookEvent(
  input: RegisterWebhookEventInput,
  /** PAYMENT P0 (item 10): the whole settlement pipeline runs on ONE tx. */
  executor: DbOrTx = db
): Promise<RegisterWebhookEventResult> {
  const provider = input.provider?.trim();
  if (!provider) {
    throw new ProviderError("WEBHOOK_INVALID", { internalDetail: "missing provider" });
  }
  if (typeof input.rawBody !== "string" || input.rawBody.length === 0) {
    throw new ProviderError("WEBHOOK_INVALID", { provider, internalDetail: "empty body" });
  }

  const payloadHash = await computePayloadHash(input.rawBody);
  const providerEventId = input.providerEventId?.trim() || null;

  const inserted = await executor
    .insert(providerWebhookEvents)
    .values({
      provider,
      providerEventId,
      payloadHash,
      eventType: input.eventType?.slice(0, 100) ?? null,
      status: "pending",
      metadata: sanitizeWebhookMetadata(input.metadata),
    })
    .onConflictDoNothing()
    .returning();

  if (inserted.length > 0) {
    return { event: inserted[0], duplicate: false };
  }

  const existing = await findWebhookEvent(provider, providerEventId, payloadHash, executor);
  if (!existing) {
    // Conflict without a visible row would mean a corrupted invariant.
    throw new ProviderError("WEBHOOK_INVALID", {
      provider,
      internalDetail: "conflict without existing row",
    });
  }
  return { event: existing, duplicate: true };
}

export async function findWebhookEvent(
  provider: string,
  providerEventId: string | null,
  payloadHash: string,
  executor: DbOrTx = db
): Promise<WebhookEventRecord | null> {
  const where = providerEventId
    ? and(eq(providerWebhookEvents.provider, provider), eq(providerWebhookEvents.providerEventId, providerEventId))
    : and(
        eq(providerWebhookEvents.provider, provider),
        eq(providerWebhookEvents.payloadHash, payloadHash),
        sql`${providerWebhookEvents.providerEventId} IS NULL`
      );
  const [row] = await executor.select().from(providerWebhookEvents).where(where).limit(1);
  return row ?? null;
}

export async function getWebhookEvent(id: number, executor: DbOrTx = db): Promise<WebhookEventRecord | null> {
  const [row] = await executor.select().from(providerWebhookEvents).where(eq(providerWebhookEvents.id, id)).limit(1);
  return row ?? null;
}

// ─── Processing state machine (provider-scoped) ───────────
// pending ──claim──► processing ──► processed | failed | ignored
// failed  ──claim──► processing   (controlled retry, capped by attempts)

/**
 * Atomically claim an event for processing.
 *
 * Returns null when the event is not claimable (already processing/processed/
 * ignored, or the retry budget is exhausted). A processed event can therefore
 * never be replayed.
 */
export async function claimWebhookEvent(
  id: number,
  options: { maxAttempts?: number; extraGrantedAttempts?: number; executor?: DbOrTx } = {}
): Promise<WebhookEventRecord | null> {
  const maxAttempts = effectiveMaxAttempts({
    maxAttempts: options.maxAttempts,
    extraGrantedAttempts: options.extraGrantedAttempts,
  });
  const [claimed] = await (options.executor ?? db)
    .update(providerWebhookEvents)
    .set({
      status: "processing",
      attempts: sql`${providerWebhookEvents.attempts} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(providerWebhookEvents.id, id),
        inArray(providerWebhookEvents.status, ["pending", "failed"]),
        sql`${providerWebhookEvents.attempts} < ${maxAttempts}`
      )
    )
    .returning();
  return claimed ?? null;
}

export async function markWebhookEventProcessed(id: number, executor: DbOrTx = db): Promise<WebhookEventRecord | null> {
  const now = new Date();
  const [row] = await executor
    .update(providerWebhookEvents)
    .set({ status: "processed", processedAt: now, lastError: null, updatedAt: now })
    .where(and(eq(providerWebhookEvents.id, id), eq(providerWebhookEvents.status, "processing")))
    .returning();
  return row ?? null;
}

export async function markWebhookEventFailed(id: number, error: unknown, executor: DbOrTx = db): Promise<WebhookEventRecord | null> {
  const now = new Date();
  const [row] = await executor
    .update(providerWebhookEvents)
    .set({ status: "failed", failedAt: now, lastError: sanitizeErrorMessage(error), updatedAt: now })
    .where(and(eq(providerWebhookEvents.id, id), eq(providerWebhookEvents.status, "processing")))
    .returning();
  return row ?? null;
}

/**
 * PAYMENT P0 (HIGH-1/HIGH-2) — the delivery was understood, its money movement
 * was recorded durably, and it now REQUIRES an operator: a financial anomaly
 * (double charge, late payment, incoherent canonical payment) has been opened.
 *
 * `anomaly` is deliberately NOT `processed`: the event is not a settled success,
 * and it is not silently acknowledged. It is terminal for the retry machinery
 * (a redelivery of the same trid stays idempotent) and explicit for operators.
 */
export async function markWebhookEventAnomaly(
  id: number,
  code: string,
  executor: DbOrTx = db
): Promise<WebhookEventRecord | null> {
  const now = new Date();
  const safeCode = sanitizeErrorMessage(code, 80);
  const [row] = await executor
    .update(providerWebhookEvents)
    .set({
      status: "anomaly",
      processedAt: now,
      failedAt: null,
      lastError: safeCode,
      updatedAt: now,
      metadata: sql`coalesce(${providerWebhookEvents.metadata}, '{}'::jsonb) || ${JSON.stringify({ anomalyCode: safeCode })}::jsonb`,
    })
    .where(and(eq(providerWebhookEvents.id, id), eq(providerWebhookEvents.status, "processing")))
    .returning();
  return row ?? null;
}

/** True when an event carries a recorded financial anomaly requiring an operator. */
export function isAnomalyWebhookEvent(
  event: Pick<WebhookEventRecord, "status" | "metadata" | "lastError">
): boolean {
  return (
    event.status === "anomaly" ||
    (typeof event.metadata?.anomalyCode === "string" && event.metadata.anomalyCode.length > 0)
  );
}

/** Event understood but intentionally not acted upon (e.g. unknown type). */
export async function markWebhookEventIgnored(id: number, reason?: string, executor: DbOrTx = db): Promise<WebhookEventRecord | null> {
  const now = new Date();
  const [row] = await executor
    .update(providerWebhookEvents)
    .set({
      status: "ignored",
      processedAt: now,
      lastError: reason ? sanitizeErrorMessage(reason) : null,
      updatedAt: now,
    })
    .where(
      and(
        eq(providerWebhookEvents.id, id),
        inArray(providerWebhookEvents.status, ["pending", "processing"])
      )
    )
    .returning();
  return row ?? null;
}

/**
 * PAYMENT P0 (H3) — account for a delivery that FAILED OUTSIDE the settlement
 * transaction.
 *
 * The settlement pipeline is one transaction, so a failure rolls its own claim
 * (and the `attempts` increment that came with it) back. This marker is executed
 * on the OUTER connection instead, so the capped budget reflects reality: each
 * failed delivery consumes exactly one attempt, and an event that runs out of
 * budget stays visible as `failed` (or deferred `pending`) until an
 * administrator explicitly grants more (see `grantWebhookRecoveryBudget`) or the
 * provider delivers a payload that can be correlated.
 */
export async function recordWebhookDeliveryFailure(
  id: number,
  error: unknown,
  executor: DbOrTx = db
): Promise<WebhookEventRecord | null> {
  const now = new Date();
  const [row] = await executor
    .update(providerWebhookEvents)
    .set({
      status: "failed",
      attempts: sql`${providerWebhookEvents.attempts} + 1`,
      failedAt: now,
      lastError: sanitizeErrorMessage(error),
      updatedAt: now,
    })
    .where(
      and(
        eq(providerWebhookEvents.id, id),
        inArray(providerWebhookEvents.status, ["pending", "failed", "processing"])
      )
    )
    .returning();
  return row ?? null;
}

/** A failed event is retryable while its capped attempt budget remains. */
/**
 * L6 — SEMANTICS: exactly one class of delivery is "retryable": a TECHNICAL
 * failure that still has retry budget. Everything else is final for this helper:
 *   • `processed`  → already settled;
 *   • `ignored`    → reasoned about and dismissed;
 *   • `anomaly`    → FAILED FINANCIALLY: the money movement is recorded and only
 *                    an operator can resolve it. Replaying it would not settle
 *                    anything and must never look like a retry candidate;
 *   • `pending`    → deferred/correlated-later; re-driven by the provider's
 *                    redelivery of the same trid (H2/HIGH-3), not by this list.
 */
export function isRetryable(event: WebhookEventRecord, maxAttempts = DEFAULT_MAX_WEBHOOK_ATTEMPTS): boolean {
  if (isAnomalyWebhookEvent(event)) return false;
  return event.status === "failed" && event.attempts < maxAttempts;
}

/**
 * Failed events still eligible for a controlled (externally scheduled) retry.
 *
 * The predicate mirrors `isRetryable()` exactly — including the exclusion of
 * financially anomalous events (which are never `failed`, but a future writer
 * could otherwise make them look retryable through metadata).
 */
export async function listRetryableWebhookEvents(
  provider?: string,
  options: { maxAttempts?: number; limit?: number } = {}
): Promise<WebhookEventRecord[]> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_WEBHOOK_ATTEMPTS;
  const base = and(
    eq(providerWebhookEvents.status, "failed" satisfies WebhookEventStatus),
    sql`${providerWebhookEvents.attempts} < ${maxAttempts}`,
    sql`coalesce(${providerWebhookEvents.metadata} ->> 'anomalyCode', '') = ''`
  );
  return db
    .select()
    .from(providerWebhookEvents)
    .where(provider ? and(base, eq(providerWebhookEvents.provider, provider)) : base)
    .limit(options.limit ?? 50);
}

// ─── PAYMENT P0 (H2/H3): deferral, budget grants, claim math ──────────────

/**
 * Administrative recovery grants are CAPPED. Each grant buys one further
 * `DEFAULT_MAX_WEBHOOK_ATTEMPTS` window; two grants is the operational ceiling,
 * after which the provider must deliver again (or a human must investigate with
 * a real settlement, not a replay).
 */
export const MAX_RECOVERY_GRANTS = 2;

/** Effective claim budget = base budget × (1 + administrative grants). */
export function effectiveMaxAttempts(input: { maxAttempts?: number; extraGrantedAttempts?: number } = {}): number {
  const base = input.maxAttempts ?? DEFAULT_MAX_WEBHOOK_ATTEMPTS;
  const grants = Math.max(0, Math.min(input.extraGrantedAttempts ?? 0, MAX_RECOVERY_GRANTS));
  return base * (1 + grants);
}

/** Number of administrative grants already recorded on this event. */
export function recoveryGrants(event: Pick<WebhookEventRecord, "metadata">): number {
  const raw = event.metadata?.recoveryGrants;
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, MAX_RECOVERY_GRANTS) : 0;
}

/**
 * H2 — a delivery whose correlation cannot be established YET.
 *
 * The event is returned to `pending` (never to the terminal `ignored` state) so
 * that the provider's redelivery of the SAME `trid` re-evaluates it against the
 * local state as it exists THEN. The claim counter is deliberately NOT reset:
 * deferrals consume the same bounded budget as any other attempt, so a delivery
 * that never becomes correlatable still ends up needing operator attention
 * instead of looping forever.
 *
 * This function performs NO financial effect and NEVER creates a payment or an
 * attempt, and it never triggers a provider call.
 */
export async function deferWebhookEvent(
  id: number,
  code: string,
  executor: DbOrTx = db
): Promise<WebhookEventRecord | null> {
  const safeCode = sanitizeErrorMessage(code, 60);
  const [row] = await executor
    .update(providerWebhookEvents)
    .set({
      status: "pending",
      updatedAt: new Date(),
      lastError: safeCode,
      metadata: sql`coalesce(${providerWebhookEvents.metadata}, '{}'::jsonb) || ${JSON.stringify({ deferred: safeCode })}::jsonb`,
    })
    .where(and(eq(providerWebhookEvents.id, id), eq(providerWebhookEvents.status, "processing")))
    .returning();
  return row ?? null;
}

/** True when an event is parked in the deferred (re-evaluable) state. */
export function isDeferredWebhookEvent(
  event: Pick<WebhookEventRecord, "status" | "lastError" | "metadata" | "attempts">,
  maxAttempts = DEFAULT_MAX_WEBHOOK_ATTEMPTS
): boolean {
  const deferred = typeof event.metadata?.deferred === "string" && event.metadata.deferred.startsWith("DEFERRED_");
  return deferred && event.status === "pending" && event.attempts >= maxAttempts;
}

export type GrantRecoveryOutcome =
  | { readonly outcome: "granted"; readonly event: WebhookEventRecord; readonly grants: number }
  | { readonly outcome: "rejected"; readonly code: string };

/**
 * H3 — restricted, audited restoration of a claim budget that ran out.
 *
 * Guarantees:
 *   • `processed` events are NEVER touched (the first predicate rejects them);
 *   • no financial value is supplied by the caller — the grant only raises the
 *     retry budget of an event whose payload was already signature-verified;
 *   • no payment/attempt is created, nothing is re-sent to the provider, and no
 *     payload is fabricated: the next provider delivery is still the only thing
 *     that can settle anything;
 *   • the update is a single atomic statement, so two concurrent grants cannot
 *     both win;
 *   • when the persisted trusted metadata is insufficient for an automatic
 *     resolution, the caller must require a NEW authenticated delivery (this
 *     function never invents missing values).
 */
export async function grantWebhookRecoveryBudget(input: {
  eventId: number;
  maxAttempts?: number;
  executor?: DbOrTx;
}): Promise<GrantRecoveryOutcome> {
  const executor = input.executor ?? db;
  const base = input.maxAttempts ?? DEFAULT_MAX_WEBHOOK_ATTEMPTS;

  // L1 — ONE atomic conditional statement. The previous read-then-write pair let
  // two concurrent grants observe the same `recoveryGrants` value and both write
  // `grants + 1`, silently exceeding the ceiling. Every rule (status, exhausted
  // budget, grant ceiling) now lives in the UPDATE predicate and the increment is
  // computed server-side, so the ceiling holds without any locking protocol.
  const granted = await executor
    .update(providerWebhookEvents)
    .set({
      updatedAt: new Date(),
      metadata: sql`coalesce(${providerWebhookEvents.metadata}, '{}'::jsonb)
        || jsonb_build_object('recoveryGrants', coalesce(${providerWebhookEvents.metadata} ->> 'recoveryGrants', '0')::int + 1)`,
    })
    .where(
      and(
        eq(providerWebhookEvents.id, input.eventId),
        inArray(providerWebhookEvents.status, ["pending", "failed"]),
        sql`${providerWebhookEvents.attempts} >= ${base}`,
        // Fail-closed on malformed metadata: a non-numeric counter makes the
        // predicate false (grant refused) instead of raising a cast error.
        sql`coalesce(${providerWebhookEvents.metadata} ->> 'recoveryGrants', '0') ~ '^[0-9]{1,3}$'
            AND coalesce(${providerWebhookEvents.metadata} ->> 'recoveryGrants', '0')::int < ${MAX_RECOVERY_GRANTS}`
      )
    )
    .returning();

  if (granted.length > 0) {
    return { outcome: "granted", event: granted[0], grants: recoveryGrants(granted[0]) };
  }

  // No row was granted: re-read ONLY to report the precise reason. This read is
  // not part of the decision — the decision was the conditional UPDATE above.
  const current = await getWebhookEvent(input.eventId, executor);
  if (!current) return { outcome: "rejected", code: "EVENT_NOT_FOUND" };
  if (current.status === "processed") return { outcome: "rejected", code: "ALREADY_PROCESSED" };
  if (current.status === "anomaly") return { outcome: "rejected", code: "EVENT_FINANCIAL_ANOMALY" };
  if (current.status === "ignored") return { outcome: "rejected", code: "EVENT_TERMINAL_IGNORED" };
  if (current.status === "processing") return { outcome: "rejected", code: "EVENT_IN_PROGRESS" };
  if (current.attempts < base) return { outcome: "rejected", code: "BUDGET_NOT_EXHAUSTED" };
  if (recoveryGrants(current) >= MAX_RECOVERY_GRANTS) return { outcome: "rejected", code: "GRANT_LIMIT_REACHED" };
  return { outcome: "rejected", code: "CONFLICT" };
}
