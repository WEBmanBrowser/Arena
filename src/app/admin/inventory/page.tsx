"use client";
import { useState, useEffect } from "react";

export default function AdminInventoryPage() {
  const [items, setItems] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [adjusting, setAdjusting] = useState<any>(null);
  const [adjForm, setAdjForm] = useState({ quantity: "", type: "entry", reason: "" });
  const [movements, setMovements] = useState<any[]>([]);
  const [viewingMvts, setViewingMvts] = useState<number | null>(null);

  const load = (p = page) => {
    const params = new URLSearchParams({ page: String(p), q: search, status });
    fetch(`/api/admin/inventory?${params}`).then(r => r.json()).then(d => {
      setItems(d.products || []);
      setTotal(d.total || 0);
      setPages(d.pages || 1);
    });
  };

  useEffect(() => { const t = setTimeout(() => load(1), 300); return () => clearTimeout(t); }, [search, status]);
  useEffect(() => { load(); }, [page]);

  const adjust = async () => {
    if (!adjusting) return;
    const qty = parseInt(adjForm.quantity);
    if (isNaN(qty) || qty === 0) return;
    const finalQty = adjForm.type === "exit" ? -Math.abs(qty) : Math.abs(qty);
    const res = await fetch("/api/admin/inventory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId: adjusting.id, quantity: finalQty, type: adjForm.type, reason: adjForm.reason }),
    });
    const data = await res.json();
    if (!res.ok) { alert(data.error); return; }
    setAdjusting(null);
    setAdjForm({ quantity: "", type: "entry", reason: "" });
    load();
  };

  const loadMovements = (productId: number) => {
    setViewingMvts(productId);
    fetch(`/api/admin/inventory?productId=${productId}`).then(r => r.json()).then(d => setMovements(d.movements || []));
  };

  const stockColor = (p: any) => {
    const avail = p.stock - p.reservedStock;
    if (avail <= 0) return "text-red-600 bg-red-50";
    if (avail <= p.minStock) return "text-amber-600 bg-amber-50";
    return "text-green-600 bg-green-50";
  };
  const stockLabel = (p: any) => {
    const avail = p.stock - p.reservedStock;
    if (avail <= 0) return "Sem stock";
    if (avail <= p.minStock) return "Stock baixo";
    return "Em stock";
  };

  return (
    <div>
      <h2 className="text-xl font-bold text-slate-800 mb-4">Inventário</h2>
      <div className="flex gap-3 mb-4 flex-wrap">
        <input type="text" placeholder="Pesquisar..." value={search} onChange={e => setSearch(e.target.value)} className="border rounded-lg px-3 py-1.5 text-sm w-64" />
        <select value={status} onChange={e => setStatus(e.target.value)} className="border rounded-lg px-3 py-1.5 text-sm">
          <option value="">Todos</option>
          <option value="low">Stock baixo</option>
          <option value="out">Sem stock</option>
        </select>
        <span className="text-sm text-slate-500 self-center">{total} produto(s)</span>
      </div>

      {adjusting && (
        <div className="bg-white border rounded-xl p-4 mb-4 animate-fade-in">
          <h3 className="font-medium text-sm mb-3">Ajustar Stock — {adjusting.name}</h3>
          <p className="text-xs text-slate-500 mb-2">Stock atual: {adjusting.stock} | Reservado: {adjusting.reservedStock} | Disponível: {adjusting.stock - adjusting.reservedStock}</p>
          <div className="grid grid-cols-3 gap-3">
            <select value={adjForm.type} onChange={e => setAdjForm(f => ({ ...f, type: e.target.value }))} className="border rounded px-3 py-1.5 text-sm">
              <option value="entry">Entrada</option>
              <option value="exit">Saída</option>
              <option value="adjustment">Correção</option>
              <option value="inventory_count">Contagem física</option>
            </select>
            <input type="number" placeholder="Quantidade" value={adjForm.quantity} onChange={e => setAdjForm(f => ({ ...f, quantity: e.target.value }))} className="border rounded px-3 py-1.5 text-sm" />
            <input type="text" placeholder="Motivo" value={adjForm.reason} onChange={e => setAdjForm(f => ({ ...f, reason: e.target.value }))} className="border rounded px-3 py-1.5 text-sm" />
          </div>
          <div className="flex gap-2 mt-3">
            <button onClick={() => setAdjusting(null)} className="px-3 py-1.5 border rounded text-sm">Cancelar</button>
            <button onClick={adjust} className="px-3 py-1.5 bg-sky-600 text-white rounded text-sm font-medium">Aplicar</button>
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th className="text-left p-3 font-medium text-slate-600">Produto</th>
              <th className="text-left p-3 font-medium text-slate-600">SKU</th>
              <th className="text-right p-3 font-medium text-slate-600">Físico</th>
              <th className="text-right p-3 font-medium text-slate-600">Reservado</th>
              <th className="text-right p-3 font-medium text-slate-600">Disponível</th>
              <th className="text-right p-3 font-medium text-slate-600">Mínimo</th>
              <th className="text-center p-3 font-medium text-slate-600">Estado</th>
              <th className="text-right p-3 font-medium text-slate-600">Ações</th>
            </tr>
          </thead>
          <tbody>
            {items.map((p: any) => (
              <tr key={p.id} className="border-t hover:bg-slate-50">
                <td className="p-3 font-medium text-slate-800 truncate max-w-xs">{p.name}</td>
                <td className="p-3 text-slate-500">{p.sku}</td>
                <td className="p-3 text-right">{p.stock}</td>
                <td className="p-3 text-right text-amber-600">{p.reservedStock}</td>
                <td className="p-3 text-right font-medium">{p.stock - p.reservedStock}</td>
                <td className="p-3 text-right text-slate-400">{p.minStock}</td>
                <td className="p-3 text-center"><span className={`px-2 py-0.5 rounded text-xs font-medium ${stockColor(p)}`}>{stockLabel(p)}</span></td>
                <td className="p-3 text-right">
                  <button onClick={() => setAdjusting(p)} className="text-sky-600 text-xs font-medium mr-2">Ajustar</button>
                  <button onClick={() => loadMovements(p.id)} className="text-slate-500 text-xs font-medium">Histórico</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages > 1 && <div className="flex justify-center gap-2 mt-4">{Array.from({ length: pages }).map((_, i) => (
        <button key={i} onClick={() => setPage(i + 1)} className={`w-8 h-8 rounded text-xs ${page === i + 1 ? "bg-sky-600 text-white" : "border text-slate-600"}`}>{i + 1}</button>
      ))}</div>}

      {viewingMvts && (
        <div className="mt-6 bg-white border rounded-xl p-4">
          <div className="flex justify-between mb-3"><h3 className="font-medium text-sm">Movimentos de Stock</h3><button onClick={() => setViewingMvts(null)} className="text-xs text-slate-500">Fechar</button></div>
          <table className="w-full text-xs">
            <thead className="bg-slate-50"><tr><th className="p-2 text-left">Tipo</th><th className="p-2 text-right">Qty</th><th className="p-2 text-right">Stock Antes</th><th className="p-2 text-right">Stock Depois</th><th className="p-2 text-right">Rsv Antes</th><th className="p-2 text-right">Rsv Depois</th><th className="p-2 text-left">Motivo</th><th className="p-2 text-left">Data</th></tr></thead>
            <tbody>
              {movements.map((m: any) => (
                <tr key={m.id} className="border-t">
                  <td className="p-2 font-medium">{m.type}</td>
                  <td className={`p-2 text-right font-medium ${m.quantity > 0 ? "text-green-600" : "text-red-600"}`}>{m.quantity > 0 ? "+" : ""}{m.quantity}</td>
                  <td className="p-2 text-right">{m.stockBefore}</td>
                  <td className="p-2 text-right">{m.stockAfter}</td>
                  <td className="p-2 text-right">{m.reservedBefore}</td>
                  <td className="p-2 text-right">{m.reservedAfter}</td>
                  <td className="p-2 text-slate-500 truncate max-w-32">{m.reason}</td>
                  <td className="p-2 text-slate-400">{new Date(m.createdAt).toLocaleString("pt-PT")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
