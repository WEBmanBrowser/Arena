"use client";
/**
 * C.3.1 — Painel de importação de listas de fornecedor.
 *
 * Fluxo: Fornecedor → CSV → Preview (gravado como snapshot) → Aplicar.
 *
 * Regras que este componente respeita deliberadamente:
 *  - o browser nunca reenvia valores financeiros: depois do preview só viaja o
 *    `importId` (+ o token assinado na primeira aplicação);
 *  - o preço NÃO é importado: uma lista de fornecedor só traz custo/stock. O
 *    preço automático é decisão do motor de pricing (C.1/C.2);
 *  - a disponibilidade de "retomar" é decidida no servidor (`canResume`, com
 *    base no heartbeat). Aqui nunca se faz aritmética de tempo no browser.
 */
import { useCallback, useEffect, useState } from "react";

type PreviewLine = {
  rowNumber: number;
  supplierSku: string | null;
  ean: string | null;
  internalSku: string | null;
  name: string | null;
  status: "ready" | "new_product" | "conflict" | "error";
  matchType: string;
  codes?: string[];
  message: string | null;
  issues?: { field: string; code: string; value?: string }[];
  costPrice: string | null;
  costBefore: string | null;
  stock: number | null;
  stockBefore: number | null;
  productId: number | null;
  productSku: string | null;
  productName: string | null;
  currentPrice: string | null;
  computedPrice: string | null;
  priceMode: string | null;
  isPreferredSupplier: boolean;
};

type PreviewResult = {
  importId: number;
  supplierId: number;
  supplierName: string;
  fileName: string;
  fileHash: string;
  delimiter: string;
  mapping: Record<string, string>;
  ignoredColumns: string[];
  summary: {
    total: number; ready: number; newProducts: number; conflicts: number; errors: number;
    actionable: number; withCost?: number; withStock?: number; batchesTotal?: number;
  };
  lines: PreviewLine[];
  truncated: boolean;
  missingProducts: {
    action: string; count: number; ambiguous: number; skippedReason: string | null;
    comparedToImportId: number | null;
    items: { supplierSku: string; productId: number; name: string | null }[];
  };
  previewToken: string;
  batchesTotal: number;
};

type Progress = {
  importId: number;
  status: string;
  total: number;
  applied: number;
  pending: number;
  errors: number;
  conflicts: number;
  batchesDone: number;
  batchesTotal: number;
  startedAt: string | null;
  completedAt: string | null;
  heartbeatAt: string | null;
  canResume: boolean;
  stale: boolean;
};

type HistoryItem = {
  id: number;
  supplierName: string | null;
  fileName: string;
  rowCount: number;
  status: string;
  batchesDone: number;
  batchesTotal: number;
  createdAt: string;
  finishedAt: string | null;
};

const eur = (v: string | number | null | undefined) =>
  v == null || v === "" ? "—" : Number(v).toLocaleString("pt-PT", { style: "currency", currency: "EUR" });

const dt = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("pt-PT", { dateStyle: "short", timeStyle: "short" }) : "—";

const MESSAGES: Record<string, string> = {
  SUPPLIER_ID_REQUIRED: "Escolha o fornecedor a que esta lista pertence.",
  SUPPLIER_NOT_FOUND: "Fornecedor não encontrado.",
  SUPPLIER_INACTIVE: "O fornecedor está inativo — reative-o antes de importar a lista.",
  CSV_EMPTY: "Ficheiro vazio.",
  CSV_NO_DATA: "O ficheiro só tem cabeçalhos.",
  CSV_TOO_MANY_ROWS: "Demasiadas linhas (o limite é 10.000 por ficheiro).",
  CSV_TOO_LARGE: "Ficheiro demasiado grande (máx. 5 MB).",
  CSV_FILE_TOO_LARGE: "Ficheiro demasiado grande (máx. 5 MB).",
  CSV_NO_COLUMNS_MAPPED: "Nenhuma coluna reconhecida. Use SKU do fornecedor, EAN ou SKU interno.",
  CSV_MISSING_KEY_COLUMN: "Falta uma coluna de identificação (SKU do fornecedor, EAN ou SKU interno).",
  DUPLICATE_MAPPING_supplierSku: "Duas colunas mapeadas para o SKU do fornecedor.",
  DUPLICATE_MAPPING_ean: "Duas colunas mapeadas para o EAN.",
  DUPLICATE_MAPPING_costPrice: "Duas colunas mapeadas para o custo.",
  DUPLICATE_MAPPING_stock: "Duas colunas mapeadas para o stock.",
  DUPLICATE_MAPPING_internalSku: "Duas colunas mapeadas para o SKU interno.",
  DUPLICATE_MAPPING_name: "Duas colunas mapeadas para o nome.",
  DUPLICATE_MAPPING_leadTimeDays: "Duas colunas mapeadas para o prazo de entrega.",
  PREVIEW_TOKEN_REQUIRED: "Confirme o preview antes de aplicar.",
  PREVIEW_TOKEN_INVALID: "Token do preview inválido.",
  PREVIEW_TOKEN_MISMATCH: "O token não corresponde a este ficheiro.",
  PREVIEW_EXPIRED: "O preview expirou — gere um novo.",
  IMPORT_IN_PROGRESS: "Já existe uma aplicação desta importação em curso.",
  IMPORT_FAILED: "Importação marcada como falhada: é preciso um novo preview.",
  IMPORT_NOT_FOUND: "Importação não encontrada.",
  SUPPLIER_IMPORT_APPLY_FAILED: "Falha ao aplicar. Nenhum registo foi gravado a mais: pode retomar.",
  SUPPLIER_IMPORT_PREVIEW_FAILED: "Falha ao processar o ficheiro.",
  UNAUTHORIZED: "Sem permissões (requer gestor).",
};

const messageFor = (code: string | undefined, fallback?: string) =>
  (code && MESSAGES[code]) || fallback || code || "Ocorreu um erro.";

const STATUS_LABEL: Record<string, string> = {
  preview: "em preview",
  applying: "a aplicar",
  completed: "concluída",
  partial: "incompleta",
  failed: "falhou",
};

const LINE_BADGE: Record<string, string> = {
  ready: "bg-sky-50 text-sky-700",
  new_product: "bg-lime-50 text-lime-700",
  conflict: "bg-amber-50 text-amber-800",
  error: "bg-red-50 text-red-700",
};

const MATCH_LABEL: Record<string, string> = {
  supplier_sku: "SKU do fornecedor",
  ean: "EAN",
  internal_sku: "SKU interno",
  none: "—",
};

function Chip({ label, value, tone = "slate" }: { label: string; value: number; tone?: "slate" | "sky" | "lime" | "amber" | "red" }) {
  const tones: Record<string, string> = {
    slate: "bg-slate-50 text-slate-600",
    sky: "bg-sky-50 text-sky-700",
    lime: "bg-lime-50 text-lime-700",
    amber: "bg-amber-50 text-amber-800",
    red: "bg-red-50 text-red-700",
  };
  return (
    <span className={`px-2.5 py-1 rounded-lg text-xs font-medium ${tones[tone]}`}>
      {value} {label}
    </span>
  );
}

export default function SupplierImportPanel() {
  const [supplierOptions, setSupplierOptions] = useState<{ id: number; name: string; isActive: boolean }[]>([]);
  const [supplierId, setSupplierId] = useState("");
  const [fileName, setFileName] = useState("");
  const [csvText, setCsvText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [outcome, setOutcome] = useState<Record<string, any> | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyProgress, setHistoryProgress] = useState<Record<number, Progress | null>>({});
  /** Bumped to re-read the history list; the effect below owns the fetch. */
  const [historyVersion, setHistoryVersion] = useState(0);
  /** Import id being watched, or null. The progress effect owns the polling. */
  const [watchId, setWatchId] = useState<number | null>(null);

  const refreshHistory = useCallback(() => setHistoryVersion((v) => v + 1), []);

  useEffect(() => {
    let stopped = false;
    (async () => {
      const res = await fetch("/api/admin/suppliers");
      if (stopped || !res.ok) return;
      const body = await res.json();
      const list = (body.suppliers ?? []) as { id: number; name: string; isActive: boolean }[];
      const firstActive = list.find((s) => s.isActive);
      if (!stopped) setSupplierOptions(list);
      if (firstActive) setSupplierId((prev) => prev || String(firstActive.id));
    })();
    return () => { stopped = true; };
  }, []);

  useEffect(() => {
    let stopped = false;
    const qs = supplierId ? `?supplierId=${supplierId}&limit=10` : "?limit=10";
    (async () => {
      const res = await fetch(`/api/admin/supplier-import${qs}`);
      if (stopped || !res.ok) return;
      const body = await res.json();
      if (!stopped) setHistory((body.imports ?? []) as HistoryItem[]);
    })();
    return () => { stopped = true; };
  }, [supplierId, historyVersion]);

  // While an import is applying, the counters come from the server. Staleness
  // and resumability are read from the same response (canResume) — never
  // derived from a clock in the browser.
  useEffect(() => {
    if (watchId === null) return;
    let stopped = false;
    const tick = async () => {
      const res = await fetch(`/api/admin/supplier-import/${watchId}/progress`);
      if (stopped || !res.ok) return;
      const p = (await res.json()) as Progress;
      if (stopped) return;
      setProgress(p);
      if (p.status !== "applying") setWatchId(null);
    };
    const id = setInterval(() => void tick(), 700);
    void tick();
    return () => { stopped = true; clearInterval(id); };
  }, [watchId]);

  const readFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setError("");
    const reader = new FileReader();
    reader.onload = (ev) => setCsvText(String(ev.target?.result ?? ""));
    reader.readAsText(file);
  };

  const reset = () => {
    setPreview(null);
    setProgress(null);
    setOutcome(null);
    setError("");
  };

  const doPreview = async () => {
    if (!supplierId || !csvText.trim()) return;
    setBusy(true);
    reset();
    const res = await fetch("/api/admin/supplier-import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ supplierId: Number(supplierId), fileName, data: csvText }),
    });
    const body = await res.json();
    if (!res.ok) {
      setError(messageFor(body.error, body.message));
      setBusy(false);
      return;
    }
    setPreview(body as PreviewResult);
    setBusy(false);
    refreshHistory();
  };

  /** Apply the FIRST time with the signed token; resume with nothing but the id. */
  const run = async (importId: number, previewToken?: string) => {
    setBusy(true);
    setError("");
    setOutcome(null);
    const res = await fetch("/api/admin/supplier-import/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(previewToken ? { importId, previewToken } : { importId }),
    });
    const body = await res.json();
    if (!res.ok) {
      setError(messageFor(body.error, body.message));
      setBusy(false);
      refreshHistory();
      return;
    }
    setOutcome(body);
    setBusy(false);
    setWatchId(importId);
    refreshHistory();
  };

  const checkHistory = async (importId: number) => {
    const res = await fetch(`/api/admin/supplier-import/${importId}/progress`);
    const body = res.ok ? ((await res.json()) as Progress) : null;
    setHistoryProgress((prev) => ({ ...prev, [importId]: body }));
  };

  const stopWatching = () => setWatchId(null);

  const running = progress?.status === "applying";
  const shownLines = preview?.lines ?? [];
  const total = progress?.total ?? preview?.summary.total ?? 0;
  const appliedCount = progress?.applied ?? 0;
  const percent = total > 0 ? Math.round((appliedCount / total) * 100) : 0;
  const resumable = !!progress?.canResume && !running;

  return (
    <div className="bg-white border rounded-xl p-6 mb-6">
      <div className="flex items-start justify-between mb-1">
        <div>
          <h3 className="font-medium text-slate-800">Importar lista de fornecedor</h3>
          <p className="text-xs text-slate-500 mt-1 max-w-2xl">
            Atualiza custo e stock por fornecedor. O preço nunca vem do ficheiro: produtos automáticos
            são recalculados pelo motor de pricing e produtos com preço manual mantêm o preço que definiram.
          </p>
        </div>
        <span className="text-[10px] uppercase tracking-wide text-slate-400 border rounded px-2 py-1">C.3.1</span>
      </div>

      <div className="grid grid-cols-3 gap-4 mt-4">
        <div>
          <label className="text-xs text-slate-500 block mb-1">Fornecedor *</label>
          <select
            value={supplierId}
            onChange={(e) => setSupplierId(e.target.value)}
            className="border rounded px-3 py-1.5 text-sm w-full"
          >
            <option value="">— escolher —</option>
            {supplierOptions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}{s.isActive ? "" : " (inativo)"}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs text-slate-500 block mb-1">Ficheiro CSV</label>
          <input type="file" accept=".csv,.txt" onChange={readFile} className="text-sm w-full" />
        </div>
        <div className="flex items-end gap-2">
          <button
            onClick={doPreview}
            disabled={busy || !csvText.trim() || !supplierId}
            className="px-4 py-2 bg-sky-600 text-white rounded-lg text-sm font-medium hover:bg-sky-700 disabled:opacity-50"
          >
            {busy && !preview ? "A processar..." : "Pré-visualizar"}
          </button>
          {preview && (
            <button onClick={() => { reset(); setCsvText(""); setFileName(""); }} className="px-3 py-2 text-sm text-slate-500 hover:text-slate-700">
              limpar
            </button>
          )}
        </div>
      </div>

      <p className="text-[11px] text-slate-400 mt-2">
        Colunas reconhecidas: <span className="font-mono">skuFornecedor</span>, <span className="font-mono">nome</span>/<span className="font-mono">designacao</span>,{" "}
        <span className="font-mono">custo</span>, <span className="font-mono">stock</span>, <span className="font-mono">ean</span>,{" "}
        <span className="font-mono">sku</span>/<span className="font-mono">codigo</span>, <span className="font-mono">prazoEntrega</span>.
        Máx. 10.000 linhas. Separador , ou ; e decimals “10,00” são detetados automaticamente.
      </p>

      <textarea
        value={csvText}
        onChange={(e) => setCsvText(e.target.value)}
        placeholder={"skuFornecedor;nome;custo;stock\nREF-001;Cabo HDMI;10,00;8"}
        className="w-full border rounded px-3 py-2 text-xs font-mono h-24 mt-3"
      />

      {error && (
        <div className="mt-3 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">{error}</div>
      )}

      {preview && (
        <div className="mt-5 border-t pt-4">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 mb-3">
            <span className="font-medium text-slate-700">{preview.fileName}</span>
            <span>· {preview.supplierName}</span>
            <span>· separador “{preview.delimiter}”</span>
            <span className="font-mono" title="SHA-256 do ficheiro">#{preview.fileHash.slice(0, 12)}</span>
          </div>

          <div className="flex flex-wrap gap-2 mb-3">
            <Chip label="linhas" value={preview.summary.total} />
            <Chip label="vão atualizar" value={preview.summary.ready} tone="sky" />
            <Chip label="novos produtos" value={preview.summary.newProducts} tone="lime" />
            <Chip label="conflitos" value={preview.summary.conflicts} tone={preview.summary.conflicts ? "amber" : "slate"} />
            <Chip label="erros" value={preview.summary.errors} tone={preview.summary.errors ? "red" : "slate"} />
          </div>

          {preview.ignoredColumns.length > 0 && (
            <p className="text-[11px] text-slate-500 mb-2">
              Colunas ignoradas: {preview.ignoredColumns.join(", ")} — o preço de venda não se importa por lista de fornecedor.
            </p>
          )}

          {preview.missingProducts.count > 0 && (
            <div className="mb-3 bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-900">
              <p className="font-medium mb-1">
                {preview.missingProducts.count} produto(s) que constavam da última importação concluída deste fornecedor já não aparecem nesta lista.
              </p>
              <p className="text-amber-800">
                Nada é alterado por esta deteção {preview.missingProducts.ambiguous > 0 && `(mais ${preview.missingProducts.ambiguous} caso(s) ambíguo(s) ignorados)`} —
                {" "}nada é desativado nem removido. Comparado com a importação #{preview.missingProducts.comparedToImportId}.
              </p>
              <ul className="mt-1 max-h-24 overflow-y-auto">
                {preview.missingProducts.items.slice(0, 20).map((m) => (
                  <li key={m.productId} className="font-mono">{m.supplierSku} · {m.name ?? "—"}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="max-h-72 overflow-auto border rounded-lg">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 sticky top-0">
                <tr>
                  {["Linha", "Ficheiro", "Estado", "Produto", "Custo", "Stock", "Preço atual", "Preço calculado"].map((h) => (
                    <th key={h} className="p-2 text-left font-medium text-slate-500 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shownLines.map((l) => (
                  <tr key={l.rowNumber} className="border-t align-top">
                    <td className="p-2 text-slate-400">{l.rowNumber}</td>
                    <td className="p-2 font-mono">
                      {l.supplierSku ?? l.ean ?? l.internalSku ?? "—"}
                      {l.name && <span className="block text-slate-400 font-sans truncate max-w-40">{l.name}</span>}
                    </td>
                    <td className="p-2">
                      <span className={`px-1.5 py-0.5 rounded ${LINE_BADGE[l.status]}`}>
                        {l.status === "new_product" ? "novo" : l.status === "ready" ? `via ${MATCH_LABEL[l.matchType] ?? l.matchType}` : l.status}
                      </span>
                      {l.message && <span className="block text-slate-400 mt-0.5 max-w-56">{l.message}</span>}
                    </td>
                    <td className="p-2">
                      {l.productId ? (
                        <span className="font-mono">{l.productSku}</span>
                      ) : l.status === "new_product" ? (
                        <span className="text-lime-700">será criado</span>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                    <td className="p-2 whitespace-nowrap">
                      {eur(l.costPrice)}
                      {l.costBefore !== null && l.costBefore !== l.costPrice && (
                        <span className="text-slate-400"> ← {eur(l.costBefore)}</span>
                      )}
                    </td>
                    <td className="p-2">
                      {l.stock ?? "—"}
                      {l.stockBefore !== null && l.stockBefore !== l.stock && (
                        <span className="text-slate-400"> ← {l.stockBefore}</span>
                      )}
                    </td>
                    <td className="p-2 whitespace-nowrap">
                      {eur(l.currentPrice)}
                      {l.priceMode === "manual" && <span className="ml-1 text-[10px] text-violet-600 border border-violet-200 rounded px-1">manual</span>}
                    </td>
                    <td className="p-2 whitespace-nowrap text-slate-600">{l.computedPrice ? eur(l.computedPrice) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.truncated && (
            <p className="text-[11px] text-slate-400 mt-1">
              A mostrar as primeiras {preview.lines.length} de {preview.summary.total} linhas. O snapshot gravado contém todas.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3 mt-4">
            <button
              onClick={() => { stopWatching(); void run(preview.importId, preview.previewToken); }}
              disabled={busy || running || preview.summary.actionable === 0}
              className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 disabled:opacity-50"
            >
              {running ? "A aplicar..." : `Aplicar ${preview.summary.actionable} linha(s)`}
            </button>
            {preview.summary.conflicts > 0 && (
              <span className="text-xs text-amber-700">
                As {preview.summary.conflicts} linha(s) em conflito não são aplicadas — resolva a ambiguidade e importe de novo.
              </span>
            )}
          </div>

          {preview.summary.actionable === 0 && (
            <p className="text-xs text-slate-500 mt-2">Nada para aplicar neste ficheiro.</p>
          )}
        </div>
      )}

      {(running || progress) && (
        <div className="mt-4 border rounded-lg p-3 bg-slate-50">
          <div className="flex items-center justify-between text-xs text-slate-600 mb-2">
            <span className="font-medium">
              {running ? "A aplicar..." : STATUS_LABEL[progress?.status ?? ""] ?? progress?.status}
              {progress?.stale && !running ? " · aplicação interrompida" : ""}
            </span>
            <span>
              {appliedCount}/{total} linhas · lote {progress?.batchesDone ?? 0}/{progress?.batchesTotal ?? 0}
              {progress && progress.errors > 0 ? ` · ${progress.errors} erro(s)` : ""}
            </span>
          </div>
          <div className="h-1.5 bg-slate-200 rounded-full overflow-hidden">
            <div className="h-full bg-emerald-500 transition-all" style={{ width: `${percent}%` }} />
          </div>
          {resumable && preview && (
            <button
              onClick={() => { stopWatching(); void run(preview.importId); }}
              className="mt-3 px-3 py-1.5 bg-amber-500 text-white rounded-lg text-xs font-medium hover:bg-amber-600"
            >
              Retomar aplicação (sem reenviar o ficheiro)
            </button>
          )}
        </div>
      )}

      {outcome && !running && (
        <div className={`mt-3 border rounded-lg p-3 text-sm ${outcome.error ? "bg-amber-50 border-amber-200 text-amber-900" : "bg-emerald-50 border-emerald-200 text-emerald-800"}`}>
          {outcome.error ? (
            <>
              <p className="font-medium">Aplicação interrompida.</p>
              <p className="text-xs mt-1">
                {outcome.applied} de {outcome.applied + (outcome.pending ?? 0)} linhas ficaram gravadas; as {outcome.pending ?? 0} restantes
                continuam pendentes e podem ser retomadas acima, sem reenviar o ficheiro.
              </p>
            </>
          ) : (
            <>
              <p className="font-medium">Importação aplicada.</p>
              <p className="text-xs mt-1">
                {outcome.appliedNow} linha(s) nesta operação · {outcome.created} produto(s) criado(s), {(outcome.updated ?? 0) + (outcome.repriced ?? 0)} atualizado(s)
                {outcome.repriced ? ` (${outcome.repriced} com preço recalculado)` : ""}
                {outcome.conflicts ? ` · ${outcome.conflicts} conflito(s) ignorado(s)` : ""}
                {outcome.errors ? ` · ${outcome.errors} linha(s) inválida(s)` : ""}
              </p>
            </>
          )}
        </div>
      )}

      {history.length > 0 && (
        <div className="mt-5 border-t pt-4">
          <h4 className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">Importações recentes</h4>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-slate-400">
                {["Ficheiro", "Fornecedor", "Linhas", "Estado", "Lotes", "Criada", "Concluída", ""].map((h, i) => (
                  <th key={i} className="p-1.5 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id} className={`border-t ${historyProgress[h.id]?.canResume ? "bg-amber-50" : ""}`}>
                  <td className="p-1.5 font-mono">{h.fileName}</td>
                  <td className="p-1.5">{h.supplierName ?? "—"}</td>
                  <td className="p-1.5">{h.rowCount}</td>
                  <td className="p-1.5">
                    <span className={`px-1.5 py-0.5 rounded ${h.status === "completed" ? "bg-emerald-50 text-emerald-700" : h.status === "applying" ? "bg-sky-50 text-sky-700" : h.status === "preview" ? "bg-slate-100 text-slate-500" : "bg-amber-50 text-amber-800"}`}>
                      {STATUS_LABEL[h.status] ?? h.status}
                    </span>
                  </td>
                  <td className="p-1.5 text-slate-500">{h.batchesDone}/{h.batchesTotal}</td>
                  <td className="p-1.5 text-slate-500">{dt(h.createdAt)}</td>
                  <td className="p-1.5 text-slate-500">{dt(h.finishedAt)}</td>
                  <td className="p-1.5 text-right">
                    {h.status === "applying" || h.status === "partial" ? (
                      historyProgress[h.id]?.canResume ? (
                        <button
                          onClick={() => { stopWatching(); void run(h.id); }}
                          className="px-2 py-1 bg-amber-500 text-white rounded text-[11px] font-medium hover:bg-amber-600"
                        >
                          Retomar
                        </button>
                      ) : (
                        <button onClick={() => void checkHistory(h.id)} className="px-2 py-1 border rounded text-[11px] text-slate-600 hover:bg-slate-50">
                          {historyProgress[h.id] ? (historyProgress[h.id]!.stale ? "interrompida" : "em curso") : "Estado"}
                        </button>
                      )
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-[11px] text-slate-400 mt-1">
            Uma importação interrompida mantém o snapshot no servidor: pode ser retomada sem voltar a carregar o CSV.
          </p>
        </div>
      )}
    </div>
  );
}
