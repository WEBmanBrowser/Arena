import { NextResponse } from "next/server";
import { db } from "@/db";
import { orders, products, users, rmaRequests } from "@/db/schema";
import { sql, eq, gte, and } from "drizzle-orm";
import { getCurrentUser, isStaff } from "@/lib/auth";

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user || !isStaff(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

    const [totalOrders] = await db.select({ count: sql<number>`count(*)` }).from(orders);
    const [todayOrders] = await db.select({ count: sql<number>`count(*)`, revenue: sql<string>`COALESCE(sum(total::numeric), 0)` }).from(orders).where(gte(orders.createdAt, today));
    const [monthOrders] = await db.select({ count: sql<number>`count(*)`, revenue: sql<string>`COALESCE(sum(total::numeric), 0)` }).from(orders).where(gte(orders.createdAt, monthStart));
    const [pendingOrders] = await db.select({ count: sql<number>`count(*)` }).from(orders).where(eq(orders.status, "pending_payment"));
    const [totalProducts] = await db.select({ count: sql<number>`count(*)` }).from(products).where(eq(products.isActive, true));
    const [lowStock] = await db.select({ count: sql<number>`count(*)` }).from(products).where(and(eq(products.isActive, true), sql`${products.stock} <= ${products.minStock}`, eq(products.isService, false)));
    const [outOfStock] = await db.select({ count: sql<number>`count(*)` }).from(products).where(and(eq(products.isActive, true), sql`${products.stock} <= 0`, eq(products.isService, false)));
    const [totalCustomers] = await db.select({ count: sql<number>`count(*)` }).from(users).where(eq(users.role, "customer"));
    const [openRma] = await db.select({ count: sql<number>`count(*)` }).from(rmaRequests).where(sql`${rmaRequests.status} != 'completed' AND ${rmaRequests.status} != 'cancelled'`);

    return NextResponse.json({
      totalOrders: Number(totalOrders.count),
      todaySales: Number(todayOrders.count),
      todayRevenue: todayOrders.revenue,
      monthSales: Number(monthOrders.count),
      monthRevenue: monthOrders.revenue,
      pendingOrders: Number(pendingOrders.count),
      totalProducts: Number(totalProducts.count),
      lowStock: Number(lowStock.count),
      outOfStock: Number(outOfStock.count),
      totalCustomers: Number(totalCustomers.count),
      openRma: Number(openRma.count),
    });
  } catch {
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
