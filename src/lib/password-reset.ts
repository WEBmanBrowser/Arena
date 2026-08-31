/**
 * P1 — Password reset tokens.
 *
 * Security properties:
 *  - Raw token (32 random bytes, hex) is returned ONCE and never stored;
 *    only its sha256 hash is persisted.
 *  - Single-use: consuming marks `used_at` atomically (safe against races).
 *  - Single-active: creating a new token invalidates previous unused ones.
 *  - TTL: 60 minutes.
 */
import crypto from "node:crypto";
import { db } from "@/db";
import { passwordResetTokens, users } from "@/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { hashPassword } from "@/lib/auth";
import { sendEmail } from "@/lib/email";

export const PASSWORD_RESET_TTL_MINUTES = 60;

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** Create a reset token for `userId` (invalidates previous unused tokens). Returns the RAW token. */
export async function createPasswordResetToken(userId: number): Promise<string> {
  const raw = crypto.randomBytes(32).toString("hex");
  await db.delete(passwordResetTokens).where(and(eq(passwordResetTokens.userId, userId), isNull(passwordResetTokens.usedAt)));
  await db.insert(passwordResetTokens).values({
    userId,
    tokenHash: sha256(raw),
    expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MINUTES * 60 * 1000),
  });
  return raw;
}

/**
 * Consume a raw token: valid, unused and unexpired → returns userId (marks used).
 * Invalid/expired/reused → null.
 */
export async function consumePasswordResetToken(rawToken: string): Promise<number | null> {
  const tokenHash = sha256(rawToken);
  const [row] = await db.select().from(passwordResetTokens).where(eq(passwordResetTokens.tokenHash, tokenHash)).limit(1);
  if (!row) return null;
  if (row.usedAt) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;

  // Atomic single-use claim — only one concurrent caller wins
  const [claimed] = await db.update(passwordResetTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(passwordResetTokens.id, row.id), isNull(passwordResetTokens.usedAt)))
    .returning({ id: passwordResetTokens.id });
  if (!claimed) return null;
  return row.userId;
}

/** Set a new password for `userId` (bcrypt-hashed). */
export async function resetUserPassword(userId: number, newPassword: string): Promise<void> {
  const hashed = await hashPassword(newPassword);
  await db.update(users).set({ password: hashed }).where(eq(users.id, userId));
}

function resetBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || "https://loja.mdtech.pt").replace(/\/+$/, "");
}

/** Send the reset email (records in email_notifications; provider optional). */
export async function sendPasswordResetEmail(user: { id: number; email: string; name: string }, rawToken: string): Promise<boolean> {
  const link = `${resetBaseUrl()}/conta/recuperar-password?token=${rawToken}`;
  return sendEmail({
    type: "password_reset",
    to: user.email,
    subject: "MDTech — Recuperação de password",
    html: `
      <p>Olá ${user.name},</p>
      <p>Recebemos um pedido para redefinir a password da tua conta.</p>
      <p><a href="${link}">Redefinir password</a></p>
      <p>Este link é válido por ${PASSWORD_RESET_TTL_MINUTES} minutos e pode ser usado uma única vez.</p>
      <p>Se não pediste isto, podes ignorar este email — a password mantém-se inalterada.</p>
    `,
    text: `Redefinir password (válido ${PASSWORD_RESET_TTL_MINUTES} minutos, uso único): ${link}`,
    referenceType: "user",
    referenceId: user.id,
    eventKey: `password_reset:${user.id}:${rawToken.slice(0, 12)}`,
  });
}

/** Password policy for reset (P1 minimum). */
export function isValidResetPassword(password: string): boolean {
  return typeof password === "string" && password.length >= 8 && password.length <= 128;
}
