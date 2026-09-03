"use client";
import { useEffect, useState } from "react";

/**
 * C.2 — Create/edit a pricing rule.
 *
 * The normal flow is deliberately short: what it applies to, method,
 * percentage, rounding. Priority is hidden behind "Opções avançadas" and
 * defaults to 0, so the natural specificity order applies without the operator
 * ever needing to understand it.
 */

export type RuleScope = "global" | "supplier" | "brand" | "category" | "product";

export interface RuleFormValue {
  id?: number;
  scope: RuleScope;
  supplierId: number | null;
  brandId: number | null;
  categoryId: number | null;
  productId: number | null;
  method: "markup_on_cost" | "margin_on_sale";
  ratePercent: string;
  roundingPolicy: "auto" | "none" | "end_90" | "end_99";
  minMarginPercent: string;
  priority: number;
  isActive: boolean;
  notes: string;
}

export const EMPTY_RULE: RuleFormValue = {
  scope: "global", supplierId: null, brandId: null, categoryId: null, productId: null,
  method: "markup_on_cost", ratePercent: "", roundingPolicy: "auto",
  minMarginPercent: "", priority: 0, isActive: true, notes: "",
};

interface Option { id: number; name: string }

const SCOPE_LABEL: Record<RuleScope, string> = {
  global: "Geral (todos os produtos)",
  supplier: "Fornecedor",
  brand: "Marca",
  category: "Categoria",
  product: "Produto",
};

export default function PricingRuleForm({
  value, onChange, onSubmit, onCancel, saving, error, lockScope,
}: {
  value: RuleFormValue;
  onChange: (v: RuleFormValue) => void;
  onSubmit: () => void;
  onCancel: () => void;
  saving: boolean;
  error: string | null;
  lockScope?: boolean;
}) {
  const [advanced, setAdvanced] = useState(false);
  const [suppliers, setSuppliers] = useState<Option[]>([]);
  const [brandList, setBrandList] = useState<Option[]>([]);
  const [categoryList, setCategoryList] = useState<Option[]>([]);
  const [productQuery, setProductQuery] = useState("");
  const [productResults, setProductResults] = useState<Array<{ id: number; name: string; sku: string | null }>>([]);

  const u = (patch: Partial<RuleFormValue>) => onChange({ ...value, ...patch });

  useEffect(() => {
    fetch("/api/admin/suppliers", { cache: "no-store" }).then(r => r.json()).then(d => setSuppliers(d.suppliers || [])).catch(() => {});
    fetch("/api/admin/brands", { cache: "no-store" }).then(r => r.json()).then(d => setBrandList(d.brands || [])).catch(() => {});
    fetch("/api/admin/categories", { cache: "no-store" }).then(r => r.json()).then(d => setCategoryList(d.categories || [])).catch(() => {});
  }, []);

  useEffect(() => {
    // Everything (including clearing) happens inside the timer: calling
    // setState in the effect body itself is an error in this repo's lint rules.
    const t = setTimeout(() => {
      if (value.scope !== "product" || productQuery.trim().length < 2) { setProductResults([]); return; }
      fetch(`/api/admin/products?q=${encodeURIComponent(productQuery)}&limit=10`, { cache: "no-store" })
        .then(r => r.json()).then(d => setProductResults(d.products || [])).catch(() => {});
    }, 300);
    return () => clearTimeout(t);
  }, [productQuery, value.scope]);

  const changeScope = (scope: RuleScope) =>
    u({ scope, supplierId: null, brandId: null, categoryId: null, productId: null });

  return (
    <div className="space-y-4">
      {error && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">{error}</div>}

      <div>
        <label className="text-xs text-slate-500 block mb-1">Aplicar a</label>
        <div className="flex flex-wrap gap-2">
          {(Object.keys(SCOPE_LABEL) as RuleScope[]).map((s) => (
            <button
              key={s} type="button" disabled={lockScope}
              onClick={() => changeScope(s)}
              className={`px-3 py-1.5 rounded-lg text-sm border transition ${
                value.scope === s ? "bg-sky-600 text-white border-sky-600" : "bg-white text-slate-700 hover:border-sky-400"
              } ${lockScope ? "opacity-60 cursor-not-allowed" : ""}`}
            >
              {SCOPE_LABEL[s]}
            </button>
          ))}
        </div>
      </div>

      {value.scope === "supplier" && (
        <Select label="Fornecedor" value={value.supplierId} options={suppliers} onChange={(id) => u({ supplierId: id })} />
      )}
      {value.scope === "brand" && (
        <Select label="Marca" value={value.brandId} options={brandList} onChange={(id) => u({ brandId: id })} />
      )}
      {value.scope === "category" && (
        <Select label="Categoria" value={value.categoryId} options={categoryList} onChange={(id) => u({ categoryId: id })} />
      )}
      {value.scope === "product" && (
        <div>
          <label className="text-xs text-slate-500 block mb-1">Produto</label>
          <input
            value={productQuery} onChange={(e) => setProductQuery(e.target.value)}
            placeholder="Pesquisar por nome…"
            className="w-full border rounded px-3 py-1.5 text-sm"
          />
          {productResults.length > 0 && (
            <div className="border rounded-lg mt-1 max-h-40 overflow-auto bg-white">
              {productResults.map((p) => (
                <button
                  key={p.id} type="button"
                  onClick={() => { u({ productId: p.id }); setProductQuery(p.name); setProductResults([]); }}
                  className={`w-full text-left px-3 py-1.5 text-sm hover:bg-slate-50 ${value.productId === p.id ? "bg-sky-50" : ""}`}
                >
                  {p.name} {p.sku && <span className="text-slate-400">· {p.sku}</span>}
                </button>
              ))}
            </div>
          )}
          {value.productId && <p className="text-[11px] text-green-600 mt-1">✓ Produto selecionado</p>}
        </div>
      )}

      <div className="grid sm:grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-slate-500 block mb-1">Método</label>
          <select
            value={value.method}
            onChange={(e) => u({ method: e.target.value as RuleFormValue["method"] })}
            className="w-full border rounded px-3 py-1.5 text-sm bg-white"
          >
            <option value="markup_on_cost">Markup sobre custo</option>
            <option value="margin_on_sale">Margem sobre venda</option>
          </select>
          <p className="text-[11px] text-slate-500 mt-1">
            {value.method === "markup_on_cost"
              ? "Percentagem acrescentada ao custo de compra."
              : "Percentagem do preço de venda que fica como lucro. Tem de ser inferior a 100%."}
          </p>
        </div>
        <div>
          <label className="text-xs text-slate-500 block mb-1">Percentagem (%)</label>
          <input
            value={value.ratePercent} onChange={(e) => u({ ratePercent: e.target.value })}
            inputMode="decimal" placeholder="Ex.: 20"
            className="w-full border rounded px-3 py-1.5 text-sm"
          />
        </div>
      </div>

      <div>
        <label className="text-xs text-slate-500 block mb-1">Arredondamento</label>
        <select
          value={value.roundingPolicy}
          onChange={(e) => u({ roundingPolicy: e.target.value as RuleFormValue["roundingPolicy"] })}
          className="w-full border rounded px-3 py-1.5 text-sm bg-white"
        >
          <option value="auto">Automático (recomendado)</option>
          <option value="end_99">Terminar em ,99</option>
          <option value="end_90">Terminar em ,90</option>
          <option value="none">Sem arredondamento</option>
        </select>
        <p className="text-[11px] text-slate-500 mt-1">
          Automático usa a política global por faixas de preço. O arredondamento nunca reduz a margem pretendida.
        </p>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={value.isActive} onChange={(e) => u({ isActive: e.target.checked })} />
        Regra ativa
      </label>

      <div className="border-t pt-3">
        <button type="button" onClick={() => setAdvanced(!advanced)} className="text-xs text-slate-500 hover:text-sky-600">
          {advanced ? "▾" : "▸"} Opções avançadas
        </button>
        {advanced && (
          <div className="mt-3 space-y-3 bg-slate-50 border rounded-lg p-3">
            <div>
              <label className="text-xs text-slate-500 block mb-1">Prioridade especial</label>
              <input
                type="number" min={0} max={1000} value={value.priority}
                onChange={(e) => u({ priority: parseInt(e.target.value) || 0 })}
                className="w-full border rounded px-3 py-1.5 text-sm"
              />
              <p className="text-[11px] text-slate-500 mt-1">
                Normalmente deixe 0. A ordem natural já é Produto → Categoria → Marca → Fornecedor → Geral.
                Uma prioridade acima de 0 faz esta regra prevalecer sobre regras normalmente mais específicas.
              </p>
            </div>
            <div>
              <label className="text-xs text-slate-500 block mb-1">Margem mínima de segurança (%)</label>
              <input
                value={value.minMarginPercent} onChange={(e) => u({ minMarginPercent: e.target.value })}
                inputMode="decimal" placeholder="Opcional"
                className="w-full border rounded px-3 py-1.5 text-sm"
              />
              <p className="text-[11px] text-slate-500 mt-1">
                Se o resultado ficar abaixo desta margem, o produto é assinalado em vez de receber um preço demasiado baixo.
              </p>
            </div>
            <div>
              <label className="text-xs text-slate-500 block mb-1">Notas</label>
              <input
                value={value.notes} onChange={(e) => u({ notes: e.target.value })}
                className="w-full border rounded px-3 py-1.5 text-sm"
              />
            </div>
          </div>
        )}
      </div>

      <div className="flex gap-2 pt-2">
        <button
          type="button" onClick={onSubmit} disabled={saving}
          className="px-4 py-2 bg-sky-600 text-white rounded-lg text-sm font-medium hover:bg-sky-700 disabled:opacity-50"
        >
          {saving ? "A guardar…" : value.id ? "Guardar alterações" : "Criar regra"}
        </button>
        <button type="button" onClick={onCancel} className="px-4 py-2 border rounded-lg text-sm hover:bg-slate-50">
          Cancelar
        </button>
      </div>
      <p className="text-[11px] text-slate-500">
        Guardar a regra não altera preços. Depois poderá calcular o impacto e decidir se aplica.
      </p>
    </div>
  );
}

function Select({ label, value, options, onChange }: {
  label: string; value: number | null; options: Option[]; onChange: (id: number | null) => void;
}) {
  return (
    <div>
      <label className="text-xs text-slate-500 block mb-1">{label}</label>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
        className="w-full border rounded px-3 py-1.5 text-sm bg-white"
      >
        <option value="">— Selecionar —</option>
        {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
    </div>
  );
}
