"use client";
import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";

interface CartItem { productId: number; name: string; slug: string; price: number; quantity: number; }
interface QuoteLine { productId: number; name: string; quantity: number; unitPriceGross: string; vatRate: string; vatAmount: string; lineTotal: string; inStock: boolean; availableStock: number; priceChanged: boolean; }
interface Quote { lines: QuoteLine[]; subtotal: string; discount: string; shipping: string; vat: string; total: string; coupon: { code: string; type: string; value: string } | null; allInStock: boolean; anyPriceChanged: boolean; }

export default function CheckoutPage() {
  const router = useRouter();
  const [cart, setCart] = useState<CartItem[]>([]);
  const [step, setStep] = useState(1);
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState<any>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [couponCode, setCouponCode] = useState("");

  const [form, setForm] = useState({
    name: "", email: "", phone: "", nif: "", companyName: "",
    address1: "", address2: "", city: "", postalCode: "",
    deliveryType: "shipping",
    paymentMethod: "bank_transfer",
    notes: "",
  });

  useEffect(() => {
    queueMicrotask(() => {
      const stored = localStorage.getItem("mdtech_cart");
      if (stored) setCart(JSON.parse(stored));
      const storedCoupon = localStorage.getItem("mdtech_coupon");
      if (storedCoupon) setCouponCode(storedCoupon);
    });
    fetch("/api/auth/me").then(r => r.json()).then(d => {
      if (d.user) {
        setUser(d.user);
        setForm(f => ({ ...f, name: d.user.name, email: d.user.email, phone: d.user.phone || "", nif: d.user.nif || "", companyName: d.user.company || "" }));
      }
    });
  }, []);

  // Fetch server-side quote whenever cart, coupon, or delivery changes
  const fetchQuote = useCallback(async (c: CartItem[], coupon: string, delivery: string) => {
    if (c.length === 0) { setQuote(null); return; }
    setQuoteLoading(true);
    try {
      const res = await fetch("/api/cart/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: c.map(i => ({ productId: i.productId, quantity: i.quantity, price: i.price })),
          couponCode: coupon || undefined,
          deliveryType: delivery,
        }),
      });
      const data = await res.json();
      if (data.error) { setError(data.error); }
      else { setQuote(data); setError(""); }
    } catch { setError("Erro ao calcular valores"); }
    setQuoteLoading(false);
  }, []);

  useEffect(() => {
    queueMicrotask(() => { void fetchQuote(cart, couponCode, form.deliveryType); });
  }, [cart, couponCode, form.deliveryType, fetchQuote]);

  const handleSubmit = async () => {
    if (!quote || !quote.allInStock) { setError("Existem produtos sem stock"); return; }
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: cart.map(c => ({ productId: c.productId, quantity: c.quantity })),
          billingAddress: { name: form.name, address1: form.address1, address2: form.address2, city: form.city, postalCode: form.postalCode, country: "Portugal" },
          shippingAddress: form.deliveryType === "shipping" ? { name: form.name, address1: form.address1, address2: form.address2, city: form.city, postalCode: form.postalCode, country: "Portugal" } : null,
          paymentMethod: form.paymentMethod,
          shippingMethod: form.deliveryType === "shipping" ? "home_delivery" : "store_pickup",
          deliveryType: form.deliveryType,
          couponCode: couponCode || null,
          nif: form.nif || null,
          companyName: form.companyName || null,
          guestEmail: !user ? form.email : null,
          guestName: !user ? form.name : null,
          guestPhone: !user ? form.phone : null,
          notes: form.notes || null,
        }),
      });
      const data = await res.json();
      if (data.error) { setError(data.error); }
      else {
        setSuccess(data.order);
        localStorage.removeItem("mdtech_cart");
        localStorage.removeItem("mdtech_coupon");
        window.dispatchEvent(new Event("cart-updated"));
      }
    } catch { setError("Erro ao processar encomenda"); }
    setLoading(false);
  };

  if (cart.length === 0 && !success) {
    return <div className="max-w-3xl mx-auto px-4 py-16 text-center"><p className="text-4xl mb-4">🛒</p><p className="text-slate-500">O seu carrinho está vazio.</p></div>;
  }

  if (success) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-16 text-center">
        <div className="bg-white rounded-2xl border p-8">
          <p className="text-5xl mb-4">📦</p>
          <h1 className="text-2xl font-bold text-slate-800 mb-2">Encomenda registada com sucesso</h1>
          <p className="text-slate-500 mb-2">Número: <strong>{success.orderNumber}</strong></p>
          <p className="text-lg font-bold text-slate-900 mb-2">Total: {parseFloat(success.total).toFixed(2)}€</p>
          <div className="inline-block px-3 py-1 rounded-full text-sm font-medium bg-amber-50 text-amber-700 mb-4">
            ⏳ A aguardar pagamento
          </div>
          <p className="text-sm text-slate-500 mb-6">
            Consulte a sua área de cliente ou contacte-nos para obter os dados de pagamento.
          </p>
          <button onClick={() => router.push("/")} className="px-6 py-3 bg-sky-600 text-white rounded-lg font-medium hover:bg-sky-700 transition">
            Voltar à Loja
          </button>
        </div>
      </div>
    );
  }

  const update = (field: string, value: string) => setForm(f => ({ ...f, [field]: value }));

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <h1 className="text-2xl font-bold text-slate-800 mb-6">Checkout</h1>

      {/* Steps */}
      <div className="flex items-center gap-2 mb-8 text-sm">
        {[{ n: 1, l: "Dados" }, { n: 2, l: "Entrega" }, { n: 3, l: "Pagamento" }, { n: 4, l: "Confirmação" }].map(s => (
          <div key={s.n} className="flex items-center gap-2">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center font-semibold text-xs ${step >= s.n ? "bg-sky-600 text-white" : "bg-slate-200 text-slate-500"}`}>{s.n}</div>
            <span className={`hidden sm:block ${step >= s.n ? "text-slate-800 font-medium" : "text-slate-400"}`}>{s.l}</span>
            {s.n < 4 && <div className={`w-8 h-px ${step > s.n ? "bg-sky-600" : "bg-slate-200"}`} />}
          </div>
        ))}
      </div>

      <div className="grid lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2">
          {step === 1 && (
            <div className="bg-white border rounded-xl p-6 space-y-4 animate-fade-in">
              <h2 className="font-bold text-slate-800">Dados Pessoais</h2>
              <div className="grid sm:grid-cols-2 gap-4">
                <div><label className="text-xs text-slate-500 block mb-1">Nome *</label><input value={form.name} onChange={e => update("name", e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" /></div>
                <div><label className="text-xs text-slate-500 block mb-1">Email *</label><input value={form.email} onChange={e => update("email", e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" /></div>
                <div><label className="text-xs text-slate-500 block mb-1">Telefone</label><input value={form.phone} onChange={e => update("phone", e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" /></div>
                <div><label className="text-xs text-slate-500 block mb-1">NIF</label><input value={form.nif} onChange={e => update("nif", e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" /></div>
                <div className="sm:col-span-2"><label className="text-xs text-slate-500 block mb-1">Empresa (opcional)</label><input value={form.companyName} onChange={e => update("companyName", e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" /></div>
              </div>
              <button onClick={() => { if (form.name && form.email) setStep(2); }} className="px-6 py-2 bg-sky-600 hover:bg-sky-700 text-white text-sm rounded-lg font-medium transition">Continuar →</button>
            </div>
          )}

          {step === 2 && (
            <div className="bg-white border rounded-xl p-6 space-y-4 animate-fade-in">
              <h2 className="font-bold text-slate-800">Método de Entrega</h2>
              <div className="space-y-3">
                <label className={`flex items-center gap-4 p-4 border rounded-xl cursor-pointer transition ${form.deliveryType === "shipping" ? "border-sky-300 bg-sky-50" : "hover:border-slate-300"}`}>
                  <input type="radio" name="delivery" value="shipping" checked={form.deliveryType === "shipping"} onChange={e => update("deliveryType", e.target.value)} className="accent-sky-600" />
                  <div className="flex-1"><p className="font-medium text-sm">🚚 Envio para Morada</p><p className="text-xs text-slate-500">{quote ? `${quote.shipping === "0.00" ? "Grátis" : quote.shipping + "€"}` : "..."} — 1-3 dias úteis</p></div>
                </label>
                <label className={`flex items-center gap-4 p-4 border rounded-xl cursor-pointer transition ${form.deliveryType === "pickup" ? "border-sky-300 bg-sky-50" : "hover:border-slate-300"}`}>
                  <input type="radio" name="delivery" value="pickup" checked={form.deliveryType === "pickup"} onChange={e => update("deliveryType", e.target.value)} className="accent-sky-600" />
                  <div className="flex-1"><p className="font-medium text-sm">📍 Levantamento em Loja</p><p className="text-xs text-slate-500">Grátis — Esposende — Seg-Sex 9:00-18:30</p></div>
                </label>
              </div>
              {form.deliveryType === "shipping" && (
                <div className="space-y-4 mt-4">
                  <h3 className="font-medium text-sm text-slate-700">Morada de Entrega</h3>
                  <div><label className="text-xs text-slate-500 block mb-1">Morada *</label><input value={form.address1} onChange={e => update("address1", e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" /></div>
                  <div><label className="text-xs text-slate-500 block mb-1">Complemento</label><input value={form.address2} onChange={e => update("address2", e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" /></div>
                  <div className="grid grid-cols-2 gap-4">
                    <div><label className="text-xs text-slate-500 block mb-1">Cidade *</label><input value={form.city} onChange={e => update("city", e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" /></div>
                    <div><label className="text-xs text-slate-500 block mb-1">Código Postal *</label><input value={form.postalCode} onChange={e => update("postalCode", e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" placeholder="0000-000" /></div>
                  </div>
                </div>
              )}
              <div className="flex gap-3">
                <button onClick={() => setStep(1)} className="px-6 py-2 border rounded-lg text-sm text-slate-600 hover:bg-slate-50 transition">← Voltar</button>
                <button onClick={() => setStep(3)} className="px-6 py-2 bg-sky-600 hover:bg-sky-700 text-white text-sm rounded-lg font-medium transition">Continuar →</button>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="bg-white border rounded-xl p-6 space-y-4 animate-fade-in">
              <h2 className="font-bold text-slate-800">Método de Pagamento</h2>
              <div className="space-y-3">
                <label className={`flex items-center gap-4 p-4 border rounded-xl cursor-pointer transition ${form.paymentMethod === "bank_transfer" ? "border-sky-300 bg-sky-50" : "hover:border-slate-300"}`}>
                  <input type="radio" name="payment" value="bank_transfer" checked={form.paymentMethod === "bank_transfer"} onChange={e => update("paymentMethod", e.target.value)} className="accent-sky-600" />
                  <div><p className="font-medium text-sm">🏦 Transferência Bancária</p><p className="text-xs text-slate-500">IBAN será fornecido após confirmação</p></div>
                </label>
              </div>
              <p className="text-xs text-slate-400">Outros métodos de pagamento (Multibanco, MB WAY, Cartão) estarão disponíveis em breve.</p>
              <div><label className="text-xs text-slate-500 block mb-1">Notas (opcional)</label><textarea value={form.notes} onChange={e => update("notes", e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" rows={2} /></div>
              <div className="flex gap-3">
                <button onClick={() => setStep(2)} className="px-6 py-2 border rounded-lg text-sm text-slate-600 hover:bg-slate-50 transition">← Voltar</button>
                <button onClick={() => setStep(4)} className="px-6 py-2 bg-sky-600 hover:bg-sky-700 text-white text-sm rounded-lg font-medium transition">Rever Encomenda →</button>
              </div>
            </div>
          )}

          {step === 4 && (
            <div className="bg-white border rounded-xl p-6 space-y-4 animate-fade-in">
              <h2 className="font-bold text-slate-800">Confirmar Encomenda</h2>

              {/* Warnings */}
              {quote?.anyPriceChanged && (
                <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800">
                  ⚠️ O preço de um ou mais artigos foi atualizado desde que foram adicionados ao carrinho.
                </div>
              )}
              {quote && !quote.allInStock && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                  ❌ Existem produtos sem stock disponível. Remova-os do carrinho para continuar.
                </div>
              )}

              <div className="space-y-3 text-sm">
                <div className="p-3 bg-slate-50 rounded-lg"><strong>Dados:</strong> {form.name} — {form.email}{form.phone ? ` — ${form.phone}` : ""}</div>
                <div className="p-3 bg-slate-50 rounded-lg"><strong>Entrega:</strong> {form.deliveryType === "pickup" ? "Levantamento em Esposende" : `${form.address1}, ${form.city} ${form.postalCode}`}</div>
                <div className="p-3 bg-slate-50 rounded-lg"><strong>Pagamento:</strong> Transferência Bancária</div>
                {form.nif && <div className="p-3 bg-slate-50 rounded-lg"><strong>NIF:</strong> {form.nif}</div>}
              </div>
              {error && <p className="text-sm text-red-500">{error}</p>}
              <div className="flex gap-3">
                <button onClick={() => setStep(3)} className="px-6 py-2 border rounded-lg text-sm text-slate-600 hover:bg-slate-50 transition">← Voltar</button>
                <button onClick={handleSubmit} disabled={loading || !quote || !quote.allInStock}
                  className="px-6 py-2 bg-lime-600 hover:bg-lime-700 text-white text-sm rounded-lg font-bold transition disabled:opacity-50">
                  {loading ? "A processar..." : `Confirmar Encomenda ${quote ? quote.total : "..."}€`}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Order summary — uses SERVER QUOTE values */}
        <div className="bg-white border rounded-xl p-6 h-fit sticky top-24">
          <h3 className="font-bold text-slate-800 mb-4">Resumo</h3>
          {quoteLoading && <p className="text-xs text-slate-400 mb-2">A recalcular...</p>}
          <div className="space-y-3 mb-4">
            {quote ? quote.lines.map(line => (
              <div key={line.productId} className="flex justify-between text-sm">
                <div className="flex-1 min-w-0 mr-2">
                  <span className={`text-slate-600 ${!line.inStock ? "line-through text-red-400" : ""}`}>{line.quantity}× {line.name}</span>
                  {line.priceChanged && <span className="block text-xs text-amber-600">Preço atualizado</span>}
                  {!line.inStock && <span className="block text-xs text-red-500">Sem stock</span>}
                </div>
                <span className="text-slate-800 font-medium whitespace-nowrap">{line.lineTotal}€</span>
              </div>
            )) : cart.map(item => (
              <div key={item.productId} className="flex justify-between text-sm">
                <span className="text-slate-600 truncate mr-2">{item.quantity}× {item.name}</span>
                <span className="text-slate-400">...</span>
              </div>
            ))}
          </div>
          {quote && (
            <>
              <hr className="mb-3" />
              <div className="space-y-1 text-sm">
                <div className="flex justify-between text-slate-600"><span>Subtotal</span><span>{quote.subtotal}€</span></div>
                {parseFloat(quote.discount) > 0 && <div className="flex justify-between text-green-600"><span>Desconto {quote.coupon ? `(${quote.coupon.code})` : ""}</span><span>-{quote.discount}€</span></div>}
                <div className="flex justify-between text-slate-600"><span>Portes</span><span>{quote.shipping === "0.00" ? <span className="text-green-600">Grátis</span> : `${quote.shipping}€`}</span></div>
                <div className="flex justify-between text-slate-400 text-xs"><span>IVA incluído</span><span>{quote.vat}€</span></div>
              </div>
              <hr className="my-3" />
              <div className="flex justify-between font-bold text-lg"><span>Total</span><span>{quote.total}€</span></div>
            </>
          )}

          {/* Coupon */}
          <div className="mt-4">
            <div className="flex gap-2">
              <input type="text" placeholder="Código de cupão" value={couponCode}
                onChange={e => { setCouponCode(e.target.value); localStorage.setItem("mdtech_coupon", e.target.value); }}
                className="flex-1 border rounded-lg px-3 py-2 text-sm" />
              <button onClick={() => fetchQuote(cart, couponCode, form.deliveryType)} className="px-3 py-2 border rounded-lg text-sm text-slate-600 hover:bg-slate-50">Aplicar</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
