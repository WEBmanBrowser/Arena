"use client";
import { useState, useEffect, useCallback } from "react";

/**
 * Product ↔ Supplier management UI.
 *
 * Consumes the EXISTING API at /api/admin/products/[id]/suppliers
 * (GET / POST / PUT / DELETE). No new endpoint, no schema change.
 *
 * Only fields that already exist on the `product_suppliers` table are shown:
 * supplierSku, costPrice, lastCostPrice (read-only), leadTimeDays, isPreferred.
 *
 * IMPORTANT: the API deliberately syncs `products.costPrice` from the
 * preferred supplier's cost. That server-side rule is untouched here; the UI
 * simply makes it visible to the operator.
 */

interface ProductSupplierRow {
  id: number;
  supplierId: number;
  supplierName: string;
  supplierSku: string | null;
  costPrice: string | null;
  lastCostPrice: string | null;
  leadTimeDays: number | null;
  isPreferred: boolean;
}

interface SupplierOption {
  id: number;
  name: string;
  isActive: boolean;
}

const eur = (v: string | null): string =>
  v == null || v === ""
    ? "—"
    : parseFloat(v).toLocaleString("pt-PT", { style: "currency", currency: "EUR" });

const emptyForm = { supplierId: "", supplierSku: "", costPrice: "", leadTimeDays: "", isPreferred: false };

/** Map API error codes to messages in European Portuguese. */
function errorMessage(code: string | undefined): string {
  switch (code) {
    case "PRODUCT_SUPPLIER_ALREADY_EXISTS":
      return "Este fornecedor já está associado a este produto.";
    case "PREFERRED_SUPPLIER_CONFLICT":
      return "Já existe outro fornecedor preferencial para este produto.";
    case "VALIDATION_ERROR":
      return "Dados inválidos. Verifique os campos preenchidos.";
    case "Não autorizado":
      return "Não tem permissões para gerir fornecedores (requer manager ou admin).";
    default:
      return code || "Ocorreu um erro. Tente novamente.";
  }
}

/**
 * `onChanged` refreshes the parent list: linking or editing the preferred
 * supplier syncs products.costPrice server-side, so the table would otherwise
 * keep showing a stale cost.
 */
export default function ProductSupplierManager({ productId, onChanged }: { productId: number; onChanged?: () => void | Promise<void> }) {
  const [rows, setRows] = useState<ProductSupplierRow[]>([]);
  const [allSuppliers, setAllSuppliers] = useState<SupplierOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState(emptyForm);

  const load = useCallback(async () => {
    setError("");
    try {
      const res = await fetch(`/api/admin/products/${productId}/suppliers`);
      const data = await res.json();
      if (!res.ok) {
        setError(errorMessage(data.error));
        setRows([]);
      } else {
        setRows(data.suppliers || []);
      }
    } catch {
      setError("Erro de rede ao carregar fornecedores.");
    }
    setLoading(false);
  }, [productId]);

  useEffect(() => {
    if (!productId) return;
    let cancelled = false;
    // Fire-and-forget load; the guard avoids setting state after unmount.
    (async () => {
      if (!cancelled) await load();
    })();
    return () => { cancelled = true; };
  }, [productId, load]);

  useEffect(() => {
    fetch("/api/admin/suppliers")
      .then((r) => r.json())
      .then((d) => setAllSuppliers(d.suppliers || []))
      .catch(() => setAllSuppliers([]));
  }, []);

  const flash = (msg: string) => {
    setSuccess(msg);
    setTimeout(() => setSuccess(""), 3000);
  };

  const resetForm = () => {
    setForm(emptyForm);
    setEditingId(null);
    setShowForm(false);
  };

  const openNew = () => {
    setForm(emptyForm);
    setEditingId(null);
    setShowForm(true);
    setError("");
  };

  const openEdit = (row: ProductSupplierRow) => {
    setForm({
      supplierId: String(row.supplierId),
      supplierSku: row.supplierSku || "",
      costPrice: row.costPrice || "",
      leadTimeDays: row.leadTimeDays != null ? String(row.leadTimeDays) : "",
      isPreferred: row.isPreferred,
    });
    setEditingId(row.id);
    setShowForm(true);
    setError("");
  };

  const save = async () => {
    setError("");
    if (!editingId && !form.supplierId) {
      setError("Selecione um fornecedor.");
      return;
    }
    setBusy(true);

    // Send only fields the backend schema accepts. Empty string => null.
    const payload: Record<string, unknown> = {
      supplierSku: form.supplierSku.trim() || null,
      costPrice: form.costPrice.trim() === "" ? null : form.costPrice.trim(),
      leadTimeDays: form.leadTimeDays.trim() === "" ? null : parseInt(form.leadTimeDays, 10),
      isPreferred: form.isPreferred,
    };
    if (editingId) payload.psId = editingId;
    else payload.supplierId = parseInt(form.supplierId, 10);

    try {
      const res = await fetch(`/api/admin/products/${productId}/suppliers`, {
        method: editingId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(errorMessage(data.error));
        setBusy(false);
        return;
      }
      flash(editingId ? "Fornecedor atualizado." : "Fornecedor associado.");
      resetForm();
      await load();
      await onChanged?.();
    } catch {
      setError("Erro de rede ao guardar.");
    }
    setBusy(false);
  };

  const setPreferred = async (row: ProductSupplierRow) => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/admin/products/${productId}/suppliers`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ psId: row.id, isPreferred: true }),
      });
      const data = await res.json();
      if (!res.ok) setError(errorMessage(data.error));
      else {
        flash("Fornecedor preferencial atualizado. O preço de custo do produto foi sincronizado.");
        await load();
        await onChanged?.();
      }
    } catch {
      setError("Erro de rede.");
    }
    setBusy(false);
  };

  const remove = async (row: ProductSupplierRow) => {
    const warning = row.isPreferred
      ? `Remover "${row.supplierName}"? É o fornecedor preferencial — o preço de custo do produto deixará de ser sincronizado por ele.`
      : `Remover a associação ao fornecedor "${row.supplierName}"?`;
    if (!confirm(warning)) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/admin/products/${productId}/suppliers`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ psId: row.id }),
      });
      const data = await res.json();
      if (!res.ok) setError(errorMessage(data.error));
      else {
        flash("Associação removida.");
        await load();
        await onChanged?.();
      }
    } catch {
      setError("Erro de rede.");
    }
    setBusy(false);
  };

  if (!productId) return null;

  const linkedIds = new Set(rows.map((r) => r.supplierId));
  const available = allSuppliers.filter((s) => !linkedIds.has(s.id) || String(s.id) === form.supplierId);

  return (
    <div className="border rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h4 className="font-medium text-slate-800">Fornecedores</h4>
          <p className="text-xs text-slate-500">
            O custo do fornecedor preferencial sincroniza o preço de custo do produto.
          </p>
        </div>
        <button
          type="button"
          onClick={openNew}
          disabled={busy}
          className="px-3 py-1.5 bg-sky-600 text-white rounded-lg text-xs font-medium hover:bg-sky-700 disabled:opacity-50"
        >
          + Associar fornecedor
        </button>
      </div>

      {error && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded p-2 mb-3">{error}</p>}
      {success && <p className="text-sm text-green-700 bg-green-50 border border-green-200 rounded p-2 mb-3">{success}</p>}

      {showForm && (
        <div className="border rounded-lg p-3 mb-3 bg-slate-50 space-y-3">
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-slate-500 block mb-1">Fornecedor *</label>
              {editingId ? (
                <p className="text-sm font-medium text-slate-800 py-1.5">
                  {rows.find((r) => r.id === editingId)?.supplierName}
                </p>
              ) : (
                <select
                  value={form.supplierId}
                  onChange={(e) => setForm((f) => ({ ...f, supplierId: e.target.value }))}
                  className="w-full border rounded px-3 py-1.5 text-sm bg-white"
                >
                  <option value="">Selecionar…</option>
                  {available.map((s) => (
                    <option key={s.id} value={s.id} disabled={!s.isActive}>
                      {s.name}
                      {!s.isActive ? " (inativo)" : ""}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div>
              <label className="text-xs text-slate-500 block mb-1">Referência / SKU do fornecedor</label>
              <input
                value={form.supplierSku}
                onChange={(e) => setForm((f) => ({ ...f, supplierSku: e.target.value }))}
                maxLength={100}
                placeholder="Opcional"
                className="w-full border rounded px-3 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="text-xs text-slate-500 block mb-1">Custo do fornecedor (€)</label>
              <input
                value={form.costPrice}
                onChange={(e) => setForm((f) => ({ ...f, costPrice: e.target.value }))}
                inputMode="decimal"
                placeholder="Ex.: 129.90"
                className="w-full border rounded px-3 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="text-xs text-slate-500 block mb-1">Prazo de entrega (dias)</label>
              <input
                value={form.leadTimeDays}
                onChange={(e) => setForm((f) => ({ ...f, leadTimeDays: e.target.value }))}
                inputMode="numeric"
                placeholder="Opcional"
                className="w-full border rounded px-3 py-1.5 text-sm"
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.isPreferred}
              onChange={(e) => setForm((f) => ({ ...f, isPreferred: e.target.checked }))}
            />
            Fornecedor preferencial (sincroniza o preço de custo do produto)
          </label>
          <div className="flex gap-2">
            <button type="button" onClick={resetForm} className="px-3 py-1.5 border rounded text-sm bg-white">
              Cancelar
            </button>
            <button
              type="button"
              onClick={save}
              disabled={busy}
              className="px-3 py-1.5 bg-sky-600 text-white rounded text-sm font-medium disabled:opacity-50"
            >
              {busy ? "A guardar…" : "Guardar"}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-slate-400">A carregar fornecedores…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-slate-400">Sem fornecedores associados a este produto.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="text-left p-2 font-medium text-slate-600">Fornecedor</th>
                <th className="text-left p-2 font-medium text-slate-600">Ref.ª</th>
                <th className="text-right p-2 font-medium text-slate-600">Custo</th>
                <th className="text-right p-2 font-medium text-slate-600 hidden sm:table-cell">Custo anterior</th>
                <th className="text-right p-2 font-medium text-slate-600 hidden sm:table-cell">Prazo</th>
                <th className="text-right p-2 font-medium text-slate-600">Ações</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t">
                  <td className="p-2">
                    <span className="font-medium text-slate-800">{row.supplierName}</span>
                    {row.isPreferred && (
                      <span className="ml-2 bg-sky-600 text-white text-[10px] px-1.5 py-0.5 rounded font-medium">
                        Preferencial
                      </span>
                    )}
                  </td>
                  <td className="p-2 text-slate-500">{row.supplierSku || "—"}</td>
                  <td className="p-2 text-right font-medium">{eur(row.costPrice)}</td>
                  <td className="p-2 text-right text-slate-400 hidden sm:table-cell">{eur(row.lastCostPrice)}</td>
                  <td className="p-2 text-right text-slate-500 hidden sm:table-cell">
                    {row.leadTimeDays != null ? `${row.leadTimeDays} d` : "—"}
                  </td>
                  <td className="p-2 text-right whitespace-nowrap">
                    {!row.isPreferred && (
                      <button
                        type="button"
                        onClick={() => setPreferred(row)}
                        disabled={busy}
                        className="text-sky-600 hover:text-sky-800 text-xs font-medium mr-2 disabled:opacity-50"
                      >
                        Preferencial
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => openEdit(row)}
                      disabled={busy}
                      className="text-slate-600 hover:text-slate-900 text-xs font-medium mr-2 disabled:opacity-50"
                    >
                      Editar
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(row)}
                      disabled={busy}
                      className="text-red-500 hover:text-red-700 text-xs font-medium disabled:opacity-50"
                    >
                      Remover
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
