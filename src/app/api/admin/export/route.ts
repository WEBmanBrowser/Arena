import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { products, brands, categories, shippingClasses } from "@/db/schema";
import { eq, asc } from "drizzle-orm";
import { getCurrentUser, isStaff } from "@/lib/auth";
import { createAuditLog } from "@/lib/audit";

/** GET /api/admin/export — Export products as CSV */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user || !isStaff(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

  const allProducts = await db.select().from(products).orderBy(asc(products.name));
  const allBrands = await db.select().from(brands);
  const allCategories = await db.select().from(categories);
  const allShippingClasses = await db.select().from(shippingClasses);
  const brandMap: Record<number, string> = {};
  const catMap: Record<number, string> = {};
  const shippingClassMap: Record<number, string> = {};
  allBrands.forEach(b => { brandMap[b.id] = b.name; });
  allCategories.forEach(c => { catMap[c.id] = c.name; });
  allShippingClasses.forEach(c => { shippingClassMap[c.id] = c.key; });

  // CSV formula injection protection
  const sanitize = (v: string | null | undefined): string => {
    if (!v) return "";
    const s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) return `'${s}`;
    if (s.includes(",") || s.includes('"') || s.includes("\n")) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const headers = ["SKU", "EAN", "Nome", "Marca", "Categoria", "Classe Envio", "Preço", "IVA%", "Stock", "Reservado", "Disponível", "Stock Mínimo", "Ativo"];
  const rows = allProducts.map(p => [
    sanitize(p.sku), sanitize(p.ean), sanitize(p.name),
    sanitize(p.brandId ? brandMap[p.brandId] : ""),
    sanitize(p.categoryId ? catMap[p.categoryId] : ""),
    sanitize(p.shippingClassId ? shippingClassMap[p.shippingClassId] : ""),
    p.price, p.vatRate, String(p.stock), String(p.reservedStock),
    String(p.stock - p.reservedStock), String(p.minStock),
    p.isActive ? "Sim" : "Não",
  ]);

  const csv = [headers.join(","), ...rows.map(r => r.join(","))].join("\n");

  await createAuditLog({ userId: user.id, action: "catalog.exported", entity: "products", details: { count: allProducts.length } });

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="mdtech-catalogo-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
