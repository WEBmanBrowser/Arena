import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { verifyPassword, createToken } from "@/lib/auth";
import { checkRateLimit, clientIp, rateLimitResponse } from "@/lib/rate-limit";
import { csrfGuard } from "@/lib/csrf";

export async function POST(req: NextRequest) {
  // P1 guards: same-origin (CSRF) + rate limit per IP
  const csrf = csrfGuard(req);
  if (csrf) return csrf;
  const ipLimit = await checkRateLimit(`login:ip:${clientIp(req)}`, { limit: 10, windowSeconds: 5 * 60 });
  if (!ipLimit.allowed) return rateLimitResponse(ipLimit.retryAfterSeconds);

  try {
    const { email, password } = await req.json();
    if (!email || !password) {
      return NextResponse.json({ error: "Email e password são obrigatórios" }, { status: 400 });
    }
    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user || !user.isActive) {
      return NextResponse.json({ error: "Credenciais inválidas" }, { status: 401 });
    }
    const valid = await verifyPassword(password, user.password);
    if (!valid) {
      return NextResponse.json({ error: "Credenciais inválidas" }, { status: 401 });
    }
    const token = createToken({ userId: user.id, role: user.role });
    const response = NextResponse.json({
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    });
    response.cookies.set("auth_token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60,
      path: "/",
    });
    return response;
  } catch {
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
