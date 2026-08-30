import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { hashPassword, createToken } from "@/lib/auth";

export async function POST(req: NextRequest) {
  try {
    const { email, password, name, phone, nif } = await req.json();
    if (!email || !password || !name) {
      return NextResponse.json({ error: "Campos obrigatórios em falta" }, { status: 400 });
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
