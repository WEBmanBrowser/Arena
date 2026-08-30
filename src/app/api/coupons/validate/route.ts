import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { coupons } from "@/db/schema";
import { eq, and } from "drizzle-orm";

export async function POST(req: NextRequest) {
  const { code, subtotal } = await req.json();
  if (!code) return NextResponse.json({ error: "Código obrigatório" }, { status: 400 });

  const [coupon] = await db.select().from(coupons).where(and(eq(coupons.code, code.toUpperCase()), eq(coupons.isActive, true))).limit(1);
  if (!coupon) return NextResponse.json({ error: "Cupão inválido ou expirado" }, { status: 404 });

  if (coupon.expiresAt && new Date(coupon.expiresAt) < new Date()) {
    return NextResponse.json({ error: "Cupão expirado" }, { status: 400 });
  }
  if (coupon.maxUses && coupon.usedCount >= coupon.maxUses) {
    return NextResponse.json({ error: "Cupão esgotado" }, { status: 400 });
  }
  if (coupon.minPurchase && subtotal < parseFloat(coupon.minPurchase)) {
    return NextResponse.json({ error: `Compra mínima de €${coupon.minPurchase}` }, { status: 400 });
  }

  let discount = 0;
  if (coupon.type === "percentage") {
    discount = subtotal * (parseFloat(coupon.value) / 100);
  } else {
    discount = parseFloat(coupon.value);
  }

  return NextResponse.json({ coupon: { code: coupon.code, type: coupon.type, value: coupon.value }, discount: Math.min(discount, subtotal) });
}
