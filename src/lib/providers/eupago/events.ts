/**
 * B.3.2 — Eupago webhook payload normalization + local correlation.
 *
 * EVENT IDENTITY
 *  Eupago has no separate webhook event id: `trid` uniquely identifies a FUND
 *  MOVEMENT, and every payment or refund movement gets its own trid.
 *  Therefore trid IS the dedupe key, scoped per provider by the existing
 *  B.3.1 provider_webhook_events ledger (no second ledger exists).
 *
 * A refund movement carries BOTH:
 *   trid          → the refund movement (dedupe key)
 *   originalTrid  → the payment movement being refunded (correlation key)
 *
 * This module is PURE: parsing, validation and normalization only. It performs
 * no I/O and never mutates state.
 */

import { isValidTrid } from "./config";

export const EUPAGO_EVENT_STATUSES = ["Paid", "Refund", "Error", "Cancel", "Expired"] as const;
export type EupagoEventStatus = (typeof EUPAGO_EVENT_STATUSES)[number];

export type EupagoEventKind = "payment" | "refund";

export interface NormalizedEupagoEvent {
  /** Dedupe key — the fund movement id. */
  readonly trid: string;
  /** Present only for refund movements. */
  readonly originalTrid: string | null;
  readonly kind: EupagoEventKind;
  readonly status: EupagoEventStatus;
  readonly identifier: string | null;
  readonly reference: string | null;
  readonly entity: string | null;
  readonly method: string | null;
  /** Integer cents — never floating point. */
  readonly amountCents: number | null;
  readonly currency: string;
}

export type NormalizeResult =
  | { readonly ok: true; readonly event: NormalizedEupagoEvent }
  | { readonly ok: false; readonly code: string };

/** Deterministic decimal string → integer cents (no floating point). */
export function decimalStringToCents(value: unknown): number | null {
  const text =
    typeof value === "number" && Number.isFinite(value)
      ? value.toFixed(2)
      : typeof value === "string"
        ? value.trim()
        : null;
  if (text === null || text.length === 0 || text.length > 20) return null;
  const match = /^(-)?(\d{1,12})(?:[.,](\d{1,2}))?$/.exec(text);
  if (!match) return null;
  const [, sign, whole, fraction = ""] = match;
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) return null;
  return sign === "-" ? -cents : cents;
}

function str(value: unknown, maxLength = 255): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : null;
}

/** Provider method label → internal payment attempt method. */
export function normalizeMethod(raw: string | null): string | null {
  if (!raw) return null;
  const value = raw.toLowerCase().replace(/[\s_-]+/g, "");
  if (value.includes("multibanco") || value === "mb" || value === "pm") return "multibanco";
  if (value.includes("mbway")) return "mbway";
  if (value.includes("card") || value.includes("cartao") || value.includes("cc")) return "card";
  return null;
}

function normalizeStatus(raw: string | null): EupagoEventStatus | null {
  if (!raw) return null;
  const found = EUPAGO_EVENT_STATUSES.find((s) => s.toLowerCase() === raw.trim().toLowerCase());
  return found ?? null;
}

/**
 * Normalize a verified webhook payload.
 *
 * The payload MUST already have passed signature verification — this function
 * only enforces structural/semantic validity.
 */
export function normalizeEupagoEvent(payload: Record<string, unknown>): NormalizeResult {
  // Some deliveries nest the movement under `transaction`.
  const raw =
    typeof payload.transaction === "object" && payload.transaction !== null && !Array.isArray(payload.transaction)
      ? (payload.transaction as Record<string, unknown>)
      : payload;

  const trid = raw.trid;
  if (!isValidTrid(trid)) return { ok: false, code: "MISSING_TRID" };

  const status = normalizeStatus(str(raw.status, 40));
  if (!status) return { ok: false, code: "UNKNOWN_STATUS" };

  const originalTridRaw = raw.originalTrid ?? raw.original_trid;
  const originalTrid = isValidTrid(originalTridRaw) ? originalTridRaw : null;

  // A refund movement is identified by its status AND its own distinct trid.
  const kind: EupagoEventKind = status === "Refund" ? "refund" : "payment";
  if (kind === "refund" && !originalTrid) return { ok: false, code: "MISSING_ORIGINAL_TRID" };
  if (kind === "refund" && originalTrid === trid) return { ok: false, code: "REFUND_TRID_NOT_DISTINCT" };

  const currency = str(raw.currency, 3) ?? "EUR";
  if (!/^[A-Z]{3}$/.test(currency)) return { ok: false, code: "INVALID_CURRENCY" };

  return {
    ok: true,
    event: {
      trid,
      originalTrid,
      kind,
      status,
      identifier: str(raw.identifier, 64),
      reference: str(raw.reference, 64),
      entity: str(raw.entity, 20),
      method: normalizeMethod(str(raw.method, 40)),
      amountCents: decimalStringToCents(raw.amount),
      currency,
    },
  };
}
