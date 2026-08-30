"use client";
import { useState, useEffect } from "react";

export default function AdminBrandsPage() {
  const [brands, setBrands] = useState<any[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState({ name: "", logo: "", description: "", sortOrder: "0", isActive: true });
  const [error, setError] = useState("");

  const load = () => fetch("/api/admin/brands").then(r => r.json()).then(d => setBrands(d.brands || []));
  useEffect(() => { load(); }, []);

  const save = async () => {
    setError("");
    const res = await fetch("/api/admin/brands", {
      method: editing ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...form, id: editing?.id, sortOrder: parseInt(form.sortOrder) }),
    });
    const data = await res.json();
    if (!res.ok) { setError(data.error || "Erro"); return; }
    setShowForm(false); setEditing(null); load();
  };

  const del = async (id: number) => {
    if (!confirm("Eliminar marca?")) return;
    const res = await fetch("/api/admin/brands", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
    const data = await res.json();
    if (!res.ok) alert(data.error);
    load();
  };

  const openEdit = (b: any) => { setEditing(b); setForm({ name: b.name, logo: b.logo || "", description: b.description || "", sortOrder: String(b.sortOrder), isActive: b.isActive }); setShowForm(true); };
  const openNew = () => { setEditing(null); setForm({ name: "", logo: "", description: "", sortOrder: "0", isActive: true }); setShowForm(true); };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold text-slate-800">Marcas</h2>
        <button onClick={openNew} className="px-4 py-2 bg-sky-600 text-white rounded-lg text-sm font-medium hover:bg-sky-700">+ Nova Marca</button>
      </div>
      {showForm && (
        <div className="bg-white border rounded-xl p-4 mb-4 animate-fade-in space-y-3">
          {error && <p className="text-sm text-red-500">{error}</p>}
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-xs text-slate-500">Nome *</label><input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="w-full border rounded px-3 py-1.5 text-sm" /></div>
            <div><label className="text-xs text-slate-500">Logo URL</label><input value={form.logo} onChange={e => setForm(f => ({ ...f, logo: e.target.value }))} className="w-full border rounded px-3 py-1.5 text-sm" /></div>
            <div className="col-span-2"><label className="text-xs text-slate-500">Descrição</label><textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} className="w-full border rounded px-3 py-1.5 text-sm" rows={2} /></div>
            <div><label className="text-xs text-slate-500">Ordem</label><input type="number" value={form.sortOrder} onChange={e => setForm(f => ({ ...f, sortOrder: e.target.value }))} className="w-full border rounded px-3 py-1.5 text-sm" /></div>
            <div className="flex items-end"><label className="flex items-center gap-2 text-sm py-1.5"><input type="checkbox" checked={form.isActive} onChange={e => setForm(f => ({ ...f, isActive: e.target.checked }))} /> Ativa</label></div>
          </div>
          <div className="flex gap-2">
            <button onClick={() => setShowForm(false)} className="px-3 py-1.5 border rounded text-sm text-slate-600">Cancelar</button>
            <button onClick={save} className="px-3 py-1.5 bg-sky-600 text-white rounded text-sm font-medium">Guardar</button>
          </div>
        </div>
      )}
      <div className="bg-white rounded-xl border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50"><tr><th className="text-left p-3 font-medium text-slate-600">Marca</th><th className="text-center p-3 font-medium text-slate-600">Produtos</th><th className="text-center p-3 font-medium text-slate-600">Estado</th><th className="text-right p-3 font-medium text-slate-600">Ações</th></tr></thead>
          <tbody>
            {brands.map((b: any) => (
              <tr key={b.id} className="border-t hover:bg-slate-50">
                <td className="p-3 font-medium text-slate-800">{b.name}</td>
                <td className="p-3 text-center text-slate-500">{b.productCount}</td>
                <td className="p-3 text-center"><span className={`px-2 py-0.5 rounded text-xs ${b.isActive ? "bg-green-50 text-green-600" : "bg-red-50 text-red-500"}`}>{b.isActive ? "Ativa" : "Inativa"}</span></td>
                <td className="p-3 text-right">
                  <button onClick={() => openEdit(b)} className="text-sky-600 hover:text-sky-800 mr-2 text-xs font-medium">Editar</button>
                  <button onClick={() => del(b.id)} className="text-red-500 hover:text-red-700 text-xs font-medium">Eliminar</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
