import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/db";
import { orders, refundAttempts } from "@/db/schema";
import { and, desc, eq, inArray } from "drizzle-orm";

/**
 * Customer-facing refund visibility (authenticated customers only).
 *
 * Ownership is enforced SERVER-SIDE: only refunds on orders belonging to
 * the authenticated user are returned (guest orders are never exposed).
 *
 * Only customer-safe fields are exposed — never internal reasons, error
 * diagnostics, provider details, idempotency keys or other customers' data.
 */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sessão requerida" }, { status: 401 });

  const orderIdRaw = new URL(req.url).searchParams.get("orderId");
  const orderId = orderIdRaw != null ? Number(orderIdRaw) : null;

  const ownership = [eq(orders.userId, user.id)];
  if (orderId != null) {
    if (!Number.isInteger(orderId) || orderId < 1) return NextResponse.json({ error: "ID inválido" }, { status: 400 });
    ownership.push(eq(orders.id, orderId));
  }

  const ownOrders = await db
    .select({ id: orders.id, orderNumber: orders.orderNumber })
    .from(orders)
    .where(and(...ownership))
    .orderBy(desc(orders.id))
    .limit(200);

  if (ownOrders.length === 0) return NextResponse.json({ refunds: [] });

  const orderIds = ownOrders.map((o) => o.id);
  const rows = await db
    .select()
    .from(refundAttempts)
    .where(inArray(refundAttempts.orderId, orderIds))
    .orderBy(desc(refundAttempts.createdAt), desc(refundAttempts.id));

  const orderNumberById = new Map(ownOrders.map((o) => [o.id, o.orderNumber]));
  const refunds = rows.map((r) => ({
    orderId: r.orderId,
    orderNumber: orderNumberById.get(r.orderId) ?? null,
    amountCents: r.amountCents,
    currency: r.currency,
    status: r.status,
    createdAt: r.createdAt,
    completedAt: r.completedAt,
  }));

  return NextResponse.json({ refunds });
}
