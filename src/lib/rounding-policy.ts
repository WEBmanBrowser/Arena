/**
 * C.1 — Configurable commercial rounding policy.
 *
 * The bands live in `settings` (key/value), NOT hardcoded in the engine and
 * NOT in a dedicated table: they are a single global configuration with no
 * foreign keys, so a settings row is the right weight and needs no migration.
 *
 * The engine reads the policy once per calculation batch; the backoffice will
 * be able to edit it in C.2 without any code change.
 */
import { db } from "@/db";
import { settings } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  DEFAULT_ROUNDING_POLICY,
  validateRoundingPolicy,
  type RoundingPolicy,
} from "@/lib/pricing-calculator";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

export const ROUNDING_POLICY_KEY = "pricing_rounding_policy";
export const ROUNDING_POLICY_GROUP = "pricing";

type QueryDb = NodePgDatabase | typeof db;

/**
 * Read the configured policy.
 *
 * Any absent/corrupt/invalid value falls back to the documented default rather
 * than throwing: a bad settings row must never make the catalogue unpriceable.
 */
export async function getRoundingPolicy(database: QueryDb = db): Promise<RoundingPolicy> {
  try {
    const [row] = await (database as typeof db)
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, ROUNDING_POLICY_KEY))
      .limit(1);
    if (!row?.value) return DEFAULT_ROUNDING_POLICY;

    const parsed = JSON.parse(row.value) as RoundingPolicy;
    if (typeof parsed?.enabled !== "boolean" || !Array.isArray(parsed?.bands)) {
      return DEFAULT_ROUNDING_POLICY;
    }
    validateRoundingPolicy(parsed);
    return parsed;
  } catch {
    return DEFAULT_ROUNDING_POLICY;
  }
}

/** Persist the default policy if none exists yet. Idempotent. */
export async function ensureRoundingPolicy(database: QueryDb = db): Promise<void> {
  await (database as typeof db)
    .insert(settings)
    .values({
      key: ROUNDING_POLICY_KEY,
      value: JSON.stringify(DEFAULT_ROUNDING_POLICY),
      group: ROUNDING_POLICY_GROUP,
    })
    .onConflictDoNothing();
}

/** Replace the policy. Validates before writing so bad bands cannot be stored. */
export async function saveRoundingPolicy(policy: RoundingPolicy): Promise<void> {
  validateRoundingPolicy(policy);
  await ensureRoundingPolicy();
  await db
    .update(settings)
    .set({ value: JSON.stringify(policy) })
    .where(eq(settings.key, ROUNDING_POLICY_KEY));
}
