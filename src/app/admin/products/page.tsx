"use client";
import { useState, useEffect, useCallback } from "react";
import BulkPriceModal from "@/components/admin/BulkPriceModal";
import ProductImageManager from "@/components/admin/ProductImageManager";
import ProductSupplierManager from "@/components/admin/ProductSupplierManager";
import PriceCalculator from "@/components/admin/PriceCalculator";

const TABS = [
  { id: "geral" as const, label: "Geral", requiresSaved: false },
  { id: "precos" as const, label: "Preços", requiresSaved: false },
  { id: "stock" as const, label: "Stock", requiresSaved: false },
  { id: "conteudo" as const, label: "Conteúdo", requiresSaved: false },
  { id: "imagens" as const, label: "Imagens", requiresSaved: true },
  { id: "fornecedores" as const, label: "Fornecedores", requiresSaved: true },
];

/** Format a number as euros in pt-PT. */
const eur = (v: number): string => v.toLocaleString("pt-PT", { style: "currency", currency: "EUR" });

/**
 * Display-only margin calculation.
 *
 * Prices are stored VAT-inclusive, so the net price is derived by removing the
 * VAT rate before comparing against cost. This is presentation logic only: it
 * never writes anything and does not touch the server-side financial model.
 */
function computeMargin(price: string, costPrice: string, vatRate: string) {
  const gross = parseFloat(price);
  const cost = parseFloat(costPrice);
  const vat = parseFloat(vatRate);
  if (!isFinite(gross) || !isFinite(cost) || gross <= 0 || costPrice.trim() === "") return null;
  const rate = isFinite(vat) ? vat : 0;
  const netPrice = gross / (1 + rate / 100);
  const value = netPrice - cost;
  const percent = netPrice > 0 ? (value / netPrice) * 100 : 0;
  return { netPrice, cost, value, percent };
}

export default function AdminProductsPage() {
  const [products, setProducts] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(25);
  const [search, setSearch] = useState("");
  const [brandFilter, setBrandFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [activeFilter, setActiveFilter] = useState("");
  const [stockFilter, setStockFilter] = useState("");
  const [sort, setSort] = useState("newest");
  const [editingProduct, setEditingProduct] = useState<any>(null);
  const [showForm, setShowForm] = useState(false);
  const [showBulkPrice, setShowBulkPrice] = useState(false);
  const [tab, setTab] = useState<"geral" | "precos" | "stock" | "conteudo" | "imagens" | "fornecedores">("geral");
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [categories, setCategories] = useState<any[]>([]);
  const [brands, setBrands] = useState<any[]>([]);
  const [shippingClasses, setShippingClasses] = useState<any[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    name: "", sku: "", ean: "", price: "", comparePrice: "", costPrice: "", stock: "0",
    minStock: "0", categoryId: "", brandId: "", shortDescription: "", description: "",
    isActive: true, isFeatured: false, isService: false, allowPreorder: false,
    attributes: "{}", tags: "[]", vatRate: "23.00", shippingClassId: "",
  });

  /**
   * Single source of truth for loading the list.
   *
   * `cache: "no-store"` stops the browser from replaying a previous response
   * after a mutation. Awaitable so callers can refresh *before* closing a
   * modal, instead of firing a request and hoping.
   */
  const fetchProducts = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), limit: String(limit), sort });
    if (search) params.set("q", search);
    if (brandFilter) params.set("brandId", brandFilter);
    if (categoryFilter) params.set("categoryId", categoryFilter);
    if (activeFilter) params.set("isActive", activeFilter);
    if (stockFilter) params.set("stockStatus", stockFilter);
    const res = await fetch(`/api/admin/products?${params}`, { cache: "no-store" });
    const d = await res.json();
    setProducts(d.products || []);
    setTotal(d.total || 0);
    setPages(d.pages || 1);
    setShippingClasses(d.shippingClasses || []);
  }, [page, limit, sort, search, brandFilter, categoryFilter, activeFilter, stockFilter]);

  /**
   * Immediate reload after a mutation.
   *
   * The debounced effect below exists for typing in the search box. Reusing it
   * after a write added ~300ms of staleness and, because the callback identity
   * changes on every render, the pending timer could be cancelled and
   * restarted — which is why saved products appeared in the list only seconds
   * later. Mutations therefore bypass the debounce entirely.
   */
  const refreshNow = useCallback(async () => {
    setRefreshing(true);
    try {
      await fetchProducts();
    } finally {
      setRefreshing(false);
    }
  }, [fetchProducts]);

  useEffect(() => {
    fetch("/api/admin/categories").then(r => r.json()).then(d => setCategories(d.categories || []));
    fetch("/api/admin/brands").then(r => r.json()).then(d => setBrands(d.brands || []));
  }, []);

  useEffect(() => { const t = setTimeout(fetchProducts, 300); return () => clearTimeout(t); }, [fetchProducts]);

  const openNew = () => {
    setEditingProduct(null);
    setForm({ name: "", sku: "", ean: "", price: "", comparePrice: "", costPrice: "", stock: "0", minStock: "0", categoryId: "", brandId: "", shortDescription: "", description: "", isActive: true, isFeatured: false, isService: false, allowPreorder: false, attributes: "{}", tags: "[]", vatRate: "23.00", shippingClassId: "" });
    setShowForm(true); setError(""); setTab("geral");
  };

  const openEdit = (p: any) => {
    setEditingProduct(p);
    setForm({ name: p.name, sku: p.sku || "", ean: p.ean || "", price: p.price, comparePrice: p.comparePrice || "", costPrice: p.costPrice || "", stock: String(p.stock), minStock: String(p.minStock), categoryId: p.categoryId ? String(p.categoryId) : "", brandId: p.brandId ? String(p.brandId) : "", shortDescription: p.shortDescription || "", description: p.description || "", isActive: p.isActive, isFeatured: p.isFeatured, isService: p.isService, allowPreorder: p.allowPreorder, attributes: JSON.stringify(p.attributes || {}), tags: JSON.stringify(p.tags || []), vatRate: p.vatRate || "23.00", shippingClassId: p.shippingClassId ? String(p.shippingClassId) : "" });
    setShowForm(true); setError(""); setTab("geral");
  };

  const saveProduct = async () => {
    setError(""); setSaving(true);
    const body: any = { ...form, stock: parseInt(form.stock), minStock: parseInt(form.minStock), categoryId: form.categoryId ? parseInt(form.categoryId) : null, brandId: form.brandId ? parseInt(form.brandId) : null, shippingClassId: form.shippingClassId ? parseInt(form.shippingClassId) : null, ean: form.ean || null, comparePrice: form.comparePrice || null, costPrice: form.costPrice || null, attributes: JSON.parse(form.attributes || "{}"), tags: JSON.parse(form.tags || "[]") };
    if (editingProduct) body.id = editingProduct.id;
    const res = await fetch("/api/admin/products", { method: editingProduct ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) { setSaving(false); setError(data.error || data.message || "Erro"); return; }
    // Refresh BEFORE closing so the table already shows the new state.
    await refreshNow();
    setSaving(false);
    // Keep the modal open on create so the user can jump to Images/Suppliers,
    // which need a persisted product id.
    if (editingProduct) { setShowForm(false); } else if (data.product) { setEditingProduct(data.product); setTab("imagens"); }
  };

  const deleteProduct = async (id: number) => {
    if (!confirm("Eliminar produto?")) return;
    const res = await fetch("/api/admin/products", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
    if (!res.ok) { const d = await res.json(); alert(d.error || "Erro"); }
    await refreshNow();
  };

  const toggleSelect = (id: number) => setSelected(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);
  const selectAll = () => setSelected(s => s.length === products.length ? [] : products.map(p => p.id));

  const bulkAction = async (action: string) => {
    if (selected.length === 0) return;
    if (!confirm(`${action} ${selected.length} produto(s)?`)) return;
    await fetch("/api/admin/bulk", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: selected, action }) });
    setSelected([]); await refreshNow();
  };

  const margin = computeMargin(form.price, form.costPrice, form.vatRate);

  // Stock status of the product currently being edited (server-authoritative values).
  const stockState = (() => {
    if (!editingProduct) return { available: 0, label: "—", tone: "text-slate-500", badge: "bg-slate-100 text-slate-600" };
    const available = editingProduct.stock - editingProduct.reservedStock;
    if (available <= 0) return { available, label: "Sem stock", tone: "text-red-600", badge: "bg-red-50 text-red-600" };
    if (available <= editingProduct.minStock) return { available, label: "Stock baixo", tone: "text-amber-600", badge: "bg-amber-50 text-amber-700" };
    return { available, label: "Disponível", tone: "text-green-600", badge: "bg-green-50 text-green-700" };
  })();

  const u = (f: string, v: any) => setForm(o => ({ ...o, [f]: v }));

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold text-slate-800">Produtos</h2>
        <button onClick={openNew} className="px-4 py-2 bg-sky-600 text-white rounded-lg text-sm font-medium hover:bg-sky-700">+ Novo Produto</button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 mb-4">
        <input type="text" placeholder="Pesquisar..." value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} className="border rounded-lg px-3 py-1.5 text-sm w-48" />
        <select value={brandFilter} onChange={e => { setBrandFilter(e.target.value); setPage(1); }} className="border rounded-lg px-2 py-1.5 text-sm">
          <option value="">Marca</option>{brands.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <select value={categoryFilter} onChange={e => { setCategoryFilter(e.target.value); setPage(1); }} className="border rounded-lg px-2 py-1.5 text-sm">
          <option value="">Categoria</option>{categories.map((c: any) => <option key={c.id} value={c.id}>{c.parentId ? "— " : ""}{c.name}</option>)}
        </select>
        <select value={activeFilter} onChange={e => { setActiveFilter(e.target.value); setPage(1); }} className="border rounded-lg px-2 py-1.5 text-sm">
          <option value="">Estado</option><option value="true">Ativos</option><option value="false">Inativos</option>
        </select>
        <select value={stockFilter} onChange={e => { setStockFilter(e.target.value); setPage(1); }} className="border rounded-lg px-2 py-1.5 text-sm">
          <option value="">Stock</option><option value="in_stock">Em stock</option><option value="low_stock">Baixo</option><option value="out_of_stock">Sem stock</option>
        </select>
        <select value={sort} onChange={e => { setSort(e.target.value); setPage(1); }} className="border rounded-lg px-2 py-1.5 text-sm">
          <option value="newest">Mais recentes</option><option value="oldest">Mais antigos</option><option value="name">Nome A-Z</option><option value="price_asc">Preço ↑</option><option value="price_desc">Preço ↓</option><option value="stock">Stock ↑</option>
        </select>
        <span className="text-xs text-slate-500 self-center">
          {refreshing ? "A atualizar…" : `${total} produto(s)`}
        </span>
        <button
          type="button"
          onClick={() => void refreshNow()}
          disabled={refreshing}
          title="Atualizar listagem"
          className="text-xs text-slate-500 hover:text-sky-600 self-center disabled:opacity-50"
        >
          ↻ Atualizar
        </button>
      </div>

      {/* Bulk actions */}
      {selected.length > 0 && (
        <div className="flex gap-2 mb-3 p-2 bg-sky-50 rounded-lg items-center text-sm">
          <span className="text-sky-700 font-medium">{selected.length} selecionado(s)</span>
          <button onClick={() => bulkAction("activate")} className="px-2 py-1 bg-green-100 text-green-700 rounded text-xs">Ativar</button>
          <button onClick={() => bulkAction("deactivate")} className="px-2 py-1 bg-red-100 text-red-700 rounded text-xs">Desativar</button>
          <button onClick={() => bulkAction("set_featured")} className="px-2 py-1 bg-amber-100 text-amber-700 rounded text-xs">Destaque</button>
          <button onClick={() => bulkAction("remove_featured")} className="px-2 py-1 bg-slate-100 text-slate-700 rounded text-xs">Remover Destaque</button>
          <button onClick={() => setShowBulkPrice(true)} className="px-2 py-1 bg-purple-100 text-purple-700 rounded text-xs font-medium">💰 Alterar preços</button>
        </div>
      )}

      {/* Product Form Modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-start justify-center overflow-y-auto py-8">
          <div className="bg-white rounded-xl w-full max-w-4xl mx-4 animate-fade-in flex flex-col max-h-[88vh]">
            {/* Header */}
            <div className="px-6 pt-5 pb-3 border-b">
              <h3 className="font-bold text-slate-800 text-lg">{editingProduct ? "Editar Produto" : "Novo Produto"}</h3>
              {editingProduct && <p className="text-xs text-slate-500 mt-0.5">{editingProduct.name}</p>}
            </div>

            {/* Tabs */}
            <div className="px-6 border-b overflow-x-auto">
              <div className="flex gap-1 -mb-px">
                {TABS.map(t => {
                  const locked = t.requiresSaved && !editingProduct;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => !locked && setTab(t.id)}
                      disabled={locked}
                      title={locked ? "Guarde o produto primeiro" : undefined}
                      className={`px-3 py-2 text-sm whitespace-nowrap border-b-2 transition ${
                        tab === t.id
                          ? "border-sky-600 text-sky-700 font-medium"
                          : locked
                            ? "border-transparent text-slate-300 cursor-not-allowed"
                            : "border-transparent text-slate-500 hover:text-slate-800"
                      }`}
                    >
                      {t.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Body */}
            <div className="px-6 py-4 overflow-y-auto flex-1">
              {error && <p className="text-sm text-red-600 mb-3 p-2 bg-red-50 border border-red-200 rounded">{error}</p>}

              {/* ─── GERAL ─── */}
              {tab === "geral" && (
                <div className="grid sm:grid-cols-2 gap-3">
                  <div className="sm:col-span-2"><label className="text-xs text-slate-500">Nome *</label><input value={form.name} onChange={e => u("name", e.target.value)} className="w-full border rounded px-3 py-1.5 text-sm" /></div>
                  <div><label className="text-xs text-slate-500">SKU *</label><input value={form.sku} onChange={e => u("sku", e.target.value)} className="w-full border rounded px-3 py-1.5 text-sm" /></div>
                  <div><label className="text-xs text-slate-500">EAN / GTIN</label><input value={form.ean} onChange={e => u("ean", e.target.value)} className="w-full border rounded px-3 py-1.5 text-sm" placeholder="Opcional" /></div>
                  <div>
                    <label className="text-xs text-slate-500">Marca</label>
                    <select value={form.brandId} onChange={e => u("brandId", e.target.value)} className="w-full border rounded px-3 py-1.5 text-sm">
                      <option value="">Selecionar</option>
                      {brands.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-slate-500">Categoria</label>
                    <select value={form.categoryId} onChange={e => u("categoryId", e.target.value)} className="w-full border rounded px-3 py-1.5 text-sm">
                      <option value="">Selecionar</option>
                      {categories.map((c: any) => <option key={c.id} value={c.id}>{c.parentId ? "— " : ""}{c.name}</option>)}
                    </select>
                  </div>
                  <div className="sm:col-span-2">
                    <label className="text-xs text-slate-500">Classe de envio</label>
                    <select value={form.shippingClassId} onChange={e => u("shippingClassId", e.target.value)} className="w-full border rounded px-3 py-1.5 text-sm">
                      <option value="">Pequeno (padrão)</option>
                      {shippingClasses.map((c: any) => <option key={c.id} value={c.id} disabled={!c.isActive}>{c.displayName} — {(c.rateCents / 100).toFixed(2)} €{!c.isActive ? " (inativa)" : ""}</option>)}
                    </select>
                  </div>
                  <div className="sm:col-span-2 border-t pt-3">
                    <p className="text-xs text-slate-500 mb-2">Estado</p>
                    <div className="flex flex-wrap gap-4">
                      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.isActive} onChange={e => u("isActive", e.target.checked)} /> Ativo</label>
                      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.isFeatured} onChange={e => u("isFeatured", e.target.checked)} /> Destaque</label>
                      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.isService} onChange={e => u("isService", e.target.checked)} /> Serviço</label>
                    </div>
                  </div>
                </div>
              )}

              {/* ─── PREÇOS ─── */}
              {tab === "precos" && (
                <PriceCalculator
                  price={form.price}
                  comparePrice={form.comparePrice}
                  costPrice={form.costPrice}
                  vatRate={form.vatRate}
                  onChange={(field, value) => u(field, value)}
                />
              )}

              {/* ─── STOCK ─── */}
              {tab === "stock" && (
                <div className="space-y-4">
                  <div className="grid sm:grid-cols-2 gap-3">
                    <div><label className="text-xs text-slate-500">Stock físico</label><input type="number" value={form.stock} onChange={e => u("stock", e.target.value)} className="w-full border rounded px-3 py-1.5 text-sm" /></div>
                    <div><label className="text-xs text-slate-500">Stock mínimo</label><input type="number" value={form.minStock} onChange={e => u("minStock", e.target.value)} className="w-full border rounded px-3 py-1.5 text-sm" /></div>
                  </div>
                  {editingProduct ? (
                    <div className="border rounded-lg p-4 bg-slate-50">
                      <h4 className="text-sm font-medium text-slate-800 mb-3">Situação atual</h4>
                      <div className="grid grid-cols-3 gap-3 mb-3">
                        <div><p className="text-[11px] text-slate-500">Físico</p><p className="text-sm font-medium">{editingProduct.stock}</p></div>
                        <div><p className="text-[11px] text-slate-500">Reservado</p><p className="text-sm font-medium text-amber-600">{editingProduct.reservedStock}</p></div>
                        <div><p className="text-[11px] text-slate-500">Disponível</p><p className={`text-sm font-bold ${stockState.tone}`}>{stockState.available}</p></div>
                      </div>
                      <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${stockState.badge}`}>{stockState.label}</span>
                      <p className="text-[11px] text-slate-500 mt-3">
                        Reservado e disponível são calculados pelo servidor e não podem ser editados aqui.
                      </p>
                      <a href="/admin/inventory" className="inline-block mt-2 text-xs text-sky-600 hover:text-sky-800 font-medium">
                        Ver movimentos de inventário →
                      </a>
                    </div>
                  ) : (
                    <p className="text-sm text-slate-400">O stock reservado e disponível fica visível após guardar o produto.</p>
                  )}
                </div>
              )}

              {/* ─── CONTEÚDO ─── */}
              {tab === "conteudo" && (
                <div className="space-y-3">
                  <div><label className="text-xs text-slate-500">Descrição curta</label><input value={form.shortDescription} onChange={e => u("shortDescription", e.target.value)} className="w-full border rounded px-3 py-1.5 text-sm" /></div>
                  <div><label className="text-xs text-slate-500">Descrição completa</label><textarea value={form.description} onChange={e => u("description", e.target.value)} className="w-full border rounded px-3 py-1.5 text-sm" rows={10} /></div>
                </div>
              )}

              {/* ─── IMAGENS ─── */}
              {tab === "imagens" && editingProduct && <ProductImageManager productId={editingProduct.id} onChanged={refreshNow} />}

              {/* ─── FORNECEDORES ─── */}
              {tab === "fornecedores" && editingProduct && <ProductSupplierManager productId={editingProduct.id} onChanged={refreshNow} />}
            </div>

            {/* Footer */}
            <div className="px-6 py-4 border-t flex items-center justify-between gap-3">
              <p className="text-xs text-slate-400">
                {tab === "imagens" || tab === "fornecedores" ? "As alterações desta secção são guardadas automaticamente." : "Campos com * são obrigatórios."}
              </p>
              <div className="flex gap-3">
                <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2 border rounded-lg text-sm text-slate-600 hover:bg-slate-50">Fechar</button>
                <button type="button" onClick={saveProduct} disabled={saving} className="px-4 py-2 bg-sky-600 text-white rounded-lg text-sm font-medium hover:bg-sky-700 disabled:opacity-50">
                  {saving ? "A guardar…" : "Guardar"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="bg-white rounded-xl border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th className="p-3 w-8"><input type="checkbox" onChange={selectAll} checked={selected.length === products.length && products.length > 0} /></th>
              <th className="text-left p-3 font-medium text-slate-600">Produto</th>
              <th className="text-left p-3 font-medium text-slate-600 hidden md:table-cell">SKU</th>
              <th className="text-right p-3 font-medium text-slate-600">Preço</th>
              <th className="text-right p-3 font-medium text-slate-600">Stock</th>
              <th className="text-right p-3 font-medium text-slate-600 hidden lg:table-cell">Reserv.</th>
              <th className="text-right p-3 font-medium text-slate-600 hidden lg:table-cell">Disp.</th>
              <th className="text-center p-3 font-medium text-slate-600">Estado</th>
              <th className="text-right p-3 font-medium text-slate-600">Ações</th>
            </tr>
          </thead>
          <tbody>
            {products.map((p: any) => {
              const avail = p.stock - p.reservedStock;
              return (
                <tr key={p.id} className="border-t hover:bg-slate-50">
                  <td className="p-3"><input type="checkbox" checked={selected.includes(p.id)} onChange={() => toggleSelect(p.id)} /></td>
                  <td className="p-3"><p className="font-medium text-slate-800 truncate max-w-xs">{p.name}</p></td>
                  <td className="p-3 text-slate-500 hidden md:table-cell">{p.sku}</td>
                  <td className="p-3 text-right font-medium">{parseFloat(p.price).toFixed(2)}€</td>
                  <td className="p-3 text-right">{p.stock}</td>
                  <td className="p-3 text-right text-amber-600 hidden lg:table-cell">{p.reservedStock}</td>
                  <td className={`p-3 text-right font-medium hidden lg:table-cell ${avail <= 0 ? "text-red-500" : avail <= p.minStock ? "text-amber-500" : "text-green-600"}`}>{avail}</td>
                  <td className="p-3 text-center"><span className={`px-2 py-0.5 rounded text-xs ${p.isActive ? "bg-green-50 text-green-600" : "bg-red-50 text-red-500"}`}>{p.isActive ? "Ativo" : "Inativo"}</span></td>
                  <td className="p-3 text-right">
                    <button onClick={() => openEdit(p)} className="text-sky-600 hover:text-sky-800 mr-2 text-xs font-medium">Editar</button>
                    <button onClick={() => deleteProduct(p.id)} className="text-red-500 hover:text-red-700 text-xs font-medium">Eliminar</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between mt-4">
        <div className="flex items-center gap-2">
          <select value={limit} onChange={e => { setLimit(parseInt(e.target.value)); setPage(1); }} className="border rounded px-2 py-1 text-xs">
            <option value="25">25</option><option value="50">50</option><option value="100">100</option>
          </select>
          <span className="text-xs text-slate-500">por página</span>
        </div>
        <div className="flex gap-1">
          <button onClick={() => setPage(Math.max(1, page - 1))} disabled={page <= 1} className="px-3 py-1 border rounded text-xs disabled:opacity-50">←</button>
          <span className="px-3 py-1 text-xs text-slate-600">{page} / {pages}</span>
          <button onClick={() => setPage(Math.min(pages, page + 1))} disabled={page >= pages} className="px-3 py-1 border rounded text-xs disabled:opacity-50">→</button>
        </div>
      </div>

      {showBulkPrice && (
        <BulkPriceModal
          selectedIds={selected}
          filterMode={selected.length === 0}
          filters={{ q: search, brandId: brandFilter, categoryId: categoryFilter, isActive: activeFilter }}
          onClose={() => setShowBulkPrice(false)}
          onDone={() => { setSelected([]); void refreshNow(); }}
        />
      )}
    </div>
  );
}
