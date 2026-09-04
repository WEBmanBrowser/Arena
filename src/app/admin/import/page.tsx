"use client";
import { useState } from "react";
import SupplierImportPanel from "@/components/admin/SupplierImportPanel";
import { formatImportErrors, formatImportValue } from "@/lib/import-error-text";

/** Tolerant body reader: a non-JSON body (proxy error page…) must not crash the flow. */
async function readBody(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Human message for a failed request: the server's safe `message` when present,
 * with its `error` code appended so the operator can report it precisely.
 */
function serverErrorText(body: any, fallback: string): string {
  const message = body && typeof body.message === "string" && body.message.trim()
    ? body.message.trim()
    : "";
  const code = body && typeof body.error === "string" && body.error.trim()
    ? body.error.trim()
    : "";
  if (message && code) return `${message} (${code})`;
  if (message) return message;
  if (code) return `${fallback} (${code})`;
  return fallback;
}

export default function AdminImportPage() {
  const [csvText, setCsvText] = useState("");
  const [importMode, setImportMode] = useState("create_update");
  const [preview, setPreview] = useState<any>(null);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const doPreview = async () => {
    if (!csvText.trim()) return;
    setLoading(true);
    setResult(null);
    setError("");
    try {
      const res = await fetch("/api/admin/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: csvText, mode: "preview", importMode }),
      });
      const body = await readBody(res);
      if (!res.ok || body?.error) {
        setPreview(null);
        setError(serverErrorText(body, "Não foi possível processar o ficheiro."));
        return;
      }
      setPreview(body);
    } catch {
      setPreview(null);
      setError("Não foi possível contactar o servidor. Tente novamente.");
    } finally {
      setLoading(false);
    }
  };

  const doExecute = async () => {
    if (!csvText.trim() || !preview) return;
    setLoading(true);
    setResult(null);
    setError("");
    try {
      const res = await fetch("/api/admin/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: csvText, mode: "execute", importMode }),
      });
      const body = await readBody(res);
      if (!res.ok) {
        // A 400 here means the file still has errors; a 500 means the server
        // refused the run. Never show "Importação concluída" for either.
        setPreview(null);
        setError(serverErrorText(body, "A importação não foi executada."));
        return;
      }
      setPreview(null);
      setResult(body);
    } catch {
      setPreview(null);
      setError("Não foi possível contactar o servidor. Nada foi importado.");
    } finally {
      setLoading(false);
    }
  };

  const doExport = () => { window.open("/api/admin/export", "_blank"); };

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => setCsvText(ev.target?.result as string || "");
    reader.readAsText(file);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold text-slate-800">Importar / Exportar</h2>
        <button onClick={doExport} className="px-4 py-2 border rounded-lg text-sm text-slate-600 hover:bg-slate-50">📥 Exportar CSV</button>
      </div>

      <SupplierImportPanel />

      <div className="bg-white border rounded-xl p-6 mb-6">
        <h3 className="font-medium text-slate-800 mb-4">Importar Catálogo CSV</h3>
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <label className="text-xs text-slate-500 block mb-1">Ficheiro CSV</label>
            <input type="file" accept=".csv,.txt" onChange={handleFile} className="text-sm" />
          </div>
          <div>
            <label className="text-xs text-slate-500 block mb-1">Modo</label>
            <select value={importMode} onChange={e => setImportMode(e.target.value)} className="border rounded px-3 py-1.5 text-sm w-full">
              <option value="create_update">Criar + Atualizar</option>
              <option value="create_only">Apenas criar novos</option>
              <option value="update_only">Apenas atualizar existentes</option>
            </select>
          </div>
        </div>
        <p className="text-xs text-slate-400 mb-2">
          Colunas suportadas: SKU (obrigatório), EAN, Nome, Marca, Categoria, IVA, Stock, Stock Mínimo.
          O preço de venda não é definido a partir do ficheiro: os produtos automáticos são recalculados pelo motor de pricing
          e os de preço manual mantêm o preço atual.
        </p>
        <textarea value={csvText} onChange={e => setCsvText(e.target.value)} placeholder="SKU,Nome,Preço,Stock&#10;ABC-001,Produto Teste,29.99,10" className="w-full border rounded px-3 py-2 text-xs font-mono h-32 mb-3" />
        <div className="flex gap-3">
          <button onClick={doPreview} disabled={loading || !csvText.trim()} className="px-4 py-2 bg-sky-600 text-white rounded-lg text-sm font-medium hover:bg-sky-700 disabled:opacity-50">
            {loading ? "A processar..." : "Preview"}
          </button>
          {preview && !preview.error && (
            <button onClick={doExecute} disabled={loading} className="px-4 py-2 bg-lime-600 text-white rounded-lg text-sm font-medium hover:bg-lime-700 disabled:opacity-50">
              Executar Importação
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-4 text-sm text-red-700 whitespace-pre-wrap">{error}</div>
      )}

      {preview?.summary && (
        <div className="bg-white border rounded-xl p-4 mb-4">
          <h3 className="font-medium text-sm mb-3">Preview</h3>
          <div className="flex gap-4 text-sm mb-4">
            <span className="text-green-600 font-medium">{preview.summary.created} novos</span>
            <span className="text-blue-600 font-medium">{preview.summary.updated} a atualizar</span>
            <span className="text-slate-400">{preview.summary.skipped} sem alterações</span>
            <span className="text-red-500 font-medium">{preview.summary.errors} erros</span>
          </div>
          <div className="max-h-64 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50"><tr><th className="p-2 text-left">Linha</th><th className="p-2 text-left">SKU</th><th className="p-2 text-left">Nome</th><th className="p-2 text-left">Ação</th><th className="p-2 text-left">Alterações</th><th className="p-2 text-left">Erros</th></tr></thead>
              <tbody>
                {preview.results?.map((r: any) => (
                  <tr key={r.row} className="border-t align-top">
                    <td className="p-2 text-slate-400">{r.row}</td>
                    <td className="p-2 font-mono">{r.sku}</td>
                    <td className="p-2 truncate max-w-32">{r.name}</td>
                    <td className="p-2"><span className={`px-1.5 py-0.5 rounded text-xs ${r.action === "create" ? "bg-green-50 text-green-700" : r.action === "update" ? "bg-blue-50 text-blue-700" : "bg-slate-50 text-slate-500"}`}>{r.action}</span></td>
                    <td className="p-2 text-slate-500">
                      {r.changes
                        ? Object.entries(r.changes).map(([k, v]) => `${k}: ${formatImportValue(v)}`).join("; ")
                        : "—"}
                    </td>
                    <td className="p-2 text-red-500 whitespace-pre-wrap">{formatImportErrors(r.errors)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {result?.summary && !result.error && (
        <div className="bg-green-50 border border-green-200 rounded-xl p-4">
          <h3 className="font-medium text-sm text-green-800 mb-2">✓ Importação concluída</h3>
          <p className="text-sm text-green-700">{result.summary.created} criados · {result.summary.updated} atualizados · {result.summary.errors} erros</p>
        </div>
      )}
    </div>
  );
}
