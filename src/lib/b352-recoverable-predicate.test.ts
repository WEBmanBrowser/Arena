/**
 * B.3.5.2 — UI Recoverability predicate.
 *
 * These tests pin the shared `isMetadataEligibleForRecovery` predicate
 * used by BOTH the recovery service (pre-transaction gate) AND the admin
 * DTO (UI recoverability boolean). The predicate is a pure function over
 * the persisted event shape — it does NOT touch the database, the
 * network, the settlement pipeline, or the audit log.
 *
 * The matrix covers every shape that can appear in the
 * `provider_webhook_events` table after the B.3.5.2 metadata
 * introduction. For each input shape we assert:
 *   - whether the predicate returns `true` (UI may show the button AND
 *     the service may enter the claim transaction);
 *   - whether the predicate returns `false` (UI MUST hide the button
 *     AND the service MUST reject with a deterministic code).
 *
 * The goal is to ensure the UI and the service can NEVER diverge: a row
 * for which the UI would enable "Recuperar" must also be the exact set
 * of rows the service can recover. A row for which the service refuses
 * MUST never be marked `recoverable: true` in the DTO.
 *
 * The boolean is "metadata-eligible for a recovery attempt" — NOT a
 * guarantee of financial success. The actual settlement is still gated
 * by the single PG transaction in `recoverIgnoredEupagoRefund`.
 */

import { describe, expect, it } from "vitest";
import { isMetadataEligibleForRecovery } from "@/lib/services/eupago-refund-recovery-service";

const REFUND_ATTEMPT_NOT_FOUND = "REFUND_ATTEMPT_NOT_FOUND";

const VALID_TRID = "TX-2026-0001234567";
const VALID_ORIGINAL_TRID = "PI-2026-0007654321";

function baseEligibleEvent() {
  return {
    provider: "eupago",
    status: "ignored",
    lastError: REFUND_ATTEMPT_NOT_FOUND,
    providerEventId: VALID_TRID,
    metadata: {
      kind: "refund" as const,
      status: "Refund" as const,
      originalTrid: VALID_ORIGINAL_TRID,
      amountCents: 1234,
      currency: "EUR",
    },
  };
}

describe("B.3.5.2 isMetadataEligibleForRecovery — pure predicate", () => {
  it("future valid event → true", () => {
    expect(isMetadataEligibleForRecovery(baseEligibleEvent())).toBe(true);
  });

  it("legacy null metadata → false", () => {
    const e = baseEligibleEvent();
    expect(isMetadataEligibleForRecovery({ ...e, metadata: null })).toBe(false);
  });

  it("empty-object metadata → false (not classified as refund)", () => {
    const e = baseEligibleEvent();
    expect(isMetadataEligibleForRecovery({ ...e, metadata: {} })).toBe(false);
  });

  it("kind=payment → false (only refund events are recoverable)", () => {
    const e = baseEligibleEvent();
    const m = { ...e.metadata, kind: "payment" as const };
    expect(isMetadataEligibleForRecovery({ ...e, metadata: m })).toBe(false);
  });

  it("status != 'Refund' → false", () => {
    const e = baseEligibleEvent();
    const m = { ...e.metadata, status: "Settled" };
    expect(isMetadataEligibleForRecovery({ ...e, metadata: m })).toBe(false);
  });

  it("missing trid (providerEventId=null) → false", () => {
    const e = baseEligibleEvent();
    expect(isMetadataEligibleForRecovery({ ...e, providerEventId: null })).toBe(false);
  });

  it("invalid trid format → false", () => {
    const e = baseEligibleEvent();
    expect(isMetadataEligibleForRecovery({ ...e, providerEventId: "DROP TABLE users;--" })).toBe(false);
  });

  it("missing originalTrid → false", () => {
    const e = baseEligibleEvent();
    const m = { ...e.metadata } as Record<string, unknown>;
    delete m.originalTrid;
    expect(isMetadataEligibleForRecovery({ ...e, metadata: m })).toBe(false);
  });

  it("invalid originalTrid format → false", () => {
    const e = baseEligibleEvent();
    const m = { ...e.metadata, originalTrid: "!!!invalid!!!" };
    expect(isMetadataEligibleForRecovery({ ...e, metadata: m })).toBe(false);
  });

  it("missing amountCents → false", () => {
    const e = baseEligibleEvent();
    const m = { ...e.metadata } as Record<string, unknown>;
    delete m.amountCents;
    expect(isMetadataEligibleForRecovery({ ...e, metadata: m })).toBe(false);
  });

  it("amountCents=0 → false", () => {
    const e = baseEligibleEvent();
    const m = { ...e.metadata, amountCents: 0 };
    expect(isMetadataEligibleForRecovery({ ...e, metadata: m })).toBe(false);
  });

  it("amountCents negative → false", () => {
    const e = baseEligibleEvent();
    const m = { ...e.metadata, amountCents: -100 };
    expect(isMetadataEligibleForRecovery({ ...e, metadata: m })).toBe(false);
  });

  it("amountCents non-integer (1.5) → false", () => {
    const e = baseEligibleEvent();
    const m = { ...e.metadata, amountCents: 1.5 };
    expect(isMetadataEligibleForRecovery({ ...e, metadata: m })).toBe(false);
  });

  it("amountCents non-finite (NaN) → false", () => {
    const e = baseEligibleEvent();
    const m = { ...e.metadata, amountCents: Number.NaN };
    expect(isMetadataEligibleForRecovery({ ...e, metadata: m })).toBe(false);
  });

  it("amountCents unsafe integer (1e20) → false", () => {
    const e = baseEligibleEvent();
    const m = { ...e.metadata, amountCents: 1e20 };
    expect(isMetadataEligibleForRecovery({ ...e, metadata: m })).toBe(false);
  });

  it("missing currency → false", () => {
    const e = baseEligibleEvent();
    const m = { ...e.metadata } as Record<string, unknown>;
    delete m.currency;
    expect(isMetadataEligibleForRecovery({ ...e, metadata: m })).toBe(false);
  });

  it("invalid currency (lowercase) → false", () => {
    const e = baseEligibleEvent();
    const m = { ...e.metadata, currency: "eur" };
    expect(isMetadataEligibleForRecovery({ ...e, metadata: m })).toBe(false);
  });

  it("invalid currency (4 letters) → false", () => {
    const e = baseEligibleEvent();
    const m = { ...e.metadata, currency: "EURO" };
    expect(isMetadataEligibleForRecovery({ ...e, metadata: m })).toBe(false);
  });

  it("wrong provider (siBS) → false", () => {
    const e = baseEligibleEvent();
    expect(isMetadataEligibleForRecovery({ ...e, provider: "siBS" })).toBe(false);
  });

  it("event status=failed → false (only ignored events are eligible)", () => {
    const e = baseEligibleEvent();
    expect(isMetadataEligibleForRecovery({ ...e, status: "failed" })).toBe(false);
  });

  it("event status=processed → false (already settled at the webhook layer)", () => {
    const e = baseEligibleEvent();
    expect(isMetadataEligibleForRecovery({ ...e, status: "processed" })).toBe(false);
  });

  it("wrong lastError (e.g. SIGNATURE_INVALID) → false", () => {
    const e = baseEligibleEvent();
    expect(isMetadataEligibleForRecovery({ ...e, lastError: "SIGNATURE_INVALID" })).toBe(false);
  });

  it("lastError=null → false", () => {
    const e = baseEligibleEvent();
    expect(isMetadataEligibleForRecovery({ ...e, lastError: null })).toBe(false);
  });
});
