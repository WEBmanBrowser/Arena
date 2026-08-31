import { Suspense } from "react";
import RecuperarPasswordClient from "./RecuperarPasswordClient";

export const metadata = {
  title: "Recuperar password — MDTech",
  description: "Recupera o acesso à tua conta MDTech.",
};

export default function RecuperarPasswordPage() {
  return (
    <Suspense fallback={<div className="max-w-md mx-auto py-12 px-4 text-sm text-slate-500">A carregar...</div>}>
      <RecuperarPasswordClient />
    </Suspense>
  );
}
