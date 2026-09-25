import { db } from "@/db";
import { categories, productSuppliers, smartShoppingProfiles, products } from "@/db/schema";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import Link from "next/link";
import ProductCard from "@/components/ProductCard";
import { intentForProfile, recommendProducts } from "@/lib/smart-shopping-recommender";

export const dynamic = "force-dynamic";

const parseBudget = (value?: string) => {
  if (!value) return null;
  const n = Number(value.replace(",", "."));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 100000) : null;
};

export default async function SmartShoppingPage({ searchParams }: { searchParams: Promise<{ profile?: string; budget?: string }> }) {
  const params = await searchParams;
  const profileId = Number.parseInt(params.profile || "", 10);
  const budget = parseBudget(params.budget);
  const profiles = await db.select().from(smartShoppingProfiles).where(eq(smartShoppingProfiles.isActive, true)).orderBy(asc(smartShoppingProfiles.sortOrder));
  const currentProfile = Number.isFinite(profileId) ? profiles.find((p) => p.id === profileId) ?? null : null;

  let recommendations: Array<{ product: any; score: number; reason: string }> = [];
  if (currentProfile) {
    const rows = await db
      .select({ product: products, categorySlug: categories.slug })
      .from(products)
      .leftJoin(categories, eq(products.categoryId, categories.id))
      .where(and(eq(products.isActive, true), eq(products.isService, false)));

    const productIds = rows.map((row) => row.product.id);
    const supplierRows = productIds.length
      ? await db.select({ productId: productSuppliers.productId, available: sql<number>`GREATEST(COALESCE(${productSuppliers.supplierStock}, 0) - ${productSuppliers.supplierReservedStock}, 0)` })
          .from(productSuppliers).where(inArray(productSuppliers.productId, productIds))
      : [];
    const supplierStock = new Map<number, number>();
    for (const row of supplierRows) supplierStock.set(row.productId, (supplierStock.get(row.productId) || 0) + Number(row.available || 0));

    recommendations = recommendProducts(rows.map(({ product, categorySlug }) => ({
      ...product,
      categorySlug,
      supplierAvailableStock: supplierStock.get(product.id) || 0,
    })), currentProfile, budget);
  }

  const intent = currentProfile ? intentForProfile(currentProfile.name) : null;

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold text-slate-800 mb-2">🧠 Smart Shopping</h1>
      <p className="text-slate-500 text-sm mb-8">Escolhe o objetivo e o orçamento. As sugestões usam produtos reais disponíveis no catálogo MDTech.</p>

      {!currentProfile ? (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {profiles.map((p) => (
            <Link key={p.id} href={`/smart-shopping?profile=${p.id}`} className="flex items-center gap-4 p-6 bg-white rounded-xl border border-slate-200 hover:border-sky-300 hover:shadow-lg transition group">
              <span className="text-4xl">{p.icon}</span>
              <div><p className="font-semibold text-slate-800 group-hover:text-sky-600 transition">{p.name}</p><p className="text-sm text-slate-500">{p.description}</p></div>
            </Link>
          ))}
        </div>
      ) : (
        <div>
          <Link href="/smart-shopping" className="text-sm text-sky-600 hover:text-sky-700 mb-4 inline-block">← Alterar objetivo</Link>
          <div className="bg-white rounded-xl border p-6 mb-6">
            <div className="flex items-center gap-4 mb-5"><span className="text-4xl">{currentProfile.icon}</span><div><h2 className="text-xl font-bold text-slate-800">{currentProfile.name}</h2><p className="text-slate-500">{currentProfile.description}</p></div></div>
            <form className="flex flex-col sm:flex-row gap-3 items-end">
              <input type="hidden" name="profile" value={currentProfile.id} />
              <label className="w-full sm:max-w-xs text-sm font-medium text-slate-700">Orçamento máximo (€)<input name="budget" inputMode="decimal" defaultValue={budget ?? ""} placeholder="Ex.: 1000" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" /></label>
              <button className="rounded-lg bg-sky-600 px-5 py-2 text-sm font-semibold text-white hover:bg-sky-700">Atualizar sugestões</button>
              {budget && <Link href={`/smart-shopping?profile=${currentProfile.id}`} className="py-2 text-sm text-slate-500 hover:text-slate-700">Limpar orçamento</Link>}
            </form>
          </div>

          {intent?.configurator && (
            <div className="mb-6 rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-900">
              Para uma montagem completa, usa o <Link href="/configurador" className="font-semibold underline">Configurador de PC</Link>: é aí que a compatibilidade entre componentes é validada. O Smart Shopping não apresenta produtos isolados como uma montagem compatível.
            </div>
          )}

          <div className="flex items-end justify-between gap-4 mb-4"><div><h3 className="text-lg font-bold text-slate-800">Sugestões para o teu objetivo</h3><p className="text-xs text-slate-500">Apenas artigos ativos e com disponibilidade MDTech ou fornecedor{budget ? `, até ${budget.toFixed(2)}€ por artigo` : ""}.</p></div></div>
          {recommendations.length ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
              {recommendations.map(({ product, reason }) => <div key={product.id}><ProductCard product={product} /><p className="mt-1 px-1 text-xs text-slate-500">{reason}</p></div>)}
            </div>
          ) : (
            <div className="rounded-xl border border-slate-200 bg-white p-6 text-slate-600">Não encontrei produtos disponíveis que correspondam a este objetivo{budget ? " dentro do orçamento indicado" : ""}. Experimenta aumentar ou remover o orçamento.</div>
          )}
        </div>
      )}
    </div>
  );
}
