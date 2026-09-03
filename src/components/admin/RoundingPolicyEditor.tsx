"use client";
import { useState } from "react";

/**
 * C.2 — Global rounding policy editor.
 *
 * The operator edits UPPER BOUNDS only ("até 199,99 € → ,99"). Each band
 * therefore starts exactly where the previous one ended, which makes gaps and
 * overlaps structurally impossible instead of merely validated against.
 * Internally this maps to the `fromCents` bands the engine expects.
 */

export interface Band { fromCents: number; mode: "none" | "end_90" | "end_99" }
export interface Policy { enabled: boolean; bands: Band[] }

const MODE_LABEL: Record<Band["mode"], string> = {
  end_99: "Terminar em ,99",
  end_90: "Terminar em ,90",
  none: "Sem arredondamento",
};

/** Upper bound of band i = start of band i+1, minus one cent. */
function upperBoundOf(bands: Band[], i: number): number | null {
  const sorted = [...bands].sort((a, b) => a.fromCents - b.fromCents);
  return i < sorted.length - 1 ? sorted[i + 1].fromCents - 1 : null;
}

export default function RoundingPolicyEditor({
  policy, onSave, saving, error,
}: {
  policy: Policy;
  onSave: (p: Policy) => void;
  saving: boolean;
  error: string | null;
}) {
  const [draft, setDraft] = useState<Policy>(policy);
  const [localError, setLocalError] = useState<string | null>(null);

  const sorted = [...draft.bands].sort((a, b) => a.fromCents - b.fromCents);

  const setMode = (fromCents: number, mode: Band["mode"]) =>
    setDraft({ ...draft, bands: draft.bands.map((b) => (b.fromCents === fromCents ? { ...b, mode } : b)) });

  /** Editing an upper bound moves the START of the NEXT band. */
  const setUpperBound = (index: number, euros: string) => {
    const value = parseFloat(euros.replace(",", "."));
    if (!Number.isFinite(value) || value < 0) return;
    const nextStart = Math.round(value * 100) + 1;
    const next = sorted[index + 1];
    if (!next) return;
    setDraft({ ...draft, bands: draft.bands.map((b) => (b.fromCents === next.fromCents ? { ...b, fromCents: nextStart } : b)) });
  };

  const addBand = () => {
    const last = sorted[sorted.length - 1];
    setDraft({ ...draft, bands: [...draft.bands, { fromCents: last.fromCents + 10000, mode: "end_90" }] });
  };

  const removeBand = (fromCents: number) => {
    if (fromCents === 0) return; // the 0 band is mandatory
    setDraft({ ...draft, bands: draft.bands.filter((b) => b.fromCents !== fromCents) });
  };

  const submit = () => {
    setLocalError(null);
    const starts = draft.bands.map((b) => b.fromCents);
    if (!starts.includes(0)) { setLocalError("É necessária uma faixa a começar em 0 €."); return; }
    if (new Set(starts).size !== starts.length) { setLocalError("Existem faixas com o mesmo início."); return; }
    onSave({ ...draft, bands: [...draft.bands].sort((a, b) => a.fromCents - b.fromCents) });
  };

  return (
    <div className="bg-white rounded-xl border p-4">
      <h3 className="font-semibold text-slate-800 mb-1">Arredondamento comercial automático</h3>
      <p className="text-xs text-slate-500 mb-4">
        Define a terminação por faixa de preço. Usada por todas as regras com arredondamento &ldquo;Automático&rdquo;.
        O preço final nunca desce abaixo do preço matemático.
      </p>

      {(error || localError) && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700 mb-3">{error || localError}</div>
      )}

      <label className="flex items-center gap-2 text-sm mb-3">
        <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
        Arredondamento automático ativo
      </label>

      <div className="border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500">
            <tr>
              <th className="text-left p-2">Até</th>
              <th className="text-left p-2">Terminação</th>
              <th className="p-2 w-10"></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((band, i) => {
              const upper = upperBoundOf(draft.bands, i);
              return (
                <tr key={band.fromCents} className="border-t">
                  <td className="p-2">
                    {upper === null ? (
                      <span className="text-slate-500">Acima</span>
                    ) : (
                      <div className="flex items-center gap-1">
                        <input
                          defaultValue={(upper / 100).toFixed(2)}
                          onBlur={(e) => setUpperBound(i, e.target.value)}
                          inputMode="decimal"
                          className="w-28 border rounded px-2 py-1 text-sm"
                        />
                        <span className="text-slate-400 text-xs">€</span>
                      </div>
                    )}
                  </td>
                  <td className="p-2">
                    <select
                      value={band.mode}
                      onChange={(e) => setMode(band.fromCents, e.target.value as Band["mode"])}
                      className="border rounded px-2 py-1 text-sm bg-white"
                    >
                      {Object.entries(MODE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </td>
                  <td className="p-2 text-right">
                    {band.fromCents !== 0 && (
                      <button onClick={() => removeBand(band.fromCents)} className="text-slate-400 hover:text-red-600 text-xs">remover</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-2 mt-3">
        <button onClick={addBand} className="text-xs text-sky-600 hover:underline">+ Adicionar faixa</button>
        <div className="flex-1" />
        <button
          onClick={submit} disabled={saving}
          className="px-4 py-2 bg-sky-600 text-white rounded-lg text-sm font-medium hover:bg-sky-700 disabled:opacity-50"
        >
          {saving ? "A guardar…" : "Guardar política"}
        </button>
      </div>
      <p className="text-[11px] text-slate-500 mt-2">
        Guardar a política não altera preços existentes. Calcule o impacto de uma regra para os atualizar.
      </p>
    </div>
  );
}
