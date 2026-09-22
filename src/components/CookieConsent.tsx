"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type Choice = "all" | "necessary";
const KEY = "mdtech_cookie_consent_v1";

export default function CookieConsent() {
  const [visible, setVisible] = useState(false);
  useEffect(() => { setVisible(localStorage.getItem(KEY) === null); }, []);
  const choose = (choice: Choice) => {
    localStorage.setItem(KEY, JSON.stringify({ choice, version: "2026-09-22", at: new Date().toISOString() }));
    window.dispatchEvent(new CustomEvent("mdtech:cookie-consent", { detail: { choice } }));
    setVisible(false);
  };
  if (!visible) return null;
  return (
    <div role="dialog" aria-label="Preferências de cookies" className="fixed inset-x-3 bottom-3 z-[100] mx-auto max-w-4xl rounded-xl border bg-white p-4 shadow-2xl">
      <p className="font-semibold text-slate-900">Cookies e privacidade</p>
      <p className="mt-1 text-sm text-slate-600">Usamos cookies estritamente necessários para o funcionamento da loja. Cookies analíticos ou de marketing só devem ser ativados depois da sua escolha. Consulte a <Link href="/pagina/politica-cookies" className="text-sky-700 underline">Política de Cookies</Link>.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button onClick={() => choose("necessary")} className="rounded-lg border px-4 py-2 text-sm font-medium">Rejeitar não essenciais</button>
        <button onClick={() => choose("all")} className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white">Aceitar todos</button>
      </div>
    </div>
  );
}
