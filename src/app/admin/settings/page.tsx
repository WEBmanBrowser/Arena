"use client";
import { useState, useEffect } from "react";

export default function AdminSettingsPage() {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [shippingClasses, setShippingClasses] = useState<any[]>([]);
  const [freeShipping, setFreeShipping] = useState({ enabled: true, thresholdCents: 10000 });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/admin/settings").then(r => r.json()).then(d => {
      setSettings(d.settings || {});
      setShippingClasses(d.shippingClasses || []);
      if (d.freeShipping) setFreeShipping(d.freeShipping);
    });
  }, []);

  const save = async () => {
    setSaving(true);
    await fetch("/api/admin/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings) });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  const saveShipping = async () => {
    setSaving(true);
    await fetch("/api/admin/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shippingConfig: { classes: shippingClasses, freeShipping } }),
    });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  const u = (key: string, value: string) => setSettings(s => ({ ...s, [key]: value }));

  const groups = [
    { title: "Empresa", fields: [
      { key: "site_name", label: "Nome do Site" },
      { key: "site_tagline", label: "Tagline" },
      { key: "company_name", label: "Razão Social" },
      { key: "company_address", label: "Morada" },
      { key: "company_phone", label: "Telefone" },
      { key: "company_email", label: "Email" },
      { key: "company_nif", label: "NIF" },
    ]},
    { title: "Loja", fields: [
      { key: "store_address", label: "Morada da Loja" },
      { key: "store_hours", label: "Horário" },
    ]},
    { title: "Analytics", fields: [
      { key: "google_analytics_id", label: "Google Analytics ID" },
      { key: "meta_pixel_id", label: "Meta Pixel ID" },
    ]},
    { title: "Tema", fields: [
      { key: "primary_color", label: "Cor Principal" },
      { key: "accent_color", label: "Cor Secundária" },
    ]},
  ];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold text-slate-800">Definições</h2>
        <div className="flex items-center gap-3">
          {saved && <span className="text-sm text-green-600">✓ Guardado</span>}
          <button onClick={save} disabled={saving} className="px-4 py-2 bg-sky-600 text-white rounded-lg text-sm font-medium hover:bg-sky-700 disabled:opacity-50">
            {saving ? "A guardar..." : "Guardar Alterações"}
          </button>
        </div>
      </div>

      <div className="space-y-6">
        <div className="bg-white border rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="font-bold text-slate-800">Envio operacional</h3>
              <p className="text-xs text-slate-500">Portes de cliente por classe; recolha em loja permanece 0,00 €.</p>
            </div>
            <button onClick={saveShipping} disabled={saving} className="px-3 py-1.5 bg-sky-600 text-white rounded text-sm disabled:opacity-50">Guardar envio</button>
          </div>
          <label className="flex items-center gap-2 text-sm mb-3">
            <input type="checkbox" checked={freeShipping.enabled} onChange={e => setFreeShipping(f => ({ ...f, enabled: e.target.checked }))} />
            Ativar portes grátis
          </label>
          <div className="grid sm:grid-cols-3 gap-2 items-center mb-4">
            <label className="text-sm text-slate-600">Limite portes grátis (cêntimos)</label>
            <input type="number" min="0" value={freeShipping.thresholdCents} onChange={e => setFreeShipping(f => ({ ...f, thresholdCents: parseInt(e.target.value || "0") }))} className="sm:col-span-2 border rounded px-3 py-1.5 text-sm" />
          </div>
          <div className="space-y-3">
            {shippingClasses.map((cls, idx) => (
              <div key={cls.id} className="grid md:grid-cols-6 gap-2 items-center border rounded-lg p-3">
                <div className="text-xs text-slate-500">{cls.key}</div>
                <input value={cls.displayName} onChange={e => setShippingClasses(a => a.map((c, i) => i === idx ? { ...c, displayName: e.target.value } : c))} className="border rounded px-2 py-1 text-sm" />
                <input type="number" min="0" value={cls.rateCents} onChange={e => setShippingClasses(a => a.map((c, i) => i === idx ? { ...c, rateCents: parseInt(e.target.value || "0") } : c))} className="border rounded px-2 py-1 text-sm" />
                <input type="number" min="0" value={cls.priority} onChange={e => setShippingClasses(a => a.map((c, i) => i === idx ? { ...c, priority: parseInt(e.target.value || "0") } : c))} className="border rounded px-2 py-1 text-sm" />
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={cls.isActive} onChange={e => setShippingClasses(a => a.map((c, i) => i === idx ? { ...c, isActive: e.target.checked } : c))} /> Ativa</label>
                <input value={cls.notes || ""} onChange={e => setShippingClasses(a => a.map((c, i) => i === idx ? { ...c, notes: e.target.value } : c))} placeholder="Notas" className="border rounded px-2 py-1 text-sm" />
              </div>
            ))}
          </div>
        </div>

        {groups.map(g => (
          <div key={g.title} className="bg-white border rounded-xl p-6">
            <h3 className="font-bold text-slate-800 mb-4">{g.title}</h3>
            <div className="space-y-3">
              {g.fields.map(f => (
                <div key={f.key} className="grid sm:grid-cols-3 gap-2 items-center">
                  <label className="text-sm text-slate-600">{f.label}</label>
                  <input value={settings[f.key] || ""} onChange={e => u(f.key, e.target.value)}
                    className="sm:col-span-2 border rounded px-3 py-1.5 text-sm" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
