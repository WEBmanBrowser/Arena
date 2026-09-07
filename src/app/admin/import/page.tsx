"use client";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import SupplierImportPanel from "@/components/admin/SupplierImportPanel";
import { IMPORT_REVIEW_QUERY_PARAM, parseSupplierImportReviewParam } from "@/lib/import-review-link";

/**
 * Admin → Importar/Exportar.
 *
 * Importação: apenas o Supplier Import Engine C.3.1 (lista de fornecedor).
 * O importador legacy de catálogo CSV deixou de estar exposto nesta página —
 * o endpoint legacy continua a existir no backend, mas não é invocado aqui.
 * A exportação do catálogo CSV mantém-se através de /api/admin/export.
 *
 * C.3.4.2 — `?open=<id>` reabre um preview PERSISTIDO (criado por
 * "Sincronizar agora" ou por um upload seguido de reload) no mesmo painel. A
 * URL transporta apenas o id: o token de apply é reemitido pelo servidor ao
 * abrir. `useSearchParams` vive num componente filho dentro de <Suspense>
 * para a página continuar prerenderable (Next 16 exige o boundary).
 */
function ImportPanelFromQuery() {
  const searchParams = useSearchParams();
  const openImportId = parseSupplierImportReviewParam(searchParams.get(IMPORT_REVIEW_QUERY_PARAM));
  return <SupplierImportPanel openImportId={openImportId} />;
}

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

      <Suspense fallback={<div className="bg-white border rounded-xl p-6 mb-6 text-sm text-slate-500">A carregar...</div>}>
        <ImportPanelFromQuery />
      </Suspense>
    </div>
  );
}
