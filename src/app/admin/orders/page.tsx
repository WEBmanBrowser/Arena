"use client";
import { useCallback, useEffect, useState } from "react";
import type {
  AdminOrderDetail,
  AdminOrderListPagination,
  AdminOrderListRow,
  AdminOrderQueueCounts,
  AdminOrderQueue,
} from "@/lib/services/admin-orders-service";

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

const PAYMENT_STATUS_LABELS: Record<string, string> = {
  pending: "Pendente",
  paid: "Pago",
  cancelled: "Cancelado",
  expired: "Expirado",
  refunded: "Reembolsado",
};

const PAYMENT_METHOD_LABELS: Record<string, string> = {
  bank_transfer: "Transferência bancária",
  mbway: "MB WAY",
  multibanco: "Multibanco",
  card: "Cartão",
  cash: "Numerário (loja)",
};

const SORT_OPTIONS = [
  { value: "newest", label: "Mais recentes" },
  { value: "oldest", label: "Mais antigas" },
  { value: "total_desc", label: "Total (maior → menor)" },
  { value: "total_asc", label: "Total (menor → maior)" },
];

const QUEUES: Array<{ id: AdminOrderQueue | ""; label: string; badgeKey?: keyof AdminOrderQueueCounts }> = [
  { id: "", label: "Todas" },
  { id: "awaiting_payment", label: "Por Pagar", badgeKey: "awaiting_payment" },
  { id: "paid_needs_processing", label: "Por Processar", badgeKey: "paid_needs_processing" },
  { id: "preparing", label: "Em Preparação", badgeKey: "preparing" },
  { id: "ready_to_ship", label: "Prontas p/ Envio", badgeKey: "ready_to_ship" },
  { id: "ready_for_pickup", label: "Levantamento em Loja", badgeKey: "ready_for_pickup" },
  { id: "shipped", label: "Enviadas", badgeKey: "shipped" },
  { id: "refund_attention", label: "Reembolsos", badgeKey: "refund_attention" },
  { id: "missing_invoice", label: "Sem Fatura", badgeKey: "missing_invoice" },
  { id: "exceptions", label: "Exceções", badgeKey: "exceptions" },
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

function fmtCents(cents: number) {
  return `${(cents / 100).toFixed(2)}€`;
}

/** Deterministic € string → integer cents. */
function parseEurosToCents(v: string): number | null {
  const m = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(v.trim());
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

const REFUND_STATUS_LABELS: Record<string, string> = {
  pending: "Pendente",
  processing: "Em processamento",
  succeeded: "Concluído",
  failed: "Falhado",
  cancelled: "Cancelado",
};

/** Render an address object (jsonb) as human-readable lines. */
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
  queue: string;
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
  const [queueCounts, setQueueCounts] = useState<AdminOrderQueueCounts | null>(null);
  const [pageSize, setPageSize] = useState(25);
  const [filters, setFilters] = useState<Filters>(() => {
    if (typeof window !== "undefined") {
      const urlParams = new URLSearchParams(window.location.search);
      return {
        queue: urlParams.get("queue") || "",
        search: urlParams.get("search") || "",
        status: urlParams.get("status") || "",
        paymentStatus: urlParams.get("paymentStatus") || "",
        deliveryType: urlParams.get("deliveryType") || "",
        sort: urlParams.get("sort") || "newest",
        dateFrom: urlParams.get("dateFrom") || "",
        dateTo: urlParams.get("dateTo") || "",
      };
    }
    return {
      queue: "",
      search: "",
      status: "",
      paymentStatus: "",
      deliveryType: "",
      sort: "newest",
      dateFrom: "",
      dateTo: "",
    };
  });
  const [selectedOrderIds, setSelectedOrderIds] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<AdminOrderDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [comment, setComment] = useState("");
  const [tracking, setTracking] = useState("");
  const [invoiceReference, setInvoiceReference] = useState("");
  const [invoiceIssuedAt, setInvoiceIssuedAt] = useState("");
  const [creditNoteOriginalDocId, setCreditNoteOriginalDocId] = useState<number | null>(null);
  const [creditNoteReference, setCreditNoteReference] = useState("");
  const [creditNoteAmount, setCreditNoteAmount] = useState("");
  const [creditNoteIssuedAt, setCreditNoteIssuedAt] = useState("");
  const [refundAmount, setRefundAmount] = useState("");
  const [refundReason, setRefundReason] = useState("");
  const [refundReference, setRefundReference] = useState("");
  const [refundCompletedAt, setRefundCompletedAt] = useState("");
  const [refundAsCompleted, setRefundAsCompleted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [bulkActionLoading, setBulkActionLoading] = useState(false);
  const [bulkResult, setBulkResult] = useState<{ total: number; succeeded: number[]; failed: Array<{ id: number; reason: string }> } | null>(null);
  const [pickingSheetOrder, setPickingSheetOrder] = useState<AdminOrderDetail | null>(null);

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
      if (data.queueCounts) setQueueCounts(data.queueCounts);
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
      setInvoiceReference("");
      setInvoiceIssuedAt(new Date().toISOString().slice(0, 10));
      const firstInvoice = data.invoiceDocuments.find((doc: { documentType: string; status: string }) => doc.documentType === "invoice" && doc.status === "issued");
      setCreditNoteOriginalDocId(firstInvoice?.id || null);
      setCreditNoteReference("");
      setCreditNoteAmount("");
      setCreditNoteIssuedAt(new Date().toISOString().slice(0, 10));
      setRefundAmount("");
      setRefundReason("");
      setRefundReference("");
      setRefundCompletedAt(new Date().toISOString().slice(0, 10));
      setRefundAsCompleted(false);
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

  const recordInvoice = async () => {
    if (!detail || saving || !invoiceReference.trim()) return;
    setSaving(true); setError("");
    const res = await fetch(`/api/admin/orders/${detail.order.id}/manual-invoice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ officialReference: invoiceReference.trim(), issuedAt: invoiceIssuedAt || undefined }),
    });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) { setError(data.error || "Erro"); return; }
    await openDetail(detail.order.id);
    load(pagination.page);
  };

  const recordCreditNote = async () => {
    if (!detail || saving || !creditNoteOriginalDocId || !creditNoteReference.trim()) return;
    const cents = parseEurosToCents(creditNoteAmount);
    if (cents == null || cents <= 0) { setError("Montante de nota de crédito inválido."); return; }
    setSaving(true); setError("");
    const res = await fetch(`/api/admin/orders/${detail.order.id}/credit-notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        originalDocumentId: creditNoteOriginalDocId,
        officialReference: creditNoteReference.trim(),
        amountCents: cents,
        issuedAt: creditNoteIssuedAt || undefined,
      }),
    });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) { setError(data.error || "Erro"); return; }
    await openDetail(detail.order.id);
    load(pagination.page);
  };

  const submitRefund = async () => {
    if (!detail || saving) return;
    const cents = parseEurosToCents(refundAmount);
    if (cents == null || cents <= 0) { setError("Montante de reembolso inválido."); return; }
    if (refundAsCompleted && !refundReference.trim()) { setError("Referência externa obrigatória para registo de reembolso concluído."); return; }
    if (!confirm(refundAsCompleted
      ? `Confirmar registo de reembolso manual CONCLUÍDO de ${(cents / 100).toFixed(2)} €? Confirme apenas se o dinheiro já foi efetivamente devolvido ao cliente.`
      : `Solicitar reembolso de ${(cents / 100).toFixed(2)} €?`)) return;
    setSaving(true); setError("");
    const res = await fetch(`/api/admin/orders/${detail.order.id}/refunds`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amountCents: cents,
        reason: refundReason.trim() || undefined,
        idempotencyKey: `admin-ui-${crypto.randomUUID()}`,
        ...(refundAsCompleted ? { manualCompletion: { externalReference: refundReference.trim(), completedAt: refundCompletedAt } } : {}),
      }),
    });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) { setError(data.error || "Erro"); return; }
    await openDetail(detail.order.id);
    load(pagination.page);
  };

  const refundAction = async (refundId: number, action: "complete" | "cancel" | "retry" | "fail") => {
    if (!detail || saving) return;
    if (action === "complete" && !refundReference.trim()) { setError("Referência externa obrigatória para concluir o reembolso."); return; }
    if (action === "complete" && !confirm("Confirmar que o reembolso foi EFETIVAMENTE executado externamente?")) return;
    if (action === "cancel" && !confirm("Cancelar este pedido de reembolso? (liberta o valor comprometido)")) return;
    setSaving(true); setError("");
    const res = await fetch(`/api/admin/refunds/${refundId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        externalReference: action === "complete" ? refundReference.trim() : undefined,
        completedAt: action === "complete" ? (refundCompletedAt || new Date().toISOString()) : undefined,
      }),
    });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) { setError(data.error || "Erro"); return; }
    await openDetail(detail.order.id);
    load(pagination.page);
  };

  const executeBulk = async (action: "start_processing" | "mark_ready_for_pickup") => {
    if (selectedOrderIds.length === 0 || bulkActionLoading) return;
    const label = action === "start_processing" ? "Iniciar preparação (Mover para Em processamento)" : "Marcar pronto para levantamento";
    if (!confirm(`${label} para as ${selectedOrderIds.length} encomendas selecionadas?`)) return;
    setBulkActionLoading(true); setError(""); setBulkResult(null);
    try {
      const res = await fetch("/api/admin/orders/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, orderIds: selectedOrderIds }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Erro no processamento em lote");
      setBulkResult(data);
      setSelectedOrderIds([]);
      load(pagination.page);
    } catch (e) {
      setError((e as Error).message);
    }
    setBulkActionLoading(false);
  };

  const toggleSelectAll = () => {
    if (selectedOrderIds.length === orders.length) {
      setSelectedOrderIds([]);
    } else {
      setSelectedOrderIds(orders.map(o => o.id));
    }
  };

  const toggleSelectOrder = (id: number) => {
    setSelectedOrderIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap justify-between items-center gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-800">Gestão Operacional de Encomendas</h2>
          <p className="text-xs text-slate-500">Fluxos de cumprimento, preparação, envio, levantamento e exceções</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => load(pagination.page)} className="px-3 py-1.5 text-xs bg-white border border-slate-300 rounded hover:bg-slate-50 text-slate-700">
            ↻ Atualizar
          </button>
        </div>
      </div>

      {/* Operational Queues Navigation */}
      <div className="border-b border-slate-200">
        <nav className="flex space-x-2 overflow-x-auto pb-2 text-xs">
          {QUEUES.map((q) => {
            const isActive = filters.queue === q.id;
            const count = q.badgeKey && queueCounts ? queueCounts[q.badgeKey] : null;
            return (
              <button
                key={q.id || "all"}
                onClick={() => setFilters(prev => ({ ...prev, queue: q.id, status: "" }))}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-t-lg font-medium whitespace-nowrap transition-colors ${
                  isActive
                    ? "bg-slate-900 text-white"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200 hover:text-slate-900"
                }`}
              >
                <span>{q.label}</span>
                {count != null && count > 0 && (
                  <span className={`px-1.5 py-0.2 rounded-full text-[10px] font-bold ${
                    isActive ? "bg-white/20 text-white" : q.id === "exceptions" || q.id === "refund_attention" ? "bg-red-100 text-red-700" : "bg-slate-300 text-slate-800"
                  }`}>
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </div>

      {error && <div className="p-3 bg-red-50 text-red-700 text-sm rounded border border-red-200">{error}</div>}

      {/* Bulk Results Alert */}
      {bulkResult && (
        <div className="p-3 bg-sky-50 text-sky-900 text-xs rounded border border-sky-200 flex justify-between items-center">
          <div>
            <strong>Resultado do lote:</strong> {bulkResult.succeeded.length} com sucesso, {bulkResult.failed.length} falharam de {bulkResult.total} total.
            {bulkResult.failed.length > 0 && (
              <ul className="mt-1 list-disc list-inside text-red-600">
                {bulkResult.failed.map(f => <li key={f.id}>Encomenda #{f.id}: {f.reason}</li>)}
              </ul>
            )}
          </div>
          <button onClick={() => setBulkResult(null)} className="text-slate-400 hover:text-slate-600 ml-4 font-bold">×</button>
        </div>
      )}

      {/* Filters Bar */}
      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm space-y-3">
        <div className="flex flex-wrap gap-2 items-center">
          <input
            type="text"
            placeholder="Pesquisar n.º, cliente ou email..."
            value={filters.search}
            onChange={(e) => setFilters(prev => ({ ...prev, search: e.target.value }))}
            className="border rounded px-3 py-1.5 text-xs flex-1 min-w-48"
          />
          <select
            value={filters.status}
            onChange={(e) => setFilters(prev => ({ ...prev, status: e.target.value }))}
            className="border rounded px-2.5 py-1.5 text-xs"
          >
            <option value="">Todos os estados</option>
            {Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select
            value={filters.paymentStatus}
            onChange={(e) => setFilters(prev => ({ ...prev, paymentStatus: e.target.value }))}
            className="border rounded px-2.5 py-1.5 text-xs"
          >
            <option value="">Todos os pagamentos</option>
            {Object.entries(PAYMENT_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select
            value={filters.deliveryType}
            onChange={(e) => setFilters(prev => ({ ...prev, deliveryType: e.target.value }))}
            className="border rounded px-2.5 py-1.5 text-xs"
          >
            <option value="">Envio e Levantamento</option>
            <option value="shipping">Envio ao domicílio</option>
            <option value="pickup">Levantamento em loja</option>
          </select>
          <select
            value={filters.sort}
            onChange={(e) => setFilters(prev => ({ ...prev, sort: e.target.value }))}
            className="border rounded px-2.5 py-1.5 text-xs"
          >
            {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <button
            onClick={() => setFilters({ queue: "", search: "", status: "", paymentStatus: "", deliveryType: "", sort: "newest", dateFrom: "", dateTo: "" })}
            className="px-2.5 py-1.5 text-xs text-slate-500 hover:text-slate-800"
          >
            Limpar
          </button>
        </div>
      </div>

      {/* Bulk Action Toolbar */}
      {selectedOrderIds.length > 0 && (
        <div className="p-3 bg-slate-900 text-white rounded-xl flex flex-wrap items-center justify-between gap-3 shadow">
          <span className="text-xs font-semibold">{selectedOrderIds.length} encomenda(s) selecionada(s)</span>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => executeBulk("start_processing")}
              disabled={bulkActionLoading}
              className="px-3 py-1 bg-sky-600 hover:bg-sky-500 text-white rounded text-xs font-medium disabled:opacity-50"
            >
              Iniciar Preparação (Mover p/ Em processamento)
            </button>
            <button
              onClick={() => executeBulk("mark_ready_for_pickup")}
              disabled={bulkActionLoading}
              className="px-3 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-xs font-medium disabled:opacity-50"
            >
              Marcar Pronto p/ Levantamento (Loja)
            </button>
            <button
              onClick={() => setSelectedOrderIds([])}
              className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-xs"
            >
              Cancelar seleção
            </button>
          </div>
        </div>
      )}

      {/* Orders Table */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-xs text-left">
            <thead className="bg-slate-50 text-slate-600 uppercase text-[10px] tracking-wider border-b">
              <tr>
                <th className="p-3 w-8 text-center">
                  <input
                    type="checkbox"
                    checked={orders.length > 0 && selectedOrderIds.length === orders.length}
                    onChange={toggleSelectAll}
                  />
                </th>
                <th className="p-3">Encomenda</th>
                <th className="p-3">Data</th>
                <th className="p-3">Cliente</th>
                <th className="p-3">Entrega</th>
                <th className="p-3">Estado</th>
                <th className="p-3">Pagamento</th>
                <th className="p-3">Tracking</th>
                <th className="p-3 text-right">Total</th>
                <th className="p-3 text-center">Ações</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading && orders.length === 0 ? (
                <tr><td colSpan={10} className="p-8 text-center text-slate-400">A carregar encomendas...</td></tr>
              ) : orders.length === 0 ? (
                <tr><td colSpan={10} className="p-8 text-center text-slate-400">Nenhuma encomenda encontrada nesta fila/filtro.</td></tr>
              ) : orders.map((o) => {
                const isSelected = selectedOrderIds.includes(o.id);
                return (
                  <tr key={o.id} className={`hover:bg-slate-50 transition ${isSelected ? "bg-sky-50/50" : ""}`}>
                    <td className="p-3 text-center">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelectOrder(o.id)}
                      />
                    </td>
                    <td className="p-3 font-semibold text-slate-800">
                      <button onClick={() => openDetail(o.id)} className="hover:text-sky-600 hover:underline">
                        {o.orderNumber}
                      </button>
                    </td>
                    <td className="p-3 text-slate-500 whitespace-nowrap">{fmtDate(o.createdAt)}</td>
                    <td className="p-3">
                      <div className="font-medium text-slate-700">{o.customerName}</div>
                      <div className="text-[10px] text-slate-400">{o.customerEmail}</div>
                    </td>
                    <td className="p-3">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] ${o.deliveryType === "pickup" ? "bg-purple-50 text-purple-700" : "bg-slate-100 text-slate-700"}`}>
                        {o.deliveryType === "pickup" ? "Levantamento" : "Envio"}
                      </span>
                    </td>
                    <td className="p-3">
                      <span className={`px-2 py-0.5 rounded-full font-medium text-[10px] ${statusColor(o.status)}`}>
                        {STATUS_LABELS[o.status] || o.status}
                      </span>
                    </td>
                    <td className="p-3">
                      <div className="font-medium">{PAYMENT_STATUS_LABELS[o.paymentStatus] || o.paymentStatus}</div>
                      <div className="text-[10px] text-slate-400">{PAYMENT_METHOD_LABELS[o.paymentMethod ?? ""] || o.paymentMethod || "—"}</div>
                    </td>
                    <td className="p-3 font-mono text-[11px] text-slate-600">{o.trackingNumber || "—"}</td>
                    <td className="p-3 text-right font-bold text-slate-800">{fmtMoney(o.total)}</td>
                    <td className="p-3 text-center">
                      <button onClick={() => openDetail(o.id)} className="px-2.5 py-1 text-[11px] bg-slate-100 hover:bg-slate-200 text-slate-700 rounded font-medium">
                        Detalhe
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="p-3 bg-slate-50 border-t flex flex-wrap items-center justify-between text-xs text-slate-600 gap-2">
          <span>Total: <strong>{pagination.total}</strong> encomendas · Página <strong>{pagination.page}</strong> de <strong>{pagination.totalPages}</strong></span>
          <div className="flex items-center gap-2">
            <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))} className="border rounded px-2 py-1 text-xs">
              <option value={10}>10 por pág</option>
              <option value={25}>25 por pág</option>
              <option value={50}>50 por pág</option>
              <option value={100}>100 por pág</option>
            </select>
            <button onClick={() => load(pagination.page - 1)} disabled={pagination.page <= 1} className="px-2.5 py-1 border rounded bg-white disabled:opacity-40">Anterior</button>
            <button onClick={() => load(pagination.page + 1)} disabled={pagination.page >= pagination.totalPages} className="px-2.5 py-1 border rounded bg-white disabled:opacity-40">Seguinte</button>
          </div>
        </div>
      </div>

      {/* Picking Sheet Modal / Print View */}
      {pickingSheetOrder && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 overflow-y-auto print:p-0 print:bg-white print:static">
          <div className="bg-white rounded-xl max-w-3xl w-full p-6 shadow-2xl space-y-4 print:shadow-none print:p-0 print:max-w-none">
            <div className="flex justify-between items-start border-b pb-3 print:border-b-2 print:border-black">
              <div>
                <h3 className="text-lg font-bold text-slate-900">Guia de Preparação e Picking</h3>
                <p className="text-xs text-slate-500">Encomenda #{pickingSheetOrder.order.orderNumber} · {fmtDate(pickingSheetOrder.order.createdAt)}</p>
              </div>
              <div className="flex gap-2 print:hidden">
                <button onClick={() => window.print()} className="px-3 py-1.5 bg-slate-900 text-white rounded text-xs font-semibold hover:bg-slate-800">
                  🖨 Imprimir
                </button>
                <button onClick={() => setPickingSheetOrder(null)} className="px-3 py-1.5 bg-slate-100 text-slate-700 rounded text-xs hover:bg-slate-200">
                  Fechar
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 text-xs">
              <div className="border rounded p-3 bg-slate-50 print:bg-white">
                <h4 className="font-bold text-slate-800 mb-1">Dados de Entrega</h4>
                <p><strong>Tipo:</strong> {pickingSheetOrder.order.deliveryType === "pickup" ? "Levantamento em loja" : "Envio ao domicílio"}</p>
                <p><strong>Método:</strong> {pickingSheetOrder.order.shippingMethod || "Padrão"}</p>
                <div className="mt-1">
                  <h5 className="font-semibold text-[11px] text-slate-600">Morada de envio:</h5>
                  <AddressBlock addr={pickingSheetOrder.order.shippingAddress || pickingSheetOrder.order.billingAddress} />
                </div>
              </div>
              <div className="border rounded p-3 bg-slate-50 print:bg-white">
                <h4 className="font-bold text-slate-800 mb-1">Cliente & Observações</h4>
                <p><strong>Nome:</strong> {pickingSheetOrder.customer?.name || pickingSheetOrder.order.guestName || "Cliente"}</p>
                <p><strong>Email:</strong> {pickingSheetOrder.customer?.email || pickingSheetOrder.order.guestEmail || "—"}</p>
                <p><strong>Telefone:</strong> {pickingSheetOrder.customer?.phone || pickingSheetOrder.order.guestPhone || "—"}</p>
                {pickingSheetOrder.order.notes && (
                  <div className="mt-2 p-2 bg-amber-50 border border-amber-200 rounded text-[11px] text-amber-800">
                    <strong>Notas do cliente:</strong> {pickingSheetOrder.order.notes}
                  </div>
                )}
              </div>
            </div>

            <div>
              <h4 className="font-bold text-xs text-slate-800 mb-2">Itens para Separação / Picking</h4>
              <table className="w-full text-xs border border-slate-200 text-left">
                <thead className="bg-slate-100 text-slate-700 border-b">
                  <tr>
                    <th className="p-2 w-8 text-center">✓</th>
                    <th className="p-2">Produto</th>
                    <th className="p-2">SKU</th>
                    <th className="p-2">EAN</th>
                    <th className="p-2 text-right">Qtd</th>
                    <th className="p-2 text-right">Stock Armazém</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {pickingSheetOrder.items.map((i) => (
                    <tr key={i.id}>
                      <td className="p-2 text-center border-r font-mono text-base">[ ]</td>
                      <td className="p-2 font-medium">{i.productName}</td>
                      <td className="p-2 font-mono text-slate-600">{i.productSku || "—"}</td>
                      <td className="p-2 font-mono text-slate-600">{i.ean || "—"}</td>
                      <td className="p-2 text-right font-bold text-base">{i.quantity}</td>
                      <td className="p-2 text-right text-slate-500">{i.warehouseStock ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="border-t pt-3 flex justify-between text-xs text-slate-500">
              <div>Separado por: ________________________ Data: ____/____/________</div>
              <div>Conferido por: ________________________</div>
            </div>
          </div>
        </div>
      )}

      {/* Order Detail Modal / Panel */}
      {detailLoading && <div className="p-6 text-center text-slate-400">A carregar detalhe da encomenda...</div>}

      {detail && (
        <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm space-y-6">
          <div className="flex flex-wrap justify-between items-start border-b pb-4 gap-4">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-bold text-slate-900">Encomenda #{detail.order.orderNumber}</h3>
                <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold ${statusColor(detail.order.status)}`}>
                  {STATUS_LABELS[detail.order.status] || detail.order.status}
                </span>
                <span className="px-2 py-0.5 rounded-full text-xs bg-slate-100 text-slate-700">
                  {PAYMENT_STATUS_LABELS[detail.order.paymentStatus] || detail.order.paymentStatus}
                </span>
              </div>
              <p className="text-xs text-slate-500 mt-1">Criada em {fmtDate(detail.order.createdAt)} · Atualizada em {fmtDate(detail.order.updatedAt)}</p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setPickingSheetOrder(detail)}
                className="px-3 py-1.5 bg-slate-900 text-white rounded text-xs font-medium hover:bg-slate-800"
              >
                🖨 Imprimir Picking
              </button>
              <button onClick={() => setDetail(null)} className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded text-xs">
                Fechar
              </button>
            </div>
          </div>

          {/* Operational Fulfillment & Delivery Panel */}
          <section className="bg-slate-50 border rounded-xl p-4">
            <h4 className="font-bold text-sm text-slate-800 mb-3">
              {detail.order.deliveryType === "pickup" ? "📦 Levantamento em Loja" : "🚚 Envio ao Domicílio"}
            </h4>

            {detail.order.deliveryType === "shipping" ? (
              <div className="space-y-3 text-xs">
                <div className="flex flex-wrap gap-4 items-center">
                  <span>Método de envio: <strong>{detail.order.shippingMethod || "Padrão"}</strong></span>
                  <div className="flex items-center gap-2 flex-1 min-w-64">
                    <input
                      type="text"
                      value={tracking}
                      onChange={(e) => setTracking(e.target.value)}
                      placeholder="N.º de seguimento (tracking)"
                      className="border rounded px-3 py-1.5 text-xs flex-1 bg-white"
                      maxLength={255}
                    />
                    <button onClick={saveTracking} disabled={saving} className="px-3 py-1.5 bg-slate-800 text-white rounded text-xs disabled:opacity-50">
                      Guardar Tracking
                    </button>
                  </div>
                </div>
                {detail.order.status === "processing" && (
                  <div className="p-2.5 bg-blue-50 border border-blue-200 rounded flex justify-between items-center">
                    <span className="text-blue-800">Encomenda pronta para envio após embalamento?</span>
                    <button
                      onClick={() => changeStatus("shipped")}
                      disabled={saving}
                      className="px-3 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded font-medium disabled:opacity-50"
                    >
                      Marcar como Enviada (Shipped)
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-3 text-xs">
                <div className="p-2.5 bg-purple-50 border border-purple-200 rounded text-purple-900">
                  Esta encomenda deve ser levantada na loja física pelo cliente.
                </div>
                {detail.order.status === "processing" && (
                  <div className="flex justify-between items-center p-2.5 bg-indigo-50 border border-indigo-200 rounded">
                    <span className="text-indigo-800">Itens separados e prontos para o cliente levantar?</span>
                    <button
                      onClick={() => changeStatus("ready_for_pickup")}
                      disabled={saving}
                      className="px-3 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded font-medium disabled:opacity-50"
                    >
                      Marcar Pronto para Levantamento
                    </button>
                  </div>
                )}
                {detail.order.status === "ready_for_pickup" && (
                  <div className="flex justify-between items-center p-2.5 bg-green-50 border border-green-200 rounded">
                    <span className="text-green-800">Cliente recolheu os produtos na loja física?</span>
                    <button
                      onClick={() => changeStatus("delivered")}
                      disabled={saving}
                      className="px-3 py-1 bg-green-600 hover:bg-green-500 text-white rounded font-medium disabled:opacity-50"
                    >
                      Confirmar Entrega ao Cliente (Delivered)
                    </button>
                  </div>
                )}
              </div>
            )}
          </section>

          {/* Customer & Addresses */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
            <div className="border rounded p-3">
              <h5 className="font-bold text-slate-800 mb-1">Cliente</h5>
              <p><strong>Nome:</strong> {detail.customer?.name || detail.order.guestName || "—"}</p>
              <p><strong>Email:</strong> {detail.customer?.email || detail.order.guestEmail || "—"}</p>
              <p><strong>Telefone:</strong> {detail.customer?.phone || detail.order.guestPhone || "—"}</p>
              <p><strong>NIF:</strong> {detail.customer?.nif || detail.order.nif || "—"}</p>
            </div>
            <div className="border rounded p-3">
              <h5 className="font-bold text-slate-800 mb-1">Morada de Envio</h5>
              <AddressBlock addr={detail.order.shippingAddress} />
            </div>
            <div className="border rounded p-3">
              <h5 className="font-bold text-slate-800 mb-1">Morada de Faturação</h5>
              <AddressBlock addr={detail.order.billingAddress} />
            </div>
          </div>

          {/* Items Table */}
          <section>
            <h4 className="font-semibold mb-2 text-sm">Itens da Encomenda</h4>
            <div className="border rounded overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead className="bg-slate-50 border-b">
                  <tr>
                    <th className="p-2">Produto</th>
                    <th className="p-2 text-center">SKU</th>
                    <th className="p-2 text-right">Qtd</th>
                    <th className="p-2 text-right">Preço Unit. (Bruto)</th>
                    <th className="p-2 text-right">Preço Unit. (Líquido)</th>
                    <th className="p-2 text-right">IVA</th>
                    <th className="p-2 text-right">Desc.</th>
                    <th className="p-2 text-right">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {detail.items.map(i => (
                    <tr key={i.id}>
                      <td className="p-2 font-medium">{i.productName}</td>
                      <td className="p-2 text-center font-mono text-slate-600">{i.productSku || "—"}</td>
                      <td className="p-2 text-right font-bold">{i.quantity}</td>
                      <td className="p-2 text-right">{fmtMoney(i.unitPriceGross)}</td>
                      <td className="p-2 text-right">{fmtMoney(i.unitPriceNet)}</td>
                      <td className="p-2 text-right">{fmtMoney(i.vatAmount)} ({i.vatRate}%)</td>
                      <td className="p-2 text-right">{fmtMoney(i.discountAmount)}</td>
                      <td className="p-2 text-right font-semibold">{fmtMoney(i.lineTotalGross)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex justify-end mt-2 text-xs text-slate-700">
              <div className="space-y-1 text-right min-w-48">
                <div>Subtotal: <strong>{fmtMoney(detail.order.subtotal)}</strong></div>
                <div>Envio: <strong>{fmtMoney(detail.order.shipping)}</strong></div>
                <div>IVA: <strong>{fmtMoney(detail.order.vat)}</strong></div>
                {parseFloat(detail.order.discount || "0") > 0 && <div>Desconto: <strong>-{fmtMoney(detail.order.discount)}</strong></div>}
                <div className="text-sm font-bold border-t pt-1 text-slate-900">Total: {fmtMoney(detail.order.total)}</div>
              </div>
            </div>
          </section>

          {/* Unified Operational Timeline */}
          <section className="border-t pt-4">
            <h4 className="font-semibold mb-3 text-sm text-slate-800">Linha Temporal Operacional Unificada</h4>
            {detail.timeline.length === 0 ? (
              <p className="text-xs text-slate-400">Sem eventos registados.</p>
            ) : (
              <div className="space-y-2 relative border-l-2 border-slate-200 ml-3 pl-4">
                {detail.timeline.map((event) => (
                  <div key={event.id} className="relative text-xs">
                    <div className="absolute -left-[21px] top-1 w-2.5 h-2.5 rounded-full bg-slate-400 border border-white" />
                    <div className="flex flex-wrap justify-between items-baseline gap-2">
                      <span className="font-semibold text-slate-800">{event.title}</span>
                      <span className="text-[10px] text-slate-400">{fmtDate(event.timestamp)}</span>
                    </div>
                    {event.description && <p className="text-slate-600 mt-0.5">{event.description}</p>}
                    {event.actor && <p className="text-[10px] text-slate-400">Por: {event.actor}</p>}
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Payment Attempts */}
          <section className="border-t pt-4">
            <h4 className="font-semibold mb-2 text-sm text-slate-800">Tentativas de Pagamento (Gateway)</h4>
            {detail.paymentAttempts.length === 0 ? (
              <p className="text-xs text-slate-400">Sem tentativas de gateway registadas.</p>
            ) : (
              <div className="space-y-1.5">
                {detail.paymentAttempts.map((pa) => (
                  <div key={pa.id} className="text-xs bg-slate-50 border rounded p-2.5 flex flex-wrap justify-between items-center gap-2">
                    <div>
                      <span className="font-bold">{pa.provider}</span> · Método: <strong>{pa.method}</strong> · Montante: <strong>{fmtCents(pa.amountCents)} {pa.currency}</strong> · Estado: <span className="font-semibold">{pa.status}</span>
                      {pa.providerReference && <span className="block text-[11px] text-slate-500">Ref: {pa.providerReference}</span>}
                      {pa.providerTransactionId && <span className="block text-[11px] text-slate-500">Trx ID: {pa.providerTransactionId}</span>}
                      {pa.recoveryState && <span className="block text-[11px] text-amber-600 font-semibold">Estado de recuperação: {pa.recoveryState}</span>}
                      {pa.failureReason && <span className="block text-[11px] text-red-600">Erro: {pa.failureReason}</span>}
                    </div>
                    <span className="text-[10px] text-slate-400">{fmtDate(pa.createdAt)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Manual Invoicing & Credit Notes */}
          <section className="border-t pt-4">
            <h4 className="font-semibold mb-2 text-sm text-slate-800">Documentos Fiscais & Faturação Manual</h4>
            {detail.invoiceDocuments.length === 0 ? (
              <p className="text-xs text-slate-400 mb-2">Sem documentos fiscais registados.</p>
            ) : (
              detail.invoiceDocuments.map((doc) => (
                <div key={doc.id} className="text-xs bg-slate-50 border rounded p-2 mb-1.5 flex justify-between items-center">
                  <div>
                    <strong>{doc.documentType === "invoice" ? "Fatura" : "Nota de Crédito"}</strong> · Ref: <strong>{doc.documentNumber || doc.documentReference || "—"}</strong> · Estado: {doc.status} · {doc.amountCents != null ? `${fmtCents(doc.amountCents)} ${doc.currency}` : ""}
                  </div>
                  <span className="text-[10px] text-slate-400">Emitido: {fmtDate(doc.issuedAt)}</span>
                </div>
              ))
            )}

            {/* Record Invoice Form */}
            {!detail.invoiceDocuments.some((doc) => doc.documentType === "invoice" && doc.status === "issued") && (
              <div className="mt-3 p-3 bg-slate-50 border rounded-lg">
                <h5 className="font-semibold text-xs text-slate-700 mb-2">Registar Fatura Manual Emitida Externamente</h5>
                <div className="flex flex-wrap gap-2">
                  <input
                    value={invoiceReference}
                    onChange={(e) => setInvoiceReference(e.target.value)}
                    maxLength={100}
                    placeholder="Referência oficial (ex. FT 2026/001)"
                    className="border rounded px-3 py-1.5 text-xs flex-1 min-w-48 bg-white"
                  />
                  <input
                    type="date"
                    value={invoiceIssuedAt}
                    onChange={(e) => setInvoiceIssuedAt(e.target.value)}
                    className="border rounded px-3 py-1.5 text-xs bg-white"
                  />
                  <button onClick={recordInvoice} disabled={saving || !invoiceReference.trim()} className="px-3 py-1.5 bg-sky-600 text-white rounded text-xs disabled:opacity-50">
                    Registar Fatura
                  </button>
                </div>
              </div>
            )}

            {/* Record Credit Note Form (if refund exists and invoice exists) */}
            {detail.refundState && detail.refundState.refundedCents > 0 && detail.invoiceDocuments.some(doc => doc.documentType === "invoice" && doc.status === "issued") && (
              <div className="mt-3 p-3 bg-amber-50/70 border border-amber-200 rounded-lg">
                <h5 className="font-semibold text-xs text-amber-900 mb-2">Registar Nota de Crédito Manual (Reembolso)</h5>
                <div className="flex flex-wrap gap-2">
                  <select
                    value={creditNoteOriginalDocId || ""}
                    onChange={(e) => setCreditNoteOriginalDocId(Number(e.target.value))}
                    className="border rounded px-2.5 py-1.5 text-xs bg-white"
                  >
                    {detail.invoiceDocuments.filter(d => d.documentType === "invoice" && d.status === "issued").map(d => (
                      <option key={d.id} value={d.id}>Fatura original: {d.documentNumber || d.providerDocumentId}</option>
                    ))}
                  </select>
                  <input
                    value={creditNoteReference}
                    onChange={(e) => setCreditNoteReference(e.target.value)}
                    maxLength={100}
                    placeholder="Referência NC oficial (ex. NC 2026/001)"
                    className="border rounded px-3 py-1.5 text-xs flex-1 min-w-36 bg-white"
                  />
                  <input
                    value={creditNoteAmount}
                    onChange={(e) => setCreditNoteAmount(e.target.value)}
                    maxLength={12}
                    placeholder="Montante €"
                    className="border rounded px-3 py-1.5 text-xs w-28 bg-white"
                  />
                  <input
                    type="date"
                    value={creditNoteIssuedAt}
                    onChange={(e) => setCreditNoteIssuedAt(e.target.value)}
                    className="border rounded px-3 py-1.5 text-xs bg-white"
                  />
                  <button onClick={recordCreditNote} disabled={saving || !creditNoteReference.trim() || !parseEurosToCents(creditNoteAmount)} className="px-3 py-1.5 bg-amber-700 text-white rounded text-xs disabled:opacity-50">
                    Registar Nota de Crédito
                  </button>
                </div>
              </div>
            )}
          </section>

          {/* Refunds Section */}
          <section className="border-t pt-4">
            <h4 className="font-semibold mb-2 text-sm text-slate-800">Reembolsos & Compensações</h4>
            {detail.refundState ? (
              <>
                <div className="text-xs bg-slate-50 border rounded p-3 mb-2 grid grid-cols-2 md:grid-cols-4 gap-2">
                  <span>Pago: <strong>{fmtCents(detail.refundState.paidCents)}</strong></span>
                  <span>Reembolsado: <strong>{fmtCents(detail.refundState.refundedCents)}</strong></span>
                  <span>Comprometido: <strong>{fmtCents(detail.refundState.committedCents)}</strong></span>
                  <span>Disponível p/ Reembolso: <strong>{fmtCents(detail.refundState.remainingRefundableCents)}</strong></span>
                </div>
                {detail.refundState.refunds.map((r) => (
                  <div key={r.id} className="text-xs bg-slate-50 border rounded p-2 mb-1.5 flex flex-wrap justify-between items-center gap-2">
                    <div>
                      #{r.id} · {fmtCents(r.amountCents)} {r.currency} · <strong>{REFUND_STATUS_LABELS[r.status] || r.status}</strong> · {r.provider}
                      {r.providerRefundId && <span> · Ref: {r.providerRefundId}</span>}
                      {r.reason && <span className="block text-[11px] text-slate-500">Motivo: {r.reason}</span>}
                    </div>
                    <div className="flex gap-1">
                      {r.status === "pending" && r.provider === "manual" && (
                        <button onClick={() => refundAction(r.id, "complete")} disabled={saving} className="px-2 py-0.5 bg-green-600 text-white rounded text-[11px]">Concluir c/ ref</button>
                      )}
                      {r.status === "pending" && (
                        <button onClick={() => refundAction(r.id, "cancel")} disabled={saving} className="px-2 py-0.5 bg-slate-500 text-white rounded text-[11px]">Cancelar</button>
                      )}
                      {r.status === "failed" && (
                        <button onClick={() => refundAction(r.id, "retry")} disabled={saving} className="px-2 py-0.5 bg-sky-600 text-white rounded text-[11px]">Reintentar</button>
                      )}
                    </div>
                  </div>
                ))}
                {detail.refundState.paidCents > 0 && detail.refundState.remainingRefundableCents > 0 && (
                  <div className="border rounded p-3 mt-2 bg-slate-50">
                    <div className="flex flex-wrap gap-2">
                      <input value={refundAmount} onChange={(e) => setRefundAmount(e.target.value)} maxLength={12} placeholder="Montante € (ex. 15.00)" className="border rounded px-3 py-1.5 text-xs w-36 bg-white" />
                      <input value={refundReason} onChange={(e) => setRefundReason(e.target.value)} maxLength={500} placeholder="Motivo interno (opcional)" className="border rounded px-3 py-1.5 text-xs flex-1 min-w-48 bg-white" />
                    </div>
                    <label className="flex items-center gap-2 mt-2 text-xs text-slate-600">
                      <input type="checkbox" checked={refundAsCompleted} onChange={(e) => setRefundAsCompleted(e.target.checked)} />
                      Registar como reembolso manual CONCLUÍDO (o dinheiro já foi devolvido ao cliente externamente)
                    </label>
                    {refundAsCompleted && (
                      <div className="flex flex-wrap gap-2 mt-2">
                        <input value={refundReference} onChange={(e) => setRefundReference(e.target.value)} maxLength={255} placeholder="Referência externa (obrigatória)" className="border rounded px-3 py-1.5 text-xs flex-1 min-w-48 bg-white" />
                        <input type="date" value={refundCompletedAt} onChange={(e) => setRefundCompletedAt(e.target.value)} className="border rounded px-3 py-1.5 text-xs bg-white" />
                      </div>
                    )}
                    <button onClick={submitRefund} disabled={saving || !parseEurosToCents(refundAmount)} className="mt-2 px-3 py-1.5 bg-sky-600 text-white rounded text-xs disabled:opacity-50">
                      Solicitar Reembolso
                    </button>
                  </div>
                )}
              </>
            ) : <p className="text-xs text-slate-400">Estado de reembolso indisponível.</p>}
          </section>

          {/* Change Status */}
          <section className="border-t pt-4">
            <h4 className="font-semibold mb-2 text-sm text-slate-800">Transição de Estado</h4>
            <div className="flex gap-2 flex-wrap items-center">
              <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Comentário opcional (ficará registado na linha temporal)" className="border rounded px-3 py-1.5 text-xs flex-1 min-w-48" />
              {detail.order.allowedTransitions.filter((s) => s !== "expired").map((s) => (
                <button
                  key={s}
                  onClick={() => changeStatus(s)}
                  disabled={saving}
                  className={`px-3 py-1.5 rounded text-xs text-white disabled:opacity-50 ${CRITICAL_STATUSES.includes(s) ? "bg-red-500 hover:bg-red-600" : "bg-sky-600 hover:bg-sky-500"}`}
                >
                  {STATUS_LABELS[s] || s}
                </button>
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
