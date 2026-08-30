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
