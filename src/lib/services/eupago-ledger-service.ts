/**
 * PAYMENT P0 (items 17/18/19 + B1) — Eupago ledger environment, migration
 * readiness and canonical payment provisioning.
 *
 * LEDGER ENVIRONMENT (item 18)
 *  A single ledger must never contain references that belong to two different
 *  Eupago environments: a sandbox `trid` can never settle production money and
 *  vice-versa. The environment the ledger was PROVISIONED against is therefore
 *  recorded once, in the internal settings key `eupago_ledger_environment`
 *  (group `eupago`).
 *
 *  That key is INTERNAL: it is not part of `ALL_KEYS` in
 *  `eupago-config-service`, so the Backoffice can neither read nor write it, the
 *  generic `/api/admin/settings` route rejects every `eupago_*` key, and no
 *  administrator can flip the ledger environment with a form post. The runtime
 *  sets it exactly once, on the first Eupago payment of a virgin ledger.
 *
 * UNKNOWN HISTORY IS FAIL-CLOSED (item 19)
 *  A recorded-but-unreadable ledger environment, or a recorded environment that
 *  no longer matches the effective runtime environment, makes Eupago
 *  unavailable. The integration never "assumes" an environment.
 *
 * MIGRATION READINESS (B1 rollout)
 *  The new code depends on 0017 (`payment_attempts.payment_id`,
 *  `operation_revision`, `email_notifications.dispatch_started_at` and the guard
 *  triggers). `assertEupagoLedgerReady()` verifies the migration is installed
 *  before any financial write, so the rollout order (0017 FIRST, then this code)
 *  is enforced at runtime instead of being a deployment convention.
 */

import { db } from "@/db";
import { paymentAttempts, payments, settings } from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { ProviderError } from "@/lib/providers/errors";
import {
  EUPAGO_PROVIDER_ID,
  resolveEupagoEnvironment,
  type EupagoEnvironment,
} from "@/lib/providers/eupago/config";
import type { DbOrTx } from "@/lib/stock-locks";

/** INTERNAL key — deliberately NOT part of the Backoffice-editable block. */
export const EUPAGO_LEDGER_ENVIRONMENT_KEY = "eupago_ledger_environment";

export type LedgerEnvironmentResolution =
  | {
      readonly status: "ready";
      readonly environment: EupagoEnvironment;
      /** `ledger` = recorded history, `runtime` = provisioned by this call. */
      readonly origin: "ledger" | "runtime";
    }
  | { readonly status: "unavailable"; readonly code: string };

function isEupagoEnvironment(value: unknown): value is EupagoEnvironment {
  return value === "sandbox" || value === "production";
}

/**
 * Effective runtime environment, using the SAME precedence the provider uses:
 * the Backoffice core `eupago_environment` value when an operator stored one,
 * otherwise `EUPAGO_ENVIRONMENT` (which defaults to `sandbox`, exactly like
 * `resolveEupagoEnvironment()`).
 *
 * This deliberately does NOT depend on credential completeness: the ledger
 * environment is about environment CONSISTENCY (sandbox references must never
 * meet production money), not about whether the API keys are filled in yet.
 * An explicitly stored but invalid environment is UNKNOWN history → fail closed,
 * never silently replaced by the env default.
 */
async function resolveRuntimeEnvironment(executor: DbOrTx = db): Promise<EupagoEnvironment | null> {
  const [stored] = await executor
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, "eupago_environment"))
    .limit(1);

  if (stored && stored.value !== null) {
    return isEupagoEnvironment(stored.value) ? stored.value : null;
  }

  try {
    return resolveEupagoEnvironment();
  } catch {
    return null;
  }
}

/**
 * Resolve (and, on a virgin ledger, provision) the ledger environment.
 *
 * Either returns ONE consistent environment or fails closed with a code.
 */
export async function resolveEupagoLedgerEnvironment(
  executor: DbOrTx = db
): Promise<LedgerEnvironmentResolution> {
  const runtime = await resolveRuntimeEnvironment(executor);
  if (!runtime) return { status: "unavailable", code: "EUPAGO_ENVIRONMENT_UNKNOWN" };

  const [row] = await executor
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, EUPAGO_LEDGER_ENVIRONMENT_KEY))
    .limit(1);

  if (row) {
    // Recorded history: a value that is not an environment is UNREADABLE history.
    if (!isEupagoEnvironment(row.value)) {
      return { status: "unavailable", code: "LEDGER_ENVIRONMENT_UNREADABLE" };
    }
    if (row.value !== runtime) {
      return { status: "unavailable", code: "LEDGER_ENVIRONMENT_MISMATCH" };
    }
    return { status: "ready", environment: row.value, origin: "ledger" };
  }

  // Virgin ledger: only provision when there is no Eupago history at all.
  const history = await probeEupagoLedgerHistory(executor);
  if (history.unknownEnvironment) {
    return { status: "unavailable", code: "LEDGER_HISTORY_ENVIRONMENT_UNKNOWN" };
  }
  if (history.any) {
    // Existing Eupago rows without a recorded ledger environment is exactly the
    // non-virgin case B1 says must STOP and get a dedicated cutover plan.
    return { status: "unavailable", code: "LEDGER_ENVIRONMENT_NOT_RECORDED_FOR_EXISTING_HISTORY" };
  }

  const inserted = await executor
    .insert(settings)
    .values({ key: EUPAGO_LEDGER_ENVIRONMENT_KEY, value: runtime, group: "eupago" })
    .onConflictDoNothing({ target: settings.key })
    .returning({ value: settings.value });

  if (inserted.length > 0) return { status: "ready", environment: runtime, origin: "runtime" };

  // Lost the race: re-read the committed value and apply the same rules.
  return resolveEupagoLedgerEnvironment(executor);
}

export interface LedgerHistoryProbe {
  readonly any: boolean;
  readonly unknownEnvironment: boolean;
}

/**
 * READ-ONLY probe over the Eupago ledger (also used by the rollout diagnostic
 * script). Reports whether Eupago history exists and whether any of it carries
 * an unknown/absent environment context.
 */
export async function probeEupagoLedgerHistory(executor: DbOrTx = db): Promise<LedgerHistoryProbe> {
  const [attemptsRow] = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(paymentAttempts)
    .where(eq(paymentAttempts.provider, EUPAGO_PROVIDER_ID));

  const [paymentsRow] = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(payments)
    .where(eq(payments.provider, EUPAGO_PROVIDER_ID));

  const [unknownRow] = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(payments)
    .where(
      and(
        eq(payments.provider, EUPAGO_PROVIDER_ID),
        sql`(${payments.metadata} ->> 'eupagoEnvironment') IS DISTINCT FROM 'sandbox'
            AND (${payments.metadata} ->> 'eupagoEnvironment') IS DISTINCT FROM 'production'`
      )
    );

  const attempts = attemptsRow?.count ?? 0;
  const providerPayments = paymentsRow?.count ?? 0;
  return { any: attempts > 0 || providerPayments > 0, unknownEnvironment: (unknownRow?.count ?? 0) > 0 };
}

// ─── Migration readiness (B1 rollout enforcement) ─────────

const REQUIRED_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
  { table: "payment_attempts", column: "payment_id" },
  { table: "payment_attempts", column: "operation_revision" },
  { table: "refund_attempts", column: "operation_revision" },
  { table: "email_notifications", column: "dispatch_started_at" },
];

const REQUIRED_TRIGGERS: readonly string[] = [
  "payment_attempts_identity_guard",
  "refund_attempts_payment_binding_guard",
];

let readinessCache: { ok: boolean; detail: string } | null = null;

/** Test-only reset of the per-isolate readiness cache. */
export function resetEupagoLedgerReadinessCache(): void {
  readinessCache = null;
}

async function queryRows<T>(executor: DbOrTx, query: ReturnType<typeof sql>): Promise<T[]> {
  const result = (await executor.execute(query)) as unknown as { rows?: T[] };
  return result?.rows ?? (result as unknown as T[]) ?? [];
}

/**
 * Verify that migration 0017 is actually installed.
 *
 * Called before any Eupago financial write. Cached per isolate — a
 * deployment-readiness invariant, not a per-request authorization check.
 */
export async function assertEupagoLedgerReady(executor: DbOrTx = db): Promise<void> {
  if (readinessCache?.ok) return;

  const missing: string[] = [];

  const columns = await queryRows<{ table_name: string; column_name: string }>(
    executor,
    sql`SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name IN ('payment_attempts','refund_attempts','email_notifications')`
  );
  const present = new Set(columns.map((row) => `${row.table_name}.${row.column_name}`));
  for (const requirement of REQUIRED_COLUMNS) {
    if (!present.has(`${requirement.table}.${requirement.column}`)) {
      missing.push(`${requirement.table}.${requirement.column}`);
    }
  }

  const triggers = await queryRows<{ tgname: string }>(
    executor,
    sql`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal`
  );
  const installed = new Set(triggers.map((row) => row.tgname));
  for (const trigger of REQUIRED_TRIGGERS) {
    if (!installed.has(trigger)) missing.push(`trigger:${trigger}`);
  }

  if (missing.length > 0) {
    readinessCache = { ok: false, detail: missing.join(",") };
    throw new ProviderError("PROVIDER_UNAVAILABLE", {
      provider: EUPAGO_PROVIDER_ID,
      internalDetail: `MIGRATION_REQUIRED_0017 missing: ${missing.join(",")}`,
    });
  }

  readinessCache = { ok: true, detail: "" };
}

// ─── Canonical payment provisioning (items 1/4/17) ────────

export interface CanonicalPaymentInput {
  readonly orderId: number;
  readonly method: string;
  readonly amountCents: number;
  readonly currency: string;
  readonly environment: EupagoEnvironment;
}

export type CanonicalPaymentRow = typeof payments.$inferSelect;

/**
 * Resolve (or create) the CANONICAL `payments` row a new Eupago attempt settles.
 *
 * The row carries the non-secret environment context in
 * `metadata.eupagoEnvironment` (item 17), so ledger provenance survives without
 * storing anything sensitive. The identity guard installed by 0017 then enforces
 * that the attempt agrees with this snapshot on order, integer amount and
 * currency.
 */
export async function resolveCanonicalEupagoPayment(
  tx: DbOrTx,
  input: CanonicalPaymentInput
): Promise<CanonicalPaymentRow> {
  const amount = (input.amountCents / 100).toFixed(2);

  const [existing] = await tx
    .select()
    .from(payments)
    .where(
      and(
        eq(payments.orderId, input.orderId),
        eq(payments.provider, EUPAGO_PROVIDER_ID),
        eq(payments.method, input.method),
        eq(payments.amount, amount),
        eq(payments.currency, input.currency),
        eq(payments.status, "pending")
      )
    )
    .limit(1);
  if (existing) return existing;

  const [created] = await tx
    .insert(payments)
    .values({
      orderId: input.orderId,
      provider: EUPAGO_PROVIDER_ID,
      method: input.method,
      amount,
      currency: input.currency,
      status: "pending",
      metadata: { eupagoEnvironment: input.environment },
    })
    .returning();
  return created;
}

/**
 * Provisioning entry point used by every writer of a NEW Eupago attempt:
 * readiness → ledger environment (never mixed) → canonical payment.
 */
export async function prepareEupagoLedgerContext(
  tx: DbOrTx,
  input: { orderId: number; method: string; amountCents: number; currency: string }
): Promise<{ payment: CanonicalPaymentRow; environment: EupagoEnvironment }> {
  await assertEupagoLedgerReady(tx);
  const ledger = await resolveEupagoLedgerEnvironment(tx);
  if (ledger.status !== "ready") {
    throw new ProviderError("PROVIDER_UNAVAILABLE", {
      provider: EUPAGO_PROVIDER_ID,
      internalDetail: ledger.code,
    });
  }
  const payment = await resolveCanonicalEupagoPayment(tx, { ...input, environment: ledger.environment });
  return { payment, environment: ledger.environment };
}
