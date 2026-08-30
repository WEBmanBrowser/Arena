"use client";
import { useState, useEffect } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";

export default function ContaClient() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const tab = searchParams.get("tab") || "dashboard";
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [orders, setOrders] = useState<any[]>([]);
  const [wishlist, setWishlist] = useState<any[]>([]);
  const [rmaList, setRmaList] = useState<any[]>([]);
  const [loginForm, setLoginForm] = useState({ email: "", password: "" });
  const [registerForm, setRegisterForm] = useState({ name: "", email: "", password: "", phone: "", nif: "" });
  const [authError, setAuthError] = useState("");
  const [rmaForm, setRmaForm] = useState({ type: "repair", description: "", orderId: "" });

  useEffect(() => {
    fetch("/api/auth/me").then(r => r.json()).then(d => { setUser(d.user); setLoading(false); });
  }, []);

  useEffect(() => {
    if (user) {
      fetch("/api/orders").then(r => r.json()).then(d => setOrders(d.orders || []));
      fetch("/api/wishlist").then(r => r.json()).then(d => setWishlist(d.wishlist || []));
      fetch("/api/rma").then(r => r.json()).then(d => setRmaList(d.rmaRequests || []));
    }
  }, [user]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError("");
    const res = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(loginForm) });
    const data = await res.json();
    if (data.error) setAuthError(data.error);
    else { setUser(data.user); router.push("/conta"); }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError("");
    const res = await fetch("/api/auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(registerForm) });
    const data = await res.json();
    if (data.error) setAuthError(data.error);
    else { setUser(data.user); router.push("/conta"); }
  };

  const handleRma = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await fetch("/api/rma", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...rmaForm, orderId: rmaForm.orderId ? parseInt(rmaForm.orderId) : null }) });
    if (res.ok) {
      fetch("/api/rma").then(r => r.json()).then(d => setRmaList(d.rmaRequests || []));
      setRmaForm({ type: "repair", description: "", orderId: "" });
    }
  };

  if (loading) return <div className="max-w-3xl mx-auto px-4 py-16 text-center text-slate-500">A carregar...</div>;

  if (!user && (tab === "login" || tab === "register" || tab === "dashboard" || !tab)) {
    return (
      <div className="max-w-md mx-auto px-4 py-12">
        <div className="bg-white border rounded-xl p-6">
          <div className="flex gap-4 mb-6 border-b">
            <button onClick={() => router.push("/conta?tab=login")} className={`pb-2 text-sm font-medium ${tab !== "register" ? "border-b-2 border-sky-600 text-sky-600" : "text-slate-500"}`}>Iniciar Sessão</button>
            <button onClick={() => router.push("/conta?tab=register")} className={`pb-2 text-sm font-medium ${tab === "register" ? "border-b-2 border-sky-600 text-sky-600" : "text-slate-500"}`}>Criar Conta</button>
          </div>
          {authError && <p className="text-sm text-red-500 mb-4">{authError}</p>}
          {tab === "register" ? (
            <form onSubmit={handleRegister} className="space-y-3">
              <input placeholder="Nome completo *" value={registerForm.name} onChange={e => setRegisterForm(f => ({ ...f, name: e.target.value }))} className="w-full border rounded-lg px-3 py-2 text-sm" required />
              <input type="email" placeholder="Email *" value={registerForm.email} onChange={e => setRegisterForm(f => ({ ...f, email: e.target.value }))} className="w-full border rounded-lg px-3 py-2 text-sm" required />
              <input type="password" placeholder="Password *" value={registerForm.password} onChange={e => setRegisterForm(f => ({ ...f, password: e.target.value }))} className="w-full border rounded-lg px-3 py-2 text-sm" required />
              <input placeholder="Telefone" value={registerForm.phone} onChange={e => setRegisterForm(f => ({ ...f, phone: e.target.value }))} className="w-full border rounded-lg px-3 py-2 text-sm" />
              <input placeholder="NIF" value={registerForm.nif} onChange={e => setRegisterForm(f => ({ ...f, nif: e.target.value }))} className="w-full border rounded-lg px-3 py-2 text-sm" />
              <button type="submit" className="w-full py-2 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-sm font-medium transition">Criar Conta</button>
            </form>
          ) : (
            <form onSubmit={handleLogin} className="space-y-3">
              <input type="email" placeholder="Email" value={loginForm.email} onChange={e => setLoginForm(f => ({ ...f, email: e.target.value }))} className="w-full border rounded-lg px-3 py-2 text-sm" required />
              <input type="password" placeholder="Password" value={loginForm.password} onChange={e => setLoginForm(f => ({ ...f, password: e.target.value }))} className="w-full border rounded-lg px-3 py-2 text-sm" required />
              <button type="submit" className="w-full py-2 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-sm font-medium transition">Entrar</button>
            </form>
          )}
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="max-w-md mx-auto px-4 py-16 text-center">
        <p className="text-slate-500 mb-4">Precisa de iniciar sessão.</p>
        <Link href="/conta?tab=login" className="text-sky-600 font-medium">Iniciar Sessão</Link>
      </div>
    );
  }

  const statusLabels: Record<string, string> = { pending: "Pendente", processing: "Em processamento", shipped: "Enviado", delivered: "Entregue", cancelled: "Cancelado", open: "Aberto", received: "Recebido", analyzing: "Em análise", repairing: "Em reparação", waiting_part: "A aguardar peça", waiting_client: "A aguardar cliente", completed: "Concluído" };
  const statusColor = (s: string) => { if (["delivered", "completed"].includes(s)) return "text-green-600 bg-green-50"; if (["cancelled"].includes(s)) return "text-red-600 bg-red-50"; if (["shipped", "repairing"].includes(s)) return "text-blue-600 bg-blue-50"; return "text-amber-600 bg-amber-50"; };

  const tabs = [
    { id: "dashboard", label: "Dashboard", icon: "📊" },
    { id: "orders", label: "Encomendas", icon: "📦" },
    { id: "wishlist", label: "Favoritos", icon: "❤️" },
    { id: "rma", label: "RMA / Assistência", icon: "🔧" },
  ];

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      <div className="grid lg:grid-cols-4 gap-6">
        <aside className="lg:col-span-1">
          <div className="bg-white border rounded-xl p-4">
            <div className="flex items-center gap-3 mb-4 pb-4 border-b">
              <div className="w-10 h-10 bg-sky-100 text-sky-600 rounded-full flex items-center justify-center font-bold">{user.name[0]}</div>
              <div><p className="font-medium text-sm">{user.name}</p><p className="text-xs text-slate-500">{user.email}</p></div>
            </div>
            <nav className="space-y-1">
              {tabs.map(t => (
                <Link key={t.id} href={`/conta?tab=${t.id}`}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition ${tab === t.id ? "bg-sky-50 text-sky-600 font-medium" : "text-slate-600 hover:bg-slate-50"}`}>
                  {t.icon} {t.label}
                </Link>
              ))}
            </nav>
          </div>
        </aside>

        <div className="lg:col-span-3">
          {tab === "dashboard" && (
            <div className="space-y-4 animate-fade-in">
              <h2 className="text-xl font-bold text-slate-800">Olá, {user.name}!</h2>
              <div className="grid sm:grid-cols-3 gap-4">
                <div className="bg-white border rounded-xl p-4 text-center"><p className="text-2xl font-bold text-sky-600">{orders.length}</p><p className="text-xs text-slate-500">Encomendas</p></div>
                <div className="bg-white border rounded-xl p-4 text-center"><p className="text-2xl font-bold text-red-500">{wishlist.length}</p><p className="text-xs text-slate-500">Favoritos</p></div>
                <div className="bg-white border rounded-xl p-4 text-center"><p className="text-2xl font-bold text-amber-500">{rmaList.length}</p><p className="text-xs text-slate-500">Pedidos RMA</p></div>
              </div>
              {orders.length > 0 && (
                <div className="bg-white border rounded-xl p-4">
                  <h3 className="font-medium text-sm text-slate-800 mb-3">Últimas Encomendas</h3>
                  {orders.slice(0, 3).map((o: any) => (
                    <div key={o.id} className="flex justify-between items-center py-2 border-b last:border-0 text-sm">
                      <span className="font-medium text-slate-700">#{o.orderNumber}</span>
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusColor(o.status)}`}>{statusLabels[o.status] || o.status}</span>
                      <span className="font-bold">{parseFloat(o.total).toFixed(2)}€</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === "orders" && (
            <div className="animate-fade-in">
              <h2 className="text-xl font-bold text-slate-800 mb-4">As minhas encomendas</h2>
              {orders.length === 0 ? <p className="text-slate-500">Ainda não tem encomendas.</p> : (
                <div className="space-y-3">
                  {orders.map((o: any) => (
                    <div key={o.id} className="bg-white border rounded-xl p-4">
                      <div className="flex items-center justify-between mb-2">
                        <span className="font-medium text-slate-800">#{o.orderNumber}</span>
                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusColor(o.status)}`}>{statusLabels[o.status] || o.status}</span>
                      </div>
                      <div className="flex justify-between text-sm text-slate-500">
                        <span>{new Date(o.createdAt).toLocaleDateString("pt-PT")}</span>
                        <span className="font-bold text-slate-800">{parseFloat(o.total).toFixed(2)}€</span>
                      </div>
                      <div className="text-xs text-slate-400 mt-1">{o.deliveryType === "pickup" ? "📍 Levantamento em loja" : "🚚 Envio"} · {o.paymentMethod}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === "wishlist" && (
            <div className="animate-fade-in">
              <h2 className="text-xl font-bold text-slate-800 mb-4">Favoritos</h2>
              {wishlist.length === 0 ? <p className="text-slate-500">Sem produtos nos favoritos.</p> : (
                <div className="grid sm:grid-cols-2 gap-3">
                  {wishlist.map((w: any) => (
                    <Link key={w.id} href={`/produto/${w.productSlug}`} className="flex items-center gap-4 bg-white border rounded-xl p-4 hover:border-sky-300 transition">
                      <div className="w-14 h-14 bg-slate-50 rounded-lg flex items-center justify-center text-2xl">📦</div>
                      <div className="flex-1"><p className="text-sm font-medium text-slate-800">{w.productName}</p><p className="text-sm font-bold text-sky-600">{parseFloat(w.productPrice).toFixed(2)}€</p></div>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === "rma" && (
            <div className="animate-fade-in">
              <h2 className="text-xl font-bold text-slate-800 mb-4">RMA / Assistência Técnica</h2>
              <form onSubmit={handleRma} className="bg-white border rounded-xl p-4 mb-6 space-y-3">
                <h3 className="font-medium text-sm">Novo Pedido</h3>
                <select value={rmaForm.type} onChange={e => setRmaForm(f => ({ ...f, type: e.target.value }))} className="w-full border rounded-lg px-3 py-2 text-sm">
                  <option value="repair">Reparação</option>
                  <option value="rma">RMA / Garantia</option>
                  <option value="return">Devolução</option>
                  <option value="support">Assistência Técnica</option>
                </select>
                <textarea placeholder="Descreva o problema..." value={rmaForm.description} onChange={e => setRmaForm(f => ({ ...f, description: e.target.value }))} className="w-full border rounded-lg px-3 py-2 text-sm" rows={3} required />
                <button type="submit" className="px-4 py-2 bg-sky-600 text-white text-sm rounded-lg hover:bg-sky-700">Enviar Pedido</button>
              </form>
              {rmaList.length > 0 && (
                <div className="space-y-3">
                  {rmaList.map((r: any) => (
                    <div key={r.id} className="bg-white border rounded-xl p-4">
                      <div className="flex items-center justify-between mb-2">
                        <span className="font-medium text-slate-800">RMA #{r.id}</span>
                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusColor(r.status)}`}>{statusLabels[r.status] || r.status}</span>
                      </div>
                      <p className="text-sm text-slate-600">{r.description}</p>
                      <p className="text-xs text-slate-400 mt-1">{new Date(r.createdAt).toLocaleDateString("pt-PT")} · {r.type}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
