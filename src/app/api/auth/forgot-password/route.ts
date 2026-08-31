import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { checkRateLimit, clientIp, rateLimitResponse } from "@/lib/rate-limit";
import { csrfGuard } from "@/lib/csrf";
import { createPasswordResetToken, sendPasswordResetEmail } from "@/lib/password-reset";

const bodySchema = z.object({ email: z.string().email().max(255) });

/**
 * POST /api/auth/forgot-password
 * Always answers 200 (no user enumeration). Sends the reset email when the
 * account exists. Rate limited per IP and per email.
 */
export async function POST(req: NextRequest) {
  const csrf = csrfGuard(req);
  if (csrf) return csrf;

  const ipLimit = await checkRateLimit(`forgot:ip:${clientIp(req)}`, { limit: 5, windowSeconds: 15 * 60 });
  if (!ipLimit.allowed) return rateLimitResponse(ipLimit.retryAfterSeconds);

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Email inválido" }, { status: 400 });
  const email = parsed.data.email.toLowerCase();

  const emailLimit = await checkRateLimit(`forgot:email:${email}`, { limit: 3, windowSeconds: 15 * 60 });
  if (!emailLimit.allowed) return rateLimitResponse(emailLimit.retryAfterSeconds);

  try {
    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (user && user.isActive) {
      const rawToken = await createPasswordResetToken(user.id);
      await sendPasswordResetEmail({ id: user.id, email: user.email, name: user.name }, rawToken);
    }
  } catch (e) {
    console.error("forgot-password failed:", e);
    // Do not leak whether the account exists
  }

  return NextResponse.json({ ok: true, message: "Se a conta existir, foi enviado um email de recuperação." });
}
