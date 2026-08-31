import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { hashPassword, createToken } from "@/lib/auth";
import { checkRateLimit, clientIp, rateLimitResponse } from "@/lib/rate-limit";
import { csrfGuard } from "@/lib/csrf";

export async function POST(req: NextRequest) {
  // P1 guards: same-origin (CSRF) + rate limit per IP + password policy
  const csrf = csrfGuard(req);
  if (csrf) return csrf;
  const ipLimit = await checkRateLimit(`register:ip:${clientIp(req)}`, { limit: 5, windowSeconds: 60 * 60 });
  if (!ipLimit.allowed) return rateLimitResponse(ipLimit.retryAfterSeconds);

  try {
    const { email, password, name, phone, nif } = await req.json();
    if (!email || !password || !name) {
      return NextResponse.json({ error: "Campos obrigatórios em falta" }, { status: 400 });
    }
    if (typeof password !== "string" || password.length < 8 || password.length > 128) {
      return NextResponse.json({ error: "A password deve ter entre 8 e 128 caracteres" }, { status: 400 });
    }
    const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (existing) {
      return NextResponse.json({ error: "Email já registado" }, { status: 409 });
    }
    const hashed = await hashPassword(password);
    const [user] = await db.insert(users).values({ email, password: hashed, name, phone: phone || null, nif: nif || null, role: "customer" }).returning();
    const token = createToken({ userId: user.id, role: user.role });
    const response = NextResponse.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } });
    response.cookies.set("auth_token", token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", maxAge: 7 * 24 * 60 * 60, path: "/" });
    return response;
  } catch {
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
