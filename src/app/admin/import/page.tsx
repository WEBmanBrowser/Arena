"use client";
import SupplierImportPanel from "@/components/admin/SupplierImportPanel";

/**
 * Admin → Importar/Exportar.
 *
 * Importação: apenas o Supplier Import Engine C.3.1 (lista de fornecedor).
 * O importador legacy de catálogo CSV deixou de estar exposto nesta página —
 * o endpoint legacy continua a existir no backend, mas não é invocado aqui.
 * A exportação do catálogo CSV mantém-se através de /api/admin/export.
 */
export default function AdminImportPage() {
  const doExport = () => { window.open("/api/admin/export", "_blank"); };

  return (
    <div>
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h2 className="text-xl font-bold text-slate-800">Importar lista de fornecedor</h2>
          <p className="text-sm text-slate-500 mt-1 max-w-2xl">
            Importe preços, stock e produtos através de uma lista fornecida pelo fornecedor. A referência do fornecedor é mantida separada do SKU interno MDTech.
          </p>
        </div>
        <button onClick={doExport} className="px-4 py-2 border rounded-lg text-sm text-slate-600 hover:bg-slate-50 whitespace-nowrap">
          📥 Exportar catálogo CSV
        </button>
      </div>

      <SupplierImportPanel />
    </div>
  );
}
