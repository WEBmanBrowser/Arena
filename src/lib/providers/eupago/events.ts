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
  readonly currency: string | null;
}

export type NormalizeResult =
  | { readonly ok: true; readonly event: NormalizedEupagoEvent }
  | { readonly ok: false; readonly code: string };

/**
 * Deterministic decimal → integer cents (no floating point, NO ROUNDING).
 *
 * PAYMENT P0 (H1) — an invalid financial value is REJECTED, never repaired.
 *  • a numeric input is converted through its exact string form (never
 *    `toFixed`): `99.999` is "99.999" and is rejected;
 *  • `99.999`, `1e3`, `"12,345"`(3 decimals), `" 12.34 "`, `""` and `NaN` all
 *    return null — the caller must treat that as an invalid amount, not as a
 *    missing one;
 *  • values with more precision than a cent can represent are never rounded
 *    into an amount that would then match a local attempt.
 */
export function decimalStringToCents(value: unknown): number | null {
  const text =
    typeof value === "number" && Number.isFinite(value)
      ? String(value)
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

/**
 * PAYMENT P0 (H1) — EXACT method labels/aliases only.
 *
 * The previous implementation matched substrings (`includes("card")`,
 * `includes("cc")`, …), so an arbitrary label such as "success" (it contains
 * "cc") or "postcard" was silently interpreted as a CARD payment. Matching is
 * now an exact lookup on a normalized label (case-folded, internal whitespace/
 * separators removed, accents stripped) against a CLOSED table: an unknown
 * label yields null, which the settlement path treats as a fail-closed
 * METHOD_MISSING/METHOD_MISMATCH rather than a guessed method.
 */
const METHOD_ALIASES: Record<string, "multibanco" | "mbway" | "card"> = {
  multibanco: "multibanco",
  referenciamultibanco: "multibanco",
  referencia: "multibanco",
  mb: "multibanco",
  pm: "multibanco",
  mbway: "mbway",
  mbwaypt: "mbway",
  card: "card",
  cartao: "card",
  cartaocredito: "card",
  cartaodecredito: "card",
  creditcard: "card",
  credit: "card",
  cc: "card",
  visa: "card",
  mastercard: "card",
};

/** Lower-case, strip accents and separators — the alias lookup key. */
function methodKey(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[\s_.\-/]+/g, "");
}

/**
 * Provider method label → internal payment attempt method, or null when the
 * label is not an explicitly allowed alias. No substring matching, ever.
 */
export function normalizeMethod(raw: string | null): string | null {
  if (!raw) return null;
  return METHOD_ALIASES[methodKey(raw)] ?? null;
}

function normalizeStatus(raw: string | null): EupagoEventStatus | null {
  if (!raw) return null;
  const found = EUPAGO_EVENT_STATUSES.find((s) => s.toLowerCase() === raw.trim().toLowerCase());
  return found ?? null;
}

/**
 * PAYMENT P0 (H1) — equivalent aliases must AGREE.
 *
 * Only these alias groups are recognized; everything else must arrive under its
 * canonical key. When two members of the same group are present with different
 * normalized values the delivery is structurally invalid (e.g.
 * `originalTrid = A` together with `original_trid = B` is a contradiction, not
 * a "last one wins").
 */
export const EUPAGO_ALIAS_GROUPS = {
  trid: ["trid", "transactionID", "transaction_id", "transactionId"],
  originalTrid: ["originalTrid", "original_trid"],
  amount: ["amount", "valor"],
} as const;

type AliasValue = { present: boolean; raw: unknown; normalized: string | null };

function resolveAliasGroup(
  raw: Record<string, unknown>,
  keys: readonly string[],
  normalize: (value: unknown) => string | null
): { conflict: boolean; value: unknown; present: boolean } {
  const found: AliasValue[] = [];
  for (const key of keys) {
    const candidate = raw[key];
    if (candidate === undefined || candidate === null) continue;
    if (typeof candidate === "string" && candidate.trim().length === 0) continue;
    found.push({ present: true, raw: candidate, normalized: normalize(candidate) });
  }
  if (found.length === 0) return { conflict: false, value: undefined, present: false };

  const first = found[0];
  // With a SINGLE member there is nothing to contradict: its own field-level
  // validation decides (MISSING_TRID / INVALID_TRID / INVALID_AMOUNT).
  // With SEVERAL members, a member that cannot be normalized at all — or that
  // normalizes differently — is a contradiction: we never pick the "good" one
  // out of an inconsistent payload.
  const conflict =
    found.length > 1 && found.some((entry) => entry.normalized === null || entry.normalized !== first.normalized);
  return { conflict, value: first.raw, present: true };
}

const asTrimmedString = (value: unknown): string | null =>
  typeof value === "string" ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : null;

const asCentsString = (value: unknown): string | null => {
  const cents = decimalStringToCents(value);
  return cents === null ? null : String(cents);
};

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

  // ── Alias groups: equivalent keys must agree (H1) ──
  const tridAlias = resolveAliasGroup(raw, EUPAGO_ALIAS_GROUPS.trid, asTrimmedString);
  if (tridAlias.conflict) return { ok: false, code: "CONFLICTING_TRID_ALIASES" };
  const trid = tridAlias.value;
  if (!tridAlias.present) return { ok: false, code: "MISSING_TRID" };
  if (!isValidTrid(trid)) return { ok: false, code: "INVALID_TRID" };

  const status = normalizeStatus(str(raw.status, 40));
  if (!status) return { ok: false, code: "UNKNOWN_STATUS" };

  const originalTridAlias = resolveAliasGroup(raw, EUPAGO_ALIAS_GROUPS.originalTrid, asTrimmedString);
  if (originalTridAlias.conflict) return { ok: false, code: "CONFLICTING_ORIGINAL_TRID_ALIASES" };
  const originalTridRaw = originalTridAlias.value;
  const originalTrid = isValidTrid(originalTridRaw) ? originalTridRaw : null;

  // ── Amount (H1): present-but-invalid is REJECTED, never rounded or ignored ──
  const amountAlias = resolveAliasGroup(raw, EUPAGO_ALIAS_GROUPS.amount, asCentsString);
  if (amountAlias.conflict) return { ok: false, code: "CONFLICTING_AMOUNT_ALIASES" };
  let amountCents: number | null = null;
  if (amountAlias.present) {
    amountCents = decimalStringToCents(amountAlias.value);
    if (amountCents === null) return { ok: false, code: "INVALID_AMOUNT" };
  }

  // A refund movement is identified by its status AND its own distinct trid.
  const kind: EupagoEventKind = status === "Refund" ? "refund" : "payment";
  if (kind === "refund" && !originalTrid) return { ok: false, code: "MISSING_ORIGINAL_TRID" };
  if (kind === "refund" && originalTrid === trid) return { ok: false, code: "REFUND_TRID_NOT_DISTINCT" };

  // ── Currency (H1): present-but-invalid is REJECTED, never dropped ──
  // `str()` used to truncate/discard anything longer than three characters and
  // report "absent", so a nonsense `EURO` quietly became `null` (a valid-looking
  // event). An unusable value is now a structural error.
  const currencyRaw = raw.currency;
  const currencyPresent =
    currencyRaw !== undefined &&
    currencyRaw !== null &&
    !(typeof currencyRaw === "string" && currencyRaw.trim().length === 0);
  let currency: string | null = null;
  if (currencyPresent) {
    currency = typeof currencyRaw === "string" ? currencyRaw.trim() : null;
    if (currency === null || !/^[A-Z]{3}$/.test(currency)) return { ok: false, code: "INVALID_CURRENCY" };
  }

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
      amountCents,
      currency,
    },
  };
}
