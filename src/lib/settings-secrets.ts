/**
 * Server-side encryption for Backoffice-managed secrets stored in the
 * `settings` table (Eupago credentials, webhook key, …).
 *
 * SECURITY PROPERTIES
 *  - AES-256-GCM via Web Crypto (`crypto.subtle`) ONLY — Cloudflare Workers /
 *    OpenNext compatible. The Node-only `crypto` module is NEVER imported.
 *  - The data-encryption key comes EXCLUSIVELY from the server environment
 *    (`SETTINGS_ENCRYPTION_KEY`, 64 hex chars = 32 bytes, set via
 *    `wrangler secret put` / server env). There is no hardcoded key, no
 *    fallback and no default. Missing/invalid key → fail closed.
 *  - Random 96-bit IV per encryption. Envelope format (versioned):
 *      enc:v1:<base64 iv>.<base64 ciphertext+tag>
 *  - The key value is NEVER included in an error, log or return value — only
 *    stable error codes.
 *
 * SERVER-ONLY: this module reads `process.env` and must never be imported by
 * client components.
 */

const ENVELOPE_PREFIX = "enc:v1:";
const KEY_ENV_NAME = "SETTINGS_ENCRYPTION_KEY";

const HEX_64_RE = /^[0-9a-fA-F]{64}$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export type SettingsSecretErrorCode =
  | "ENCRYPTION_KEY_MISSING"
  | "ENCRYPTION_KEY_INVALID"
  | "ENCRYPT_FAILED"
  | "DECRYPT_FAILED"
  | "NOT_ENCRYPTED";

export class SettingsSecretError extends Error {
  readonly code: SettingsSecretErrorCode;
  constructor(code: SettingsSecretErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "SettingsSecretError";
    this.code = code;
  }
}

/** True when `value` looks like an `enc:v1:` envelope (prefix check only). */
export function isEncryptedSettingValue(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(ENVELOPE_PREFIX);
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  if (value.length === 0 || value.length % 4 !== 0 || !BASE64_RE.test(value)) {
    throw new SettingsSecretError("DECRYPT_FAILED", "malformed envelope encoding");
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new SettingsSecretError("DECRYPT_FAILED", "undecodable envelope encoding");
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Import the data-encryption key from the environment. Imported on every call
 * (no cache) so key rotation via env redeploy is always honored and tests can
 * vary the environment per case. The key value NEVER appears in errors.
 */
async function importDataKey(): Promise<CryptoKey> {
  const raw = process.env[KEY_ENV_NAME];
  if (typeof raw !== "string" || raw.length === 0) {
    throw new SettingsSecretError(
      "ENCRYPTION_KEY_MISSING",
      `${KEY_ENV_NAME} is not set in the server environment`
    );
  }
  if (!HEX_64_RE.test(raw)) {
    throw new SettingsSecretError(
      "ENCRYPTION_KEY_INVALID",
      `${KEY_ENV_NAME} must be 64 hex chars (32 bytes)`
    );
  }
  try {
    return await crypto.subtle.importKey(
      "raw",
      hexToBytes(raw) as BufferSource,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  } catch {
    throw new SettingsSecretError("ENCRYPTION_KEY_INVALID", "key import failed");
  }
}

/** Encrypt a non-empty plaintext secret. Returns the `enc:v1:` envelope. */
export async function encryptSettingValue(plaintext: string): Promise<string> {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new SettingsSecretError("ENCRYPT_FAILED", "plaintext must be a non-empty string");
  }
  const key = await importDataKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  try {
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      encoder.encode(plaintext) as BufferSource
    );
    return `${ENVELOPE_PREFIX}${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(ct))}`;
  } catch {
    throw new SettingsSecretError("ENCRYPT_FAILED", "encryption operation failed");
  }
}

/**
 * Decrypt an `enc:v1:` envelope back to plaintext. Fails closed on any
 * malformed envelope, wrong key or tampering (GCM tag mismatch) — the caller
 * must treat the stored secret as unusable, never fall back to plaintext.
 */
export async function decryptSettingValue(envelope: string): Promise<string> {
  if (!isEncryptedSettingValue(envelope)) {
    throw new SettingsSecretError("NOT_ENCRYPTED", "value is not an encrypted envelope");
  }
  const parts = envelope.slice(ENVELOPE_PREFIX.length).split(".");
  if (parts.length !== 2) {
    throw new SettingsSecretError("DECRYPT_FAILED", "malformed envelope structure");
  }
  const iv = base64ToBytes(parts[0]);
  const ct = base64ToBytes(parts[1]);
  if (iv.length !== 12) {
    throw new SettingsSecretError("DECRYPT_FAILED", "malformed envelope IV");
  }
  const key = await importDataKey();
  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      ct as BufferSource
    );
    return decoder.decode(pt);
  } catch (e) {
    if (e instanceof SettingsSecretError) throw e;
    throw new SettingsSecretError("DECRYPT_FAILED", "decryption failed (wrong key or tampered data)");
  }
}
