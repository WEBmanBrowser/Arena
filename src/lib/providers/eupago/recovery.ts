/**
 * B.3.2 — Eupago advanced-search recovery (management API).
 *
 * PURPOSE
 *  Eupago exposes NO formal Idempotency-Key contract for creation endpoints.
 *  When a create request ends ambiguously (timeout / 5xx / malformed body),
 *  the ONLY safe way forward is to ask the provider what actually exists,
 *  keyed by our stable identifier.
 *
 * ABSENCE SEMANTICS ARE STRICT
 *  `absent` is returned ONLY when the provider gives a well-formed response
 *  that positively proves nothing was created (HTTP 200 with an empty result
 *  set, or an explicit documented 404 "not found").
 *
 *  Timeout, 5xx, OAuth failure and malformed responses are AMBIGUOUS. They are
 *  never downgraded to "absent", because doing so would authorize a second
 *  create request and risk charging the customer twice.
 */

import {
  eupagoRequest,
  getEupagoAccessToken,
  type AmbiguityReason,
} from "./client";
import type { EupagoConfig } from "./config";
import { isValidTrid } from "./config";

export type RecoveryLookupResult =
  | {
      readonly kind: "found";
      readonly reference?: string | null;
      readonly transactionId?: string | null;
      readonly status?: string | null;
      readonly amountCents?: number | null;
    }
  /** Provider PROVED nothing exists for this identifier. */
  | { readonly kind: "absent" }
  /** Unknown provider state — operator/reconciliation required. */
  | { readonly kind: "ambiguous"; readonly reason: AmbiguityReason };

export interface RecoveryLookupInput {
  readonly config: EupagoConfig;
  /** Our stable identifier — the primary recovery key. */
  readonly identifier: string;
  readonly startDate?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

/**
 * Look up whether a creation already happened for our stable identifier.
 */
export async function lookupByIdentifier(
  input: RecoveryLookupInput
): Promise<RecoveryLookupResult> {
  const token = await getEupagoAccessToken({
    environment: input.config.environment,
    clientId: input.config.oauthClientId,
    clientSecret: input.config.oauthClientSecret,
    fetchImpl: input.fetchImpl,
    timeoutMs: input.timeoutMs,
    now: input.now,
  });

  // An OAuth failure tells us NOTHING about provider-side state.
  if (token.kind === "ambiguous") {
    return { kind: "ambiguous", reason: token.reason };
  }

  const response = await eupagoRequest({
    environment: input.config.environment,
    endpoint: "referencesInfo",
    method: "GET",
    headers: { Authorization: `Bearer ${token.accessToken}` },
    query: {
      identifier: input.identifier,
      ...(input.startDate ? { start_date: input.startDate } : {}),
    },
    timeoutMs: input.timeoutMs,
    fetchImpl: input.fetchImpl,
  });

  if (response.kind === "ambiguous") {
    return { kind: "ambiguous", reason: response.reason };
  }

  // A documented 404 is positive proof of absence. Any other 4xx (401/403
  // authorization problems, 400 malformed query) is NOT.
  if (response.status === 404) return { kind: "absent" };
  if (response.status >= 400) return { kind: "ambiguous", reason: "malformed_response" };

  const records = extractRecords(response.body);
  if (records === null) {
    // We cannot tell an empty result from an unexpected shape → ambiguous.
    return { kind: "ambiguous", reason: "malformed_response" };
  }
  if (records.length === 0) return { kind: "absent" };

  const record = records[0];
  return {
    kind: "found",
    reference: readString(record, "reference") ?? readString(record, "referencia"),
    transactionId: pickTrid(record),
    status: readString(record, "status") ?? readString(record, "estado"),
    amountCents: readAmountCents(record),
  };
}

function extractRecords(body: Record<string, unknown>): Array<Record<string, unknown>> | null {
  const candidates = [body.data, body.references, body.transactions, body.results];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter(
        (r): r is Record<string, unknown> => typeof r === "object" && r !== null && !Array.isArray(r)
      );
    }
  }
  // Some documented responses carry a single object instead of a list.
  if (typeof body.data === "object" && body.data !== null && !Array.isArray(body.data)) {
    return [body.data as Record<string, unknown>];
  }
  return null;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 && value.length <= 255 ? value : null;
}

function pickTrid(record: Record<string, unknown>): string | null {
  for (const key of ["trid", "transactionID", "transactionId"]) {
    const value = record[key];
    if (isValidTrid(value)) return value;
  }
  return null;
}

/** Deterministic decimal-string → cents. Never floating point. */
function readAmountCents(record: Record<string, unknown>): number | null {
  const raw = record.amount ?? record.valor;
  const text = typeof raw === "number" ? raw.toFixed(2) : typeof raw === "string" ? raw : null;
  if (text === null) return null;
  const match = /^(-)?(\d{1,12})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  const [, sign, whole, fraction = ""] = match;
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) return null;
  return sign === "-" ? -cents : cents;
}
