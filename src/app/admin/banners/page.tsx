"use client";
import { useState, useEffect } from "react";

export default function AdminBannersPage() {
  const [banners, setBanners] = useState<any[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState({ title: "", subtitle: "", link: "", buttonText: "", sortOrder: "0", isActive: true });

  const fetch_ = () => fetch("/api/admin/banners").then(r => r.json()).then(d => setBanners(d.banners || []));
  useEffect(() => { fetch_(); }, []);

  const save = async () => {
    await fetch("/api/admin/banners", {
      method: editing ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...form, id: editing?.id, sortOrder: parseInt(form.sortOrder) }),
    });
    setShowForm(false);
    setEditing(null);
    fetch_();
  };

  const del = async (id: number) => {
    if (!confirm("Eliminar?")) return;
    await fetch("/api/admin/banners", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
    fetch_();
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold text-slate-800">Banners</h2>
        <button onClick={() => { setEditing(null); setForm({ title: "", subtitle: "", link: "", buttonText: "", sortOrder: "0", isActive: true }); setShowForm(true); }}
          className="px-4 py-2 bg-sky-600 text-white rounded-lg text-sm font-medium hover:bg-sky-700">+ Novo Banner</button>
      </div>

      {showForm && (
        <div className="bg-white border rounded-xl p-4 mb-4 animate-fade-in space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-xs text-slate-500">Título</label><input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} className="w-full border rounded px-3 py-1.5 text-sm" /></div>
            <div><label className="text-xs text-slate-500">Link</label><input value={form.link} onChange={e => setForm(f => ({ ...f, link: e.target.value }))} className="w-full border rounded px-3 py-1.5 text-sm" /></div>
          </div>
          <div><label className="text-xs text-slate-500">Subtítulo</label><textarea value={form.subtitle} onChange={e => setForm(f => ({ ...f, subtitle: e.target.value }))} className="w-full border rounded px-3 py-1.5 text-sm" rows={2} /></div>
          <div className="grid grid-cols-3 gap-3">
            <div><label className="text-xs text-slate-500">Texto Botão</label><input value={form.buttonText} onChange={e => setForm(f => ({ ...f, buttonText: e.target.value }))} className="w-full border rounded px-3 py-1.5 text-sm" /></div>
            <div><label className="text-xs text-slate-500">Ordem</label><input type="number" value={form.sortOrder} onChange={e => setForm(f => ({ ...f, sortOrder: e.target.value }))} className="w-full border rounded px-3 py-1.5 text-sm" /></div>
            <div className="flex items-end"><label className="flex items-center gap-2 text-sm py-1.5"><input type="checkbox" checked={form.isActive} onChange={e => setForm(f => ({ ...f, isActive: e.target.checked }))} /> Ativo</label></div>
          </div>
          <div className="flex gap-2">
            <button onClick={() => setShowForm(false)} className="px-3 py-1.5 border rounded text-sm text-slate-600">Cancelar</button>
            <button onClick={save} className="px-3 py-1.5 bg-sky-600 text-white rounded text-sm font-medium">Guardar</button>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {banners.map(b => (
          <div key={b.id} className="bg-white border rounded-xl p-4 flex items-center justify-between">
            <div>
              <p className="font-medium text-slate-800">{b.title}</p>
              <p className="text-xs text-slate-500">{b.subtitle}</p>
              <div className="flex gap-3 mt-1">
                {b.link && <span className="text-xs text-sky-600">{b.link}</span>}
                <span className={`text-xs ${b.isActive ? "text-green-600" : "text-red-500"}`}>{b.isActive ? "Ativo" : "Inativo"}</span>
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => { setEditing(b); setForm({ title: b.title, subtitle: b.subtitle || "", link: b.link || "", buttonText: b.buttonText || "", sortOrder: String(b.sortOrder), isActive: b.isActive }); setShowForm(true); }}
                className="text-sky-600 hover:text-sky-800 text-xs font-medium">Editar</button>
              <button onClick={() => del(b.id)} className="text-red-500 hover:text-red-700 text-xs font-medium">Eliminar</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
