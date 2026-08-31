"use client";
import { useCallback, useEffect, useState } from "react";
import type { AdminOrderDetail, AdminOrderListPagination, AdminOrderListRow } from "@/lib/services/admin-orders-service";

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

const PAYMENT_STATUS_LABELS: Record<string, string> = { pending: "Pendente", paid: "Pago", cancelled: "Cancelado", expired: "Expirado", refunded: "Reembolsado" };
const PAYMENT_METHOD_LABELS: Record<string, string> = { bank_transfer: "Transferência bancária", mbway: "MB WAY", card: "Cartão", cash: "Numerário (loja)" };
const SORT_OPTIONS = [
  { value: "newest", label: "Mais recentes" },
  { value: "oldest", label: "Mais antigas" },
  { value: "total_desc", label: "Total (maior → menor)" },
  { value: "total_asc", label: "Total (menor → maior)" },
];
const CRITICAL_STATUSES = ["cancelled", "refunded"];

function statusColor(s: string) {
  if (["paid", "delivered"].includes(s)) return "bg-green-50 text-green-700";
  if (["cancelled", "expired", "refunded"].includes(s)) return "bg-red-50 text-red-700";
  if (["shipped", "ready_for_pickup"].includes(s)) return "bg-blue-50 text-blue-700";
  return "bg-amber-50 text-amber-700";
}

function fmtDate(d: Date | string | null | undefined) {
  return d ? new Date(d).toLocaleString("pt-PT") : "—";
}

function fmtMoney(v: string | null | undefined) {
  return `${parseFloat(v || "0").toFixed(2)}€`;
}

/** Render an address object (jsonb) as human-readable lines — never JSON.stringify. */
function formatAddress(addr: unknown): string[] {
  if (!addr || typeof addr !== "object") return ["—"];
  const a = addr as Record<string, unknown>;
  const line = (...vals: unknown[]) => vals.filter(v => typeof v === "string" && v.trim() !== "").join(" ") || null;
  const lines = [
    line(a.name),
    line(a.address1 ?? a.street ?? a.line1),
    typeof (a.address2 ?? a.line2) === "string" && (a.address2 as string ?? a.line2 as string).trim() !== "" ? String(a.address2 ?? a.line2) : null,
    line(a.postalCode ?? a.zip, a.city),
    line(a.country),
    typeof a.phone === "string" && a.phone ? `Telefone: ${a.phone}` : null,
    typeof a.nif === "string" && a.nif ? `NIF: ${a.nif}` : null,
  ].filter((l): l is string => l !== null);
  return lines.length ? lines : ["—"];
}

function AddressBlock({ addr }: { addr: unknown }) {
  return (
    <div className="text-sm text-slate-700 space-y-0.5">
      {formatAddress(addr).map((l, i) => <p key={i}>{l}</p>)}
    </div>
  );
}

type Filters = {
  search: string;
  status: string;
  paymentStatus: string;
  deliveryType: string;
  sort: string;
  dateFrom: string;
  dateTo: string;
};

export default function AdminOrdersPage() {
  const [orders, setOrders] = useState<AdminOrderListRow[]>([]);
  const [pagination, setPagination] = useState<AdminOrderListPagination>({ page: 1, pageSize: 25, total: 0, totalPages: 1 });
  const [pageSize, setPageSize] = useState(25);
  const [filters, setFilters] = useState<Filters>({ search: "", status: "", paymentStatus: "", deliveryType: "", sort: "newest", dateFrom: "", dateTo: "" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<AdminOrderDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [comment, setComment] = useState("");
  const [tracking, setTracking] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (page = 1) => {
    setLoading(true); setError("");
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize), sort: filters.sort || "newest" });
    (Object.entries(filters) as [keyof Filters, string][]).forEach(([k, v]) => { if (v && k !== "sort") params.set(k, v); });
    try {
      const res = await fetch(`/api/admin/orders?${params}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Erro");
      setOrders(data.orders || []);
      setPagination(data.pagination || { page: 1, pageSize, total: 0, totalPages: 1 });
    } catch (e) { setError((e as Error).message); }
    setLoading(false);
  }, [filters, pageSize]);

  useEffect(() => { const t = setTimeout(() => load(1), 300); return () => clearTimeout(t); }, [filters, pageSize, load]);

  const openDetail = async (id: number) => {
    setDetailLoading(true); setError(""); setDetail(null);
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
    if (!detail || saving) return;
    if (CRITICAL_STATUSES.includes(status) && !confirm(`Confirmar alteração para "${STATUS_LABELS[status] || status}"? Esta é uma operação crítica.`)) return;
    setSaving(true); setError("");
    const res = await fetch("/api/admin/orders", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: detail.order.id, status, comment }) });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) { setError(data.error || "Erro"); return; }
    setDetail(data);
    setComment("");
    load(pagination.page);
  };

  const saveTracking = async () => {
    if (!detail || saving) return;
    setSaving(true); setError("");
    const res = await fetch("/api/admin/orders", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: detail.order.id, trackingNumber: tracking.trim() || null }) });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) { setError(data.error || "Erro"); return; }
    setDetail(data.order || data);
    load(pagination.page);
  };

  const setFilter = (patch: Partial<Filters>) => setFilters(f => ({ ...f, ...patch }));

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold text-slate-800">Encomendas</h2>
        <span className="text-sm text-slate-500">{pagination.total} encomenda(s)</span>
      </div>

      <div className="bg-white border rounded-xl p-4 mb-4 flex flex-wrap gap-2 items-center">
        <input value={filters.search} onChange={e => setFilter({ search: e.target.value })} placeholder="Pesquisar encomenda, cliente, email..." className="border rounded px-3 py-1.5 text-sm w-72" />
        <select value={filters.status} onChange={e => setFilter({ status: e.target.value })} className="border rounded px-2 py-1.5 text-sm">
          <option value="">Estado</option>{Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select value={filters.paymentStatus} onChange={e => setFilter({ paymentStatus: e.target.value })} className="border rounded px-2 py-1.5 text-sm">
          <option value="">Pagamento</option>{Object.entries(PAYMENT_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select value={filters.deliveryType} onChange={e => setFilter({ deliveryType: e.target.value })} className="border rounded px-2 py-1.5 text-sm">
          <option value="">Entrega</option><option value="shipping">Envio</option><option value="pickup">Levantamento</option>
        </select>
        <select value={filters.sort} onChange={e => setFilter({ sort: e.target.value })} className="border rounded px-2 py-1.5 text-sm">
          {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <input type="date" value={filters.dateFrom} onChange={e => setFilter({ dateFrom: e.target.value })} title="De" className="border rounded px-2 py-1.5 text-sm text-slate-600" aria-label="Data de" />
        <span className="text-slate-400 text-sm">→</span>
        <input type="date" value={filters.dateTo} onChange={e => setFilter({ dateTo: e.target.value })} title="Até (dia completo)" className="border rounded px-2 py-1.5 text-sm text-slate-600" aria-label="Data até (dia completo)" />
        <select value={pageSize} onChange={e => setPageSize(parseInt(e.target.value))} className="border rounded px-2 py-1.5 text-sm ml-auto">
          <option value="25">25 / página</option><option value="50">50 / página</option><option value="100">100 / página</option>
        </select>
      </div>

      {error && <div className="mb-4 p-3 bg-red-50 text-red-600 rounded-lg text-sm">{error}</div>}

      <div className="bg-white rounded-xl border overflow-hidden">
        {loading && <p className="text-sm text-slate-500 p-4">A carregar...</p>}
        {!loading && orders.length === 0 && (
          <div className="p-10 text-center text-slate-500">
            <p className="text-3xl mb-2">📦</p>
            <p className="text-sm font-medium">Nenhuma encomenda encontrada</p>
            <p className="text-xs text-slate-400 mt-1">Ajusta os filtros ou a pesquisa.</p>
          </div>
        )}
        {!loading && orders.length > 0 && (
          <table className="w-full text-sm">
            <thead className="bg-slate-50"><tr><th className="text-left p-3">Encomenda</th><th className="text-left p-3 hidden md:table-cell">Data</th><th className="text-left p-3">Cliente</th><th className="text-right p-3">Total</th><th className="text-center p-3">Pagamento</th><th className="text-center p-3">Estado</th><th className="text-center p-3 hidden md:table-cell">Entrega</th><th className="text-right p-3">Ações</th></tr></thead>
            <tbody>{orders.map(o => <tr key={o.id} className="border-t hover:bg-slate-50"><td className="p-3 font-medium">#{o.orderNumber}</td><td className="p-3 hidden md:table-cell text-slate-500">{fmtDate(o.createdAt)}</td><td className="p-3"><p className="font-medium">{o.customerName}</p><p className="text-xs text-slate-400">{o.customerEmail}</p></td><td className="p-3 text-right font-bold">{fmtMoney(o.total)}</td><td className="p-3 text-center text-xs">{PAYMENT_STATUS_LABELS[o.paymentStatus] || o.paymentStatus}</td><td className="p-3 text-center"><span className={`px-2 py-0.5 rounded text-xs font-medium ${statusColor(o.status)}`}>{STATUS_LABELS[o.status] || o.status}</span></td><td className="p-3 text-center hidden md:table-cell text-xs">{o.deliveryType === "pickup" ? "📍 Loja" : "🚚 Envio"}</td><td className="p-3 text-right"><button onClick={() => openDetail(o.id)} className="text-sky-600 text-xs font-medium">Detalhes</button></td></tr>)}</tbody>
          </table>
        )}
      </div>

      <div className="flex justify-between mt-4 text-sm">
        <button disabled={pagination.page <= 1} onClick={() => load(pagination.page - 1)} className="px-3 py-1 border rounded disabled:opacity-50">Anterior</button>
        <span className="text-slate-500">Página {pagination.page} / {pagination.totalPages}</span>
        <button disabled={pagination.page >= pagination.totalPages} onClick={() => load(pagination.page + 1)} className="px-3 py-1 border rounded disabled:opacity-50">Seguinte</button>
      </div>

      {detailLoading && <p className="mt-6 text-sm text-slate-500">A carregar detalhe...</p>}

      {detail && !detailLoading && (
        <div className="mt-6 bg-white border rounded-xl p-6">
          <div className="flex justify-between mb-4"><h3 className="font-bold text-slate-800">Encomenda #{detail.order.orderNumber}</h3><button onClick={() => setDetail(null)} className="text-slate-400 hover:text-slate-600">Fechar</button></div>

          <div className="grid md:grid-cols-2 gap-6 text-sm">
            <section>
              <h4 className="font-semibold mb-2">Resumo</h4>
              <p>Estado: <span className={`px-2 py-0.5 rounded text-xs ${statusColor(detail.order.status)}`}>{STATUS_LABELS[detail.order.status] || detail.order.status}</span></p>
              <p>Data: {fmtDate(detail.order.createdAt)}</p>
              <p>Subtotal: {fmtMoney(detail.order.subtotal)}</p>
              <p>Desconto: {fmtMoney(detail.order.discount)}</p>
              <p>IVA: {fmtMoney(detail.order.vat)}</p>
              <p>Portes: {fmtMoney(detail.order.shipping)}</p>
              <p className="text-base">Total: <strong>{fmtMoney(detail.order.total)}</strong></p>
              <p>Método de pagamento: {PAYMENT_METHOD_LABELS[detail.order.paymentMethod ?? ""] || detail.order.paymentMethod || "—"}</p>
              <p>Tracking: {detail.order.trackingNumber ? <span className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded">{detail.order.trackingNumber}</span> : "—"}</p>
            </section>

            <section>
              <h4 className="font-semibold mb-2">Cliente</h4>
              {detail.customer ? (
                <>
                  <p><span className="text-xs uppercase tracking-wide text-sky-600 font-semibold">Cliente registado</span></p>
                  <p className="font-medium">{detail.customer.name}</p>
                  <p className="text-slate-600">{detail.customer.email}</p>
                  {detail.customer.phone && <p className="text-slate-600">Telefone: {detail.customer.phone}</p>}
                  <p className="text-slate-600">NIF: {detail.customer.nif || "—"}</p>
                  {detail.customer.company && <p className="text-slate-600">Empresa: {detail.customer.company}</p>}
                </>
              ) : (
                <>
                  <p><span className="text-xs uppercase tracking-wide text-amber-600 font-semibold">Cliente guest (sem registo)</span></p>
                  <p className="font-medium">{detail.order.guestName || "—"}</p>
                  <p className="text-slate-600">{detail.order.guestEmail || "—"}</p>
                  {detail.order.guestPhone && <p className="text-slate-600">Telefone: {detail.order.guestPhone}</p>}
                </>
              )}
            </section>

            <section>
              <h4 className="font-semibold mb-2">Morada de faturação</h4>
              <AddressBlock addr={detail.order.billingAddress} />
            </section>

            <section>
              <h4 className="font-semibold mb-2">Entrega</h4>
              {detail.order.deliveryType === "pickup" ? (
                <p className="text-sm text-slate-700">📍 <strong>Levantamento em loja</strong> — a encomenda será recolhida nas nossas instalações.</p>
              ) : (
                <>
                  <p className="text-sm text-slate-700 mb-1">🚚 Envio para:</p>
                  <AddressBlock addr={detail.order.shippingAddress} />
                </>
              )}
              <div className="flex gap-2 mt-3">
                <input value={tracking} onChange={e => setTracking(e.target.value)} maxLength={255} placeholder="Número de tracking" className="border rounded px-3 py-1.5 text-xs flex-1" />
                <button onClick={saveTracking} disabled={saving} className="px-3 py-1 bg-sky-600 text-white rounded text-xs disabled:opacity-50">Guardar tracking</button>
              </div>
              <p className="text-[11px] text-slate-400 mt-1">Vazio = limpar tracking. Máx. 255 caracteres.</p>
            </section>
          </div>

          <section className="mt-6">
            <h4 className="font-semibold mb-2 text-sm">Produtos</h4>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50"><tr><th className="p-2 text-left">Produto</th><th className="p-2">SKU</th><th className="p-2 text-right">Qtd</th><th className="p-2 text-right">Unit. Bruto</th><th className="p-2 text-right">Unit. Líq.</th><th className="p-2 text-right">IVA</th><th className="p-2 text-right">Desc.</th><th className="p-2 text-right">Total</th></tr></thead>
                <tbody>{detail.items.map(i => <tr key={i.id} className="border-t"><td className="p-2">{i.productName}</td><td className="p-2 text-center">{i.productSku}</td><td className="p-2 text-right">{i.quantity}</td><td className="p-2 text-right">{fmtMoney(i.unitPriceGross)}</td><td className="p-2 text-right">{fmtMoney(i.unitPriceNet)}</td><td className="p-2 text-right">{fmtMoney(i.vatAmount)} ({i.vatRate}%)</td><td className="p-2 text-right">{fmtMoney(i.discountAmount)}</td><td className="p-2 text-right font-medium">{fmtMoney(i.lineTotalGross)}</td></tr>)}</tbody>
              </table>
            </div>
            <p className="text-[11px] text-slate-400 mt-1">Preços e nomes apresentados são os snapshots históricos da compra.</p>
          </section>

          <section className="mt-6">
            <h4 className="font-semibold mb-2 text-sm">Pagamentos</h4>
            {detail.payments.length === 0 ? <p className="text-xs text-slate-400">Sem registos de pagamento.</p> : detail.payments.map(p => <div key={p.id} className="text-xs bg-slate-50 rounded p-2 mb-1">{p.provider} · {PAYMENT_METHOD_LABELS[p.method ?? ""] || p.method || "—"} · {fmtMoney(p.amount)} {p.currency} · {PAYMENT_STATUS_LABELS[p.status] || p.status} {p.paidAt ? `· pago em ${fmtDate(p.paidAt)}` : ""}</div>)}
          </section>

          <section className="mt-6">
            <h4 className="font-semibold mb-2 text-sm">Alterar estado</h4>
            <div className="flex gap-2 flex-wrap items-center">
              <input value={comment} onChange={e => setComment(e.target.value)} placeholder="Comentário opcional (ficará no histórico)" className="border rounded px-3 py-1.5 text-xs flex-1 min-w-48" />
              {detail.order.allowedTransitions.filter(s => s !== "expired").map(s => <button key={s} onClick={() => changeStatus(s)} disabled={saving} className={`px-3 py-1.5 rounded text-xs text-white disabled:opacity-50 ${CRITICAL_STATUSES.includes(s) ? "bg-red-500" : "bg-sky-600"}`}>{STATUS_LABELS[s] || s}</button>)}
            </div>
            {detail.order.allowedTransitions.length === 0 && <p className="text-xs text-slate-400 mt-2">Estado final — sem transições permitidas.</p>}
            {detail.order.status === "refunded" && <p className="text-xs text-amber-600 mt-2">Nota: este estado não executa reembolso em gateway externo.</p>}
            <p className="text-[11px] text-slate-400 mt-1">Estados críticos (cancelar/reembolsar) requerem nível manager/admin e pedem confirmação.</p>
          </section>

          <section className="mt-6">
            <h4 className="font-semibold mb-2 text-sm">Histórico de estados</h4>
            {detail.statusHistory.length === 0 ? <p className="text-xs text-slate-400">Sem histórico registado.</p> : detail.statusHistory.map(h => <div key={h.id} className="text-xs border-t py-2"><strong>{STATUS_LABELS[h.fromStatus ?? ""] || h.fromStatus || "—"}</strong> → <strong>{STATUS_LABELS[h.toStatus] || h.toStatus}</strong> · {fmtDate(h.createdAt)} {h.changedByName ? `· por ${h.changedByName}` : ""}{h.comment ? <p className="text-slate-500">{h.comment}</p> : null}</div>)}
          </section>

          {detail.order.notes && <section className="mt-6"><h4 className="font-semibold mb-2 text-sm">Notas da encomenda / cliente</h4><p className="text-sm text-slate-600">{detail.order.notes}</p></section>}
        </div>
      )}
    </div>
  );
}
