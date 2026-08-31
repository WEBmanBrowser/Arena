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
  input: RegisterWebhookEventInput
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

  const inserted = await db
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

  const existing = await findWebhookEvent(provider, providerEventId, payloadHash);
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
  payloadHash: string
): Promise<WebhookEventRecord | null> {
  const where = providerEventId
    ? and(eq(providerWebhookEvents.provider, provider), eq(providerWebhookEvents.providerEventId, providerEventId))
    : and(
        eq(providerWebhookEvents.provider, provider),
        eq(providerWebhookEvents.payloadHash, payloadHash),
        sql`${providerWebhookEvents.providerEventId} IS NULL`
      );
  const [row] = await db.select().from(providerWebhookEvents).where(where).limit(1);
  return row ?? null;
}

export async function getWebhookEvent(id: number): Promise<WebhookEventRecord | null> {
  const [row] = await db.select().from(providerWebhookEvents).where(eq(providerWebhookEvents.id, id)).limit(1);
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
  options: { maxAttempts?: number } = {}
): Promise<WebhookEventRecord | null> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_WEBHOOK_ATTEMPTS;
  const [claimed] = await db
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

export async function markWebhookEventProcessed(id: number): Promise<WebhookEventRecord | null> {
  const now = new Date();
  const [row] = await db
    .update(providerWebhookEvents)
    .set({ status: "processed", processedAt: now, lastError: null, updatedAt: now })
    .where(and(eq(providerWebhookEvents.id, id), eq(providerWebhookEvents.status, "processing")))
    .returning();
  return row ?? null;
}

export async function markWebhookEventFailed(id: number, error: unknown): Promise<WebhookEventRecord | null> {
  const now = new Date();
  const [row] = await db
    .update(providerWebhookEvents)
    .set({ status: "failed", failedAt: now, lastError: sanitizeErrorMessage(error), updatedAt: now })
    .where(and(eq(providerWebhookEvents.id, id), eq(providerWebhookEvents.status, "processing")))
    .returning();
  return row ?? null;
}

/** Event understood but intentionally not acted upon (e.g. unknown type). */
export async function markWebhookEventIgnored(id: number, reason?: string): Promise<WebhookEventRecord | null> {
  const now = new Date();
  const [row] = await db
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

/** A failed event is retryable while its capped attempt budget remains. */
export function isRetryable(event: WebhookEventRecord, maxAttempts = DEFAULT_MAX_WEBHOOK_ATTEMPTS): boolean {
  return event.status === "failed" && event.attempts < maxAttempts;
}

/** Failed events still eligible for a controlled (externally scheduled) retry. */
export async function listRetryableWebhookEvents(
  provider?: string,
  options: { maxAttempts?: number; limit?: number } = {}
): Promise<WebhookEventRecord[]> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_WEBHOOK_ATTEMPTS;
  const base = and(
    eq(providerWebhookEvents.status, "failed" satisfies WebhookEventStatus),
    sql`${providerWebhookEvents.attempts} < ${maxAttempts}`
  );
  return db
    .select()
    .from(providerWebhookEvents)
    .where(provider ? and(base, eq(providerWebhookEvents.provider, provider)) : base)
    .limit(options.limit ?? 50);
}
