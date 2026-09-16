/**
 * "Testar ligação" — live Eupago connectivity probe (admin + CSRF).
 *
 * Uses the EFFECTIVE credentials (Backoffice-complete or ENV, same atomic
 * rule as the payment runtime) for a single OAuth `client_credentials` call.
 * That endpoint is side-effect-free: it proves reachability + client
 * credentials + environment correctness WITHOUT creating any payment, refund
 * or reference.
 *
 *  - Incomplete/unreadable config → 400, NO network call is attempted.
 *  - Success → `{ ok: true, environment, latencyMs }`.
 *  - Provider/transport failure → 502 `{ ok: false, error, reason? }`.
 *
 * The access token obtained is NEVER returned, logged or persisted (the
 * provider module keeps it in-memory only, by design). The API key and
 * webhook key are presence-checked, not live-probed — no side-effect-free
 * probe exists for them. Every attempt is audit-logged (outcome only).
 */
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser, isAdmin } from "@/lib/auth";
import { csrfGuard } from "@/lib/csrf";
import { createAuditLog } from "@/lib/audit";
import { isProviderError } from "@/lib/providers/errors";
import { getEupagoAccessToken } from "@/lib/providers/eupago/client";
import {
  getEupagoConfigStatus,
  recordEupagoConnectionTest,
  resolveEupagoConfig,
} from "@/lib/services/eupago-config-service";

const TEST_TIMEOUT_MS = 10_000;

export async function POST(req: NextRequest) {
  const csrf = csrfGuard(req);
  if (csrf) return csrf;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sessão requerida" }, { status: 401 });
  if (!isAdmin(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

  const ipAddress = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();

  // Effective config only — incomplete/unreadable → no network call.
  let config;
  try {
    config = await resolveEupagoConfig();
  } catch (e) {
    if (isProviderError(e) && e.code === "PROVIDER_UNAVAILABLE") {
      const status = await getEupagoConfigStatus().catch(() => null);
      return NextResponse.json(
        { ok: false, error: "EUPAGO_CONFIG_INCOMPLETE", config: status },
        { status: 400 }
      );
    }
    throw e;
  }

  const started = Date.now();
  try {
    const result = await getEupagoAccessToken({
      environment: config.environment,
      clientId: config.oauthClientId,
      clientSecret: config.oauthClientSecret,
      timeoutMs: TEST_TIMEOUT_MS,
    });
    const latencyMs = Date.now() - started;
    if (result.kind === "ok") {
      await recordEupagoConnectionTest({
        ok: true,
        environment: config.environment,
        latencyMs,
      });
      await createAuditLog({
        userId: user.id,
        action: "eupago_connection_tested",
        entity: "settings",
        details: { environment: config.environment, ok: true },
        ipAddress,
      });
      return NextResponse.json({ ok: true, environment: config.environment, latencyMs });
    }
    await recordEupagoConnectionTest({
      ok: false,
      environment: config.environment,
      latencyMs,
    });
    await createAuditLog({
      userId: user.id,
      action: "eupago_connection_tested",
      entity: "settings",
      details: { environment: config.environment, ok: false, reason: result.reason },
      ipAddress,
    });
    return NextResponse.json(
      {
        ok: false,
        error: "EUPAGO_CONNECTION_FAILED",
        reason: result.reason,
        environment: config.environment,
      },
      { status: 502 }
    );
  } catch {
    // Transport-level throw (network down, DNS, …): safe generic error only.
    // No provider internals, no credentials, no token in the response or logs.
    await recordEupagoConnectionTest({
      ok: false,
      environment: config.environment,
    }).catch(() => {});
    await createAuditLog({
      userId: user.id,
      action: "eupago_connection_tested",
      entity: "settings",
      details: { environment: config.environment, ok: false, reason: "transport_error" },
      ipAddress,
    }).catch(() => {});
    return NextResponse.json(
      { ok: false, error: "EUPAGO_CONNECTION_FAILED", environment: config.environment },
      { status: 502 }
    );
  }
}
