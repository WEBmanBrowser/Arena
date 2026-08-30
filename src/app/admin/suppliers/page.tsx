"use client";
import { useState, useEffect } from "react";

export default function AdminSuppliersPage() {
  const [items, setItems] = useState<any[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState({ name: "", legalName: "", taxId: "", email: "", phone: "", website: "", contactName: "", notes: "", isActive: true });

  const load = () => fetch("/api/admin/suppliers").then(r => r.json()).then(d => setItems(d.suppliers || []));
  useEffect(() => { load(); }, []);

  const save = async () => {
    await fetch("/api/admin/suppliers", { method: editing ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...form, id: editing?.id }) });
    setShowForm(false); setEditing(null); load();
  };

  const openEdit = (s: any) => { setEditing(s); setForm({ name: s.name, legalName: s.legalName || "", taxId: s.taxId || "", email: s.email || "", phone: s.phone || "", website: s.website || "", contactName: s.contactName || "", notes: s.notes || "", isActive: s.isActive }); setShowForm(true); };
  const openNew = () => { setEditing(null); setForm({ name: "", legalName: "", taxId: "", email: "", phone: "", website: "", contactName: "", notes: "", isActive: true }); setShowForm(true); };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold text-slate-800">Fornecedores</h2>
        <button onClick={openNew} className="px-4 py-2 bg-sky-600 text-white rounded-lg text-sm font-medium hover:bg-sky-700">+ Novo Fornecedor</button>
      </div>
      {showForm && (
        <div className="bg-white border rounded-xl p-4 mb-4 animate-fade-in space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-xs text-slate-500">Nome *</label><input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="w-full border rounded px-3 py-1.5 text-sm" /></div>
            <div><label className="text-xs text-slate-500">Razão Social</label><input value={form.legalName} onChange={e => setForm(f => ({ ...f, legalName: e.target.value }))} className="w-full border rounded px-3 py-1.5 text-sm" /></div>
            <div><label className="text-xs text-slate-500">NIF</label><input value={form.taxId} onChange={e => setForm(f => ({ ...f, taxId: e.target.value }))} className="w-full border rounded px-3 py-1.5 text-sm" /></div>
            <div><label className="text-xs text-slate-500">Email</label><input value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} className="w-full border rounded px-3 py-1.5 text-sm" /></div>
            <div><label className="text-xs text-slate-500">Telefone</label><input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} className="w-full border rounded px-3 py-1.5 text-sm" /></div>
            <div><label className="text-xs text-slate-500">Website</label><input value={form.website} onChange={e => setForm(f => ({ ...f, website: e.target.value }))} className="w-full border rounded px-3 py-1.5 text-sm" /></div>
            <div><label className="text-xs text-slate-500">Contacto</label><input value={form.contactName} onChange={e => setForm(f => ({ ...f, contactName: e.target.value }))} className="w-full border rounded px-3 py-1.5 text-sm" /></div>
            <div className="flex items-end"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.isActive} onChange={e => setForm(f => ({ ...f, isActive: e.target.checked }))} /> Ativo</label></div>
          </div>
          <div><label className="text-xs text-slate-500">Notas</label><textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} className="w-full border rounded px-3 py-1.5 text-sm" rows={2} /></div>
          <div className="flex gap-2">
            <button onClick={() => setShowForm(false)} className="px-3 py-1.5 border rounded text-sm">Cancelar</button>
            <button onClick={save} className="px-3 py-1.5 bg-sky-600 text-white rounded text-sm font-medium">Guardar</button>
          </div>
        </div>
      )}
      <div className="bg-white rounded-xl border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50"><tr><th className="text-left p-3 font-medium text-slate-600">Nome</th><th className="text-left p-3 font-medium text-slate-600">Email</th><th className="text-left p-3 font-medium text-slate-600">Telefone</th><th className="text-left p-3 font-medium text-slate-600">NIF</th><th className="text-center p-3 font-medium text-slate-600">Estado</th><th className="text-right p-3 font-medium text-slate-600">Ações</th></tr></thead>
          <tbody>
            {items.map((s: any) => (
              <tr key={s.id} className="border-t hover:bg-slate-50">
                <td className="p-3 font-medium text-slate-800">{s.name}</td>
                <td className="p-3 text-slate-500">{s.email || "—"}</td>
                <td className="p-3 text-slate-500">{s.phone || "—"}</td>
                <td className="p-3 text-slate-500">{s.taxId || "—"}</td>
                <td className="p-3 text-center"><span className={`px-2 py-0.5 rounded text-xs ${s.isActive ? "bg-green-50 text-green-600" : "bg-red-50 text-red-500"}`}>{s.isActive ? "Ativo" : "Inativo"}</span></td>
                <td className="p-3 text-right"><button onClick={() => openEdit(s)} className="text-sky-600 text-xs font-medium">Editar</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
