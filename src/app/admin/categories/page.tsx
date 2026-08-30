"use client";
import { useState, useEffect } from "react";

export default function AdminCategoriesPage() {
  const [categories, setCategories] = useState<any[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState({ name: "", icon: "", parentId: "", sortOrder: "0", description: "" });

  const fetch_ = () => fetch("/api/admin/categories").then(r => r.json()).then(d => setCategories(d.categories || []));
  useEffect(() => { fetch_(); }, []);

  const save = async () => {
    await fetch("/api/admin/categories", {
      method: editing ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...form,
        id: editing?.id,
        parentId: form.parentId ? parseInt(form.parentId) : null,
        sortOrder: parseInt(form.sortOrder),
      }),
    });
    setShowForm(false);
    setEditing(null);
    fetch_();
  };

  const del = async (id: number) => {
    if (!confirm("Eliminar?")) return;
    await fetch("/api/admin/categories", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
    fetch_();
  };

  const openEdit = (c: any) => {
    setEditing(c);
    setForm({ name: c.name, icon: c.icon || "", parentId: c.parentId ? String(c.parentId) : "", sortOrder: String(c.sortOrder), description: c.description || "" });
    setShowForm(true);
  };

  const openNew = () => {
    setEditing(null);
    setForm({ name: "", icon: "", parentId: "", sortOrder: "0", description: "" });
    setShowForm(true);
  };

  const parents = categories.filter(c => !c.parentId);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold text-slate-800">Categorias</h2>
        <button onClick={openNew} className="px-4 py-2 bg-sky-600 text-white rounded-lg text-sm font-medium hover:bg-sky-700">+ Nova Categoria</button>
      </div>

      {showForm && (
        <div className="bg-white border rounded-xl p-4 mb-4 animate-fade-in space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-xs text-slate-500">Nome</label><input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="w-full border rounded px-3 py-1.5 text-sm" /></div>
            <div><label className="text-xs text-slate-500">Ícone (emoji)</label><input value={form.icon} onChange={e => setForm(f => ({ ...f, icon: e.target.value }))} className="w-full border rounded px-3 py-1.5 text-sm" /></div>
            <div>
              <label className="text-xs text-slate-500">Categoria Pai</label>
              <select value={form.parentId} onChange={e => setForm(f => ({ ...f, parentId: e.target.value }))} className="w-full border rounded px-3 py-1.5 text-sm">
                <option value="">Nenhuma (raiz)</option>
                {parents.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div><label className="text-xs text-slate-500">Ordem</label><input type="number" value={form.sortOrder} onChange={e => setForm(f => ({ ...f, sortOrder: e.target.value }))} className="w-full border rounded px-3 py-1.5 text-sm" /></div>
          </div>
          <div className="flex gap-2">
            <button onClick={() => setShowForm(false)} className="px-3 py-1.5 border rounded text-sm text-slate-600">Cancelar</button>
            <button onClick={save} className="px-3 py-1.5 bg-sky-600 text-white rounded text-sm font-medium">Guardar</button>
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50"><tr><th className="text-left p-3 font-medium text-slate-600">Categoria</th><th className="text-left p-3 font-medium text-slate-600">Slug</th><th className="text-center p-3 font-medium text-slate-600">Ordem</th><th className="text-right p-3 font-medium text-slate-600">Ações</th></tr></thead>
          <tbody>
            {categories.map(c => (
              <tr key={c.id} className="border-t hover:bg-slate-50">
                <td className="p-3"><span className="mr-2">{c.icon}</span>{c.parentId ? "— " : ""}<span className="font-medium text-slate-800">{c.name}</span></td>
                <td className="p-3 text-slate-500">{c.slug}</td>
                <td className="p-3 text-center text-slate-500">{c.sortOrder}</td>
                <td className="p-3 text-right">
                  <button onClick={() => openEdit(c)} className="text-sky-600 hover:text-sky-800 mr-2 text-xs font-medium">Editar</button>
                  <button onClick={() => del(c.id)} className="text-red-500 hover:text-red-700 text-xs font-medium">Eliminar</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
