import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { csrfGuard } from "@/lib/csrf";
import { checkRateLimit, clientIp, rateLimitResponse } from "@/lib/rate-limit";
import { selfDisableAccount, AccountError } from "@/lib/services/customer-account-service";
import { z } from "zod";

const disableSchema = z.object({
  currentPassword: z.string().min(1, "Password é obrigatória"),
  confirmDisable: z.boolean().refine(v => v === true, "Confirmação obrigatória"),
}).strict();

export async function POST(req: NextRequest) {
  const csrf = csrfGuard(req);
  if (csrf) return csrf;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sessão requerida" }, { status: 401 });

  const parsed = disableSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "VALIDATION_ERROR", issues: parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });
  }

  // Rate limit (prevents brute force on current password)
  const limit = await checkRateLimit(`self-disable:user:${user.id}`, { limit: 3, windowSeconds: 60 * 60 });
  if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

  try {
    await selfDisableAccount(user.id, parsed.data.currentPassword);
    // Session is now invalid (isActive = false → getCurrentUser returns null on next request)
    const res = NextResponse.json({ ok: true });
    res.cookies.set("auth_token", "", { httpOnly: true, maxAge: 0, path: "/" });
    return res;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Erro";
    if (e instanceof AccountError) {
      if (msg === "USER_NOT_FOUND") return NextResponse.json({ error: "Utilizador não encontrado" }, { status: 404 });
      if (msg === "INVALID_CURRENT_PASSWORD") return NextResponse.json({ error: "Password incorreta" }, { status: 400 });
    }
    console.error("self-disable failed:", e);
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
