import { NextRequest, NextResponse } from "next/server";
import { csrfGuard } from "@/lib/csrf";

export async function POST(req: NextRequest) {
  // P1 guard: same-origin (CSRF) — logout is a state-changing action
  const csrf = csrfGuard(req);
  if (csrf) return csrf;

  const response = NextResponse.json({ ok: true });
  response.cookies.set("auth_token", "", { httpOnly: true, maxAge: 0, path: "/" });
  return response;
}
