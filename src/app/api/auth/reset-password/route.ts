import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { checkRateLimit, clientIp, rateLimitResponse } from "@/lib/rate-limit";
import { csrfGuard } from "@/lib/csrf";
import { consumePasswordResetToken, isValidResetPassword, resetUserPassword } from "@/lib/password-reset";

const bodySchema = z.object({
  token: z.string().min(32).max(128),
  password: z.string().min(1).max(128),
});

/**
 * POST /api/auth/reset-password
 * Single-use, time-limited token (sha256-verified). Rate limited per IP.
 */
export async function POST(req: NextRequest) {
  const csrf = csrfGuard(req);
  if (csrf) return csrf;

  const ipLimit = await checkRateLimit(`reset:ip:${clientIp(req)}`, { limit: 10, windowSeconds: 15 * 60 });
  if (!ipLimit.allowed) return rateLimitResponse(ipLimit.retryAfterSeconds);

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Pedido inválido" }, { status: 400 });

  const { token, password } = parsed.data;
  if (!isValidResetPassword(password)) {
    return NextResponse.json({ error: "A password deve ter entre 8 e 128 caracteres" }, { status: 400 });
  }

  try {
    const userId = await consumePasswordResetToken(token);
    if (userId === null) {
      return NextResponse.json({ error: "Token inválido ou expirado" }, { status: 400 });
    }
    await resetUserPassword(userId, password);
    return NextResponse.json({ ok: true, message: "Password redefinida com sucesso. Podes iniciar sessão." });
  } catch (e) {
    console.error("reset-password failed:", e);
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
