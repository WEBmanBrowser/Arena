"use client";
import { useState } from "react";

/**
 * C.2 — Impact preview before applying automatic prices.
 *
 * Nothing is written until the operator presses Apply, and price DECREASES
 * require an explicit tick. The server re-checks that consent against the
 * signed token, so this checkbox is a usability affordance, not the security
 * boundary.
 */

export interface RecalcLine {
  productId: number;
  name: string;
  sku: string | null;
  costPrice: string | null;
  currentPrice: string;
  mathematicalPrice: string | null;
  newPrice: string | null;
  diffCents: number;
  diffPercent: number | null;
  realMarginPercent: number | null;
  realMarkupPercent: number | null;
  ruleLabel: string | null;
  status: "up" | "down" | "same" | "manual" | "no_cost" | "no_rule" | "error";
  message?: string;
}

export interface RecalcSummary {
  affected: number; up: number; down: number; same: number;
  manual: number; noCost: number; noRule: number; errors: number; totalScanned: number;
}

const STATUS_LABEL: Record<RecalcLine["status"], string> = {
  up: "Sobe", down: "Desce", same: "Igual",
  manual: "Manual (ignorado)", no_cost: "Sem custo", no_rule: "Sem regra", error: "Erro",
};

const STATUS_CLASS: Record<RecalcLine["status"], string> = {
  up: "text-green-700 bg-green-50",
  down: "text-red-700 bg-red-50",
  same: "text-slate-500 bg-slate-50",
  manual: "text-violet-700 bg-violet-50",
  no_cost: "text-amber-700 bg-amber-50",
  no_rule: "text-amber-700 bg-amber-50",
  error: "text-red-700 bg-red-50",
};

const PAGE_SIZE = 50;

export default function RecalcPreviewModal({
  title, lines, summary, previewToken, requiresDecreaseConfirmation, applying, error, onApply, onClose,
}: {
  title: string;
  lines: RecalcLine[];
  summary: RecalcSummary;
  previewToken: string | null;
  requiresDecreaseConfirmation: boolean;
  applying: boolean;
  error: string | null;
  onApply: (confirmDecreases: boolean) => void;
  onClose: () => void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [filter, setFilter] = useState<"all" | RecalcLine["status"]>("all");
  const [page, setPage] = useState(1);

  const filtered = filter === "all" ? lines : lines.filter((l) => l.status === filter);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const visible = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const canApply = !!previewToken && (!requiresDecreaseConfirmation || confirmed);

  const chip = (key: "all" | RecalcLine["status"], label: string, count: number, tone = "") => (
    <button
      key={key} type="button"
      onClick={() => { setFilter(key); setPage(1); }}
      className={`px-2.5 py-1 rounded-lg text-xs border transition ${filter === key ? "border-sky-500 bg-sky-50 text-sky-700" : "bg-white hover:border-slate-400"} ${tone}`}
    >
      {label}: <strong>{count}</strong>
    </button>
  );

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-start justify-center p-4 overflow-auto">
      <div className="bg-white rounded-xl w-full max-w-6xl my-4">
        <div className="flex items-center justify-between border-b p-4">
          <div>
            <h3 className="font-semibold text-slate-800">{title}</h3>
            <p className="text-xs text-slate-500">{summary.totalScanned} produto(s) analisado(s)</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-xl leading-none">×</button>
        </div>

        <div className="p-4 space-y-3">
          {error && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">{error}</div>}

          <div className="flex flex-wrap gap-2">
            {chip("all", "Todos", lines.length)}
            {chip("up", "Sobem", summary.up)}
            {chip("down", "Descem", summary.down)}
            {chip("same", "Iguais", summary.same)}
            {chip("manual", "Manuais ignorados", summary.manual)}
            {chip("no_cost", "Sem custo", summary.noCost)}
            {chip("no_rule", "Sem regra", summary.noRule)}
            {chip("error", "Erros", summary.errors)}
          </div>

          {summary.down > 0 && (
            <div className="bg-amber-50 border border-amber-300 rounded-lg p-3">
              <p className="text-sm font-semibold text-amber-900">
                ⚠️ {summary.down} produto(s) vão baixar de preço
              </p>
              <p className="text-xs text-amber-800 mt-1">
                Verifique a lista antes de aplicar. Descidas de preço afetam diretamente a margem.
              </p>
            </div>
          )}

          <div className="border rounded-lg overflow-auto max-h-[45vh]">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 sticky top-0">
                <tr className="text-left text-slate-500">
                  <th className="p-2">Produto</th>
                  <th className="p-2">Regra aplicada</th>
                  <th className="p-2 text-right">Custo</th>
                  <th className="p-2 text-right">Preço atual</th>
                  <th className="p-2 text-right">Matemático</th>
                  <th className="p-2 text-right">Novo preço</th>
                  <th className="p-2 text-right">Dif.</th>
                  <th className="p-2 text-right">Margem</th>
                  <th className="p-2 text-right">Markup</th>
                  <th className="p-2">Estado</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((l) => (
                  <tr key={l.productId} className="border-t">
                    <td className="p-2">
                      <div className="font-medium text-slate-800">{l.name}</div>
                      {l.sku && <div className="text-slate-400">{l.sku}</div>}
                    </td>
                    <td className="p-2 text-slate-600">{l.ruleLabel || <span className="text-slate-400">—</span>}</td>
                    <td className="p-2 text-right">{l.costPrice ? `${l.costPrice} €` : "—"}</td>
                    <td className="p-2 text-right">{l.currentPrice} €</td>
                    <td className="p-2 text-right text-slate-500">{l.mathematicalPrice ? `${l.mathematicalPrice} €` : "—"}</td>
                    <td className="p-2 text-right font-semibold">{l.newPrice ? `${l.newPrice} €` : "—"}</td>
                    <td className={`p-2 text-right ${l.diffCents > 0 ? "text-green-700" : l.diffCents < 0 ? "text-red-700" : "text-slate-400"}`}>
                      {l.diffCents !== 0 ? `${l.diffCents > 0 ? "+" : ""}${(l.diffCents / 100).toFixed(2)} €` : "—"}
                      {l.diffPercent !== null && l.diffCents !== 0 && (
                        <div className="text-[10px]">{l.diffPercent > 0 ? "+" : ""}{l.diffPercent.toFixed(1)}%</div>
                      )}
                    </td>
                    <td className="p-2 text-right">{l.realMarginPercent !== null ? `${l.realMarginPercent.toFixed(1)}%` : "—"}</td>
                    <td className="p-2 text-right">{l.realMarkupPercent !== null ? `${l.realMarkupPercent.toFixed(1)}%` : "—"}</td>
                    <td className="p-2">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] whitespace-nowrap ${STATUS_CLASS[l.status]}`}>
                        {STATUS_LABEL[l.status]}
                      </span>
                      {l.message && l.status !== "up" && l.status !== "down" && (
                        <div className="text-[10px] text-slate-400 mt-0.5">{l.message}</div>
                      )}
                    </td>
                  </tr>
                ))}
                {visible.length === 0 && (
                  <tr><td colSpan={10} className="p-6 text-center text-slate-400">Sem produtos nesta categoria.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {pageCount > 1 && (
            <div className="flex items-center justify-center gap-3 text-xs">
              <button onClick={() => setPage(Math.max(1, page - 1))} disabled={page === 1} className="px-2 py-1 border rounded disabled:opacity-40">Anterior</button>
              <span className="text-slate-500">Página {page} de {pageCount}</span>
              <button onClick={() => setPage(Math.min(pageCount, page + 1))} disabled={page === pageCount} className="px-2 py-1 border rounded disabled:opacity-40">Seguinte</button>
            </div>
          )}
        </div>

        <div className="border-t p-4 space-y-3">
          {requiresDecreaseConfirmation && previewToken && (
            <label className="flex items-start gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-0.5" />
              <span>Confirmo a descida de preço em <strong>{summary.down}</strong> produto(s).</span>
            </label>
          )}
          <div className="flex items-center gap-2">
            <button
              type="button" disabled={!canApply || applying}
              onClick={() => onApply(confirmed)}
              className="px-4 py-2 bg-sky-600 text-white rounded-lg text-sm font-medium hover:bg-sky-700 disabled:opacity-50"
            >
              {applying ? "A aplicar…" : previewToken ? `Aplicar a ${summary.affected} produto(s)` : "Nada para aplicar"}
            </button>
            <button type="button" onClick={onClose} className="px-4 py-2 border rounded-lg text-sm hover:bg-slate-50">
              Fechar sem aplicar
            </button>
          </div>
          <p className="text-[11px] text-slate-500">
            Produtos em preço manual nunca são alterados. Se algum produto mudar entretanto, a aplicação é recusada e terá de recalcular.
          </p>
        </div>
      </div>
    </div>
  );
}
