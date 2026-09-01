"use client";
import { useState, useEffect, useCallback } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";

interface UserInfo {
  id: number;
  email: string;
  name: string;
  role: string;
  phone: string | null;
  nif: string | null;
  company: string | null;
}

interface OrderSummary {
  id: number;
  orderNumber: string;
  createdAt: string;
  total: string;
  status: string;
  paymentStatus: string;
  deliveryType: string;
}

interface Address {
  id: number;
  label: string | null;
  name: string;
  address1: string;
  address2: string | null;
  city: string;
  postalCode: string;
  country: string;
  phone: string | null;
  isDefault: boolean;
  isDefaultBilling: boolean;
  isDefaultShipping: boolean;
  createdAt: string;
}

const STATUS_LABELS: Record<string, string> = {
  pending_payment: "A aguardar pagamento",
  paid: "Pago",
  processing: "Em processamento",
  ready_for_pickup: "Pronto para levantamento",
  shipped: "Enviado",
  delivered: "Entregue",
  cancelled: "Cancelado",
  expired: "Expirado",
  refunded: "Reembolsado",
  return_requested: "Devolução solicitada",
  returned: "Devolvido",
};

const PAYMENT_LABELS: Record<string, string> = {
  pending: "Pendente", paid: "Pago", cancelled: "Cancelado", expired: "Expirado", refunded: "Reembolsado",
};

function fmtDate(d: string | Date | null | undefined) {
  return d ? new Date(d).toLocaleDateString("pt-PT") : "—";
}

function fmtMoney(v: string | null | undefined) {
  return `${parseFloat(v || "0").toFixed(2)}€`;
}

function statusColor(s: string) {
  if (["paid", "delivered", "completed"].includes(s)) return "bg-green-50 text-green-700";
  if (["cancelled", "expired", "refunded"].includes(s)) return "bg-red-50 text-red-700";
  if (["shipped", "ready_for_pickup", "processing"].includes(s)) return "bg-blue-50 text-blue-700";
  return "bg-amber-50 text-amber-700";
}

export default function ContaClient() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const tab = searchParams.get("tab") || "overview";
  const [user, setUser] = useState<UserInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersPage, setOrdersPage] = useState(1);
  const [ordersPagination, setOrdersPagination] = useState({ page: 1, pageSize: 10, total: 0, totalPages: 1 });
  const [wishlist, setWishlist] = useState<unknown[]>([]);
  const [rmaList, setRmaList] = useState<unknown[]>([]);
  const [addressList, setAddressList] = useState<Address[]>([]);
  const [addressLoading, setAddressLoading] = useState(false);
  const [loginForm, setLoginForm] = useState({ email: "", password: "" });
  const [registerForm, setRegisterForm] = useState({ name: "", email: "", password: "", phone: "", nif: "" });
  const [authError, setAuthError] = useState("");
  const [rmaForm, setRmaForm] = useState({ type: "repair", description: "", orderId: "" });
  const [profileForm, setProfileForm] = useState({ name: "", phone: "", nif: "", company: "" });
  const [profileMsg, setProfileMsg] = useState({ type: "" as "success" | "error" | "", text: "" });
  const [passwordForm, setPasswordForm] = useState({ currentPassword: "", newPassword: "", confirmNewPassword: "" });
  const [passwordMsg, setPasswordMsg] = useState({ type: "" as "success" | "error" | "", text: "" });
  const [addressForm, setAddressForm] = useState({
    label: "", name: "", address1: "", address2: "", city: "", postalCode: "",
    phone: "", setDefaultBilling: false, setDefaultShipping: false,
  });
  const [addressMsg, setAddressMsg] = useState({ type: "" as "success" | "error" | "", text: "" });
  const [addressEditing, setAddressEditing] = useState<number | null>(null);
  const [orderDetail, setOrderDetail] = useState<Record<string, unknown> | null>(null);
  const [disableForm, setDisableForm] = useState({ currentPassword: "", confirmDisable: false });
  const [disableMsg, setDisableMsg] = useState({ type: "" as "success" | "error" | "", text: "" });
  const [anonymizeForm, setAnonymizeForm] = useState({ currentPassword: "", confirmAnonymize: false });
  const [anonymizeMsg, setAnonymizeMsg] = useState({ type: "" as "success" | "error" | "", text: "" });

  const loadOrders = useCallback(async (page = 1) => {
    setOrdersLoading(true);
    try {
      const res = await fetch(`/api/account/orders?page=${page}&pageSize=10`);
      const data = await res.json();
      if (res.ok) {
        setOrders(data.orders || []);
        setOrdersPagination(data.pagination || { page: 1, pageSize: 10, total: 0, totalPages: 1 });
      }
    } catch { /* ignore */ }
    setOrdersLoading(false);
  }, []);

  const loadAddresses = useCallback(async () => {
    setAddressLoading(true);
    try {
      const res = await fetch("/api/account/addresses");
      const data = await res.json();
      if (res.ok) setAddressList(data.addresses || []);
    } catch { /* ignore */ }
    setAddressLoading(false);
  }, []);

  useEffect(() => {
    fetch("/api/auth/me").then(r => r.json()).then(d => { setUser(d.user); setLoading(false); });
  }, []);

  useEffect(() => {
    if (!user) return;
    Promise.resolve().then(() => {
      loadOrders(1);
      fetch("/api/wishlist").then(r => r.json()).then(d => setWishlist(d.wishlist || []));
      fetch("/api/rma").then(r => r.json()).then(d => setRmaList(d.rmaRequests || []));
      loadAddresses();
    });
  }, [user, loadOrders, loadAddresses]);

  useEffect(() => {
    if (!user) return;
    const t = setTimeout(() => {
      setProfileForm({ name: user.name, phone: user.phone || "", nif: user.nif || "", company: user.company || "" });
    }, 0);
    return () => clearTimeout(t);
  }, [user]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault(); setAuthError("");
    const res = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(loginForm) });
    const data = await res.json();
    if (data.error) setAuthError(data.error);
    else { setUser(data.user); router.push("/conta"); }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault(); setAuthError("");
    const res = await fetch("/api/auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(registerForm) });
    const data = await res.json();
    if (data.error) setAuthError(data.error);
    else { setUser(data.user); router.push("/conta"); }
  };

  const handleProfileSave = async (e: React.FormEvent) => {
    e.preventDefault(); setProfileMsg({ type: "", text: "" });
    const res = await fetch("/api/account/profile", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: profileForm.name.trim(),
        phone: profileForm.phone.trim() || null,
        nif: profileForm.nif.trim() || null,
        company: profileForm.company.trim() || null,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setProfileMsg({ type: "error", text: data.error || "Erro ao atualizar perfil" });
    } else {
      setProfileMsg({ type: "success", text: "Perfil atualizado com sucesso." });
      setUser(prev => prev ? { ...prev, name: data.profile.name, phone: data.profile.phone, nif: data.profile.nif, company: data.profile.company } : null);
    }
  };

  const handlePasswordChange = async (e: React.FormEvent) => {
    e.preventDefault(); setPasswordMsg({ type: "", text: "" });
    if (passwordForm.newPassword !== passwordForm.confirmNewPassword) {
      setPasswordMsg({ type: "error", text: "As novas passwords não coincidem." }); return;
    }
    const res = await fetch("/api/account/change-password", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        currentPassword: passwordForm.currentPassword,
        newPassword: passwordForm.newPassword,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setPasswordMsg({ type: "error", text: data.error || "Erro ao alterar password" });
    } else {
      setPasswordMsg({ type: "success", text: "Password alterada com sucesso." });
      setPasswordForm({ currentPassword: "", newPassword: "", confirmNewPassword: "" });
    }
  };

  const handleAddressSubmit = async (e: React.FormEvent) => {
    e.preventDefault(); setAddressMsg({ type: "", text: "" });
    const payload = {
      label: addressForm.label.trim() || null,
      name: addressForm.name.trim(),
      address1: addressForm.address1.trim(),
      address2: addressForm.address2.trim() || null,
      city: addressForm.city.trim(),
      postalCode: addressForm.postalCode.trim(),
      phone: addressForm.phone.trim() || null,
      setDefaultBilling: addressForm.setDefaultBilling,
      setDefaultShipping: addressForm.setDefaultShipping,
    };
    const method = addressEditing ? "PATCH" : "POST";
    const url = addressEditing ? `/api/account/addresses/${addressEditing}` : "/api/account/addresses";
    const res = await fetch(url, {
      method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      setAddressMsg({ type: "error", text: data.error || "Erro ao guardar morada" });
    } else {
      setAddressMsg({ type: "success", text: addressEditing ? "Morada atualizada." : "Morada adicionada." });
      setAddressForm({ label: "", name: "", address1: "", address2: "", city: "", postalCode: "", phone: "", setDefaultBilling: false, setDefaultShipping: false });
      setAddressEditing(null);
      loadAddresses();
    }
  };

  const handleAddressDelete = async (id: number) => {
    if (!confirm("Tem a certeza que deseja apagar esta morada?")) return;
    const res = await fetch(`/api/account/addresses/${id}`, { method: "DELETE" });
    if (res.ok) loadAddresses();
  };

  const handleAddressEdit = (addr: Address) => {
    setAddressEditing(addr.id);
    setAddressForm({
      label: addr.label || "", name: addr.name, address1: addr.address1,
      address2: addr.address2 || "", city: addr.city, postalCode: addr.postalCode,
      phone: addr.phone || "", setDefaultBilling: addr.isDefaultBilling, setDefaultShipping: addr.isDefaultShipping,
    });
  };

  const handleSelfDisable = async (e: React.FormEvent) => {
    e.preventDefault(); setDisableMsg({ type: "", text: "" });
    const res = await fetch("/api/account/disable", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword: disableForm.currentPassword, confirmDisable: disableForm.confirmDisable }),
    });
    const data = await res.json();
    if (!res.ok) {
      setDisableMsg({ type: "error", text: data.error || "Erro ao desativar conta" });
    } else {
      setDisableMsg({ type: "success", text: "Conta desativada. A redirecionar..." });
      setTimeout(() => { setUser(null); router.push("/conta?tab=login"); }, 2000);
    }
  };

  const handleAnonymize = async (e: React.FormEvent) => {
    e.preventDefault(); setAnonymizeMsg({ type: "", text: "" });
    const res = await fetch("/api/account/anonymize", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword: anonymizeForm.currentPassword, confirmAnonymize: anonymizeForm.confirmAnonymize }),
    });
    const data = await res.json();
    if (!res.ok) {
      setAnonymizeMsg({ type: "error", text: data.error || "Erro ao anonymizar conta" });
    } else {
      setAnonymizeMsg({ type: "success", text: "Conta anonimizada. A redirecionar..." });
      setTimeout(() => { setUser(null); router.push("/conta?tab=login"); }, 2000);
    }
  };

  const loadOrderDetail = async (id: number) => {
    try {
      const res = await fetch(`/api/account/orders/${id}`);
      const data = await res.json();
      if (res.ok) setOrderDetail(data);
    } catch { /* ignore */ }
  };

  // ─── Auth pages (not logged in) ────────────────────────
  if (loading) return <div className="max-w-3xl mx-auto px-4 py-16 text-center text-slate-500">A carregar...</div>;

  if (!user && (tab === "login" || tab === "register" || tab === "overview" || tab === "dashboard" || !tab)) {
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

  const tabs = [
    { id: "overview", label: "Visão Geral", icon: "📊" },
    { id: "orders", label: "Encomendas", icon: "📦" },
    { id: "profile", label: "Perfil", icon: "👤" },
    { id: "addresses", label: "Moradas", icon: "📍" },
    { id: "wishlist", label: "Favoritos", icon: "❤️" },
    { id: "rma", label: "RMA / Assistência", icon: "🔧" },
    { id: "security", label: "Segurança", icon: "🔐" },
  ];

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      <div className="grid lg:grid-cols-4 gap-6">
        <aside className="lg:col-span-1">
          <div className="bg-white border rounded-xl p-4">
            <div className="flex items-center gap-3 mb-4 pb-4 border-b">
              <div className="w-10 h-10 bg-sky-100 text-sky-600 rounded-full flex items-center justify-center font-bold">{user.name[0]}</div>
              <div>
                <p className="font-medium text-sm">{user.name}</p>
                <p className="text-xs text-slate-500">{user.email}</p>
              </div>
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
          {/* ─── OVERVIEW ─── */}
          {tab === "overview" && (
            <div className="space-y-4 animate-fade-in">
              <h2 className="text-xl font-bold text-slate-800">Olá, {user.name}!</h2>
              <div className="grid sm:grid-cols-4 gap-4">
                <div className="bg-white border rounded-xl p-4 text-center"><p className="text-2xl font-bold text-sky-600">{ordersPagination.total}</p><p className="text-xs text-slate-500">Encomendas</p></div>
                <div className="bg-white border rounded-xl p-4 text-center"><p className="text-2xl font-bold text-red-500">{wishlist.length}</p><p className="text-xs text-slate-500">Favoritos</p></div>
                <div className="bg-white border rounded-xl p-4 text-center"><p className="text-2xl font-bold text-amber-500">{rmaList.length}</p><p className="text-xs text-slate-500">Pedidos RMA</p></div>
                <div className="bg-white border rounded-xl p-4 text-center"><p className="text-2xl font-bold text-slate-500">{addressList.length}</p><p className="text-xs text-slate-500">Moradas</p></div>
              </div>
              {orders.slice(0, 3).map(o => (
                <div key={o.id} className="bg-white border rounded-xl p-4 flex justify-between items-center text-sm">
                  <span className="font-medium">#{o.orderNumber}</span>
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusColor(o.status)}`}>{STATUS_LABELS[o.status] || o.status}</span>
                  <span className="font-bold">{fmtMoney(o.total)}</span>
                </div>
              ))}
            </div>
          )}

          {/* ─── ORDERS ─── */}
          {tab === "orders" && (
            <div className="animate-fade-in">
              <h2 className="text-xl font-bold text-slate-800 mb-4">As minhas encomendas</h2>
              {ordersLoading ? <p className="text-slate-500">A carregar...</p> : (
                <>
                  {orders.length === 0 ? <p className="text-slate-500">Ainda não tem encomendas.</p> : (
                    <div className="space-y-3">
                      {orders.map(o => (
                        <div key={o.id} className="bg-white border rounded-xl p-4">
                          <div className="flex items-center justify-between mb-2">
                            <span className="font-medium text-slate-800">#{o.orderNumber}</span>
                            <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusColor(o.status)}`}>{STATUS_LABELS[o.status] || o.status}</span>
                          </div>
                          <div className="flex justify-between text-sm text-slate-500">
                            <span>{fmtDate(o.createdAt)}</span>
                            <span className="font-bold text-slate-800">{fmtMoney(o.total)}</span>
                          </div>
                          <div className="text-xs text-slate-400 mt-1">{o.deliveryType === "pickup" ? "📍 Levantamento em loja" : "🚚 Envio"} · {PAYMENT_LABELS[o.paymentStatus] || o.paymentStatus}</div>
                          <button onClick={() => loadOrderDetail(o.id)} className="mt-2 text-xs text-sky-600 hover:underline">Ver detalhe</button>
                        </div>
                      ))}
                    </div>
                  )}
                  {ordersPagination.totalPages > 1 && (
                    <div className="flex justify-between mt-4 text-sm">
                      <button disabled={ordersPagination.page <= 1} onClick={() => loadOrders(ordersPagination.page - 1)} className="px-3 py-1 border rounded disabled:opacity-50">Anterior</button>
                      <span className="text-slate-500">Página {ordersPagination.page} / {ordersPagination.totalPages}</span>
                      <button disabled={ordersPagination.page >= ordersPagination.totalPages} onClick={() => loadOrders(ordersPagination.page + 1)} className="px-3 py-1 border rounded disabled:opacity-50">Seguinte</button>
                    </div>
                  )}
                  {orderDetail && (
                    <div className="mt-4 bg-white border rounded-xl p-4">
                      <div className="flex justify-between mb-2">
                        <h3 className="font-bold">Encomenda #{((orderDetail as any).order?.orderNumber || (orderDetail as any).orderNumber) as string}</h3>
                        <button onClick={() => setOrderDetail(null)} className="text-slate-400">✕</button>
                      </div>
                      <p className="text-xs text-slate-500 mb-3">Detalhe disponível com snapshots históricos (dados preservados).</p>
                      {(orderDetail as any).invoiceDocuments?.length ? (
                        <div className="border-t pt-3">
                          <h4 className="font-semibold text-sm mb-2">Documentos fiscais</h4>
                          {(orderDetail as any).invoiceDocuments.map((doc: any) => (
                            <p key={doc.id} className="text-xs text-slate-600">{doc.documentType === "invoice" ? "Fatura" : "Documento"}: {doc.documentNumber || doc.documentReference} · {doc.amountCents != null ? `${(doc.amountCents / 100).toFixed(2)} ${doc.currency}` : ""} · {fmtDate(doc.issuedAt)}</p>
                          ))}
                        </div>
                      ) : <p className="text-xs text-slate-400">Sem documento fiscal registado.</p>}
                      {(orderDetail as any).refunds?.length ? (
                        <div className="border-t pt-3">
                          <h4 className="font-semibold text-sm mb-2">Reembolsos</h4>
                          {(orderDetail as any).refunds.map((r: any, i: number) => (
                            <p key={i} className="text-xs text-slate-600">
                              {(r.amountCents / 100).toFixed(2)} {r.currency} · {r.status === "succeeded" ? "Reembolsado" : r.status === "pending" ? "Pendente" : "Em processamento"} · {fmtDate(r.completedAt ?? r.createdAt)}
                            </p>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* ─── PROFILE ─── */}
          {tab === "profile" && (
            <div className="animate-fade-in">
              <h2 className="text-xl font-bold text-slate-800 mb-4">O meu perfil</h2>
              <div className="bg-white border rounded-xl p-6 max-w-lg">
                <form onSubmit={handleProfileSave} className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Email</label>
                    <input type="email" value={user.email} disabled className="w-full border rounded-lg px-3 py-2 text-sm bg-slate-50 text-slate-400" />
                    <p className="text-xs text-slate-400 mt-1">Email não pode ser alterado.</p>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Nome *</label>
                    <input value={profileForm.name} onChange={e => setProfileForm(f => ({ ...f, name: e.target.value }))} className="w-full border rounded-lg px-3 py-2 text-sm" required />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Telefone</label>
                    <input value={profileForm.phone} onChange={e => setProfileForm(f => ({ ...f, phone: e.target.value }))} className="w-full border rounded-lg px-3 py-2 text-sm" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">NIF</label>
                    <input value={profileForm.nif} onChange={e => setProfileForm(f => ({ ...f, nif: e.target.value }))} className="w-full border rounded-lg px-3 py-2 text-sm" maxLength={20} />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Empresa</label>
                    <input value={profileForm.company} onChange={e => setProfileForm(f => ({ ...f, company: e.target.value }))} className="w-full border rounded-lg px-3 py-2 text-sm" />
                  </div>
                  {profileMsg.text && <p className={`text-sm ${profileMsg.type === "success" ? "text-green-600" : "text-red-500"}`}>{profileMsg.text}</p>}
                  <button type="submit" className="w-full py-2 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-sm font-medium transition">Guardar Perfil</button>
                </form>
              </div>
            </div>
          )}

          {/* ─── ADDRESSES ─── */}
          {tab === "addresses" && (
            <div className="animate-fade-in">
              <h2 className="text-xl font-bold text-slate-800 mb-4">As minhas moradas</h2>
              <div className="grid sm:grid-cols-1 gap-4">
                <div className="bg-white border rounded-xl p-4">
                  <div className="flex justify-between items-center mb-3">
                    <h3 className="font-medium text-sm">{addressEditing ? "Editar morada" : "Nova morada"}</h3>
                    {addressEditing && <button onClick={() => { setAddressEditing(null); setAddressForm({ label: "", name: "", address1: "", address2: "", city: "", postalCode: "", phone: "", setDefaultBilling: false, setDefaultShipping: false }); }} className="text-xs text-slate-400">Cancelar</button>}
                  </div>
                  <form onSubmit={handleAddressSubmit} className="space-y-3">
                    <div className="grid sm:grid-cols-2 gap-3">
                      <input placeholder="Etiqueta (ex: Casa, Trabalho)" value={addressForm.label} onChange={e => setAddressForm(f => ({ ...f, label: e.target.value }))} className="border rounded-lg px-3 py-2 text-sm w-full" />
                      <input placeholder="Nome do destinatário *" value={addressForm.name} onChange={e => setAddressForm(f => ({ ...f, name: e.target.value }))} className="border rounded-lg px-3 py-2 text-sm w-full" required />
                    </div>
                    <input placeholder="Morada *" value={addressForm.address1} onChange={e => setAddressForm(f => ({ ...f, address1: e.target.value }))} className="w-full border rounded-lg px-3 py-2 text-sm" required />
                    <input placeholder="Complemento" value={addressForm.address2} onChange={e => setAddressForm(f => ({ ...f, address2: e.target.value }))} className="w-full border rounded-lg px-3 py-2 text-sm" />
                    <div className="grid sm:grid-cols-2 gap-3">
                      <input placeholder="Cidade *" value={addressForm.city} onChange={e => setAddressForm(f => ({ ...f, city: e.target.value }))} className="border rounded-lg px-3 py-2 text-sm w-full" required />
                      <input placeholder="Código postal * (NNNN-NNN)" value={addressForm.postalCode} onChange={e => setAddressForm(f => ({ ...f, postalCode: e.target.value }))} className="border rounded-lg px-3 py-2 text-sm w-full" required />
                    </div>
                    <input placeholder="Telefone" value={addressForm.phone} onChange={e => setAddressForm(f => ({ ...f, phone: e.target.value }))} className="w-full border rounded-lg px-3 py-2 text-sm" />
                    <div className="flex gap-4">
                      <label className="flex items-center gap-2 text-xs">
                        <input type="checkbox" checked={addressForm.setDefaultBilling} onChange={e => setAddressForm(f => ({ ...f, setDefaultBilling: e.target.checked }))} /> Faturação padrão
                      </label>
                      <label className="flex items-center gap-2 text-xs">
                        <input type="checkbox" checked={addressForm.setDefaultShipping} onChange={e => setAddressForm(f => ({ ...f, setDefaultShipping: e.target.checked }))} /> Envio padrão
                      </label>
                    </div>
                    {addressMsg.text && <p className={`text-xs ${addressMsg.type === "success" ? "text-green-600" : "text-red-500"}`}>{addressMsg.text}</p>}
                    <button type="submit" className="w-full py-2 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-sm font-medium transition">{addressEditing ? "Atualizar Morada" : "Adicionar Morada"}</button>
                  </form>
                </div>

                {addressLoading ? <p className="text-slate-500 text-sm">A carregar...</p> : addressList.length === 0 ? <p className="text-slate-500 text-sm">Sem moradas.</p> : (
                  <div className="space-y-3">
                    {addressList.map(a => (
                      <div key={a.id} className="bg-white border rounded-xl p-4 flex justify-between items-start">
                        <div className="flex-1">
                          {a.label && <p className="text-xs text-slate-400 uppercase tracking-wide mb-1">{a.label}</p>}
                          <p className="text-sm font-medium">{a.name}</p>
                          <p className="text-sm text-slate-600">{a.address1}{a.address2 ? `, ${a.address2}` : ""}</p>
                          <p className="text-sm text-slate-600">{a.postalCode} {a.city}</p>
                          <p className="text-sm text-slate-600">{a.country}</p>
                          {a.phone && <p className="text-xs text-slate-400 mt-1">Tel: {a.phone}</p>}
                          <div className="flex gap-2 mt-1">
                            {a.isDefaultBilling && <span className="bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded text-[10px]">Faturação padrão</span>}
                            {a.isDefaultShipping && <span className="bg-green-50 text-green-700 px-1.5 py-0.5 rounded text-[10px]">Envio padrão</span>}
                          </div>
                        </div>
                        <div className="flex gap-2 ml-3">
                          <button onClick={() => handleAddressEdit(a)} className="text-xs text-sky-600 hover:underline">Editar</button>
                          <button onClick={() => handleAddressDelete(a.id)} className="text-xs text-red-500 hover:underline">Apagar</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ─── WISHLIST ─── */}
          {tab === "wishlist" && (
            <div className="animate-fade-in">
              <h2 className="text-xl font-bold text-slate-800 mb-4">Favoritos</h2>
              {wishlist.length === 0 ? <p className="text-slate-500">Sem produtos nos favoritos.</p> : (
                <div className="grid sm:grid-cols-2 gap-3">
                  {(wishlist as Array<Record<string, unknown> & { productSlug: string; productName: string; productPrice: string }>).map((w) => (
                    <Link key={String(w.id)} href={`/produto/${w.productSlug}`} className="flex items-center gap-4 bg-white border rounded-xl p-4 hover:border-sky-300 transition">
                      <div className="w-14 h-14 bg-slate-50 rounded-lg flex items-center justify-center text-2xl">📦</div>
                      <div className="flex-1"><p className="text-sm font-medium">{w.productName}</p><p className="text-sm font-bold text-sky-600">{fmtMoney(w.productPrice)}</p></div>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ─── RMA ─── */}
          {tab === "rma" && (
            <div className="animate-fade-in">
              <h2 className="text-xl font-bold text-slate-800 mb-4">RMA / Assistência Técnica</h2>
              <form onSubmit={async (e) => {
                e.preventDefault();
                const res = await fetch("/api/rma", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...rmaForm, orderId: rmaForm.orderId ? parseInt(rmaForm.orderId) : null }) });
                if (res.ok) {
                  fetch("/api/rma").then(r => r.json()).then(d => setRmaList(d.rmaRequests || []));
                  setRmaForm({ type: "repair", description: "", orderId: "" });
                }
              }} className="bg-white border rounded-xl p-4 mb-6 space-y-3">
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
                  {(rmaList as Array<Record<string, unknown> & { id: number; status: string; description: string; createdAt: string; type: string }>).map(r => (
                    <div key={r.id} className="bg-white border rounded-xl p-4">
                      <div className="flex items-center justify-between mb-2">
                        <span className="font-medium text-slate-800">RMA #{r.id}</span>
                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusColor(r.status)}`}>{r.status}</span>
                      </div>
                      <p className="text-sm text-slate-600">{r.description}</p>
                      <p className="text-xs text-slate-400 mt-1">{fmtDate(r.createdAt)} · {r.type}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ─── SECURITY ─── */}
          {tab === "security" && (
            <div className="animate-fade-in space-y-6">
              <h2 className="text-xl font-bold text-slate-800 mb-4">Segurança</h2>

              <div className="bg-white border rounded-xl p-6">
                <h3 className="font-medium text-sm mb-3">Alterar password</h3>
                <form onSubmit={handlePasswordChange} className="space-y-3 max-w-sm">
                  <input type="password" placeholder="Password atual *" value={passwordForm.currentPassword} onChange={e => setPasswordForm(f => ({ ...f, currentPassword: e.target.value }))} className="w-full border rounded-lg px-3 py-2 text-sm" required />
                  <input type="password" placeholder="Nova password *" value={passwordForm.newPassword} onChange={e => setPasswordForm(f => ({ ...f, newPassword: e.target.value }))} className="w-full border rounded-lg px-3 py-2 text-sm" required minLength={8} />
                  <input type="password" placeholder="Confirmar nova password *" value={passwordForm.confirmNewPassword} onChange={e => setPasswordForm(f => ({ ...f, confirmNewPassword: e.target.value }))} className="w-full border rounded-lg px-3 py-2 text-sm" required />
                  {passwordMsg.text && <p className={`text-xs ${passwordMsg.type === "success" ? "text-green-600" : "text-red-500"}`}>{passwordMsg.text}</p>}
                  <button type="submit" className="px-4 py-2 bg-sky-600 hover:bg-sky-700 text-white text-sm rounded-lg transition">Alterar password</button>
                </form>
              </div>

              <div className="bg-white border border-red-200 rounded-xl p-6">
                <h3 className="font-medium text-sm mb-3 text-red-700">Zona de perigo</h3>

                <div className="mb-4">
                  <h4 className="text-xs font-semibold text-slate-700 mb-1">Desativar conta</h4>
                  <p className="text-xs text-slate-500 mb-2">A sua conta será desativada. Não conseguirá fazer login. Os seus dados históricos (encomendas, RMA, etc.) serão preservados. Para reativar, contacte o suporte.</p>
                  <form onSubmit={handleSelfDisable} className="space-y-2 max-w-xs">
                    <input type="password" placeholder="Confirme a password *" value={disableForm.currentPassword} onChange={e => setDisableForm(f => ({ ...f, currentPassword: e.target.value }))} className="w-full border rounded-lg px-3 py-2 text-sm" required />
                    <label className="flex items-start gap-2 text-xs">
                      <input type="checkbox" checked={disableForm.confirmDisable} onChange={e => setDisableForm(f => ({ ...f, confirmDisable: e.target.checked }))} />
                      <span>Compreendo que a conta será desativada</span>
                    </label>
                    {disableMsg.text && <p className={`text-xs ${disableMsg.type === "success" ? "text-green-600" : "text-red-500"}`}>{disableMsg.text}</p>}
                    <button type="submit" disabled={!disableForm.confirmDisable || !disableForm.currentPassword} className="px-4 py-2 bg-red-500 hover:bg-red-600 text-white text-xs rounded-lg disabled:opacity-50 transition">Desativar conta</button>
                  </form>
                </div>

                <div className="border-t pt-4">
                  <h4 className="text-xs font-semibold text-red-700 mb-1">Anonymizar dados pessoais</h4>
                  <p className="text-xs text-slate-500 mb-2">Remove permanentemente os seus dados pessoais (nome, email, telefone, NIF, empresa, moradas). <strong>Esta ação é irreversível.</strong> O histórico de encomendas será preservado mas sem associação a si. A conta será desativada.</p>
                  <form onSubmit={handleAnonymize} className="space-y-2 max-w-xs">
                    <input type="password" placeholder="Confirme a password *" value={anonymizeForm.currentPassword} onChange={e => setAnonymizeForm(f => ({ ...f, currentPassword: e.target.value }))} className="w-full border rounded-lg px-3 py-2 text-sm" required />
                    <label className="flex items-start gap-2 text-xs">
                      <input type="checkbox" checked={anonymizeForm.confirmAnonymize} onChange={e => setAnonymizeForm(f => ({ ...f, confirmAnonymize: e.target.checked }))} />
                      <span className="text-red-600">Compreendo que esta ação é irreversível</span>
                    </label>
                    {anonymizeMsg.text && <p className={`text-xs ${anonymizeMsg.type === "success" ? "text-green-600" : "text-red-500"}`}>{anonymizeMsg.text}</p>}
                    <button type="submit" disabled={!anonymizeForm.confirmAnonymize || !anonymizeForm.currentPassword} className="px-4 py-2 bg-red-700 hover:bg-red-800 text-white text-xs rounded-lg disabled:opacity-50 transition">Anonymizar conta</button>
                  </form>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
