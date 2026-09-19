/**
 * Pure payload-building and dirty-checking logic for the Eupago backoffice settings page.
 *
 * Client-safe (no server-only imports, no DB access).
 *
 * Business Rules:
 *  1. If `storedEnvironment === null`, the UI defaults visually to "sandbox".
 *  2. On the FIRST save that touches ANY core field (e.g. apiKey, oauthClientId,
 *     oauthClientSecret, webhookKey):
 *     - If the user did NOT change the dropdown (env === null), the payload MUST
 *       explicitly include `environment: "sandbox"`.
 *     - If the user selected "production", the payload sends `environment: "production"`.
 *     - If the user explicitly selected "sandbox", it sends `environment: "sandbox"`.
 *  3. Once `storedEnvironment` already exists in the Backoffice:
 *     - A metadata-only save (e.g. webhookEndpoint, webhookEncryption, webhookTypes)
 *       MUST NOT send `environment` unnecessarily.
 *     - An update to core secrets without changing the dropdown does not re-send
 *       `environment`.
 *     - Only when `env !== null && env !== storedEnvironment` is `environment: env` sent.
 *  4. Empty secret strings are filtered out (left empty to keep existing).
 */

export const CORE_SECRET_FIELDS = [
  "apiKey",
  "oauthClientId",
  "oauthClientSecret",
  "webhookKey",
] as const;

export type CoreSecretField = (typeof CORE_SECRET_FIELDS)[number];

export interface SavePayloadInput {
  secrets?: Record<string, string>;
  env?: string | null;
  endpoint?: string | null;
  encryption?: boolean | null;
  types?: string[] | null;
  storedEnvironment?: string | null;
  storedEndpoint?: string | null;
  storedEncryption?: boolean | null;
  storedTypes?: string[] | null;
}

export interface IsDirtyInput {
  secrets?: Record<string, string>;
  env?: string | null;
  endpoint?: string | null;
  encryption?: boolean | null;
  types?: string[] | null;
  storedEnvironment?: string | null;
  storedEndpoint?: string | null;
  storedEncryption?: boolean | null;
  storedTypes?: string[] | null;
}

/**
 * Check if the input contains any non-empty core secret or an explicit environment selection.
 */
export function hasCoreFieldChanges(
  secrets: Record<string, string> = {},
  env: string | null = null,
  storedEnvironment: string | null = null
): boolean {
  const hasSecret = CORE_SECRET_FIELDS.some(
    (field) => typeof secrets[field] === "string" && secrets[field].length > 0
  );
  if (hasSecret) return true;
  if (env !== null && env !== storedEnvironment) return true;
  return false;
}

/**
 * Build the JSON payload to PUT to /api/admin/settings/eupago.
 */
export function buildSavePayload(input: SavePayloadInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  const secrets = input.secrets ?? {};

  // 1. Secrets (only non-empty strings are transmitted)
  let hasCoreSecret = false;
  for (const [k, v] of Object.entries(secrets)) {
    if (typeof v === "string" && v.length > 0) {
      payload[k] = v;
      if (CORE_SECRET_FIELDS.includes(k as CoreSecretField)) {
        hasCoreSecret = true;
      }
    }
  }

  // 2. Environment logic
  const storedEnv = input.storedEnvironment ?? null;
  const chosenEnv = input.env ?? null;

  if (chosenEnv !== null) {
    // User explicitly interacted with the dropdown
    if (storedEnv === null) {
      payload.environment = chosenEnv;
    } else if (chosenEnv !== storedEnv) {
      payload.environment = chosenEnv;
    }
  } else {
    // User did NOT touch the dropdown (chosenEnv === null)
    // If storedEnvironment is null and we are saving any core secret,
    // default visually displayed "sandbox" must be persisted explicitly.
    if (storedEnv === null && hasCoreSecret) {
      payload.environment = "sandbox";
    }
  }

  // 3. Webhook endpoint
  const storedEndpoint = input.storedEndpoint ?? "";
  if (input.endpoint !== null && input.endpoint !== undefined && input.endpoint !== storedEndpoint) {
    if (input.endpoint.trim().length > 0) {
      payload.webhookEndpoint = input.endpoint;
    }
  }

  // 4. Webhook encryption
  const storedEncryption = input.storedEncryption ?? false;
  if (
    input.encryption !== null &&
    input.encryption !== undefined &&
    input.encryption !== storedEncryption
  ) {
    payload.webhookEncryption = input.encryption;
  }

  // 5. Webhook event types
  const storedTypes = input.storedTypes ?? [];
  if (input.types !== null && input.types !== undefined) {
    const sortedCurrent = [...input.types].sort();
    const sortedStored = [...storedTypes].sort();
    if (JSON.stringify(sortedCurrent) !== JSON.stringify(sortedStored)) {
      payload.webhookTypes = input.types;
    }
  }

  return payload;
}

/**
 * Determine whether the form has unsaved modifications.
 */
export function isFormDirty(input: IsDirtyInput): boolean {
  const secrets = input.secrets ?? {};
  const hasSecrets = Object.values(secrets).some(
    (v) => typeof v === "string" && v.length > 0
  );
  if (hasSecrets) return true;

  const currentEffectiveDefault = input.storedEnvironment ?? "sandbox";
  if (input.env !== null && input.env !== undefined && input.env !== currentEffectiveDefault) {
    return true;
  }

  const storedEndpoint = input.storedEndpoint ?? "";
  if (
    input.endpoint !== null &&
    input.endpoint !== undefined &&
    input.endpoint !== storedEndpoint
  ) {
    return true;
  }

  const storedEncryption = input.storedEncryption ?? false;
  if (
    input.encryption !== null &&
    input.encryption !== undefined &&
    input.encryption !== storedEncryption
  ) {
    return true;
  }

  const storedTypes = input.storedTypes ?? [];
  if (input.types !== null && input.types !== undefined) {
    const sortedCurrent = [...input.types].sort();
    const sortedStored = [...storedTypes].sort();
    if (JSON.stringify(sortedCurrent) !== JSON.stringify(sortedStored)) {
      return true;
    }
  }

  return false;
}
