import { db } from "@/db";
import { banners, products, categories, smartShoppingProfiles } from "@/db/schema";
import { eq, and, desc, asc, isNull } from "drizzle-orm";
import Link from "next/link";
import ProductCard from "@/components/ProductCard";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const heroBanners = await db.select().from(banners).where(eq(banners.isActive, true)).orderBy(asc(banners.sortOrder));
  const featuredProducts = await db.select().from(products).where(and(eq(products.isActive, true), eq(products.isFeatured, true))).orderBy(desc(products.createdAt)).limit(8);
  const topCategories = await db.select().from(categories).where(and(eq(categories.isActive, true), isNull(categories.parentId))).orderBy(asc(categories.sortOrder)).limit(8);
  const smartProfiles = await db.select().from(smartShoppingProfiles).where(eq(smartShoppingProfiles.isActive, true)).orderBy(asc(smartShoppingProfiles.sortOrder));
  const latestProducts = await db.select().from(products).where(eq(products.isActive, true)).orderBy(desc(products.createdAt)).limit(8);

  return (
    <div>
      {/* Hero Banner */}
      {heroBanners.length > 0 && (
        <section className="relative bg-gradient-to-br from-slate-900 via-slate-800 to-sky-900 overflow-hidden">
          <div className="absolute inset-0 opacity-10">
            <div className="absolute top-20 left-20 w-64 h-64 bg-sky-400 rounded-full filter blur-3xl"></div>
            <div className="absolute bottom-10 right-20 w-48 h-48 bg-lime-400 rounded-full filter blur-3xl"></div>
          </div>
          <div className="max-w-7xl mx-auto px-4 py-16 md:py-24 relative">
            <div className="max-w-2xl">
              <h1 className="text-3xl md:text-5xl font-bold text-white mb-4 leading-tight animate-slide-up">
                {heroBanners[0].title}
              </h1>
              <p className="text-lg text-slate-300 mb-8 animate-slide-up" style={{ animationDelay: "0.1s" }}>
                {heroBanners[0].subtitle}
              </p>
              {heroBanners[0].link && (
                <Link href={heroBanners[0].link}
                  className="inline-flex items-center gap-2 px-6 py-3 bg-sky-600 hover:bg-sky-700 text-white font-semibold rounded-lg transition animate-slide-up" style={{ animationDelay: "0.2s" }}>
                  {heroBanners[0].buttonText || "Explorar"} →
                </Link>
              )}
            </div>
          </div>
        </section>
      )}

      {/* Trust badges */}
      <section className="bg-white border-b">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
            {[
              { icon: "🚚", title: "Portes Grátis", sub: "Em compras acima de 50€" },
              { icon: "📍", title: "Levantamento em Loja", sub: "Esposende" },
              { icon: "🛡️", title: "Garantia", sub: "Todos os produtos" },
              { icon: "🔧", title: "Assistência Técnica", sub: "Suporte profissional" },
            ].map((b) => (
              <div key={b.title} className="flex items-center gap-3 justify-center md:justify-start">
                <span className="text-2xl">{b.icon}</span>
                <div className="text-left">
                  <p className="text-sm font-semibold text-slate-800">{b.title}</p>
                  <p className="text-xs text-slate-500">{b.sub}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Categories */}
      <section className="py-10 bg-slate-50">
        <div className="max-w-7xl mx-auto px-4">
          <h2 className="text-xl font-bold text-slate-800 mb-6">Categorias</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
            {topCategories.map((cat) => (
              <Link key={cat.id} href={`/produtos?cat=${cat.slug}`}
                className="flex flex-col items-center gap-2 p-4 bg-white rounded-xl border border-slate-200 hover:border-sky-300 hover:shadow-md transition group">
                <span className="text-3xl group-hover:scale-110 transition">{cat.icon || "📁"}</span>
                <span className="text-xs font-medium text-slate-700 text-center">{cat.name}</span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* Smart Shopping */}
      {smartProfiles.length > 0 && (
        <section className="py-10 bg-white">
          <div className="max-w-7xl mx-auto px-4">
            <div className="text-center mb-8">
              <h2 className="text-xl font-bold text-slate-800 mb-2">🧠 Smart Shopping</h2>
              <p className="text-slate-500 text-sm">Não sabes o que precisas? Nós ajudamos.</p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {smartProfiles.map((p) => (
                <Link key={p.id} href={`/smart-shopping?profile=${p.id}`}
                  className="flex items-center gap-4 p-5 bg-slate-50 rounded-xl border border-slate-200 hover:border-sky-300 hover:bg-white hover:shadow-md transition group">
                  <span className="text-3xl">{p.icon}</span>
                  <div>
                    <p className="font-semibold text-slate-800 group-hover:text-sky-600 transition">{p.name}</p>
                    <p className="text-xs text-slate-500">{p.description}</p>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Featured Products */}
      {featuredProducts.length > 0 && (
        <section className="py-10 bg-slate-50">
          <div className="max-w-7xl mx-auto px-4">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl font-bold text-slate-800">⭐ Destaques</h2>
              <Link href="/produtos?featured=true" className="text-sm text-sky-600 hover:text-sky-700 font-medium">Ver todos →</Link>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
              {featuredProducts.map((p) => (
                <ProductCard key={p.id} product={p as any} />
              ))}
            </div>
          </div>
        </section>
      )}

      {/* CTA - Configurador */}
      <section className="py-12 bg-gradient-to-r from-slate-900 to-sky-900">
        <div className="max-w-7xl mx-auto px-4 text-center">
          <h2 className="text-2xl md:text-3xl font-bold text-white mb-3">🖥️ Constrói o teu PC</h2>
          <p className="text-slate-300 mb-6 max-w-lg mx-auto">Usa o nosso configurador com verificação de compatibilidade e monta o computador perfeito.</p>
          <Link href="/configurador" className="inline-flex items-center gap-2 px-6 py-3 bg-lime-500 hover:bg-lime-600 text-slate-900 font-bold rounded-lg transition">
            Abrir Configurador →
          </Link>
        </div>
      </section>

      {/* Latest Products */}
      {latestProducts.length > 0 && (
        <section className="py-10 bg-white">
          <div className="max-w-7xl mx-auto px-4">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl font-bold text-slate-800">🆕 Novidades</h2>
              <Link href="/produtos" className="text-sm text-sky-600 hover:text-sky-700 font-medium">Ver todos →</Link>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
              {latestProducts.map((p) => (
                <ProductCard key={p.id} product={p as any} />
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Esposende section */}
      <section className="py-12 bg-slate-50">
        <div className="max-w-7xl mx-auto px-4">
          <div className="bg-white rounded-2xl border border-slate-200 p-8 md:p-12">
            <div className="grid md:grid-cols-2 gap-8 items-center">
              <div>
                <h2 className="text-2xl font-bold text-slate-800 mb-4">📍 Somos de Esposende</h2>
                <p className="text-slate-600 mb-4">
                  A MD Tech Solutions é uma empresa local de informática, com presença física em Esposende. 
                  Oferecemos atendimento personalizado, assistência técnica especializada e a possibilidade 
                  de levantar as tuas encomendas diretamente na nossa loja.
                </p>
                <div className="space-y-3">
                  {[
                    { icon: "🏪", text: "Loja física com atendimento personalizado" },
                    { icon: "🔧", text: "Assistência técnica profissional no local" },
                    { icon: "📦", text: "Levantamento de encomendas na loja" },
                    { icon: "💬", text: "Suporte técnico em português" },
                    { icon: "🏢", text: "Serviços para particulares e empresas" },
                  ].map((item) => (
                    <div key={item.text} className="flex items-center gap-3">
                      <span className="text-lg">{item.icon}</span>
                      <span className="text-sm text-slate-700">{item.text}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="bg-gradient-to-br from-sky-50 to-lime-50 rounded-xl p-8 text-center">
                <div className="w-20 h-20 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-lime-400 to-sky-500 flex items-center justify-center font-black text-white text-2xl">MD</div>
                <h3 className="font-bold text-slate-800 mb-2">MD Tech Solutions</h3>
                <p className="text-sm text-slate-500 mb-4">Reparação Rápida. Soluções Completas.</p>
                <p className="text-xs text-slate-500">Esposende, Braga, Portugal</p>
                <p className="text-xs text-slate-500">Seg-Sex: 9:00 - 18:30 | Sáb: 9:00 - 13:00</p>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
