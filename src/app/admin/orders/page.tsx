"use client";
import { useCallback, useEffect, useState } from "react";

const STATUS_LABELS: Record<string, string> = {
  pending_payment: "A aguardar pagamento",
  paid: "Pago",
  processing: "Em processamento",
  ready_for_pickup: "Pronto para levantamento",
  shipped: "Enviado",
  delivered: "Entregue",
  cancelled: "Cancelado",
  expired: "Expirado",
  refunded: "Reembolsado",
  return_requested: "Devolução solicitada",
  returned: "Devolvido",
};

const PAYMENT_LABELS: Record<string, string> = { pending: "Pendente", paid: "Pago", cancelled: "Cancelado", expired: "Expirado", refunded: "Reembolsado" };
const METHOD_LABELS: Record<string, string> = { bank_transfer: "Transferência bancária", pending: "Pendente" };

function statusColor(s: string) {
  if (["paid", "delivered"].includes(s)) return "bg-green-50 text-green-700";
  if (["cancelled", "expired", "refunded"].includes(s)) return "bg-red-50 text-red-700";
  if (["shipped", "ready_for_pickup"].includes(s)) return "bg-blue-50 text-blue-700";
  return "bg-amber-50 text-amber-700";
}

export default function AdminOrdersPage() {
  const [orders, setOrders] = useState<any[]>([]);
  const [pagination, setPagination] = useState({ page: 1, pageSize: 25, total: 0, totalPages: 1 });
  const [filters, setFilters] = useState({ search: "", status: "", paymentStatus: "", deliveryType: "", sort: "newest" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [comment, setComment] = useState("");
  const [tracking, setTracking] = useState("");

  const load = useCallback(async (page = pagination.page) => {
    setLoading(true); setError("");
    const params = new URLSearchParams({ page: String(page), pageSize: String(pagination.pageSize), sort: filters.sort });
    Object.entries(filters).forEach(([k, v]) => { if (v && k !== "sort") params.set(k, v); });
    try {
      const res = await fetch(`/api/admin/orders?${params}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Erro");
      setOrders(data.orders || []);
      setPagination(data.pagination || pagination);
    } catch (e) { setError((e as Error).message); }
    setLoading(false);
  }, [filters, pagination.pageSize]);

  useEffect(() => { const t = setTimeout(() => load(1), 300); return () => clearTimeout(t); }, [filters, load]);

  const openDetail = async (id: number) => {
    setDetailLoading(true); setError("");
    try {
      const res = await fetch(`/api/admin/orders/${id}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Erro");
      setDetail(data);
      setTracking(data.order.trackingNumber || "");
      setComment("");
    } catch (e) { setError((e as Error).message); }
    setDetailLoading(false);
  };

  const changeStatus = async (status: string) => {
    if (!detail) return;
    if (["cancelled", "refunded"].includes(status) && !confirm(`Confirmar alteração para ${STATUS_LABELS[status]}?`)) return;
    setError("");
    const res = await fetch("/api/admin/orders", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: detail.order.id, status, comment }) });
    const data = await res.json();
    if (!res.ok) { setError(data.error || "Erro"); return; }
    setDetail(data);
    load();
  };

  const saveTracking = async () => {
    if (!detail) return;
    setError("");
    const res = await fetch("/api/admin/orders", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: detail.order.id, trackingNumber: tracking || null }) });
    const data = await res.json();
    if (!res.ok) { setError(data.error || "Erro"); return; }
    setDetail(data.order || data);
    load();
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold text-slate-800">Encomendas</h2>
        <span className="text-sm text-slate-500">{pagination.total} encomenda(s)</span>
      </div>

      <div className="bg-white border rounded-xl p-4 mb-4 flex flex-wrap gap-2">
        <input value={filters.search} onChange={e => setFilters(f => ({ ...f, search: e.target.value }))} placeholder="Pesquisar encomenda, cliente, email..." className="border rounded px-3 py-1.5 text-sm w-72" />
        <select value={filters.status} onChange={e => setFilters(f => ({ ...f, status: e.target.value }))} className="border rounded px-2 py-1.5 text-sm">
          <option value="">Estado</option>{Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select value={filters.paymentStatus} onChange={e => setFilters(f => ({ ...f, paymentStatus: e.target.value }))} className="border rounded px-2 py-1.5 text-sm">
          <option value="">Pagamento</option>{Object.entries(PAYMENT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select value={filters.deliveryType} onChange={e => setFilters(f => ({ ...f, deliveryType: e.target.value }))} className="border rounded px-2 py-1.5 text-sm">
          <option value="">Entrega</option><option value="shipping">Envio</option><option value="pickup">Levantamento</option>
        </select>
        <select value={pagination.pageSize} onChange={e => setPagination(p => ({ ...p, pageSize: parseInt(e.target.value), page: 1 }))} className="border rounded px-2 py-1.5 text-sm">
          <option value="25">25</option><option value="50">50</option><option value="100">100</option>
        </select>
      </div>

      {error && <div className="mb-4 p-3 bg-red-50 text-red-600 rounded-lg text-sm">{error}</div>}
      {loading && <p className="text-sm text-slate-500 mb-3">A carregar...</p>}

      <div className="bg-white rounded-xl border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50"><tr><th className="text-left p-3">Encomenda</th><th className="text-left p-3 hidden md:table-cell">Data</th><th className="text-left p-3">Cliente</th><th className="text-right p-3">Total</th><th className="text-center p-3">Pagamento</th><th className="text-center p-3">Estado</th><th className="text-center p-3 hidden md:table-cell">Entrega</th><th className="text-right p-3">Ações</th></tr></thead>
          <tbody>{orders.map(o => <tr key={o.id} className="border-t hover:bg-slate-50"><td className="p-3 font-medium">#{o.orderNumber}</td><td className="p-3 hidden md:table-cell text-slate-500">{new Date(o.createdAt).toLocaleString("pt-PT")}</td><td className="p-3"><p className="font-medium">{o.customerName}</p><p className="text-xs text-slate-400">{o.customerEmail}</p></td><td className="p-3 text-right font-bold">{parseFloat(o.total).toFixed(2)}€</td><td className="p-3 text-center text-xs">{PAYMENT_LABELS[o.paymentStatus] || o.paymentStatus}</td><td className="p-3 text-center"><span className={`px-2 py-0.5 rounded text-xs font-medium ${statusColor(o.status)}`}>{STATUS_LABELS[o.status] || o.status}</span></td><td className="p-3 text-center hidden md:table-cell text-xs">{o.deliveryType === "pickup" ? "📍 Loja" : "🚚 Envio"}</td><td className="p-3 text-right"><button onClick={() => openDetail(o.id)} className="text-sky-600 text-xs font-medium">Detalhes</button></td></tr>)}</tbody>
        </table>
      </div>

      <div className="flex justify-between mt-4 text-sm"><button disabled={pagination.page <= 1} onClick={() => load(pagination.page - 1)} className="px-3 py-1 border rounded disabled:opacity-50">Anterior</button><span>Página {pagination.page} / {pagination.totalPages}</span><button disabled={pagination.page >= pagination.totalPages} onClick={() => load(pagination.page + 1)} className="px-3 py-1 border rounded disabled:opacity-50">Seguinte</button></div>

      {detail && (
        <div className="mt-6 bg-white border rounded-xl p-6">
          <div className="flex justify-between mb-4"><h3 className="font-bold text-slate-800">Encomenda #{detail.order.orderNumber}</h3><button onClick={() => setDetail(null)} className="text-slate-400">Fechar</button></div>
          {detailLoading && <p>A carregar...</p>}
          <div className="grid md:grid-cols-2 gap-6 text-sm">
            <section><h4 className="font-semibold mb-2">Resumo</h4><p>Estado: <span className={`px-2 py-0.5 rounded text-xs ${statusColor(detail.order.status)}`}>{STATUS_LABELS[detail.order.status]}</span></p><p>Total: <strong>{parseFloat(detail.order.total).toFixed(2)}€</strong></p><p>Subtotal: {parseFloat(detail.order.subtotal).toFixed(2)}€</p><p>Desconto: {parseFloat(detail.order.discount).toFixed(2)}€</p><p>IVA: {parseFloat(detail.order.vat).toFixed(2)}€</p><p>Portes: {parseFloat(detail.order.shipping).toFixed(2)}€</p></section>
            <section><h4 className="font-semibold mb-2">Cliente</h4>{detail.customer ? <><p>{detail.customer.name}</p><p>{detail.customer.email}</p><p>{detail.customer.phone}</p><p>NIF: {detail.customer.nif || "—"}</p></> : <><p>{detail.order.guestName}</p><p>{detail.order.guestEmail}</p><p>{detail.order.guestPhone}</p></>}</section>
            <section><h4 className="font-semibold mb-2">Morada de faturação</h4><pre className="text-xs whitespace-pre-wrap bg-slate-50 p-2 rounded">{JSON.stringify(detail.order.billingAddress, null, 2)}</pre></section>
            <section><h4 className="font-semibold mb-2">Entrega</h4><p>{detail.order.deliveryType === "pickup" ? "Levantamento em loja" : "Envio"}</p>{detail.order.deliveryType === "shipping" && <pre className="text-xs whitespace-pre-wrap bg-slate-50 p-2 rounded">{JSON.stringify(detail.order.shippingAddress, null, 2)}</pre>}<div className="flex gap-2 mt-2"><input value={tracking} onChange={e => setTracking(e.target.value)} placeholder="Tracking" className="border rounded px-2 py-1 text-xs flex-1" /><button onClick={saveTracking} className="px-2 py-1 bg-sky-600 text-white rounded text-xs">Guardar</button></div></section>
          </div>
          <section className="mt-6"><h4 className="font-semibold mb-2 text-sm">Produtos</h4><div className="overflow-x-auto"><table className="w-full text-xs"><thead className="bg-slate-50"><tr><th className="p-2 text-left">Produto</th><th className="p-2">SKU</th><th className="p-2 text-right">Qtd</th><th className="p-2 text-right">Unit. Bruto</th><th className="p-2 text-right">Unit. Líq.</th><th className="p-2 text-right">IVA</th><th className="p-2 text-right">Desc.</th><th className="p-2 text-right">Total</th></tr></thead><tbody>{detail.items.map((i:any) => <tr key={i.id} className="border-t"><td className="p-2">{i.productName}</td><td className="p-2">{i.productSku}</td><td className="p-2 text-right">{i.quantity}</td><td className="p-2 text-right">{i.unitPriceGross}€</td><td className="p-2 text-right">{i.unitPriceNet}€</td><td className="p-2 text-right">{i.vatAmount}€ ({i.vatRate}%)</td><td className="p-2 text-right">{i.discountAmount}€</td><td className="p-2 text-right font-medium">{i.lineTotalGross}€</td></tr>)}</tbody></table></div></section>
          <section className="mt-6"><h4 className="font-semibold mb-2 text-sm">Pagamento</h4>{detail.payments.map((p:any) => <div key={p.id} className="text-xs bg-slate-50 rounded p-2 mb-1">{p.provider} · {METHOD_LABELS[p.method] || p.method} · {p.amount} {p.currency} · {p.status} {p.paidAt ? `· ${new Date(p.paidAt).toLocaleString("pt-PT")}` : ""}</div>)}</section>
          <section className="mt-6"><h4 className="font-semibold mb-2 text-sm">Alterar estado</h4><div className="flex gap-2 flex-wrap"><input value={comment} onChange={e => setComment(e.target.value)} placeholder="Comentário opcional" className="border rounded px-2 py-1 text-xs flex-1 min-w-48" />{detail.order.allowedTransitions.filter((s:string)=>s!=="expired").map((s:string)=><button key={s} onClick={()=>changeStatus(s)} className="px-3 py-1 bg-sky-600 text-white rounded text-xs">{STATUS_LABELS[s]||s}</button>)}</div>{detail.order.status === "refunded" && <p className="text-xs text-amber-600 mt-2">Nota: este estado não executa reembolso em gateway externo.</p>}</section>
          <section className="mt-6"><h4 className="font-semibold mb-2 text-sm">Histórico</h4>{detail.statusHistory.map((h:any)=><div key={h.id} className="text-xs border-t py-2"><strong>{STATUS_LABELS[h.fromStatus]||h.fromStatus||"—"}</strong> → <strong>{STATUS_LABELS[h.toStatus]||h.toStatus}</strong> · {new Date(h.createdAt).toLocaleString("pt-PT")} {h.changedByName ? `· ${h.changedByName}` : ""}{h.comment ? <p className="text-slate-500">{h.comment}</p> : null}</div>)}</section>
          {detail.order.notes && <section className="mt-6"><h4 className="font-semibold mb-2 text-sm">Notas da encomenda / cliente</h4><p className="text-sm text-slate-600">{detail.order.notes}</p></section>}
        </div>
      )}
    </div>
  );
}
