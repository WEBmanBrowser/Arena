/**
 * B.2.2 — Customer self-service account operations.
 *
 * Change password, self-disable and anonymization.
 * Anonymization is soft: orders / order items / snapshots are preserved.
 */
import crypto from "node:crypto";
import { db } from "@/db";
import { addresses, passwordResetTokens, users } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { verifyPassword, hashPassword } from "@/lib/auth";
import { isValidResetPassword } from "@/lib/password-reset";
import { createAuditLog } from "@/lib/audit";
import { sql } from "drizzle-orm";

export class AccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountError";
  }
}

// ─── CHANGE PASSWORD ──────────────────────────────────────
export async function changeAccountPassword(
  userId: number,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new AccountError("USER_NOT_FOUND");

  const valid = await verifyPassword(currentPassword, user.password);
  if (!valid) throw new AccountError("INVALID_CURRENT_PASSWORD");

  if (!isValidResetPassword(newPassword)) throw new AccountError("WEAK_PASSWORD");

  const hash = await hashPassword(newPassword);
  await db.update(users).set({ password: hash, updatedAt: new Date() }).where(eq(users.id, userId));

  await createAuditLog({
    userId,
    action: "customer.password_changed",
    entity: "customer",
    entityId: userId,
    // never include passwords/hashes
  });
}

// ─── SELF-DISABLE ─────────────────────────────────────────
export async function selfDisableAccount(userId: number, currentPassword: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) throw new AccountError("USER_NOT_FOUND");
    const ok = await verifyPassword(currentPassword, user.password);
    if (!ok) throw new AccountError("INVALID_CURRENT_PASSWORD");

    await tx.update(users).set({ isActive: false, updatedAt: new Date() }).where(eq(users.id, userId));
  });

  await createAuditLog({
    userId,
    action: "customer.self_disabled",
    entity: "customer",
    entityId: userId,
  });
}

// ─── ANONYMIZATION (soft delete — preserves history) ─────
export async function anonymizeAccount(userId: number, currentPassword: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) throw new AccountError("USER_NOT_FOUND");

    const ok = await verifyPassword(currentPassword, user.password);
    if (!ok) throw new AccountError("INVALID_CURRENT_PASSWORD");

    const rnd = crypto.randomBytes(8).toString("hex");
    const technicalEmail = `deleted-${user.id}-${rnd}@anonymized.local`;

    // Unusable random hash — account can never log in again
    const unusable = await hashPassword(crypto.randomBytes(32).toString("hex"));

    await tx.update(users).set({
      email: technicalEmail,
      name: "Conta removida",
      phone: null,
      nif: null,
      company: null,
      password: unusable,
      isActive: false,
      updatedAt: new Date(),
    }).where(eq(users.id, userId));

    // Remove personal addresses (does NOT touch historical order snapshots)
    await tx.delete(addresses).where(eq(addresses.userId, userId));

    // Remove any unused password-reset tokens
    await tx.delete(passwordResetTokens).where(
      and(eq(passwordResetTokens.userId, userId), sql`${passwordResetTokens.usedAt} IS NULL`),
    );
  });

  await createAuditLog({
    userId,
    action: "customer.anonymized",
    entity: "customer",
    entityId: userId,
  });
}
