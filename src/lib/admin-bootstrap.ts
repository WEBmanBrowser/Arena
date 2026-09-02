/**
 * B.5.1 — Production-safe first-administrator bootstrap.
 *
 * Used exclusively by the `npm run admin:create` CLI
 * (src/scripts/create-admin.ts). There is deliberately NO HTTP endpoint,
 * NO bootstrap table, NO schema change and NO .env writing here.
 *
 * Concurrency: a plain "count admins then insert" is racy — two concurrent
 * bootstrap runs against a zero-admin database could both observe zero and
 * both insert. We therefore serialize the whole check-then-insert inside a
 * single transaction guarded by a PostgreSQL transaction-scoped advisory
 * lock (pg_advisory_xact_lock). The lock is released automatically on
 * COMMIT/ROLLBACK, cannot leak, and exists ONLY to serialize first-admin
 * bootstrap.
 */
import { db } from "../db";
import { users } from "../db/schema";
import { eq, sql } from "drizzle-orm";
import bcryptjs from "bcryptjs";

/**
 * Fixed, application-specific advisory lock key for first-admin bootstrap.
 * Chosen once and documented here; must never be reused for another purpose.
 * (Arbitrary constant in the bigint range — "B5" + admin bootstrap.)
 */
export const ADMIN_BOOTSTRAP_LOCK_KEY = 851_000_001;

/** bcrypt cost — matches the existing repository policy (src/lib/auth.ts). */
export const BCRYPT_ROUNDS = 12;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export type AdminBootstrapErrorCode =
  | "EMAIL_REQUIRED"
  | "EMAIL_INVALID"
  | "PASSWORD_REQUIRED"
  | "PASSWORD_TOO_SHORT"
  | "PASSWORD_TOO_LONG"
  | "PASSWORD_MISSING_LOWERCASE"
  | "PASSWORD_MISSING_UPPERCASE"
  | "PASSWORD_MISSING_DIGIT"
  | "PASSWORD_MISSING_SPECIAL"
  | "ADMIN_ALREADY_EXISTS"
  | "EMAIL_ALREADY_EXISTS";

export class AdminBootstrapError extends Error {
  code: AdminBootstrapErrorCode;
  constructor(code: AdminBootstrapErrorCode, message: string) {
    super(message);
    this.name = "AdminBootstrapError";
    this.code = code;
  }
}

/** Consistent email normalization: trim + lowercase. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function validateEmail(rawEmail: unknown): string {
  if (typeof rawEmail !== "string" || rawEmail.trim() === "") {
    throw new AdminBootstrapError("EMAIL_REQUIRED", "--email is required");
  }
  const email = normalizeEmail(rawEmail);
  if (email.length > 255 || !EMAIL_RE.test(email)) {
    throw new AdminBootstrapError("EMAIL_INVALID", "--email is not a valid email address");
  }
  return email;
}

/** Password policy. Never returns or logs the password itself. */
export function validatePassword(password: unknown): string {
  if (typeof password !== "string" || password === "") {
    throw new AdminBootstrapError("PASSWORD_REQUIRED", "--password is required");
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new AdminBootstrapError("PASSWORD_TOO_SHORT", `password must be at least ${PASSWORD_MIN_LENGTH} characters`);
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw new AdminBootstrapError("PASSWORD_TOO_LONG", `password must be at most ${PASSWORD_MAX_LENGTH} characters`);
  }
  if (!/[a-z]/.test(password)) {
    throw new AdminBootstrapError("PASSWORD_MISSING_LOWERCASE", "password must contain a lowercase letter");
  }
  if (!/[A-Z]/.test(password)) {
    throw new AdminBootstrapError("PASSWORD_MISSING_UPPERCASE", "password must contain an uppercase letter");
  }
  if (!/[0-9]/.test(password)) {
    throw new AdminBootstrapError("PASSWORD_MISSING_DIGIT", "password must contain a digit");
  }
  if (!/[^A-Za-z0-9]/.test(password)) {
    throw new AdminBootstrapError("PASSWORD_MISSING_SPECIAL", "password must contain a special character");
  }
  return password;
}

export interface CreateFirstAdminInput {
  email: string;
  password: string;
  name?: string;
}

export interface CreateFirstAdminResult {
  id: number;
  email: string;
  role: "admin";
}

/**
 * Create the FIRST administrator. Refuses if any admin already exists or if
 * the requested email is already taken. Role is hardcoded to "admin".
 */
export async function createFirstAdmin(input: CreateFirstAdminInput): Promise<CreateFirstAdminResult> {
  const email = validateEmail(input.email);
  const password = validatePassword(input.password);
  const name = (input.name ?? "").trim() || "Administrator";

  // Hash outside the transaction (bcrypt is CPU-bound; keep the lock short).
  const passwordHash = await bcryptjs.hash(password, BCRYPT_ROUNDS);

  return db.transaction(async (tx) => {
    // 1. Serialize concurrent bootstrap attempts (released on tx end).
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADMIN_BOOTSTRAP_LOCK_KEY})`);

    // 2. Refuse if any administrator already exists.
    const existingAdmins = await tx.select({ id: users.id }).from(users).where(eq(users.role, "admin")).limit(1);
    if (existingAdmins.length > 0) {
      throw new AdminBootstrapError(
        "ADMIN_ALREADY_EXISTS",
        "An administrator already exists — refusing to bootstrap another one",
      );
    }

    // 3. Refuse if the requested email is already registered (any role).
    const existingEmail = await tx.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (existingEmail.length > 0) {
      throw new AdminBootstrapError("EMAIL_ALREADY_EXISTS", "A user with that email already exists");
    }

    // 4. Insert the first administrator. Role is hardcoded.
    const [created] = await tx
      .insert(users)
      .values({ email, password: passwordHash, name, role: "admin" })
      .returning({ id: users.id, email: users.email });

    return { id: created.id, email: created.email, role: "admin" as const };
  });
}
