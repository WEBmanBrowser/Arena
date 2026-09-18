import { db } from "@/db";
import { auditLogs } from "@/db/schema";

/**
 * Record an administrative action in the audit log.
 * Call AFTER transaction commits — audit log failure should not block operations.
 */
export async function createAuditLog(params: {
  userId: number | null;
  action: string;
  entity?: string;
  entityId?: number;
  details?: Record<string, unknown>;
  ipAddress?: string;
}): Promise<void> {
  try {
    // Strip sensitive fields from details
    const safeDetails = params.details ? sanitizeDetails(params.details) : undefined;

    await db.insert(auditLogs).values({
      userId: params.userId,
      action: params.action,
      entity: params.entity || null,
      entityId: params.entityId || null,
      details: safeDetails || null,
      ipAddress: params.ipAddress || null,
    });
  } catch (e) {
    // Audit log failure should NOT crash the application
    console.error("Audit log error:", e);
  }
}

/**
 * PAYMENT P0 (item 21) — MANDATORY financial audit INSIDE the transaction.
 *
 * `createAuditLog()` is deliberately best-effort (it swallows its own errors so
 * an audit outage never blocks a normal operation). That is the wrong trade-off
 * on a financial path: if the money movement commits, its audit record must
 * commit with it. This variant therefore:
 *   • runs on the caller's transaction handle (commit/rollback together), and
 *   • does NOT swallow errors — a failure aborts the financial transaction.
 *
 * Details are sanitized with the same rule as the best-effort variant, and the
 * P0 callers only ever pass identifiers, integer cents, currency codes and
 * sanitized reason codes (never tokens, signatures, payloads or credentials).
 */
export async function createAuditLogTx(
  tx: any,
  params: {
    userId: number | null;
    action: string;
    entity?: string;
    entityId?: number;
    details?: Record<string, unknown>;
    ipAddress?: string;
  }
): Promise<void> {
  const safeDetails = params.details ? sanitizeDetails(params.details) : undefined;
  await tx.insert(auditLogs).values({
    userId: params.userId,
    action: params.action,
    entity: params.entity || null,
    entityId: params.entityId || null,
    details: safeDetails || null,
    ipAddress: params.ipAddress || null,
  });
}

function sanitizeDetails(details: Record<string, unknown>): Record<string, unknown> {
  const sensitive = ["password", "token", "secret", "apiKey", "api_key", "creditCard", "cvv"];
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (sensitive.some(s => key.toLowerCase().includes(s.toLowerCase()))) {
      clean[key] = "[REDACTED]";
    } else {
      clean[key] = value;
    }
  }
  return clean;
}
