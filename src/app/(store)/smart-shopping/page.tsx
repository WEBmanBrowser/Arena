import { db } from "@/db";
import { smartShoppingProfiles, products } from "@/db/schema";
import { eq, asc, and, ilike } from "drizzle-orm";
import Link from "next/link";
import ProductCard from "@/components/ProductCard";

export const dynamic = "force-dynamic";

export default async function SmartShoppingPage({ searchParams }: { searchParams: Promise<{ profile?: string }> }) {
  const { profile: profileId } = await searchParams;
  const profiles = await db.select().from(smartShoppingProfiles).where(eq(smartShoppingProfiles.isActive, true)).orderBy(asc(smartShoppingProfiles.sortOrder));

  let recommendedProducts: any[] = [];
  let currentProfile: any = null;

  if (profileId) {
    currentProfile = profiles.find(p => p.id === parseInt(profileId));
    if (currentProfile) {
      // Simple recommendation: get products matching tags from profile name
      const keywords = currentProfile.name.toLowerCase().split(" ").filter((w: string) => w.length > 3);
      for (const kw of keywords.slice(0, 2)) {
        const prods = await db.select().from(products)
          .where(and(eq(products.isActive, true), ilike(products.name, `%${kw}%`)))
          .limit(4);
        recommendedProducts.push(...prods);
      }
      if (recommendedProducts.length === 0) {
        recommendedProducts = await db.select().from(products).where(eq(products.isFeatured, true)).limit(8);
      }
      // Deduplicate
      const seen = new Set();
      recommendedProducts = recommendedProducts.filter(p => { if (seen.has(p.id)) return false; seen.add(p.id); return true; });
    }
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold text-slate-800 mb-2">🧠 Smart Shopping</h1>
      <p className="text-slate-500 text-sm mb-8">Não sabes o que precisas? Diz-nos o que queres fazer e recomendamos os melhores produtos.</p>

      {!currentProfile ? (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {profiles.map(p => (
            <Link key={p.id} href={`/smart-shopping?profile=${p.id}`}
              className="flex items-center gap-4 p-6 bg-white rounded-xl border border-slate-200 hover:border-sky-300 hover:shadow-lg transition group">
              <span className="text-4xl">{p.icon}</span>
              <div>
                <p className="font-semibold text-slate-800 group-hover:text-sky-600 transition">{p.name}</p>
                <p className="text-sm text-slate-500">{p.description}</p>
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <div>
          <Link href="/smart-shopping" className="text-sm text-sky-600 hover:text-sky-700 mb-4 inline-block">← Voltar</Link>
          <div className="bg-white rounded-xl border p-6 mb-8">
            <div className="flex items-center gap-4">
              <span className="text-4xl">{currentProfile.icon}</span>
              <div>
                <h2 className="text-xl font-bold text-slate-800">{currentProfile.name}</h2>
                <p className="text-slate-500">{currentProfile.description}</p>
              </div>
            </div>
          </div>
          <h3 className="text-lg font-bold text-slate-800 mb-4">Produtos Recomendados</h3>
          {recommendedProducts.length > 0 ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
              {recommendedProducts.map((p: any) => (
                <ProductCard key={p.id} product={p} />
              ))}
            </div>
          ) : (
            <p className="text-slate-500">Sem recomendações disponíveis de momento.</p>
          )}
        </div>
      )}
    </div>
  );
}
