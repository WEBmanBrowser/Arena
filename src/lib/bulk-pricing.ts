/**
 * Shared bulk pricing calculator + HMAC-signed preview token.
 * Token binds: operation, value, product IDs, old prices, timestamp.
 * Apply extracts everything from the token — browser cannot override.
 */
import { toCents, toEuros } from "./money";
import { createHmac, timingSafeEqual } from "crypto";

export type BulkPriceOp = "percent_increase" | "percent_decrease" | "fixed_increase" | "fixed_decrease";
export const VALID_OPS: BulkPriceOp[] = ["percent_increase", "percent_decrease", "fixed_increase", "fixed_decrease"];
export const PREVIEW_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes

export interface BulkPriceResult {
  productId: number; name: string; sku: string | null;
  currentPrice: string; newPrice: string; diffCents: number; invalid: boolean;
}

/** Calculate new prices — used by BOTH preview and apply */
export function calculateBulkPriceChanges(
  products: Array<{ id: number; name: string; sku: string | null; price: string }>,
  operation: BulkPriceOp, value: number
): BulkPriceResult[] {
  return products.map(p => {
    const cur = toCents(p.price);
    let nc: number;
    switch (operation) {
      case "percent_increase": nc = Math.round(cur * (1 + value / 100)); break;
      case "percent_decrease": nc = Math.round(cur * (1 - value / 100)); break;
      case "fixed_increase": nc = cur + toCents(value); break;
      case "fixed_decrease": nc = cur - toCents(value); break;
      default: nc = cur;
    }
    return { productId: p.id, name: p.name, sku: p.sku, currentPrice: p.price, newPrice: nc < 0 ? p.price : toEuros(nc), diffCents: nc - cur, invalid: nc < 0 };
  });
}

// ── Token ─────────────────────────────────────────────────

interface TokenPayload {
  v: 1;
  op: BulkPriceOp;
  val: number;
  products: Array<{ id: number; price: string }>;
  iat: number;
  exp: number;
}

function getSecret(): string {
  return getPreviewSecret();
}

/**
 * Shared HMAC secret for every signed preview token (bulk prices, C.2 recalc,
 * C.3.1 supplier import). Exported so new preview/apply flows reuse this exact
 * scheme instead of introducing a second one.
 */
export function getPreviewSecret(): string {
  const s = process.env.BULK_PREVIEW_SECRET;
  if (!s || s.length < 32) throw new Error("BULK_PREVIEW_SECRET_NOT_CONFIGURED");
  return s;
}

export function createPreviewToken(operation: BulkPriceOp, value: number, products: Array<{ id: number; price: string }>): string {
  const secret = getSecret();
  const payload: TokenPayload = { v: 1, op: operation, val: value, products, iat: Date.now(), exp: Date.now() + PREVIEW_EXPIRY_MS };
  const json = JSON.stringify(payload);
  const sig = createHmac("sha256", secret).update(json).digest("hex");
  return Buffer.from(json + "." + sig).toString("base64url");
}

export function verifyPreviewToken(token: string): { valid: boolean; expired?: boolean; staleReason?: string; data?: TokenPayload } {
  try {
    const decoded = Buffer.from(token, "base64url").toString();
    const dotIdx = decoded.lastIndexOf(".");
    if (dotIdx < 0) return { valid: false };
    const json = decoded.substring(0, dotIdx);
    const sig = decoded.substring(dotIdx + 1);
    const secret = getSecret();
    const expected = createHmac("sha256", secret).update(json).digest("hex");
    // Timing-safe comparison
    if (sig.length !== expected.length) return { valid: false };
    const sigBuf = Buffer.from(sig, "hex");
    const expBuf = Buffer.from(expected, "hex");
    if (!timingSafeEqual(sigBuf, expBuf)) return { valid: false };
    const data: TokenPayload = JSON.parse(json);
    if (data.v !== 1) return { valid: false };
    if (Date.now() > data.exp) return { valid: true, expired: true, data };
    return { valid: true, expired: false, data };
  } catch {
    return { valid: false };
  }
}

// ── C.2: recalculation preview token ──────────────────────
// Same HMAC construction and same secret as the bulk price token above, but a
// different payload: the automatic engine binds the RESULTING prices, not an
// operation. Reusing the signing primitives avoids a second crypto scheme.

export interface RecalcTokenLine {
  /** Product id */
  i: number;
  /** Price observed at preview time — apply refuses if it moved. */
  o: string;
  /** New price the preview showed the operator. */
  n: string;
  /** Rule that produced it, for the audit trail. */
  r: number | null;
}

interface RecalcTokenPayload {
  v: 1;
  kind: "recalc";
  lines: RecalcTokenLine[];
  /** Number of lines whose price goes DOWN — apply requires explicit consent. */
  down: number;
  iat: number;
  exp: number;
}

export function createRecalcToken(lines: RecalcTokenLine[], down: number): string {
  const secret = getSecret();
  const payload: RecalcTokenPayload = {
    v: 1, kind: "recalc", lines, down,
    iat: Date.now(), exp: Date.now() + PREVIEW_EXPIRY_MS,
  };
  const json = JSON.stringify(payload);
  const sig = createHmac("sha256", secret).update(json).digest("hex");
  return Buffer.from(json + "." + sig).toString("base64url");
}

export function verifyRecalcToken(token: string): {
  valid: boolean;
  expired?: boolean;
  data?: RecalcTokenPayload;
} {
  try {
    const decoded = Buffer.from(token, "base64url").toString();
    const dotIdx = decoded.lastIndexOf(".");
    if (dotIdx < 0) return { valid: false };
    const json = decoded.substring(0, dotIdx);
    const sig = decoded.substring(dotIdx + 1);
    const secret = getSecret();
    const expected = createHmac("sha256", secret).update(json).digest("hex");
    if (sig.length !== expected.length) return { valid: false };
    if (!timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"))) return { valid: false };
    const data: RecalcTokenPayload = JSON.parse(json);
    // A bulk-price token must not be accepted here, and vice versa.
    if (data.v !== 1 || data.kind !== "recalc") return { valid: false };
    if (Date.now() > data.exp) return { valid: true, expired: true, data };
    return { valid: true, expired: false, data };
  } catch {
    return { valid: false };
  }
}
