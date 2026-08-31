"use client";
import { useCallback, useEffect, useState } from "react";
import type { AdminCustomerListRow, AdminCustomerListPagination, AdminCustomerDetail } from "@/lib/services/admin-customers-service";

const STATUS_OPTIONS = [
  { value: "all", label: "Todos" },
  { value: "active", label: "Ativos" },
  { value: "disabled", label: "Desativados" },
  { value: "with_orders", label: "Com encomendas" },
  { value: "without_orders", label: "Sem encomendas" },
];

const SORT_OPTIONS = [
  { value: "newest", label: "Mais recentes" },
  { value: "oldest", label: "Mais antigos" },
  { value: "name_asc", label: "Nome (A → Z)" },
  { value: "name_desc", label: "Nome (Z → A)" },
  { value: "orders_desc", label: "Mais encomendas" },
  { value: "spend_desc", label: "Maior valor gasto" },
  { value: "last_order_desc", label: "Última encomenda" },
];

type Filters = {
  search: string;
  status: string;
  registeredFrom: string;
  registeredTo: string;
  lastOrderFrom: string;
  lastOrderTo: string;
  sort: string;
};

function fmtDate(d: Date | string | null | undefined) {
  return d ? new Date(d).toLocaleDateString("pt-PT") : "—";
}

function fmtCents(cents: number): string {
  return new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR" }).format(cents / 100);
}

export default function AdminCustomersPage() {
  const [customers, setCustomers] = useState<AdminCustomerListRow[]>([]);
  const [pagination, setPagination] = useState<AdminCustomerListPagination>({ page: 1, pageSize: 25, total: 0, totalPages: 1 });
  const [pageSize, setPageSize] = useState(25);
  const [filters, setFilters] = useState<Filters>({
    search: "", status: "all", registeredFrom: "", registeredTo: "", lastOrderFrom: "", lastOrderTo: "", sort: "newest",
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<AdminCustomerDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (page = 1) => {
    setLoading(true); setError("");
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize), sort: filters.sort });
    (Object.entries(filters) as [keyof Filters, string][]).forEach(([k, v]) => {
      if (v && k !== "sort" && k !== "status") params.set(k, v);
    });
    if (filters.status && filters.status !== "all") params.set("status", filters.status);
    try {
      const res = await fetch(`/api/admin/customers?${params}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Erro");
      setCustomers(data.customers || []);
      setPagination(data.pagination || { page: 1, pageSize, total: 0, totalPages: 1 });
    } catch (e) { setError((e as Error).message); }
    setLoading(false);
  }, [filters, pageSize]);

  useEffect(() => { const t = setTimeout(() => load(1), 300); return () => clearTimeout(t); }, [filters, pageSize, load]);

  const openDetail = async (id: number) => {
    setDetailLoading(true); setDetail(null); setError(""); setNoteText("");
    try {
      const res = await fetch(`/api/admin/customers/${id}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Erro");
      setDetail(data);
    } catch (e) { setError((e as Error).message); }
    setDetailLoading(false);
  };

  const toggleStatus = async (action: "disable" | "reactivate") => {
    if (!detail || saving) return;
    if (action === "disable" && !confirm("Tem a certeza que deseja desativar esta conta? O cliente não conseguirá fazer login. (Dados históricos preservados.)")) return;
    setSaving(true); setError("");
    const res = await fetch(`/api/admin/customers/${detail.customer.id}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) { setError(data.error || "Erro"); return; }
    await openDetail(detail.customer.id);
    load(pagination.page);
  };

  const addNote = async () => {
    if (!detail || !noteText.trim() || saving) return;
    setSaving(true); setError("");
    const res = await fetch(`/api/admin/customers/${detail.customer.id}/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: noteText.trim() }),
    });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) { setError(data.error || "Erro"); return; }
    setNoteText("");
    await openDetail(detail.customer.id);
  };

  const deleteNote = async (noteId: number) => {
    if (!detail) return;
    setSaving(true);
    const res = await fetch(`/api/admin/customers/${detail.customer.id}/notes/${noteId}`, { method: "DELETE" });
    setSaving(false);
    if (!res.ok) { const d = await res.json(); setError(d.error || "Erro"); return; }
    await openDetail(detail.customer.id);
  };

  const setFilter = (patch: Partial<Filters>) => setFilters(f => ({ ...f, ...patch }));

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold text-slate-800">Clientes</h2>
        <span className="text-sm text-slate-500">{pagination.total} cliente(s)</span>
      </div>

      <div className="bg-white border rounded-xl p-4 mb-4 flex flex-wrap gap-2 items-center">
        <input value={filters.search} onChange={e => setFilter({ search: e.target.value })} placeholder="Pesquisar nome, email, telefone, NIF, empresa..." className="border rounded px-3 py-1.5 text-sm w-80" />
        <select value={filters.status} onChange={e => setFilter({ status: e.target.value })} className="border rounded px-2 py-1.5 text-sm">
          {STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select value={filters.sort} onChange={e => setFilter({ sort: e.target.value })} className="border rounded px-2 py-1.5 text-sm">
          {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <span className="text-xs text-slate-400">Registo:</span>
        <input type="date" value={filters.registeredFrom} onChange={e => setFilter({ registeredFrom: e.target.value })} className="border rounded px-2 py-1.5 text-sm text-slate-600" aria-label="Registo de" />
        <span className="text-slate-400 text-sm">→</span>
        <input type="date" value={filters.registeredTo} onChange={e => setFilter({ registeredTo: e.target.value })} className="border rounded px-2 py-1.5 text-sm text-slate-600" aria-label="Registo até" />
        <span className="text-xs text-slate-400 ml-2">Últ. encomenda:</span>
        <input type="date" value={filters.lastOrderFrom} onChange={e => setFilter({ lastOrderFrom: e.target.value })} className="border rounded px-2 py-1.5 text-sm text-slate-600" aria-label="Última encomenda de" />
        <span className="text-slate-400 text-sm">→</span>
        <input type="date" value={filters.lastOrderTo} onChange={e => setFilter({ lastOrderTo: e.target.value })} className="border rounded px-2 py-1.5 text-sm text-slate-600" aria-label="Última encomenda até" />
        <select value={pageSize} onChange={e => setPageSize(parseInt(e.target.value))} className="border rounded px-2 py-1.5 text-sm ml-auto">
          <option value="25">25 / página</option><option value="50">50 / página</option><option value="100">100 / página</option>
        </select>
      </div>

      {error && <div className="mb-4 p-3 bg-red-50 text-red-600 rounded-lg text-sm">{error}</div>}

      <div className="bg-white rounded-xl border overflow-hidden">
        {loading && <p className="text-sm text-slate-500 p-4">A carregar...</p>}
        {!loading && customers.length === 0 && (
          <div className="p-10 text-center text-slate-500">
            <p className="text-3xl mb-2">👥</p>
            <p className="text-sm font-medium">Nenhum cliente encontrado</p>
            <p className="text-xs text-slate-400 mt-1">Ajusta os filtros ou a pesquisa.</p>
          </div>
        )}
        {!loading && customers.length > 0 && (
          <table className="w-full text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="text-left p-3">Cliente</th>
                <th className="text-left p-3 hidden md:table-cell">Telefone</th>
                <th className="text-left p-3 hidden md:table-cell">NIF</th>
                <th className="text-center p-3">Estado</th>
                <th className="text-right p-3">Encomendas</th>
                <th className="text-right p-3">Total gasto</th>
                <th className="text-left p-3 hidden lg:table-cell">Últ. encomenda</th>
                <th className="text-left p-3 hidden lg:table-cell">Registo</th>
                <th className="text-right p-3">Ações</th>
              </tr>
            </thead>
            <tbody>
              {customers.map(c => (
                <tr key={c.id} className={`border-t hover:bg-slate-50 ${!c.isActive ? "opacity-60" : ""}`}>
                  <td className="p-3">
                    <p className="font-medium">{c.name}</p>
                    <p className="text-xs text-slate-400">{c.email}</p>
                    {c.company && <p className="text-xs text-slate-500">{c.company}</p>}
                  </td>
                  <td className="p-3 hidden md:table-cell text-slate-600">{c.phone || "—"}</td>
                  <td className="p-3 hidden md:table-cell text-slate-600">{c.nif || "—"}</td>
                  <td className="p-3 text-center">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${c.isActive ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"}`}>
                      {c.isActive ? "Ativo" : "Desativado"}
                    </span>
                  </td>
                  <td className="p-3 text-right font-bold">{c.orderCount}</td>
                  <td className="p-3 text-right">{fmtCents(c.totalSpentCents)}</td>
                  <td className="p-3 hidden lg:table-cell text-slate-500 text-xs">{fmtDate(c.lastOrderDate)}</td>
                  <td className="p-3 hidden lg:table-cell text-slate-500 text-xs">{fmtDate(c.createdAt)}</td>
                  <td className="p-3 text-right"><button onClick={() => openDetail(c.id)} className="text-sky-600 text-xs font-medium">Detalhes</button></td>
                </tr>
              ))}
            </tbody>
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
          <div className="flex justify-between mb-4">
            <h3 className="font-bold text-slate-800">Cliente: {detail.customer.name}</h3>
            <button onClick={() => setDetail(null)} className="text-slate-400 hover:text-slate-600">Fechar</button>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            <div className="bg-slate-50 rounded-lg p-3 text-center">
              <p className="text-2xl font-bold text-sky-600">{detail.statistics.totalOrders}</p>
              <p className="text-xs text-slate-500">Encomendas</p>
            </div>
            <div className="bg-slate-50 rounded-lg p-3 text-center">
              <p className="text-2xl font-bold text-green-600">{fmtCents(detail.statistics.totalSpentCents)}</p>
              <p className="text-xs text-slate-500">Total gasto</p>
            </div>
            <div className="bg-slate-50 rounded-lg p-3 text-center">
              <p className="text-2xl font-bold text-amber-600">{fmtCents(detail.statistics.averageOrderValueCents)}</p>
              <p className="text-xs text-slate-500">Ticket médio</p>
            </div>
            <div className="bg-slate-50 rounded-lg p-3 text-center">
              <p className="text-2xl font-bold text-slate-600">{fmtDate(detail.statistics.lastOrderDate)}</p>
              <p className="text-xs text-slate-500">Última encomenda</p>
            </div>
          </div>

          <div className="grid md:grid-cols-2 gap-6 text-sm">
            <section>
              <h4 className="font-semibold mb-2">Dados do cliente</h4>
              <p><strong>Email:</strong> {detail.customer.email}</p>
              <p><strong>Telefone:</strong> {detail.customer.phone || "—"}</p>
              <p><strong>NIF:</strong> {detail.customer.nif || "—"}</p>
              <p><strong>Empresa:</strong> {detail.customer.company || "—"}</p>
              <p><strong>Registo:</strong> {fmtDate(detail.customer.createdAt)}</p>
              <p><strong>Estado:</strong> <span className={`px-2 py-0.5 rounded text-xs font-medium ${detail.customer.isActive ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"}`}>{detail.customer.isActive ? "Ativo" : "Desativado"}</span></p>
            </section>

            <section>
              <h4 className="font-semibold mb-2">RMA / Wishlist</h4>
              <p><strong>Pedidos RMA:</strong> {detail.rmaSummary.total} (abertos: {detail.rmaSummary.open})</p>
              <p><strong>Produtos na wishlist:</strong> {detail.wishlistCount}</p>
            </section>
          </div>

          <section className="mt-6">
            <h4 className="font-semibold mb-2 text-sm">Moradas ({detail.addresses.length})</h4>
            {detail.addresses.length === 0 ? <p className="text-xs text-slate-400">Sem moradas registadas.</p> : (
              <div className="grid sm:grid-cols-2 gap-3">
                {detail.addresses.map(a => (
                  <div key={a.id} className="border rounded-lg p-3 text-xs">
                    {a.label && <p className="font-semibold text-slate-700 mb-1">{a.label}</p>}
                    <p>{a.name}</p>
                    <p>{a.address1}{a.address2 ? `, ${a.address2}` : ""}</p>
                    <p>{a.postalCode} {a.city}</p>
                    <p>{a.country}</p>
                    {a.phone && <p>Tel: {a.phone}</p>}
                    <div className="mt-1 flex gap-2">
                      {a.isDefaultBilling && <span className="bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded text-[10px]">Faturação padrão</span>}
                      {a.isDefaultShipping && <span className="bg-green-50 text-green-700 px-1.5 py-0.5 rounded text-[10px]">Envio padrão</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="mt-6">
            <h4 className="font-semibold mb-2 text-sm">Encomendas ({detail.ordersPaginated.pagination.total})</h4>
            {detail.ordersPaginated.orders.length === 0 ? <p className="text-xs text-slate-400">Sem encomendas.</p> : (
              <>
                <table className="w-full text-xs">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="text-left p-2">N.º</th><th className="text-left p-2">Data</th>
                      <th className="text-right p-2">Total</th><th className="text-center p-2">Estado</th>
                      <th className="text-center p-2">Pagamento</th><th className="text-center p-2 hidden md:table-cell">Entrega</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.ordersPaginated.orders.map(o => (
                      <tr key={o.id} className="border-t">
                        <td className="p-2 font-medium">#{o.orderNumber}</td>
                        <td className="p-2">{fmtDate(o.createdAt)}</td>
                        <td className="p-2 text-right">{parseFloat(o.total).toFixed(2)}€</td>
                        <td className="p-2 text-center">{o.status}</td>
                        <td className="p-2 text-center">{o.paymentStatus}</td>
                        <td className="p-2 text-center hidden md:table-cell">{o.deliveryType === "pickup" ? "📍 Loja" : "🚚 Envio"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {detail.ordersPaginated.pagination.totalPages > 1 && (
                  <p className="text-xs text-slate-400 mt-2">Página {detail.ordersPaginated.pagination.page} de {detail.ordersPaginated.pagination.totalPages} — {detail.ordersPaginated.pagination.total} total</p>
                )}
              </>
            )}
          </section>

          <section className="mt-6">
            <h4 className="font-semibold mb-2 text-sm">Notas internas ({detail.notes.length})</h4>
            <div className="flex gap-2 mb-3">
              <input value={noteText} onChange={e => setNoteText(e.target.value)} maxLength={5000} placeholder="Nova nota..." className="border rounded px-3 py-1.5 text-xs flex-1" />
              <button onClick={addNote} disabled={saving || !noteText.trim()} className="px-3 py-1.5 bg-sky-600 text-white rounded text-xs disabled:opacity-50">Adicionar</button>
            </div>
            {detail.notes.length === 0 ? <p className="text-xs text-slate-400">Sem notas.</p> : detail.notes.map(n => (
              <div key={n.id} className="border-t py-2 text-xs flex justify-between items-start">
                <div className="flex-1">
                  <p className="text-slate-700">{n.note}</p>
                  <p className="text-slate-400 mt-0.5">{n.authorName || n.authorEmail || "Sistema"} · {fmtDate(n.createdAt)}{n.updatedAt ? ` (editado ${fmtDate(n.updatedAt)})` : ""}</p>
                </div>
                <button onClick={() => deleteNote(n.id)} disabled={saving} className="text-red-400 hover:text-red-600 text-xs ml-2 disabled:opacity-50">Apagar</button>
              </div>
            ))}
          </section>

          <section className="mt-6">
            <h4 className="font-semibold mb-2 text-sm">Conta</h4>
            <p className="text-xs text-slate-500 mb-3">
              {detail.customer.isActive
                ? "Desativar a conta impede o login mas preserva todos os dados históricos (encomendas, RMA, etc.)."
                : "Reativar a conta permite ao cliente fazer login novamente. Password inalterada."}
            </p>
            {detail.customer.isActive ? (
              <button onClick={() => toggleStatus("disable")} disabled={saving} className="px-4 py-2 bg-red-500 text-white rounded text-xs font-medium hover:bg-red-600 disabled:opacity-50">
                Desativar conta
              </button>
            ) : (
              <button onClick={() => toggleStatus("reactivate")} disabled={saving} className="px-4 py-2 bg-green-600 text-white rounded text-xs font-medium hover:bg-green-700 disabled:opacity-50">
                Reativar conta
              </button>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
