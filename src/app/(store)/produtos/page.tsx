import { Suspense } from "react";
import ProdutosClient from "./ProdutosClient";

export default function ProdutosPage() {
  return (
    <Suspense fallback={<div className="max-w-7xl mx-auto px-4 py-16 text-center text-slate-500">A carregar produtos...</div>}>
      <ProdutosClient />
    </Suspense>
  );
}
