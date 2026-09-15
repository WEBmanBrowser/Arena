/**
 * Backoffice Eupago configuration (dedicated routes — secrets NEVER flow
 * through the generic `/api/admin/settings` key/value loop).
 *
 *  GET  (manager+)        → presence/metadata view only. NEVER secret values
 *                            or fragments (D4: presence-only).
 *  PUT  (admin + CSRF)    → strict allowlist partial update; `null` clears a
 *                            field; unknown fields / empty secrets → 400.
 *                            Secrets are encrypted before any DB write.
 *
 * Both handlers are Backoffice-authenticated; mutations are audit-logged with
 * FIELD NAMES only (never values). CSRF uses the project-standard `csrfGuard`.
 */
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser, isAdmin, isManager } from "@/lib/auth";
import { csrfGuard } from "@/lib/csrf";
import { createAuditLog } from "@/lib/audit";
import {
  EupagoConfigValidationError,
  getEupagoConfigStatus,
  saveEupagoBackofficeConfig,
} from "@/lib/services/eupago-config-service";
import { SettingsSecretError } from "@/lib/settings-secrets";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sessão requerida" }, { status: 401 });
  if (!isManager(user.role)) {
    return NextResponse.json({ error: "Não autorizado" }, { status: 403 });
  }
  const status = await getEupagoConfigStatus();
  return NextResponse.json(status);
}

export async function PUT(req: NextRequest) {
  const csrf = csrfGuard(req);
  if (csrf) return csrf;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sessão requerida" }, { status: 401 });
  if (!isAdmin(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
  }

  try {
    const { updated, cleared } = await saveEupagoBackofficeConfig(body);
    await createAuditLog({
      userId: user.id,
      action: "eupago_config_updated",
      entity: "settings",
      details: { fields: updated, cleared },
      ipAddress: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim(),
    });
    const status = await getEupagoConfigStatus();
    return NextResponse.json({ ok: true, updated, cleared, status });
  } catch (e) {
    if (e instanceof EupagoConfigValidationError) {
      return NextResponse.json({ error: e.code, field: e.field }, { status: 400 });
    }
    if (e instanceof SettingsSecretError) {
      // Encryption key unavailable/misconfigured — server-side config issue.
      // The code is safe metadata; the key value is never included.
      return NextResponse.json({ error: "EUPAGO_ENCRYPTION_UNAVAILABLE" }, { status: 500 });
    }
    throw e;
  }
}
