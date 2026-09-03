/**
 * C.3.1 — Signed preview/apply token for supplier imports.
 *
 * Same HMAC construction and same secret as the bulk price / recalculation
 * tokens in src/lib/bulk-pricing.ts — one crypto scheme, not two.
 *
 * What it binds: the import id, the supplier, the SHA-256 of the file and the
 * snapshot size, under an action-specific `kind`. So the browser cannot:
 *  - apply an import nobody previewed;
 *  - apply supplier A's preview against supplier B;
 *  - apply an old preview after the file was re-uploaded (hash/rows differ);
 *  - reuse a bulk-price or recalculation token here (different `kind`).
 *
 * The token carries NO financial values: prices, costs and stock come from the
 * persisted snapshot in supplier_import_rows. It is only the proof that this
 * exact snapshot was shown to the operator.
 */
import { createHmac, timingSafeEqual } from "crypto";
import { getPreviewSecret } from "@/lib/bulk-pricing";
import { SUPPLIER_IMPORT_TOKEN_TTL_MS } from "./constants";

export const SUPPLIER_IMPORT_TOKEN_KIND = "supplier_import_apply";

export interface SupplierImportTokenPayload {
  v: 1;
  kind: typeof SUPPLIER_IMPORT_TOKEN_KIND;
  importId: number;
  supplierId: number;
  fileHash: string;
  rowCount: number;
  iat: number;
  exp: number;
}

export function createSupplierImportToken(input: {
  importId: number;
  supplierId: number;
  fileHash: string;
  rowCount: number;
}): string {
  const payload: SupplierImportTokenPayload = {
    v: 1,
    kind: SUPPLIER_IMPORT_TOKEN_KIND,
    importId: input.importId,
    supplierId: input.supplierId,
    fileHash: input.fileHash,
    rowCount: input.rowCount,
    iat: Date.now(),
    exp: Date.now() + SUPPLIER_IMPORT_TOKEN_TTL_MS,
  };
  const json = JSON.stringify(payload);
  const sig = createHmac("sha256", getPreviewSecret()).update(json).digest("hex");
  return Buffer.from(`${json}.${sig}`).toString("base64url");
}

export interface SupplierImportTokenCheck {
  valid: boolean;
  expired?: boolean;
  payload?: SupplierImportTokenPayload;
}

/** Signature + shape only. Whether the payload matches the stored import is the
 *  service's job (it re-reads the import row). */
export function verifySupplierImportToken(token: string): SupplierImportTokenCheck {
  try {
    const decoded = Buffer.from(token, "base64url").toString();
    const dotIdx = decoded.lastIndexOf(".");
    if (dotIdx < 0) return { valid: false };
    const json = decoded.slice(0, dotIdx);
    const sig = decoded.slice(dotIdx + 1);
    const expected = createHmac("sha256", getPreviewSecret()).update(json).digest("hex");
    if (sig.length !== expected.length) return { valid: false };
    if (!timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"))) return { valid: false };

    const payload = JSON.parse(json) as SupplierImportTokenPayload;
    if (payload.v !== 1 || payload.kind !== SUPPLIER_IMPORT_TOKEN_KIND) return { valid: false };
    if (typeof payload.importId !== "number" || typeof payload.fileHash !== "string") return { valid: false };
    if (Date.now() > payload.exp) return { valid: false, expired: true, payload };
    return { valid: true, expired: false, payload };
  } catch {
    return { valid: false };
  }
}

/** True when the token describes exactly this persisted import. */
export function tokenMatchesImport(
  payload: SupplierImportTokenPayload,
  snapshot: { id: number; supplierId: number; fileHash: string; rowCount: number }
): boolean {
  return (
    payload.importId === snapshot.id &&
    payload.supplierId === snapshot.supplierId &&
    payload.fileHash === snapshot.fileHash &&
    payload.rowCount === snapshot.rowCount
  );
}
