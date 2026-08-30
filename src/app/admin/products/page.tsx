"use client";
import { useState, useEffect, useCallback } from "react";
import BulkPriceModal from "@/components/admin/BulkPriceModal";
import ProductImageManager from "@/components/admin/ProductImageManager";

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
  const [categories, setCategories] = useState<any[]>([]);
  const [brands, setBrands] = useState<any[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    name: "", sku: "", ean: "", price: "", comparePrice: "", costPrice: "", stock: "0",
    minStock: "0", categoryId: "", brandId: "", shortDescription: "", description: "",
    isActive: true, isFeatured: false, isService: false, allowPreorder: false,
    attributes: "{}", tags: "[]", vatRate: "23.00",
  });

  const fetchProducts = useCallback(() => {
    const params = new URLSearchParams({ page: String(page), limit: String(limit), sort });
    if (search) params.set("q", search);
    if (brandFilter) params.set("brandId", brandFilter);
    if (categoryFilter) params.set("categoryId", categoryFilter);
    if (activeFilter) params.set("isActive", activeFilter);
    if (stockFilter) params.set("stockStatus", stockFilter);
    fetch(`/api/admin/products?${params}`).then(r => r.json()).then(d => {
      setProducts(d.products || []);
      setTotal(d.total || 0);
      setPages(d.pages || 1);
    });
  }, [page, limit, sort, search, brandFilter, categoryFilter, activeFilter, stockFilter]);

  useEffect(() => {
    fetch("/api/admin/categories").then(r => r.json()).then(d => setCategories(d.categories || []));
    fetch("/api/admin/brands").then(r => r.json()).then(d => setBrands(d.brands || []));
  }, []);

  useEffect(() => { const t = setTimeout(fetchProducts, 300); return () => clearTimeout(t); }, [fetchProducts]);

  const openNew = () => {
    setEditingProduct(null);
    setForm({ name: "", sku: "", ean: "", price: "", comparePrice: "", costPrice: "", stock: "0", minStock: "0", categoryId: "", brandId: "", shortDescription: "", description: "", isActive: true, isFeatured: false, isService: false, allowPreorder: false, attributes: "{}", tags: "[]", vatRate: "23.00" });
    setShowForm(true); setError("");
  };

  const openEdit = (p: any) => {
    setEditingProduct(p);
    setForm({ name: p.name, sku: p.sku || "", ean: p.ean || "", price: p.price, comparePrice: p.comparePrice || "", costPrice: p.costPrice || "", stock: String(p.stock), minStock: String(p.minStock), categoryId: p.categoryId ? String(p.categoryId) : "", brandId: p.brandId ? String(p.brandId) : "", shortDescription: p.shortDescription || "", description: p.description || "", isActive: p.isActive, isFeatured: p.isFeatured, isService: p.isService, allowPreorder: p.allowPreorder, attributes: JSON.stringify(p.attributes || {}), tags: JSON.stringify(p.tags || []), vatRate: p.vatRate || "23.00" });
    setShowForm(true); setError("");
  };

  const saveProduct = async () => {
    setError("");
    const body: any = { ...form, stock: parseInt(form.stock), minStock: parseInt(form.minStock), categoryId: form.categoryId ? parseInt(form.categoryId) : null, brandId: form.brandId ? parseInt(form.brandId) : null, ean: form.ean || null, comparePrice: form.comparePrice || null, costPrice: form.costPrice || null, attributes: JSON.parse(form.attributes || "{}"), tags: JSON.parse(form.tags || "[]") };
    if (editingProduct) body.id = editingProduct.id;
    const res = await fetch("/api/admin/products", { method: editingProduct ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) { setError(data.error || data.message || "Erro"); return; }
    setShowForm(false); fetchProducts();
  };

  const deleteProduct = async (id: number) => {
    if (!confirm("Eliminar produto?")) return;
    const res = await fetch("/api/admin/products", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
    if (!res.ok) { const d = await res.json(); alert(d.error || "Erro"); }
    fetchProducts();
  };

  const toggleSelect = (id: number) => setSelected(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);
  const selectAll = () => setSelected(s => s.length === products.length ? [] : products.map(p => p.id));

  const bulkAction = async (action: string) => {
    if (selected.length === 0) return;
    if (!confirm(`${action} ${selected.length} produto(s)?`)) return;
    await fetch("/api/admin/bulk", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: selected, action }) });
    setSelected([]); fetchProducts();
  };

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
        <span className="text-xs text-slate-500 self-center">{total} produto(s)</span>
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
          <div className="bg-white rounded-xl w-full max-w-2xl p-6 animate-fade-in mx-4">
            <h3 className="font-bold text-slate-800 mb-4">{editingProduct ? "Editar Produto" : "Novo Produto"}</h3>
            {error && <p className="text-sm text-red-500 mb-3 p-2 bg-red-50 rounded">{error}</p>}
            <div className="space-y-3 max-h-[70vh] overflow-y-auto">
              <div className="grid grid-cols-2 gap-3">
                <div><label className="text-xs text-slate-500">Nome *</label><input value={form.name} onChange={e => u("name", e.target.value)} className="w-full border rounded px-3 py-1.5 text-sm" /></div>
                <div><label className="text-xs text-slate-500">SKU *</label><input value={form.sku} onChange={e => u("sku", e.target.value)} className="w-full border rounded px-3 py-1.5 text-sm" /></div>
                <div><label className="text-xs text-slate-500">EAN / GTIN</label><input value={form.ean} onChange={e => u("ean", e.target.value)} className="w-full border rounded px-3 py-1.5 text-sm" placeholder="Opcional" /></div>
                <div><label className="text-xs text-slate-500">Preço c/ IVA *</label><input value={form.price} onChange={e => u("price", e.target.value)} className="w-full border rounded px-3 py-1.5 text-sm" /></div>
                <div><label className="text-xs text-slate-500">Preço Anterior</label><input value={form.comparePrice} onChange={e => u("comparePrice", e.target.value)} className="w-full border rounded px-3 py-1.5 text-sm" /></div>
                <div><label className="text-xs text-slate-500">Taxa IVA %</label><input value={form.vatRate} onChange={e => u("vatRate", e.target.value)} className="w-full border rounded px-3 py-1.5 text-sm" /></div>
                <div><label className="text-xs text-slate-500">Preço Custo</label><input value={form.costPrice} onChange={e => u("costPrice", e.target.value)} className="w-full border rounded px-3 py-1.5 text-sm" /></div>
                <div><label className="text-xs text-slate-500">Stock</label><input type="number" value={form.stock} onChange={e => u("stock", e.target.value)} className="w-full border rounded px-3 py-1.5 text-sm" /></div>
                <div><label className="text-xs text-slate-500">Stock Mínimo</label><input type="number" value={form.minStock} onChange={e => u("minStock", e.target.value)} className="w-full border rounded px-3 py-1.5 text-sm" /></div>
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
              </div>
              <div><label className="text-xs text-slate-500">Descrição Curta</label><input value={form.shortDescription} onChange={e => u("shortDescription", e.target.value)} className="w-full border rounded px-3 py-1.5 text-sm" /></div>
              <div><label className="text-xs text-slate-500">Descrição</label><textarea value={form.description} onChange={e => u("description", e.target.value)} className="w-full border rounded px-3 py-1.5 text-sm" rows={3} /></div>
              <div className="flex flex-wrap gap-4">
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.isActive} onChange={e => u("isActive", e.target.checked)} /> Ativo</label>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.isFeatured} onChange={e => u("isFeatured", e.target.checked)} /> Destaque</label>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.isService} onChange={e => u("isService", e.target.checked)} /> Serviço</label>
              </div>
            </div>
            <div className="flex gap-3 mt-4 pt-4 border-t">
              <button onClick={() => setShowForm(false)} className="px-4 py-2 border rounded-lg text-sm text-slate-600 hover:bg-slate-50">Cancelar</button>
              <button onClick={saveProduct} className="px-4 py-2 bg-sky-600 text-white rounded-lg text-sm font-medium hover:bg-sky-700">Guardar</button>
            {editingProduct && <ProductImageManager productId={editingProduct.id} />}
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
          onDone={() => { setSelected([]); fetchProducts(); }}
        />
      )}
    </div>
  );
}
