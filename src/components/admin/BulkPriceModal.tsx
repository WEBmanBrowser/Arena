"use client";
import { useState } from "react";

interface Props { selectedIds: number[]; filterMode: boolean; filters: Record<string, string>; onClose: () => void; onDone: () => void; }

export default function BulkPriceModal({ selectedIds, filterMode, filters, onClose, onDone }: Props) {
  const [step, setStep] = useState(1);
  const [operation, setOperation] = useState("percent_increase");
  const [value, setValue] = useState("");
  const [preview, setPreview] = useState<any[] | null>(null);
  const [token, setToken] = useState("");
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const isPercent = operation.includes("percent");
  const label = isPercent ? "%" : "€";

  const doPreview = async () => {
    setLoading(true); setError("");
    const numVal = parseFloat(value);
    if (isNaN(numVal) || numVal <= 0) { setError("Valor inválido"); setLoading(false); return; }
    const target = filterMode
      ? { type: "filters", filters: Object.fromEntries(Object.entries(filters).filter(([, v]) => v).map(([k, v]) => [k, k === "brandId" || k === "categoryId" ? parseInt(v) : k === "isActive" || k === "isFeatured" ? v === "true" : v])) }
      : { type: "selection", productIds: selectedIds };
    const res = await fetch("/api/admin/bulk", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "price_update", mode: "preview", target, operation, value: numVal }) });
    const data = await res.json();
    if (!res.ok) { setError(data.error || data.message || "Erro"); setLoading(false); return; }
    setPreview(data.preview); setToken(data.previewToken); setCount(data.productCount);
    setStep(3); setLoading(false);
  };

  const doApply = async () => {
    setLoading(true); setError("");
    const res = await fetch("/api/admin/bulk", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "price_update", mode: "apply", previewToken: token }) });
    const data = await res.json();
    if (!res.ok) { setError(data.error === "BULK_PREVIEW_STALE" ? "Alguns preços foram alterados desde a pré-visualização. Gere uma nova." : data.error === "BULK_PREVIEW_EXPIRED" ? "Esta pré-visualização expirou. Gere uma nova." : data.error || "Erro"); setStep(3); setLoading(false); return; }
    setStep(4); setLoading(false);
  };

  const fmt = (v: string) => parseFloat(v).toLocaleString("pt-PT", { style: "currency", currency: "EUR" });
  const invalidatePreview = () => { setPreview(null); setToken(""); setStep(2); };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-start justify-center overflow-y-auto py-8">
      <div className="bg-white rounded-xl w-full max-w-3xl p-6 mx-4 animate-fade-in">
        <div className="flex justify-between mb-4">
          <h3 className="font-bold text-slate-800 text-lg">Alterar preços</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl">✕</button>
        </div>

        {/* Step 1: Target */}
        {step === 1 && (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">{filterMode ? `Aplicar aos resultados filtrados` : `${selectedIds.length} produto(s) selecionado(s)`}</p>
            <button onClick={() => setStep(2)} className="px-4 py-2 bg-sky-600 text-white rounded-lg text-sm font-medium">Continuar →</button>
          </div>
        )}

        {/* Step 2: Operation + Value */}
        {step === 2 && (
          <div className="space-y-4">
            <div>
              <label className="text-xs text-slate-500 block mb-1">Tipo de alteração</label>
              <select value={operation} onChange={e => { setOperation(e.target.value); invalidatePreview(); }} className="w-full border rounded-lg px-3 py-2 text-sm">
                <option value="percent_increase">Aumentar percentagem</option>
                <option value="percent_decrease">Diminuir percentagem</option>
                <option value="fixed_increase">Aumentar valor</option>
                <option value="fixed_decrease">Diminuir valor</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-slate-500 block mb-1">Valor ({label})</label>
              <div className="flex items-center gap-2">
                <input type="number" step="0.01" min="0.01" value={value} onChange={e => { setValue(e.target.value); invalidatePreview(); }} className="flex-1 border rounded-lg px-3 py-2 text-sm" placeholder={isPercent ? "5" : "2.50"} />
                <span className="text-sm text-slate-500 font-medium">{label}</span>
              </div>
            </div>
            {error && <p className="text-sm text-red-500">{error}</p>}
            <div className="flex gap-3">
              <button onClick={() => setStep(1)} className="px-4 py-2 border rounded-lg text-sm">← Voltar</button>
              <button onClick={doPreview} disabled={loading || !value} className="px-4 py-2 bg-sky-600 text-white rounded-lg text-sm font-medium disabled:opacity-50">
                {loading ? "A calcular..." : "Gerar pré-visualização"}
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Preview */}
        {step === 3 && preview && (
          <div className="space-y-4">
            <p className="text-sm font-medium text-slate-700">{count} produto(s) serão alterados</p>
            {error && <p className="text-sm text-red-500 p-2 bg-red-50 rounded">{error}</p>}
            <div className="max-h-64 overflow-y-auto border rounded-lg">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 sticky top-0"><tr><th className="p-2 text-left">Produto</th><th className="p-2 text-left">SKU</th><th className="p-2 text-right">Atual</th><th className="p-2 text-right">Novo</th><th className="p-2 text-right">Diferença</th></tr></thead>
                <tbody>
                  {preview.map((r: any) => (
                    <tr key={r.productId} className="border-t"><td className="p-2 truncate max-w-32">{r.name}</td><td className="p-2 text-slate-500">{r.sku}</td><td className="p-2 text-right">{fmt(r.currentPrice)}</td><td className="p-2 text-right font-medium">{fmt(r.newPrice)}</td><td className={`p-2 text-right ${r.diffCents >= 0 ? "text-green-600" : "text-red-600"}`}>{r.diffCents >= 0 ? "+" : ""}{(r.diffCents / 100).toFixed(2)}€</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex gap-3">
              <button onClick={() => { setStep(2); setError(""); }} className="px-4 py-2 border rounded-lg text-sm">← Alterar</button>
              <button onClick={doApply} disabled={loading} className="px-4 py-2 bg-lime-600 text-white rounded-lg text-sm font-bold disabled:opacity-50">
                {loading ? "A aplicar..." : `Confirmar alteração de preços`}
              </button>
            </div>
          </div>
        )}

        {/* Step 4: Success */}
        {step === 4 && (
          <div className="text-center py-8">
            <p className="text-3xl mb-3">✅</p>
            <p className="font-medium text-slate-800 mb-4">{count} produto(s) atualizado(s) com sucesso.</p>
            <button onClick={() => { onDone(); onClose(); }} className="px-6 py-2 bg-sky-600 text-white rounded-lg text-sm font-medium">Fechar</button>
          </div>
        )}
      </div>
    </div>
  );
}
