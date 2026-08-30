import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { products, stockMovements } from "@/db/schema";
import { eq, desc, sql, and, ilike } from "drizzle-orm";
import { getCurrentUser, isStaff, isManager } from "@/lib/auth";
import { createAuditLog } from "@/lib/audit";

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user || !isStaff(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

  const page = Math.max(1, parseInt(req.nextUrl.searchParams.get("page") || "1"));
  const limit = 50;
  const q = req.nextUrl.searchParams.get("q") || "";
  const status = req.nextUrl.searchParams.get("status") || "";

  // Build base query for non-service products
  let baseWhere = eq(products.isService, false);
  if (q) baseWhere = and(baseWhere, ilike(products.name, `%${q}%`))!;
  if (status === "out") baseWhere = and(baseWhere, sql`${products.stock} - ${products.reservedStock} <= 0`)!;
  if (status === "low") baseWhere = and(baseWhere, sql`${products.stock} - ${products.reservedStock} > 0`, sql`${products.stock} - ${products.reservedStock} <= ${products.minStock}`)!;

  const [countResult] = await db.select({ count: sql<number>`count(*)` }).from(products).where(baseWhere);
  const items = await db.select({
    id: products.id, name: products.name, sku: products.sku,
    stock: products.stock, reservedStock: products.reservedStock, minStock: products.minStock,
    isActive: products.isActive, price: products.price,
  }).from(products).where(baseWhere).orderBy(desc(products.updatedAt)).limit(limit).offset((page - 1) * limit);

  // Get recent movements for listed products
  const productIds = items.map(i => i.id);
  let movements: typeof stockMovements.$inferSelect[] = [];
  if (req.nextUrl.searchParams.get("productId")) {
    const pid = parseInt(req.nextUrl.searchParams.get("productId")!);
    movements = await db.select().from(stockMovements).where(eq(stockMovements.productId, pid)).orderBy(desc(stockMovements.createdAt)).limit(50);
  }

  return NextResponse.json({ products: items, total: Number(countResult.count), page, pages: Math.ceil(Number(countResult.count) / limit), movements });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user || !isManager(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

  const body = await req.json() as Record<string, unknown>;
  const productId = parseInt(body.productId as string);
  const quantity = parseInt(body.quantity as string);
  const type = (body.type as string) || "adjustment";
  const reason = (body.reason as string) || "";

  if (!productId || isNaN(quantity) || quantity === 0) return NextResponse.json({ error: "Dados inválidos" }, { status: 400 });

  try {
    const result = await db.transaction(async (tx) => {
      const [product] = await tx.select().from(products).where(eq(products.id, productId)).limit(1);
      if (!product) throw new Error("VALIDATION:Produto não encontrado");
      if (product.stock + quantity < 0) throw new Error("VALIDATION:Ajuste resultaria em stock negativo");

      const [updated] = await tx.update(products).set({
        stock: sql`${products.stock} + ${quantity}`,
        updatedAt: new Date(),
      }).where(and(eq(products.id, productId), sql`${products.stock} + ${quantity} >= 0`)).returning();

      if (!updated) throw new Error("VALIDATION:Stock negativo (concorrência)");

      await tx.insert(stockMovements).values({
        productId, type, quantity,
        stockBefore: product.stock, stockAfter: product.stock + quantity,
        reservedBefore: product.reservedStock, reservedAfter: product.reservedStock,
        reason: reason || `Ajuste manual: ${type}`, referenceType: "manual", userId: user.id,
      });
      return updated;
    });

    await createAuditLog({ userId: user.id, action: "stock.adjusted", entity: "product", entityId: productId,
      details: { type, quantity, reason } });
    return NextResponse.json({ product: result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Erro";
    if (msg.startsWith("VALIDATION:")) return NextResponse.json({ error: msg.replace("VALIDATION:", "") }, { status: 400 });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
