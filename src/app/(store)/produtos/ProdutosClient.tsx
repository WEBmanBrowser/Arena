"use client";
import { useState, useEffect, useCallback } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import ProductCard from "@/components/ProductCard";
import Link from "next/link";

export default function ProdutosClient() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [products, setProducts] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [categories, setCategories] = useState<any[]>([]);
  const [showFilters, setShowFilters] = useState(false);

  const q = searchParams.get("q") || "";
  const cat = searchParams.get("cat") || "";
  const brand = searchParams.get("brand") || "";
  const sort = searchParams.get("sort") || "newest";
  const page = parseInt(searchParams.get("page") || "1");
  const minPrice = searchParams.get("minPrice") || "";
  const maxPrice = searchParams.get("maxPrice") || "";
  const featured = searchParams.get("featured") || "";
  const inStock = searchParams.get("inStock") || "";

  const fetchProducts = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (cat) params.set("cat", cat);
    if (brand) params.set("brand", brand);
    if (sort) params.set("sort", sort);
    if (minPrice) params.set("minPrice", minPrice);
    if (maxPrice) params.set("maxPrice", maxPrice);
    if (featured) params.set("featured", featured);
    if (inStock) params.set("inStock", inStock);
    params.set("page", page.toString());

    const res = await fetch(`/api/products?${params.toString()}`);
    const data = await res.json();
    setProducts(data.products || []);
    setTotal(data.total || 0);
    setPages(data.pages || 1);
    setLoading(false);
  }, [q, cat, brand, sort, page, minPrice, maxPrice, featured, inStock]);

  useEffect(() => {
    fetch("/api/categories").then(r => r.json()).then(d => setCategories(d.categories || []));
  }, []);

  useEffect(() => {
    queueMicrotask(() => { void fetchProducts(); });
  }, [fetchProducts]);

  const updateFilter = (key: string, value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    params.delete("page");
    router.push(`/produtos?${params.toString()}`);
  };

  const parentCats = categories.filter(c => !c.parentId);
  const currentCat = categories.find(c => c.slug === cat);

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      {/* Breadcrumb */}
      <nav className="text-xs text-slate-500 mb-4">
        <Link href="/" className="hover:text-sky-600">Início</Link>
        <span className="mx-1">›</span>
        <span className="text-slate-800">{currentCat ? currentCat.name : (q ? `Pesquisa: "${q}"` : "Todos os Produtos")}</span>
      </nav>

      <div className="flex gap-6">
        {/* Sidebar Filters */}
        <aside className={`${showFilters ? "fixed inset-0 z-40 bg-white p-6 overflow-y-auto" : "hidden"} lg:block lg:static lg:w-56 shrink-0`}>
          {showFilters && (
            <button onClick={() => setShowFilters(false)} className="lg:hidden mb-4 text-slate-500">✕ Fechar</button>
          )}
          <h3 className="font-bold text-slate-800 mb-4 text-sm">Filtros</h3>
          
          {/* Categories */}
          <div className="mb-6">
            <h4 className="text-xs font-semibold text-slate-500 mb-2 uppercase">Categorias</h4>
            <div className="space-y-1">
              <button onClick={() => updateFilter("cat", "")}
                className={`block w-full text-left text-sm py-1 px-2 rounded ${!cat ? "text-sky-600 font-medium bg-sky-50" : "text-slate-600 hover:text-sky-600"}`}>
                Todos
              </button>
              {parentCats.map(c => {
                const subs = categories.filter(s => s.parentId === c.id);
                return (
                  <div key={c.id}>
                    <button onClick={() => updateFilter("cat", c.slug)}
                      className={`block w-full text-left text-sm py-1 px-2 rounded ${cat === c.slug ? "text-sky-600 font-medium bg-sky-50" : "text-slate-600 hover:text-sky-600"}`}>
                      {c.icon} {c.name}
                    </button>
                    {(cat === c.slug || subs.some(s => s.slug === cat)) && subs.length > 0 && (
                      <div className="ml-4 space-y-1 mt-1">
                        {subs.map(s => (
                          <button key={s.id} onClick={() => updateFilter("cat", s.slug)}
                            className={`block w-full text-left text-xs py-1 px-2 rounded ${cat === s.slug ? "text-sky-600 font-medium bg-sky-50" : "text-slate-500 hover:text-sky-600"}`}>
                            {s.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Price range */}
          <div className="mb-6">
            <h4 className="text-xs font-semibold text-slate-500 mb-2 uppercase">Preço</h4>
            <div className="flex gap-2">
              <input type="number" placeholder="Min" value={minPrice} onChange={e => updateFilter("minPrice", e.target.value)}
                className="w-full border rounded px-2 py-1.5 text-xs" />
              <input type="number" placeholder="Max" value={maxPrice} onChange={e => updateFilter("maxPrice", e.target.value)}
                className="w-full border rounded px-2 py-1.5 text-xs" />
            </div>
          </div>

          {/* In stock */}
          <div className="mb-6">
            <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer">
              <input type="checkbox" checked={inStock === "true"} onChange={e => updateFilter("inStock", e.target.checked ? "true" : "")}
                className="rounded" />
              Apenas em stock
            </label>
          </div>

          {showFilters && (
            <button onClick={() => setShowFilters(false)} className="w-full py-2 bg-sky-600 text-white rounded-lg text-sm font-medium lg:hidden">
              Ver {total} resultados
            </button>
          )}
        </aside>

        {/* Products grid */}
        <div className="flex-1">
          <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
            <div className="flex items-center gap-3">
              <button onClick={() => setShowFilters(true)} className="lg:hidden px-3 py-1.5 border rounded-lg text-sm text-slate-600 hover:bg-slate-50">
                ☰ Filtros
              </button>
              <p className="text-sm text-slate-500">{total} produto{total !== 1 ? "s" : ""}</p>
            </div>
            <select value={sort} onChange={e => updateFilter("sort", e.target.value)}
              className="border rounded-lg px-3 py-1.5 text-sm text-slate-600">
              <option value="newest">Mais recentes</option>
              <option value="price_asc">Preço: menor para maior</option>
              <option value="price_desc">Preço: maior para menor</option>
              <option value="popular">Mais vendidos</option>
              <option value="name">Nome A-Z</option>
            </select>
          </div>

          {loading ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="bg-white rounded-xl border border-slate-200 animate-pulse">
                  <div className="aspect-square bg-slate-100"></div>
                  <div className="p-4 space-y-2">
                    <div className="h-4 bg-slate-100 rounded w-3/4"></div>
                    <div className="h-4 bg-slate-100 rounded w-1/2"></div>
                  </div>
                </div>
              ))}
            </div>
          ) : products.length === 0 ? (
            <div className="text-center py-16">
              <p className="text-4xl mb-4">🔍</p>
              <p className="text-slate-500">Nenhum produto encontrado.</p>
              <Link href="/produtos" className="text-sky-600 text-sm mt-2 inline-block">Limpar filtros</Link>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                {products.map((p: any) => (
                  <ProductCard key={p.id} product={p} />
                ))}
              </div>
              {pages > 1 && (
                <div className="flex justify-center gap-2 mt-8">
                  {Array.from({ length: pages }).map((_, i) => (
                    <button key={i} onClick={() => updateFilter("page", (i + 1).toString())}
                      className={`w-10 h-10 rounded-lg text-sm font-medium transition ${page === i + 1 ? "bg-sky-600 text-white" : "bg-white border text-slate-600 hover:border-sky-300"}`}>
                      {i + 1}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
