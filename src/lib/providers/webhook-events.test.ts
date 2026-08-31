// B.3.1 — Webhook event foundation tests (real PostgreSQL, real production service)

import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/db";
import { providerWebhookEvents } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import {
  registerWebhookEvent,
  claimWebhookEvent,
  markWebhookEventProcessed,
  markWebhookEventFailed,
  markWebhookEventIgnored,
  getWebhookEvent,
  computePayloadHash,
  sanitizeWebhookMetadata,
  listRetryableWebhookEvents,
  isRetryable,
  assertWebhookVerified,
  rejectUnverifiedWebhook,
  DEFAULT_MAX_WEBHOOK_ATTEMPTS,
} from "@/lib/providers/webhook-events";
import { ProviderError } from "@/lib/providers/errors";

const BODY = JSON.stringify({ event: "payment.paid", reference: "REF-1", amount: "12.34" });

beforeEach(async () => {
  await db.delete(providerWebhookEvents);
});

describe("B.3.1 — webhook events: registration and deduplication", () => {
  it("registers a new event as pending and stores only the payload hash", async () => {
    const { event, duplicate } = await registerWebhookEvent({
      provider: "eupago",
      providerEventId: "evt_1",
      rawBody: BODY,
      eventType: "payment.paid",
    });

    expect(duplicate).toBe(false);
    expect(event.status).toBe("pending");
    expect(event.attempts).toBe(0);
    expect(event.provider).toBe("eupago");
    expect(event.providerEventId).toBe("evt_1");
    expect(event.payloadHash).toBe(await computePayloadHash(BODY));
    expect(event.payloadHash).toHaveLength(64);
    expect(event.receivedAt).toBeInstanceOf(Date);
    expect(event.processedAt).toBeNull();

    // The raw body is never persisted in any column
    const serializedRow = JSON.stringify(event);
    expect(serializedRow).not.toContain("REF-1");
    expect(serializedRow).not.toContain("payment.paid\",\"reference");
  });

  it("deduplicates on providerEventId", async () => {
    const first = await registerWebhookEvent({ provider: "eupago", providerEventId: "evt_dup", rawBody: BODY });
    const second = await registerWebhookEvent({
      provider: "eupago",
      providerEventId: "evt_dup",
      rawBody: JSON.stringify({ different: true }),
    });

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.event.id).toBe(first.event.id);

    const rows = await db.select().from(providerWebhookEvents).where(eq(providerWebhookEvents.providerEventId, "evt_dup"));
    expect(rows).toHaveLength(1);
  });

  it("falls back to payloadHash deduplication when no providerEventId exists", async () => {
    const first = await registerWebhookEvent({ provider: "ctt", rawBody: BODY });
    const second = await registerWebhookEvent({ provider: "ctt", rawBody: BODY });
    const other = await registerWebhookEvent({ provider: "ctt", rawBody: JSON.stringify({ other: 1 }) });

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.event.id).toBe(first.event.id);
    expect(other.duplicate).toBe(false);
    expect(other.event.id).not.toBe(first.event.id);
  });

  it("does not collapse the same event id coming from different providers", async () => {
    const a = await registerWebhookEvent({ provider: "eupago", providerEventId: "shared_1", rawBody: BODY });
    const b = await registerWebhookEvent({ provider: "mrw", providerEventId: "shared_1", rawBody: BODY });

    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(false);
    expect(a.event.id).not.toBe(b.event.id);

    const rows = await db.select().from(providerWebhookEvents).where(eq(providerWebhookEvents.providerEventId, "shared_1"));
    expect(rows).toHaveLength(2);
  });

  it("does not collapse identical payloads from different providers (hash fallback)", async () => {
    const a = await registerWebhookEvent({ provider: "mrw", rawBody: BODY });
    const b = await registerWebhookEvent({ provider: "ctt", rawBody: BODY });
    expect(a.event.id).not.toBe(b.event.id);
    expect(a.event.payloadHash).toBe(b.event.payloadHash);
  });

  it("enforces deduplication with database unique indexes, not application checks", async () => {
    const hash = await computePayloadHash(BODY);
    await registerWebhookEvent({ provider: "eupago", providerEventId: "evt_db", rawBody: BODY });

    await expect(
      db.insert(providerWebhookEvents).values({ provider: "eupago", providerEventId: "evt_db", payloadHash: "deadbeef" })
    ).rejects.toThrow();

    await registerWebhookEvent({ provider: "eupago", rawBody: BODY });
    await expect(
      db.insert(providerWebhookEvents).values({ provider: "eupago", providerEventId: null, payloadHash: hash })
    ).rejects.toThrow();
  });

  it("rejects invalid registrations with normalized errors", async () => {
    await expect(registerWebhookEvent({ provider: "", rawBody: BODY })).rejects.toThrow(ProviderError);
    await expect(registerWebhookEvent({ provider: "eupago", rawBody: "" })).rejects.toThrow(ProviderError);
  });
});

describe("B.3.1 — webhook events: processing lifecycle", () => {
  async function newEvent(eventId = `evt_${Math.random().toString(36).slice(2)}`) {
    const { event } = await registerWebhookEvent({
      provider: "eupago",
      providerEventId: eventId,
      rawBody: `${BODY}${eventId}`,
    });
    return event;
  }

  it("claims pending → processing atomically and increments attempts", async () => {
    const event = await newEvent();
    const claimed = await claimWebhookEvent(event.id);
    expect(claimed?.status).toBe("processing");
    expect(claimed?.attempts).toBe(1);
  });

  it("prevents a second concurrent claim of the same event", async () => {
    const event = await newEvent();
    const [a, b] = await Promise.all([claimWebhookEvent(event.id), claimWebhookEvent(event.id)]);
    const claimed = [a, b].filter(Boolean);
    expect(claimed).toHaveLength(1);
    const stored = await getWebhookEvent(event.id);
    expect(stored?.attempts).toBe(1);
  });

  it("moves processing → processed", async () => {
    const event = await newEvent();
    await claimWebhookEvent(event.id);
    const processed = await markWebhookEventProcessed(event.id);
    expect(processed?.status).toBe("processed");
    expect(processed?.processedAt).toBeInstanceOf(Date);
  });

  it("prevents replay: a processed event can never be claimed or processed again", async () => {
    const event = await newEvent();
    await claimWebhookEvent(event.id);
    await markWebhookEventProcessed(event.id);

    expect(await claimWebhookEvent(event.id)).toBeNull();
    expect(await markWebhookEventProcessed(event.id)).toBeNull();

    const stored = await getWebhookEvent(event.id);
    expect(stored?.status).toBe("processed");
    expect(stored?.attempts).toBe(1);
  });

  it("re-delivery of a processed event is reported as duplicate and stays processed", async () => {
    const { event } = await registerWebhookEvent({ provider: "eupago", providerEventId: "evt_replay", rawBody: BODY });
    await claimWebhookEvent(event.id);
    await markWebhookEventProcessed(event.id);

    const redelivery = await registerWebhookEvent({ provider: "eupago", providerEventId: "evt_replay", rawBody: BODY });
    expect(redelivery.duplicate).toBe(true);
    expect(redelivery.event.status).toBe("processed");
    expect(await claimWebhookEvent(redelivery.event.id)).toBeNull();
  });

  it("moves processing → failed with a sanitized error and allows controlled retry", async () => {
    const event = await newEvent();
    await claimWebhookEvent(event.id);
    const failed = await markWebhookEventFailed(event.id, new Error("timeout api_key=sk_live_ABC"));

    expect(failed?.status).toBe("failed");
    expect(failed?.failedAt).toBeInstanceOf(Date);
    expect(failed?.lastError).not.toContain("sk_live_ABC");
    expect(isRetryable(failed!)).toBe(true);

    const retryable = await listRetryableWebhookEvents("eupago");
    expect(retryable.map((r) => r.id)).toContain(event.id);

    const reclaimed = await claimWebhookEvent(event.id);
    expect(reclaimed?.status).toBe("processing");
    expect(reclaimed?.attempts).toBe(2);
  });

  it("caps retries — no uncontrolled retry loop", async () => {
    const event = await newEvent();
    for (let i = 0; i < DEFAULT_MAX_WEBHOOK_ATTEMPTS; i++) {
      const claimed = await claimWebhookEvent(event.id);
      expect(claimed).not.toBeNull();
      await markWebhookEventFailed(event.id, "boom");
    }
    const stored = await getWebhookEvent(event.id);
    expect(stored?.attempts).toBe(DEFAULT_MAX_WEBHOOK_ATTEMPTS);
    expect(isRetryable(stored!)).toBe(false);
    expect(await claimWebhookEvent(event.id)).toBeNull();
    expect(await listRetryableWebhookEvents("eupago")).toHaveLength(0);
  });

  it("supports the ignored state for events that must not be acted upon", async () => {
    const event = await newEvent();
    await claimWebhookEvent(event.id);
    const ignored = await markWebhookEventIgnored(event.id, "unknown event type");
    expect(ignored?.status).toBe("ignored");
    expect(await claimWebhookEvent(event.id)).toBeNull();

    const direct = await newEvent();
    const ignoredPending = await markWebhookEventIgnored(direct.id);
    expect(ignoredPending?.status).toBe("ignored");
  });

  it("cannot mark processed an event that was not claimed", async () => {
    const event = await newEvent();
    expect(await markWebhookEventProcessed(event.id)).toBeNull();
    expect(await markWebhookEventFailed(event.id, "x")).toBeNull();
  });
});

describe("B.3.1 — webhook events: security foundation", () => {
  it("drops secret-bearing metadata instead of persisting it", async () => {
    const { event } = await registerWebhookEvent({
      provider: "eupago",
      providerEventId: "evt_meta",
      rawBody: BODY,
      metadata: {
        authorization: "Bearer secret-token",
        apiKey: "sk_live_123",
        rawPayload: BODY,
        cardNumber: "4111111111111111",
        nested: { a: 1 },
        attemptNumber: 2,
        eventVersion: "v1",
      },
    });

    const metadata = event.metadata ?? {};
    expect(Object.keys(metadata).sort()).toEqual(["attemptNumber", "eventVersion"]);
    const serialized = JSON.stringify(metadata);
    expect(serialized).not.toContain("secret-token");
    expect(serialized).not.toContain("sk_live_123");
    expect(serialized).not.toContain("4111111111111111");
  });

  it("sanitizes metadata deterministically", () => {
    expect(sanitizeWebhookMetadata(undefined)).toBeNull();
    expect(sanitizeWebhookMetadata({ token: "x" })).toBeNull();
    expect(sanitizeWebhookMetadata({ ok: true, n: 1, s: "a" })).toEqual({ ok: true, n: 1, s: "a" });
    expect(sanitizeWebhookMetadata({ long: "y".repeat(500) })!.long).toHaveLength(200);
  });

  it("requires provider verification and rejects unverified deliveries by default", async () => {
    const result = await rejectUnverifiedWebhook.verify({ provider: "eupago", rawBody: BODY, headers: {} });
    expect(result.valid).toBe(false);
    expect(() => assertWebhookVerified(result, "eupago")).toThrow(ProviderError);
    try {
      assertWebhookVerified(result, "eupago");
    } catch (e) {
      expect((e as ProviderError).code).toBe("WEBHOOK_INVALID");
      expect((e as ProviderError).toCustomerSafeJSON().error).toBe("WEBHOOK_INVALID");
    }
    expect(() => assertWebhookVerified({ valid: true }, "eupago")).not.toThrow();
  });

  it("stores no order state and no order reference (provider state is not order state)", async () => {
    const { event } = await registerWebhookEvent({ provider: "eupago", providerEventId: "evt_no_order", rawBody: BODY });
    expect(Object.keys(event)).not.toContain("orderId");
    expect(Object.keys(event)).not.toContain("orderStatus");
  });

  it("scopes lookups per provider in the database", async () => {
    await registerWebhookEvent({ provider: "eupago", providerEventId: "scoped", rawBody: BODY });
    await registerWebhookEvent({ provider: "ctt", providerEventId: "scoped", rawBody: BODY });
    const eupagoRows = await db
      .select()
      .from(providerWebhookEvents)
      .where(and(eq(providerWebhookEvents.provider, "eupago"), eq(providerWebhookEvents.providerEventId, "scoped")));
    expect(eupagoRows).toHaveLength(1);
  });
});
