/**
 * B.3.2 — Eupago Realtime Webhooks 2.0: signature verification + decryption.
 *
 * FAIL CLOSED. A webhook key is REQUIRED; once configured, `X-Signature` is
 * MANDATORY. There is no unsigned compatibility mode.
 *
 * encrypt=false
 *   HMAC input is the COMPLETE RAW HTTP JSON BODY exactly as received
 *   (UTF-8 bytes). The body is NEVER JSON.parse()'d and re-stringified before
 *   verification: whitespace, key order and escaping are signature-sensitive.
 *
 * encrypt=true
 *   HMAC input is EXACTLY the Base64 STRING VALUE of the top-level JSON field
 *   `data` — not the decoded ciphertext, not the decrypted JSON, not the full
 *   body, and without surrounding quotes. Decryption happens ONLY after the
 *   signature has been verified.
 *
 * Key handling: the configured webhook key is used DIRECTLY as UTF-8 bytes for
 * HMAC-SHA256 (no derivation, no pre-hashing, no Base64 decoding). For AES it
 * must be EXACTLY 32 UTF-8 bytes.
 *
 * X-Signature is standard Base64 WITH padding (raw 32-byte HMAC → 44 chars).
 * Comparison is constant-time.
 *
 * RUNTIME: Web Crypto only (crypto.subtle) — Cloudflare Workers / OpenNext
 * compatible. No Node-only crypto module is imported.
 */

import { ProviderError } from "../errors";
import { EUPAGO_PROVIDER_ID } from "./config";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function invalid(detail: string): never {
  throw new ProviderError("WEBHOOK_INVALID", {
    provider: EUPAGO_PROVIDER_ID,
    internalDetail: detail,
  });
}

// ─── Base64 helpers (Workers-safe, strict) ────────────────

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Strict standard Base64 (with padding) → bytes. */
export function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || value.length === 0) invalid("empty base64");
  if (value.length % 4 !== 0 || !BASE64_RE.test(value)) invalid("malformed base64");
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    return invalid("undecodable base64");
  }
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

// ─── HMAC-SHA256 ──────────────────────────────────────────

/**
 * Raw HMAC-SHA256 over `message` UTF-8 bytes, keyed with the webhook key's
 * UTF-8 bytes used DIRECTLY (no derivation).
 */
export async function hmacSha256(key: string, message: string): Promise<Uint8Array> {
  if (typeof key !== "string" || key.length === 0) invalid("missing webhook key");
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
  return new Uint8Array(signature);
}

/** Base64 (padded) HMAC-SHA256 — the X-Signature wire format. */
export async function computeSignature(key: string, message: string): Promise<string> {
  return bytesToBase64(await hmacSha256(key, message));
}

/** Length-independent constant-time byte comparison. */
export function constantTimeEquals(a: Uint8Array, b: Uint8Array): boolean {
  // Compare a fixed-width accumulator so the loop count never depends on the
  // position of the first differing byte. A length difference is folded into
  // the same accumulator instead of returning early.
  let diff = a.length ^ b.length;
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/**
 * Verify a provided X-Signature against the expected HMAC of `message`.
 * Never throws on a bad signature — returns false (callers fail closed).
 */
export async function verifySignature(
  key: string,
  message: string,
  providedSignature: string | null | undefined
): Promise<boolean> {
  if (typeof providedSignature !== "string" || providedSignature.length === 0) return false;
  let provided: Uint8Array;
  try {
    provided = base64ToBytes(providedSignature.trim());
  } catch {
    return false;
  }
  const expected = await hmacSha256(key, message);
  return constantTimeEquals(expected, provided);
}

// ─── Encrypted payload (AES-256-CBC) ──────────────────────

/** Webhook key must be EXACTLY 32 UTF-8 bytes for AES-256. */
export function assertAesKeyBytes(key: string): Uint8Array<ArrayBuffer> {
  const encoded = encoder.encode(key);
  if (encoded.length !== 32) invalid("webhook key must be exactly 32 UTF-8 bytes for AES-256");
  // Copy into a plain ArrayBuffer so the value satisfies BufferSource under
  // the strict lib.dom typings used for Web Crypto.
  const bytes = new Uint8Array(new ArrayBuffer(encoded.length));
  bytes.set(encoded);
  return bytes;
}

/** X-Initialization-Vector: Base64 of EXACTLY 16 bytes. */
export function decodeIv(headerValue: string | null | undefined): Uint8Array<ArrayBuffer> {
  if (typeof headerValue !== "string" || headerValue.trim().length === 0) {
    invalid("missing X-Initialization-Vector");
  }
  const iv = base64ToBytes(headerValue.trim());
  if (iv.length !== 16) invalid("initialization vector must be exactly 16 bytes");
  return iv;
}

/**
 * Decrypt an Eupago encrypted webhook payload.
 *
 * MUST only be called AFTER the signature over the Base64 `data` string has
 * been verified. Invalid padding / undecryptable ciphertext / non-UTF-8
 * plaintext all fail closed with WEBHOOK_INVALID.
 */
export async function decryptWebhookData(
  key: string,
  dataBase64: string,
  ivHeader: string | null | undefined
): Promise<string> {
  const keyBytes = assertAesKeyBytes(key);
  const iv = decodeIv(ivHeader);
  const ciphertext = base64ToBytes(dataBase64);
  if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) {
    invalid("ciphertext length is not an AES block multiple");
  }

  const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-CBC" }, false, [
    "decrypt",
  ]);

  let plaintextBytes: ArrayBuffer;
  try {
    // Web Crypto validates and strips PKCS#7 padding; bad padding throws.
    plaintextBytes = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, cryptoKey, ciphertext);
  } catch {
    return invalid("decryption failed");
  }

  try {
    return decoder.decode(plaintextBytes);
  } catch {
    return invalid("decrypted payload is not valid UTF-8");
  }
}

// ─── Top-level `data` extraction ──────────────────────────

/**
 * Extract the EXACT Base64 string value of the top-level `data` field.
 *
 * Parsing here is safe: it is used ONLY to obtain the string that will be
 * HMAC'd. The signature input is that string's own UTF-8 bytes, so
 * re-serialization of the surrounding object is irrelevant — unlike the
 * encrypt=false case, where the full raw body is signature-sensitive.
 */
export function extractEncryptedData(rawBody: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return invalid("body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    invalid("body is not a JSON object");
  }
  const data = (parsed as Record<string, unknown>).data;
  if (typeof data !== "string" || data.length === 0) invalid("missing data field");
  return data;
}

/** True when the delivery is an encrypted (encrypt=true) webhook. */
export function isEncryptedDelivery(rawBody: string): boolean {
  try {
    const parsed = JSON.parse(rawBody) as Record<string, unknown> | null;
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      typeof parsed.data === "string"
    );
  } catch {
    return false;
  }
}

// ─── Full verification entry point ────────────────────────

export interface VerifiedWebhookPayload {
  /** Decoded JSON payload (decrypted when the delivery was encrypted). */
  readonly payload: Record<string, unknown>;
  readonly encrypted: boolean;
}

/**
 * Verify an inbound Eupago webhook and return its payload.
 *
 * Ordering is mandatory and enforced here:
 *   1. obtain the raw body (caller must pass it byte-exact)
 *   2. choose the signature input (raw body | exact `data` string)
 *   3. HMAC-SHA256 + constant-time compare against X-Signature
 *   4. ONLY on success: decode Base64, validate IV, AES-256-CBC decrypt
 */
export async function verifyEupagoWebhook(
  webhookKey: string,
  rawBody: string,
  headers: Record<string, string>
): Promise<VerifiedWebhookPayload> {
  if (typeof rawBody !== "string" || rawBody.length === 0) invalid("empty body");
  if (typeof webhookKey !== "string" || webhookKey.length === 0) invalid("webhook key not configured");

  const signature = headers["x-signature"];
  // Signature is MANDATORY — no unsigned compatibility mode.
  if (typeof signature !== "string" || signature.trim().length === 0) {
    invalid("missing X-Signature");
  }

  const encrypted = isEncryptedDelivery(rawBody);

  if (!encrypted) {
    const ok = await verifySignature(webhookKey, rawBody, signature);
    if (!ok) invalid("signature mismatch");
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return invalid("body is not valid JSON");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      invalid("body is not a JSON object");
    }
    return { payload: parsed as Record<string, unknown>, encrypted: false };
  }

  const dataString = extractEncryptedData(rawBody);
  const ok = await verifySignature(webhookKey, dataString, signature);
  // NEVER decrypt before the signature is proven valid.
  if (!ok) invalid("signature mismatch");

  const plaintext = await decryptWebhookData(webhookKey, dataString, headers["x-initialization-vector"]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return invalid("decrypted payload is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    invalid("decrypted payload is not a JSON object");
  }
  return { payload: parsed as Record<string, unknown>, encrypted: true };
}
