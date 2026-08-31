"use client";
import { useState } from "react";
import { useSearchParams } from "next/navigation";

export default function RecuperarPasswordClient() {
  const params = useSearchParams();
  const token = params.get("token") || "";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [okMessage, setOkMessage] = useState("");

  async function pedirEmail(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(""); setOkMessage("");
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Erro");
      setOkMessage(data.message || "Se a conta existir, foi enviado um email de recuperação.");
    } catch (err) { setError((err as Error).message); }
    setBusy(false);
  }

  async function redefinir(e: React.FormEvent) {
    e.preventDefault();
    if (password !== password2) { setError("As passwords não coincidem."); return; }
    setBusy(true); setError(""); setOkMessage("");
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Erro");
      setOkMessage(data.message || "Password redefinida com sucesso.");
    } catch (err) { setError((err as Error).message); }
    setBusy(false);
  }

  return (
    <div className="max-w-md mx-auto py-12 px-4">
      <h1 className="text-2xl font-bold text-slate-800 mb-2">Recuperar password</h1>
      <p className="text-sm text-slate-500 mb-6">
        {token ? "Define uma nova password para a tua conta." : "Indica o email da conta para receberes um link de recuperação."}
      </p>

      {error && <div className="mb-4 p-3 bg-red-50 text-red-600 rounded-lg text-sm">{error}</div>}
      {okMessage && <div className="mb-4 p-3 bg-green-50 text-green-700 rounded-lg text-sm">{okMessage}</div>}

      {!token ? (
        <form onSubmit={pedirEmail} className="space-y-4">
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-slate-700 mb-1">Email</label>
            <input id="email" type="email" required value={email} onChange={e => setEmail(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm" placeholder="oteu@email.pt" />
          </div>
          <button type="submit" disabled={busy}
            className="w-full bg-sky-600 text-white rounded-lg py-2 text-sm font-medium disabled:opacity-50">
            {busy ? "A enviar..." : "Enviar link de recuperação"}
          </button>
        </form>
      ) : (
        <form onSubmit={redefinir} className="space-y-4">
          <div>
            <label htmlFor="npass" className="block text-sm font-medium text-slate-700 mb-1">Nova password</label>
            <input id="npass" type="password" required minLength={8} value={password} onChange={e => setPassword(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm" placeholder="Mínimo 8 caracteres" />
          </div>
          <div>
            <label htmlFor="npass2" className="block text-sm font-medium text-slate-700 mb-1">Confirmar password</label>
            <input id="npass2" type="password" required minLength={8} value={password2} onChange={e => setPassword2(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm" />
          </div>
          <button type="submit" disabled={busy}
            className="w-full bg-sky-600 text-white rounded-lg py-2 text-sm font-medium disabled:opacity-50">
            {busy ? "A guardar..." : "Redefinir password"}
          </button>
        </form>
      )}

      <p className="text-xs text-slate-400 mt-6">O link de recuperação é válido por 60 minutos e pode ser usado uma única vez.</p>
    </div>
  );
}
