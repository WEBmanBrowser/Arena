"use client";
import { useMemo, useState } from "react";
import {
  calculatePrice,
  analyseGrossPrice,
  centsToDecimalString,
  formatCents,
  PricingError,
  type PricingMethod,
  type RoundingMode,
} from "@/lib/pricing-calculator";

/**
 * Pricing section of the product form.
 *
 * Two ways to set the sale price:
 *   - "Preço manual"          — type the gross price; margin is reported.
 *   - "Calcular a partir do custo" — pick a method (margin on sale OR markup
 *     on cost), a percentage and a commercial ending; the price is derived.
 *
 * All arithmetic lives in src/lib/pricing-calculator.ts (integer cents) so the
 * future automatic pricing engine can reuse it. Everything here is a preview:
 * the value submitted is a plain gross price, still validated server-side.
 */

interface Props {
  price: string;
  comparePrice: string;
  costPrice: string;
  vatRate: string;
  onChange: (field: "price" | "comparePrice" | "costPrice" | "vatRate", value: string) => void;
}

const METHOD_LABEL: Record<PricingMethod, string> = {
  margin_on_sale: "Margem sobre venda",
  markup_on_cost: "Markup sobre custo",
};

const METHOD_HELP: Record<PricingMethod, string> = {
  margin_on_sale:
    "Percentagem do preço de venda (s/ IVA) que fica como lucro. Indicador real de rentabilidade. Tem de ser inferior a 100%.",
  markup_on_cost:
    "Percentagem acrescentada ao custo de compra. Habitual em regras comerciais por fornecedor. Não tem limite.",
};

export default function PriceCalculator({ price, comparePrice, costPrice, vatRate, onChange }: Props) {
  const [mode, setMode] = useState<"manual" | "calculated">("manual");
  const [method, setMethod] = useState<PricingMethod>("margin_on_sale");
  const [rate, setRate] = useState("30");
  const [rounding, setRounding] = useState<RoundingMode>("none");

  // Live preview of the calculated price (never written until applied).
  const calculated = useMemo(() => {
    if (mode !== "calculated") return null;
    try {
      return { ok: true as const, data: calculatePrice({ cost: costPrice, method, ratePercent: rate, vatPercent: vatRate, rounding }) };
    } catch (e) {
      return { ok: false as const, message: e instanceof PricingError ? e.message : "Não foi possível calcular o preço." };
    }
  }, [mode, costPrice, method, rate, vatRate, rounding]);

  // Real margin of whatever is currently in the price field.
  const current = useMemo(() => {
    try {
      return analyseGrossPrice({ grossPrice: price, cost: costPrice, vatPercent: vatRate });
    } catch {
      return null;
    }
  }, [price, costPrice, vatRate]);

  const applyCalculated = () => {
    if (calculated?.ok) onChange("price", centsToDecimalString(calculated.data.finalGrossCents));
  };

  const pct = (v: number) => `${v.toFixed(1)}%`;
  const suggested = calculated?.ok ? centsToDecimalString(calculated.data.finalGrossCents) : null;
  const alreadyApplied = suggested !== null && suggested === price.trim();

  return (
    <div className="space-y-4">
      {/* Cost + VAT: shared context for both modes */}
      <div className="grid sm:grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-slate-500">Preço de custo (€)</label>
          <input
            value={costPrice}
            onChange={(e) => onChange("costPrice", e.target.value)}
            inputMode="decimal"
            placeholder="Opcional"
            className="w-full border rounded px-3 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="text-xs text-slate-500">Taxa de IVA (%)</label>
          <input
            value={vatRate}
            onChange={(e) => onChange("vatRate", e.target.value)}
            inputMode="decimal"
            className="w-full border rounded px-3 py-1.5 text-sm"
          />
        </div>
      </div>

      {/* Mode selector */}
      <div className="border rounded-lg p-3">
        <p className="text-xs text-slate-500 mb-2">Modo de definição do preço</p>
        <div className="flex flex-col sm:flex-row gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="price-mode" checked={mode === "manual"} onChange={() => setMode("manual")} />
            Preço manual
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="price-mode" checked={mode === "calculated"} onChange={() => setMode("calculated")} />
            Calcular a partir do custo
          </label>
        </div>
      </div>

      {/* Calculator */}
      {mode === "calculated" && (
        <div className="border rounded-lg p-4 bg-slate-50 space-y-3">
          <div>
            <label className="text-xs text-slate-500 block mb-1">Método de cálculo</label>
            <select
              value={method}
              onChange={(e) => setMethod(e.target.value as PricingMethod)}
              className="w-full border rounded px-3 py-1.5 text-sm bg-white"
            >
              <option value="margin_on_sale">{METHOD_LABEL.margin_on_sale}</option>
              <option value="markup_on_cost">{METHOD_LABEL.markup_on_cost}</option>
            </select>
            <p className="text-[11px] text-slate-500 mt-1">{METHOD_HELP[method]}</p>
          </div>

          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-slate-500 block mb-1">
                {method === "margin_on_sale" ? "Margem pretendida (%)" : "Markup pretendido (%)"}
              </label>
              <input
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                inputMode="decimal"
                className="w-full border rounded px-3 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="text-xs text-slate-500 block mb-1">Arredondamento comercial</label>
              <select
                value={rounding}
                onChange={(e) => setRounding(e.target.value as RoundingMode)}
                className="w-full border rounded px-3 py-1.5 text-sm bg-white"
              >
                <option value="none">Sem arredondamento</option>
                <option value="end_90">Terminar em ,90 €</option>
                <option value="end_99">Terminar em ,99 €</option>
              </select>
            </div>
          </div>

          {calculated && !calculated.ok && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded p-2">{calculated.message}</p>
          )}

          {calculated?.ok && (
            <div className="bg-white border rounded-lg p-3">
              <h5 className="text-sm font-medium text-slate-800 mb-2">Resumo do cálculo</h5>
              <dl className="text-sm divide-y">
                <Row label="Custo" value={formatCents(calculated.data.costCents)} />
                <Row
                  label={method === "margin_on_sale" ? "Margem pretendida" : "Markup pretendido"}
                  value={pct(Number(rate) || 0)}
                />
                <Row label="Preço s/ IVA" value={formatCents(calculated.data.netBeforeRoundingCents)} />
                <Row label={`IVA (${vatRate || 0}%)`} value={formatCents(calculated.data.grossBeforeRoundingCents - calculated.data.netBeforeRoundingCents)} />
                <Row label="Preço matemático c/ IVA" value={formatCents(calculated.data.grossBeforeRoundingCents)} />
                <Row
                  label="Preço final comercial"
                  value={formatCents(calculated.data.finalGrossCents)}
                  strong
                  hint={calculated.data.roundingUpliftCents > 0 ? `+${formatCents(calculated.data.roundingUpliftCents)} por arredondamento` : undefined}
                />
                <Row
                  label="Margem real (sobre venda)"
                  value={`${formatCents(calculated.data.realMarginCents)} · ${pct(calculated.data.realMarginOnSalePercent)}`}
                  tone={calculated.data.realMarginCents >= 0 ? "text-green-600" : "text-red-600"}
                />
                <Row
                  label="Markup real (sobre custo)"
                  value={calculated.data.realMarkupOnCostPercent === null ? "—" : pct(calculated.data.realMarkupOnCostPercent)}
                />
              </dl>

              <button
                type="button"
                onClick={applyCalculated}
                disabled={alreadyApplied}
                className="mt-3 px-4 py-2 bg-sky-600 text-white rounded-lg text-sm font-medium hover:bg-sky-700 disabled:opacity-50"
              >
                {alreadyApplied ? "✓ Preço aplicado" : "Aplicar este preço"}
              </button>
              <p className="text-[11px] text-slate-500 mt-2">
                O preço só é gravado ao guardar o produto e continua sujeito à validação do servidor.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Final price — always editable, in both modes */}
      <div className="grid sm:grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-slate-500">Preço de venda c/ IVA (€) *</label>
          <input
            value={price}
            onChange={(e) => onChange("price", e.target.value)}
            inputMode="decimal"
            className="w-full border rounded px-3 py-1.5 text-sm font-medium"
          />
          <p className="text-[11px] text-slate-500 mt-1">Pode sempre ajustar manualmente o preço final.</p>
        </div>
        <div>
          <label className="text-xs text-slate-500">Preço anterior (€)</label>
          <input
            value={comparePrice}
            onChange={(e) => onChange("comparePrice", e.target.value)}
            inputMode="decimal"
            placeholder="Opcional"
            className="w-full border rounded px-3 py-1.5 text-sm"
          />
        </div>
      </div>

      {/* Real margin of the price actually in the field */}
      <div className="border rounded-lg p-4 bg-slate-50">
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-sm font-medium text-slate-800">Margem do preço atual</h4>
          <span className="text-[10px] text-slate-500 uppercase tracking-wide">Apenas indicativo</span>
        </div>
        {current === null || costPrice.trim() === "" ? (
          <p className="text-sm text-slate-400">Preencha o preço de venda e o preço de custo para ver a margem.</p>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Cell label="Venda s/ IVA" value={formatCents(current.finalNetCents)} />
              <Cell label="Custo" value={formatCents(current.costCents)} />
              <Cell
                label="Margem (€)"
                value={formatCents(current.realMarginCents)}
                tone={current.realMarginCents >= 0 ? "text-green-600" : "text-red-600"}
                bold
              />
              <Cell
                label="Margem (%)"
                value={pct(current.realMarginOnSalePercent)}
                tone={current.realMarginCents >= 0 ? "text-green-600" : "text-red-600"}
                bold
              />
            </div>
            {current.realMarginCents < 0 && (
              <p className="text-xs text-red-600 mt-2">⚠️ O preço de custo é superior ao preço de venda sem IVA.</p>
            )}
            <p className="text-[11px] text-slate-500 mt-3">
              Margem sobre venda = (preço c/ IVA ÷ (1 + IVA/100)) − custo. Cálculo de interface: não altera regras financeiras.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function Row({ label, value, strong, tone, hint }: { label: string; value: string; strong?: boolean; tone?: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between py-1.5 gap-3">
      <dt className="text-slate-500 text-xs">{label}</dt>
      <dd className={`text-right ${strong ? "text-base font-bold text-slate-900" : "text-sm"} ${tone || "text-slate-800"}`}>
        {value}
        {hint && <span className="block text-[11px] font-normal text-slate-400">{hint}</span>}
      </dd>
    </div>
  );
}

function Cell({ label, value, tone, bold }: { label: string; value: string; tone?: string; bold?: boolean }) {
  return (
    <div>
      <p className="text-[11px] text-slate-500">{label}</p>
      <p className={`text-sm ${bold ? "font-bold" : "font-medium"} ${tone || "text-slate-800"}`}>{value}</p>
    </div>
  );
}
