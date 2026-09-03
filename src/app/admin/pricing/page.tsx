"use client";
import { useCallback, useEffect, useState } from "react";
import PricingRuleForm, { EMPTY_RULE, type RuleFormValue, type RuleScope } from "@/components/admin/PricingRuleForm";
import RecalcPreviewModal, { type RecalcLine, type RecalcSummary } from "@/components/admin/RecalcPreviewModal";
import RoundingPolicyEditor, { type Policy } from "@/components/admin/RoundingPolicyEditor";

/**
 * C.2 — Automatic pricing administration.
 *
 * Philosophy: configure once, let the engine price everything. Saving a rule
 * never moves prices; the operator explicitly asks for an impact analysis and
 * decides whether to apply it.
 */

interface RuleRow {
  id: number;
  scope: RuleScope;
  targetId: number | null;
  targetName: string | null;
  method: string;
  ratePercent: string;
  roundingPolicy: string;
  minMarginPercent: string | null;
  priority: number;
  isActive: boolean;
}

interface Coverage {
  total: number; automatic: number; manual: number;
  withoutCost: number; withoutRule: number; ready: number;
  hasGlobalRule: boolean; activeRules: number;
}

const SCOPE_LABEL: Record<RuleScope, string> = {
  global: "Todos", supplier: "Fornecedor", brand: "Marca", category: "Categoria", product: "Produto",
};

export default function PricingAdminPage() {
  const [rules, setRules] = useState<RuleRow[]>([]);
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<RuleFormValue>(EMPTY_RULE);
  const [lockScope, setLockScope] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [policySaving, setPolicySaving] = useState(false);
  const [policyError, setPolicyError] = useState<string | null>(null);

  const [preview, setPreview] = useState<{
    title: string; lines: RecalcLine[]; summary: RecalcSummary;
    previewToken: string | null; requiresDecreaseConfirmation: boolean;
  } | null>(null);
  const [applying, setApplying] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(async () => {
    /**
     * The loader must always terminate.
     *
     * The first version awaited .json() with no guard, so a failing endpoint
     * threw before `setLoading(false)` was ever reached and the page span for
     * ever. Loading now ends in `finally`, and a non-OK response becomes a
     * readable message instead of a spinner.
     */
    setLoadError(null);
    try {
      const [rulesRes, roundRes] = await Promise.all([
        fetch("/api/admin/pricing/rules", { cache: "no-store" }),
        fetch("/api/admin/pricing/rounding", { cache: "no-store" }),
      ]);

      const failed = [
        !rulesRes.ok ? `regras (HTTP ${rulesRes.status})` : null,
        !roundRes.ok ? `arredondamento (HTTP ${roundRes.status})` : null,
      ].filter(Boolean);

      if (failed.length) {
        const forbidden = rulesRes.status === 403 || roundRes.status === 403;
        setLoadError(
          forbidden
            ? "Sem permissões para aceder à administração de preços."
            : `Não foi possível carregar: ${failed.join(" e ")}. Se o problema persistir, confirme que as migrações da base de dados estão aplicadas.`
        );
        return;
      }

      const rulesData = await rulesRes.json();
      const roundData = await roundRes.json();
      setRules(rulesData.rules || []);
      setCoverage(rulesData.coverage || null);
      setPolicy(roundData.policy || null);
    } catch {
      setLoadError("Não foi possível contactar o servidor. Verifique a ligação e tente novamente.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Deferred: a loader that calls setState must not run directly in an
    // effect body (react-hooks/set-state-in-effect is an error here).
    const t = setTimeout(() => { void load(); }, 0);
    return () => clearTimeout(t);
  }, [load]);

  const notify = (msg: string) => { setFlash(msg); setTimeout(() => setFlash(null), 4000); };

  const openCreate = (scope: RuleScope = "global", lock = false) => {
    setForm({ ...EMPTY_RULE, scope });
    setLockScope(lock);
    setFormError(null);
    setShowForm(true);
  };

  const openEdit = (r: RuleRow) => {
    setForm({
      id: r.id, scope: r.scope,
      supplierId: r.scope === "supplier" ? r.targetId : null,
      brandId: r.scope === "brand" ? r.targetId : null,
      categoryId: r.scope === "category" ? r.targetId : null,
      productId: r.scope === "product" ? r.targetId : null,
      method: r.method as RuleFormValue["method"],
      ratePercent: String(Number(r.ratePercent)),
      roundingPolicy: r.roundingPolicy as RuleFormValue["roundingPolicy"],
      minMarginPercent: r.minMarginPercent ? String(Number(r.minMarginPercent)) : "",
      priority: r.priority, isActive: r.isActive, notes: "",
    });
    setLockScope(true);
    setFormError(null);
    setShowForm(true);
  };

  const saveRule = async () => {
    setSaving(true);
    setFormError(null);
    const rate = parseFloat(form.ratePercent.replace(",", "."));
    if (!Number.isFinite(rate) || rate < 0) { setFormError("Indique uma percentagem válida."); setSaving(false); return; }

    const targetId =
      form.scope === "supplier" ? form.supplierId
      : form.scope === "brand" ? form.brandId
      : form.scope === "category" ? form.categoryId
      : form.scope === "product" ? form.productId
      : null;
    if (form.scope !== "global" && !targetId) {
      setFormError(`Selecione ${SCOPE_LABEL[form.scope].toLowerCase()}.`); setSaving(false); return;
    }

    const minMargin = form.minMarginPercent.trim() === "" ? null : parseFloat(form.minMarginPercent.replace(",", "."));
    const body: Record<string, unknown> = {
      scope: form.scope,
      supplierId: form.scope === "supplier" ? targetId : undefined,
      brandId: form.scope === "brand" ? targetId : undefined,
      categoryId: form.scope === "category" ? targetId : undefined,
      productId: form.scope === "product" ? targetId : undefined,
      method: form.method, ratePercent: rate, roundingPolicy: form.roundingPolicy,
      minMarginPercent: minMargin, isActive: form.isActive,
      notes: form.notes || undefined,
    };
    if (form.priority > 0) body.priority = form.priority;
    if (form.id) body.id = form.id;

    const res = await fetch("/api/admin/pricing/rules", {
      method: form.id ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) { setFormError(data.message || data.error || "Erro ao guardar"); return; }

    setShowForm(false);
    await load();
    notify("Regra guardada. Os preços não foram alterados — calcule o impacto para os atualizar.");
  };

  const toggleRule = async (r: RuleRow) => {
    const res = await fetch("/api/admin/pricing/rules", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: r.id, isActive: !r.isActive }),
    });
    if (!res.ok) { const d = await res.json(); notify(d.message || "Erro"); return; }
    await load();
  };

  const removeRule = async (r: RuleRow) => {
    if (!confirm("Eliminar esta regra? Os preços atuais dos produtos não serão alterados.")) return;
    const res = await fetch("/api/admin/pricing/rules", {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: r.id }),
    });
    if (!res.ok) { const d = await res.json(); notify(d.message || "Erro"); return; }
    await load();
    notify("Regra eliminada.");
  };

  const runPreview = async (r: RuleRow | null) => {
    setPreviewError(null);
    const res = await fetch("/api/admin/pricing/recalculate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(r ? { mode: "preview", ruleId: r.id } : { mode: "preview" }),
    });
    const data = await res.json();
    if (!res.ok) { notify(data.message || data.error || "Erro ao calcular impacto"); return; }
    setPreview({
      title: r ? `Impacto — ${SCOPE_LABEL[r.scope]}${r.targetName ? `: ${r.targetName}` : ""}` : "Impacto — todo o catálogo",
      lines: data.lines, summary: data.summary,
      previewToken: data.previewToken, requiresDecreaseConfirmation: data.requiresDecreaseConfirmation,
    });
  };

  const applyPreview = async (confirmDecreases: boolean) => {
    if (!preview?.previewToken) return;
    setApplying(true);
    setPreviewError(null);
    const res = await fetch("/api/admin/pricing/recalculate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "apply", previewToken: preview.previewToken, confirmDecreases }),
    });
    const data = await res.json();
    setApplying(false);
    if (!res.ok) { setPreviewError(data.message || data.error || "Erro ao aplicar"); return; }
    setPreview(null);
    await load();
    notify(`${data.updated} preço(s) atualizado(s) — ${data.up} subiram, ${data.down} desceram.`);
  };

  const savePolicy = async (p: Policy) => {
    setPolicySaving(true);
    setPolicyError(null);
    const res = await fetch("/api/admin/pricing/rounding", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p),
    });
    const data = await res.json();
    setPolicySaving(false);
    if (!res.ok) { setPolicyError(data.message || data.error || "Erro ao guardar"); return; }
    setPolicy(data.policy);
    notify("Política de arredondamento guardada.");
  };

  if (loading) return <div className="p-6 text-slate-500">A carregar…</div>;

  // Terminal error state: the operator gets a reason and a way out, not a spinner.
  if (loadError) {
    return (
      <div className="p-6">
        <h1 className="text-xl font-semibold mb-4">Preços automáticos</h1>
        <div className="p-4 rounded-lg border border-red-200 bg-red-50">
          <p className="text-sm font-medium text-red-700">{loadError}</p>
          <button type="button"
            onClick={() => { setLoading(true); void load(); }}
            className="mt-3 px-3 py-1.5 text-xs rounded border border-red-300 text-red-700 bg-white hover:bg-red-100">
            Tentar novamente
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-800">Preços automáticos</h1>
          <p className="text-sm text-slate-500">Configure uma vez e o sistema calcula os preços a partir do custo.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => void runPreview(null)} className="px-3 py-2 border rounded-lg text-sm hover:bg-slate-50">
            Calcular impacto global
          </button>
          <button onClick={() => openCreate("supplier")} className="px-4 py-2 bg-sky-600 text-white rounded-lg text-sm font-medium hover:bg-sky-700">
            + Nova regra
          </button>
        </div>
      </div>

      {flash && <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-sm text-green-800">{flash}</div>}

      {coverage && !coverage.hasGlobalRule && (
        <div className="bg-amber-50 border border-amber-300 rounded-xl p-4">
          <p className="font-semibold text-amber-900">Não existe uma regra geral de preços.</p>
          <p className="text-sm text-amber-800 mt-1">
            Produtos sem uma regra específica não poderão ter o preço calculado automaticamente.
          </p>
          <button
            onClick={() => openCreate("global", true)}
            className="mt-3 px-4 py-2 bg-amber-600 text-white rounded-lg text-sm font-medium hover:bg-amber-700"
          >
            Criar regra geral
          </button>
        </div>
      )}

      {coverage && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <Stat label="Produtos" value={coverage.total} />
          <Stat label="Automáticos" value={coverage.automatic} tone="text-sky-700" />
          <Stat label="Manuais" value={coverage.manual} tone="text-violet-700" />
          <Stat label="Sem custo" value={coverage.withoutCost} tone={coverage.withoutCost ? "text-amber-700" : ""} />
          <Stat label="Sem regra" value={coverage.withoutRule} tone={coverage.withoutRule ? "text-red-700" : "text-green-700"} />
          <Stat label="Prontos" value={coverage.ready} tone="text-green-700" />
        </div>
      )}

      <div className="bg-white rounded-xl border overflow-hidden">
        <div className="p-4 border-b">
          <h2 className="font-semibold text-slate-800">Regras de preços</h2>
          <p className="text-xs text-slate-500">
            Ordem de aplicação: Produto → Categoria → Marca → Fornecedor → Geral. A regra mais específica ganha.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className="text-left p-3">Aplicada a</th>
                <th className="text-left p-3">Âmbito</th>
                <th className="text-left p-3">Método</th>
                <th className="text-right p-3">Valor</th>
                <th className="text-left p-3">Arredondamento</th>
                <th className="text-left p-3">Estado</th>
                <th className="text-right p-3">Ações</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="p-3">
                    <span className="font-medium text-slate-800">{r.targetName || "—"}</span>
                    {r.priority > 0 && (
                      <span className="ml-2 px-1.5 py-0.5 bg-orange-100 text-orange-700 rounded text-[10px]">
                        prioridade especial
                      </span>
                    )}
                  </td>
                  <td className="p-3 text-slate-600">{SCOPE_LABEL[r.scope]}</td>
                  <td className="p-3 text-slate-600">{r.method === "markup_on_cost" ? "Markup" : "Margem"}</td>
                  <td className="p-3 text-right font-medium">{Number(r.ratePercent)}%</td>
                  <td className="p-3 text-slate-600">
                    {r.roundingPolicy === "auto" ? "Automático" : r.roundingPolicy === "none" ? "Sem" : r.roundingPolicy === "end_90" ? ",90" : ",99"}
                  </td>
                  <td className="p-3">
                    <span className={`px-2 py-0.5 rounded text-xs ${r.isActive ? "bg-green-50 text-green-700" : "bg-slate-100 text-slate-500"}`}>
                      {r.isActive ? "Ativa" : "Inativa"}
                    </span>
                  </td>
                  <td className="p-3 text-right whitespace-nowrap">
                    <button onClick={() => void runPreview(r)} className="text-sky-600 hover:underline text-xs mr-3">Ver impacto</button>
                    <button onClick={() => openEdit(r)} className="text-slate-600 hover:underline text-xs mr-3">Editar</button>
                    <button onClick={() => void toggleRule(r)} className="text-slate-600 hover:underline text-xs mr-3">
                      {r.isActive ? "Desativar" : "Ativar"}
                    </button>
                    <button onClick={() => void removeRule(r)} className="text-red-600 hover:underline text-xs">Eliminar</button>
                  </td>
                </tr>
              ))}
              {rules.length === 0 && (
                <tr><td colSpan={7} className="p-8 text-center text-slate-400">Ainda não existem regras de preços.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {policy && <RoundingPolicyEditor policy={policy} onSave={savePolicy} saving={policySaving} error={policyError} />}

      {showForm && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-start justify-center p-4 overflow-auto">
          <div className="bg-white rounded-xl w-full max-w-2xl my-4">
            <div className="flex items-center justify-between border-b p-4">
              <h3 className="font-semibold text-slate-800">{form.id ? "Editar regra" : "Nova regra de preço"}</h3>
              <button onClick={() => setShowForm(false)} className="text-slate-400 hover:text-slate-700 text-xl leading-none">×</button>
            </div>
            <div className="p-4">
              <PricingRuleForm
                value={form} onChange={setForm} onSubmit={saveRule}
                onCancel={() => setShowForm(false)} saving={saving} error={formError} lockScope={lockScope}
              />
            </div>
          </div>
        </div>
      )}

      {preview && (
        <RecalcPreviewModal
          title={preview.title} lines={preview.lines} summary={preview.summary}
          previewToken={preview.previewToken} requiresDecreaseConfirmation={preview.requiresDecreaseConfirmation}
          applying={applying} error={previewError}
          onApply={applyPreview} onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="bg-white rounded-xl border p-3">
      <p className="text-[11px] text-slate-500">{label}</p>
      <p className={`text-xl font-bold ${tone || "text-slate-800"}`}>{value}</p>
    </div>
  );
}
