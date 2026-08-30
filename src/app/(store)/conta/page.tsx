import { Suspense } from "react";
import ContaClient from "./ContaClient";

export default function ContaPage() {
  return (
    <Suspense fallback={<div className="max-w-3xl mx-auto px-4 py-16 text-center text-slate-500">A carregar...</div>}>
      <ContaClient />
    </Suspense>
  );
}
