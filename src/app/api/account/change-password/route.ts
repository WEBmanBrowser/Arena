import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { csrfGuard } from "@/lib/csrf";
import { checkRateLimit, clientIp, rateLimitResponse } from "@/lib/rate-limit";
import { changeAccountPassword, AccountError } from "@/lib/services/customer-account-service";
import { changePasswordSchema } from "@/lib/b22-schemas";

export async function POST(req: NextRequest) {
  const csrf = csrfGuard(req);
  if (csrf) return csrf;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sessão requerida" }, { status: 401 });

  const parsed = changePasswordSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "VALIDATION_ERROR", issues: parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });
  }

  // Rate limit per user (prevent brute force on current password)
  const limit = await checkRateLimit(`change-password:user:${user.id}`, { limit: 5, windowSeconds: 15 * 60 });
  if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

  try {
    await changeAccountPassword(user.id, parsed.data.currentPassword, parsed.data.newPassword);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Erro";
    if (e instanceof AccountError) {
      if (msg === "USER_NOT_FOUND") return NextResponse.json({ error: "Utilizador não encontrado" }, { status: 404 });
      if (msg === "INVALID_CURRENT_PASSWORD") return NextResponse.json({ error: "Password atual incorreta" }, { status: 400 });
      if (msg === "WEAK_PASSWORD") return NextResponse.json({ error: "Nova password é fraca (mínimo 8 caracteres)" }, { status: 400 });
    }
    console.error("change password failed:", e);
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
