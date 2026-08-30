"use client";
import { useEffect, useState } from "react";
import Link from "next/link";

export default function AdminDashboard() {
  const [stats, setStats] = useState<any>(null);

  useEffect(() => {
    fetch("/api/admin/stats").then(r => r.json()).then(setStats);
  }, []);

  if (!stats) return <div className="text-slate-500">A carregar...</div>;

  const cards = [
    { label: "Vendas Hoje", value: stats.todaySales, sub: `${parseFloat(stats.todayRevenue || 0).toFixed(2)}€`, color: "bg-sky-50 text-sky-700", icon: "💰" },
    { label: "Vendas Mês", value: stats.monthSales, sub: `${parseFloat(stats.monthRevenue || 0).toFixed(2)}€`, color: "bg-lime-50 text-lime-700", icon: "📈" },
    { label: "Encomendas Pendentes", value: stats.pendingOrders, color: "bg-amber-50 text-amber-700", icon: "⏳" },
    { label: "Total Encomendas", value: stats.totalOrders, color: "bg-blue-50 text-blue-700", icon: "📦" },
    { label: "Produtos Ativos", value: stats.totalProducts, color: "bg-purple-50 text-purple-700", icon: "🏷️" },
    { label: "Stock Baixo", value: stats.lowStock, color: "bg-orange-50 text-orange-700", icon: "⚠️" },
    { label: "Sem Stock", value: stats.outOfStock, color: "bg-red-50 text-red-700", icon: "🚫" },
    { label: "Clientes", value: stats.totalCustomers, color: "bg-teal-50 text-teal-700", icon: "👥" },
    { label: "RMA Abertos", value: stats.openRma, color: "bg-rose-50 text-rose-700", icon: "🔧" },
  ];

  return (
    <div>
      <h2 className="text-xl font-bold text-slate-800 mb-6">Dashboard</h2>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4 mb-8">
        {cards.map(c => (
          <div key={c.label} className={`${c.color} rounded-xl p-4`}>
            <div className="flex items-center justify-between mb-2">
              <span className="text-2xl">{c.icon}</span>
              <span className="text-2xl font-bold">{c.value}</span>
            </div>
            <p className="text-xs font-medium">{c.label}</p>
            {c.sub && <p className="text-xs mt-0.5 opacity-75">{c.sub}</p>}
          </div>
        ))}
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <div className="bg-white rounded-xl border p-6">
          <h3 className="font-bold text-slate-800 mb-4">Ações Rápidas</h3>
          <div className="space-y-2">
            <Link href="/admin/products" className="flex items-center gap-3 p-3 rounded-lg hover:bg-slate-50 text-sm text-slate-700 transition">
              <span className="text-lg">➕</span> Adicionar Produto
            </Link>
            <Link href="/admin/orders" className="flex items-center gap-3 p-3 rounded-lg hover:bg-slate-50 text-sm text-slate-700 transition">
              <span className="text-lg">📦</span> Gerir Encomendas
            </Link>
            <Link href="/admin/categories" className="flex items-center gap-3 p-3 rounded-lg hover:bg-slate-50 text-sm text-slate-700 transition">
              <span className="text-lg">📁</span> Gerir Categorias
            </Link>
            <Link href="/admin/banners" className="flex items-center gap-3 p-3 rounded-lg hover:bg-slate-50 text-sm text-slate-700 transition">
              <span className="text-lg">🖼️</span> Gerir Banners
            </Link>
            <Link href="/admin/rma" className="flex items-center gap-3 p-3 rounded-lg hover:bg-slate-50 text-sm text-slate-700 transition">
              <span className="text-lg">🔧</span> Ver Pedidos RMA
            </Link>
          </div>
        </div>

        <div className="bg-white rounded-xl border p-6">
          <h3 className="font-bold text-slate-800 mb-4">Alertas</h3>
          <div className="space-y-2">
            {stats.pendingOrders > 0 && <p className="text-sm text-amber-600 flex items-center gap-2"><span>⏳</span> {stats.pendingOrders} encomenda(s) pendente(s)</p>}
            {stats.lowStock > 0 && <p className="text-sm text-orange-600 flex items-center gap-2"><span>⚠️</span> {stats.lowStock} produto(s) com stock baixo</p>}
            {stats.outOfStock > 0 && <p className="text-sm text-red-600 flex items-center gap-2"><span>🚫</span> {stats.outOfStock} produto(s) sem stock</p>}
            {stats.openRma > 0 && <p className="text-sm text-rose-600 flex items-center gap-2"><span>🔧</span> {stats.openRma} pedido(s) RMA aberto(s)</p>}
            {stats.pendingOrders === 0 && stats.lowStock === 0 && stats.outOfStock === 0 && stats.openRma === 0 && (
              <p className="text-sm text-green-600">✅ Tudo em ordem!</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
