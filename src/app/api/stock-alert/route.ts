import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { stockAlerts } from "@/db/schema";

export async function POST(req: NextRequest) {
  const { email, productId } = await req.json();
  if (!email || !productId) return NextResponse.json({ error: "Dados em falta" }, { status: 400 });

  await db.insert(stockAlerts).values({ email, productId });
  return NextResponse.json({ ok: true });
}
