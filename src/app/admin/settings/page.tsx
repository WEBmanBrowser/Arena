"use client";
import { useState, useEffect } from "react";

export default function AdminSettingsPage() {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/admin/settings").then(r => r.json()).then(d => setSettings(d.settings || {}));
  }, []);

  const save = async () => {
    setSaving(true);
    await fetch("/api/admin/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings) });
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
    { title: "Envio", fields: [
      { key: "shipping_free_above", label: "Portes grátis acima de (€)" },
      { key: "shipping_default_cost", label: "Custo de envio padrão (€)" },
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
