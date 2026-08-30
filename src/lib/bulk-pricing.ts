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
