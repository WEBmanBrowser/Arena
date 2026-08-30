"use client";
import { useState, useEffect } from "react";
import Link from "next/link";

export default function ComparadorPage() {
  const [items, setItems] = useState<any[]>([]);
  const [products, setProducts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    queueMicrotask(() => {
      const stored = localStorage.getItem("mdtech_compare");
      const compare = stored ? JSON.parse(stored) : [];
      setItems(compare);

      Promise.all(
        compare.map((c: any) => fetch(`/api/products/${c.slug}`).then(r => r.json()).then(d => d.product))
      ).then(prods => {
        setProducts(prods.filter(Boolean));
        setLoading(false);
      });
    });
  }, []);

  const removeItem = (id: number) => {
    const updated = items.filter(i => i.id !== id);
    setItems(updated);
    setProducts(products.filter(p => p.id !== id));
    localStorage.setItem("mdtech_compare", JSON.stringify(updated));
  };

  const clearAll = () => {
    setItems([]);
    setProducts([]);
    localStorage.removeItem("mdtech_compare");
  };

  const allAttrKeys = new Set<string>();
  products.forEach(p => {
    if (p.attributes) Object.keys(p.attributes).forEach(k => allAttrKeys.add(k));
  });

  if (loading) return <div className="max-w-7xl mx-auto px-4 py-16 text-center text-slate-500">A carregar...</div>;

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-slate-800">📊 Comparador de Produtos</h1>
        {products.length > 0 && (
          <button onClick={clearAll} className="text-sm text-red-500 hover:text-red-700">Limpar tudo</button>
        )}
      </div>

      {products.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-4xl mb-4">📊</p>
          <p className="text-slate-500 mb-4">Nenhum produto para comparar.</p>
          <p className="text-sm text-slate-400 mb-6">Adicione produtos ao comparador a partir das páginas de produto.</p>
          <Link href="/produtos" className="px-6 py-2 bg-sky-600 text-white rounded-lg text-sm hover:bg-sky-700 transition">Ver Produtos</Link>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse bg-white rounded-xl border overflow-hidden">
            <thead>
              <tr>
                <th className="text-left p-4 bg-slate-50 font-medium text-sm text-slate-600 w-40">Produto</th>
                {products.map(p => (
                  <th key={p.id} className="p-4 bg-slate-50 text-center min-w-48">
                    <button onClick={() => removeItem(p.id)} className="text-xs text-red-400 hover:text-red-600 float-right">✕</button>
                    <div className="text-3xl mb-2">{p.isService ? "🛠️" : "📦"}</div>
                    <Link href={`/produto/${p.slug}`} className="text-sm font-medium text-slate-800 hover:text-sky-600">{p.name}</Link>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr className="border-t">
                <td className="p-4 text-sm font-medium text-slate-600">Preço</td>
                {products.map(p => (
                  <td key={p.id} className="p-4 text-center">
                    <span className="text-lg font-bold text-slate-900">{parseFloat(p.price).toFixed(2)}€</span>
                    {p.comparePrice && <span className="text-xs text-slate-400 line-through ml-1">{parseFloat(p.comparePrice).toFixed(2)}€</span>}
                  </td>
                ))}
              </tr>
              <tr className="border-t">
                <td className="p-4 text-sm font-medium text-slate-600">Disponibilidade</td>
                {products.map(p => (
                  <td key={p.id} className="p-4 text-center text-sm">
                    <span className={p.stock > 0 ? "text-green-600" : "text-red-500"}>{p.stock > 0 ? "Em stock" : "Esgotado"}</span>
                  </td>
                ))}
              </tr>
              {Array.from(allAttrKeys).map(key => (
                <tr key={key} className="border-t">
                  <td className="p-4 text-sm font-medium text-slate-600 capitalize">{key}</td>
                  {products.map(p => (
                    <td key={p.id} className="p-4 text-center text-sm text-slate-700">
                      {p.attributes?.[key] || "—"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
