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
  const [accountAddresses, setAccountAddresses] = useState<any[]>([]);
  const [selectedBillingAddressId, setSelectedBillingAddressId] = useState<number | null>(null);
  const [selectedShippingAddressId, setSelectedShippingAddressId] = useState<number | null>(null);
  const [shippingSameAsBilling, setShippingSameAsBilling] = useState(true);
  const [saveBillingAddress, setSaveBillingAddress] = useState(false);
  const [saveShippingAddress, setSaveShippingAddress] = useState(false);

  const [form, setForm] = useState({
    name: "", email: "", phone: "", nif: "", companyName: "",
    address1: "", address2: "", city: "", postalCode: "",
    shippingAddress1: "", shippingAddress2: "", shippingCity: "", shippingPostalCode: "",
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
        fetch("/api/account/addresses")
          .then(r => r.json())
          .then(data => {
            if (data.addresses) {
              setAccountAddresses(data.addresses);

              const billing = data.addresses.find((a: any) => a.isDefaultBilling) || data.addresses[0];
              const shipping = data.addresses.find((a: any) => a.isDefaultShipping) || billing;

              if (billing && shipping) {
                setShippingSameAsBilling(billing.id === shipping.id);
              }

              if (billing) {
                setSelectedBillingAddressId(billing.id);
                setForm(f => ({
                  ...f,
                  address1: billing.address1 || "",
                  address2: billing.address2 || "",
                  city: billing.city || "",
                  postalCode: billing.postalCode || "",
                }));
              }

              if (shipping) {
                setSelectedShippingAddressId(shipping.id);
                setForm(f => ({
                  ...f,
                  shippingAddress1: shipping.address1 || "",
                  shippingAddress2: shipping.address2 || "",
                  shippingCity: shipping.city || "",
                  shippingPostalCode: shipping.postalCode || "",
                }));
              }
            }
          })
          .catch(() => {});
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

  const saveProfileToAccount = async () => {
    if (!user) return;

    const res = await fetch("/api/account/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: form.name.trim(),
        phone: form.phone.trim() || null,
        nif: form.nif.trim() || null,
        company: form.companyName.trim() || null,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "Erro ao guardar dados do cliente");
    }

    if (data.profile) {
      setUser((current: any) => ({ ...current, ...data.profile }));
    }
  };

  const saveBillingAddressToAccount = async () => {
    if (!user) return;

    const addressUrl = selectedBillingAddressId
      ? `/api/account/addresses/${selectedBillingAddressId}`
      : "/api/account/addresses";

    const res = await fetch(addressUrl, {
      method: selectedBillingAddressId ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        label: "Faturação",
        name: form.name.trim(),
        address1: form.address1.trim(),
        address2: form.address2.trim() || null,
        city: form.city.trim(),
        postalCode: form.postalCode.trim(),
        country: "Portugal",
        phone: form.phone.trim() || null,
        setDefaultBilling: true,
        setDefaultShipping: shippingSameAsBilling,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "Erro ao guardar morada de faturação");
    }

    if (data.address) {
      setAccountAddresses(prev => {
        const others = prev
          .filter(a => a.id !== data.address.id)
          .map(a => ({
            ...a,
            isDefaultBilling: false,
            ...(shippingSameAsBilling ? { isDefaultShipping: false } : {}),
          }));

        return [data.address, ...others];
      });

      setSelectedBillingAddressId(data.address.id);
      if (shippingSameAsBilling) setSelectedShippingAddressId(data.address.id);
    }
  };

  const saveShippingAddressToAccount = async () => {
    if (!user || shippingSameAsBilling) return;

    const addressUrl = selectedShippingAddressId
      ? `/api/account/addresses/${selectedShippingAddressId}`
      : "/api/account/addresses";

    const res = await fetch(addressUrl, {
      method: selectedShippingAddressId ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        label: "Entrega",
        name: form.name.trim(),
        address1: form.shippingAddress1.trim(),
        address2: form.shippingAddress2.trim() || null,
        city: form.shippingCity.trim(),
        postalCode: form.shippingPostalCode.trim(),
        country: "Portugal",
        phone: form.phone.trim() || null,
        setDefaultBilling: false,
        setDefaultShipping: true,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "Erro ao guardar morada de entrega");
    }

    if (data.address) {
      setAccountAddresses(prev => {
        const others = prev
          .filter(a => a.id !== data.address.id)
          .map(a => ({ ...a, isDefaultShipping: false }));

        return [data.address, ...others];
      });

      setSelectedShippingAddressId(data.address.id);
    }
  };

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
          billingAddress: {
            name: form.name,
            address1: form.address1,
            address2: form.address2,
            city: form.city,
            postalCode: form.postalCode,
            country: "Portugal",
            phone: form.phone || null,
          },
          shippingAddress: form.deliveryType === "shipping"
            ? {
                name: form.name,
                address1: shippingSameAsBilling ? form.address1 : form.shippingAddress1,
                address2: shippingSameAsBilling ? form.address2 : form.shippingAddress2,
                city: shippingSameAsBilling ? form.city : form.shippingCity,
                postalCode: shippingSameAsBilling ? form.postalCode : form.shippingPostalCode,
                country: "Portugal",
                phone: form.phone || null,
              }
            : null,
          paymentMethod: form.paymentMethod,
          shippingMethod: form.deliveryType === "shipping" ? "home_delivery" : "store_pickup",
          deliveryType: form.deliveryType,
          couponCode: couponCode || null,
          nif: form.nif || null,
          companyName: form.companyName || null,
          guestEmail: !user ? form.email : null,
          guestName: !user ? form.name : null,
          guestPhone: form.phone || null,
          notes: form.notes || null,
        }),
      });
      const data = await res.json();

      if (!res.ok || data.error) {
        setError(data.error || "Erro ao processar encomenda");
      } else if (data.order) {
        // A encomenda já foi criada. A persistência dos dados da conta é
        // secundária e nunca deve transformar uma encomenda válida num erro.
        if (user) {
          try {
            await saveProfileToAccount();

            if (saveBillingAddress) {
              await saveBillingAddressToAccount();
              setSaveBillingAddress(false);
            }

            if (saveShippingAddress && !shippingSameAsBilling) {
              await saveShippingAddressToAccount();
              setSaveShippingAddress(false);
            }
          } catch (accountError) {
            console.error("checkout account persistence failed:", accountError);
          }
        }

        // The order already exists at this point. Clear the cart before
        // handling the provider result so a payment provisioning problem
        // cannot lead to an accidental duplicate order.
        localStorage.removeItem("mdtech_cart");
        localStorage.removeItem("mdtech_coupon");
        window.dispatchEvent(new Event("cart-updated"));

        const payment = data.payment ?? null;

        if (
          payment?.method === "card" &&
          payment.outcome === "created" &&
          typeof payment.redirectUrl === "string" &&
          payment.redirectUrl.startsWith("https://")
        ) {
          window.location.assign(payment.redirectUrl);
          return;
        }

        setSuccess({
          ...data.order,
          payment,
          checkout: {
            customer: {
              name: form.name,
              email: form.email,
              phone: form.phone,
              nif: form.nif,
              companyName: form.companyName,
            },
            billingAddress: {
              address1: form.address1,
              address2: form.address2,
              city: form.city,
              postalCode: form.postalCode,
            },
            deliveryType: form.deliveryType,
            shippingAddress: form.deliveryType === "shipping"
              ? {
                  address1: shippingSameAsBilling ? form.address1 : form.shippingAddress1,
                  address2: shippingSameAsBilling ? form.address2 : form.shippingAddress2,
                  city: shippingSameAsBilling ? form.city : form.shippingCity,
                  postalCode: shippingSameAsBilling ? form.postalCode : form.shippingPostalCode,
                }
              : null,
            paymentMethod: form.paymentMethod,
            notes: form.notes,
            items: cart.map(item => ({
              productId: item.productId,
              name: item.name,
              quantity: item.quantity,
            })),
          },
        });
      }
    } catch { setError("Erro ao processar encomenda"); }
    setLoading(false);
  };

  if (cart.length === 0 && !success) {
    return <div className="max-w-3xl mx-auto px-4 py-16 text-center"><p className="text-4xl mb-4">🛒</p><p className="text-slate-500">O seu carrinho está vazio.</p></div>;
  }

  if (success) {
    const payment = success.payment;

    return (
      <div className="max-w-3xl mx-auto px-4 py-16 text-center">
        <div className="bg-white rounded-2xl border p-8">
          <h1 className="text-2xl font-bold text-slate-800 mb-2">
            Encomenda registada com sucesso
          </h1>

          <p className="text-slate-500 mb-2">
            Número: <strong>{success.orderNumber}</strong>
          </p>

          <p className="text-lg font-bold text-slate-900 mb-4">
            Total: {parseFloat(success.total).toFixed(2)} EUR
          </p>

          {payment?.method === "multibanco" && payment.outcome === "created" && (
            <div className="max-w-md mx-auto mb-6 rounded-xl border bg-slate-50 p-5 text-left">
              <p className="font-semibold text-slate-800 mb-3">Pagamento por Multibanco</p>
              <p className="text-sm text-slate-600 mb-1">
                Entidade: <strong>{payment.entity || "-"}</strong>
              </p>
              <p className="text-sm text-slate-600 mb-1">
                Referência: <strong>{payment.reference || "-"}</strong>
              </p>
              <p className="text-sm text-slate-600">
                Valor: <strong>{parseFloat(success.total).toFixed(2)} EUR</strong>
              </p>
              {payment.expiresAt && (
                <p className="text-xs text-slate-500 mt-3">
                  Referência válida até {new Date(payment.expiresAt).toLocaleString("pt-PT")}.
                </p>
              )}
            </div>
          )}

          {payment?.method === "mbway" && payment.outcome === "created" && (
            <div className="max-w-md mx-auto mb-6 rounded-xl border bg-slate-50 p-5">
              <p className="font-semibold text-slate-800 mb-2">Pedido MB WAY enviado</p>
              <p className="text-sm text-slate-600">
                Confirme o pagamento na aplicação MB WAY. A encomenda será atualizada depois da confirmação do pagamento.
              </p>
            </div>
          )}

          {payment?.method === "bank_transfer" && (
            <div className="max-w-md mx-auto mb-6 rounded-xl border bg-slate-50 p-5">
              <p className="font-semibold text-slate-800 mb-2">Transferência bancária</p>
              <p className="text-sm text-slate-600">
                A encomenda encontra-se registada e aguarda pagamento.
              </p>
            </div>
          )}

          {(payment?.outcome === "provisioning_error" ||
            payment?.outcome === "reconciliation_required" ||
            payment?.outcome === "rejected") && (
            <div className="max-w-md mx-auto mb-6 rounded-xl border border-amber-200 bg-amber-50 p-5">
              <p className="font-semibold text-amber-800 mb-2">
                Pagamento ainda não concluído
              </p>
              <p className="text-sm text-amber-700">
                A encomenda já foi registada. Não volte a criar a encomenda. Consulte a sua área de cliente ou contacte-nos para concluir o pagamento.
              </p>
            </div>
          )}

          <div className="inline-block px-3 py-1 rounded-full text-sm font-medium bg-amber-50 text-amber-700 mb-6">
            A aguardar confirmação do pagamento
          </div>

          {success.checkout && (
            <div className="mb-8 text-left">
              <h2 className="text-lg font-bold text-slate-800 mb-4">
                Resumo da encomenda
              </h2>

              <div className="grid sm:grid-cols-2 gap-3 text-sm mb-4">
                <div className="p-4 bg-slate-50 rounded-lg">
                  <p className="font-semibold text-slate-800 mb-2">Dados do cliente</p>
                  <p>{success.checkout.customer.name}</p>
                  <p>{success.checkout.customer.email}</p>
                  {success.checkout.customer.phone && (
                    <p>{success.checkout.customer.phone}</p>
                  )}
                  {success.checkout.customer.nif && (
                    <p>NIF: {success.checkout.customer.nif}</p>
                  )}
                  {success.checkout.customer.companyName && (
                    <p>Empresa: {success.checkout.customer.companyName}</p>
                  )}
                </div>

                <div className="p-4 bg-slate-50 rounded-lg">
                  <p className="font-semibold text-slate-800 mb-2">Morada de faturação</p>
                  <p>{success.checkout.billingAddress.address1}</p>
                  {success.checkout.billingAddress.address2 && (
                    <p>{success.checkout.billingAddress.address2}</p>
                  )}
                  <p>
                    {success.checkout.billingAddress.postalCode}{" "}
                    {success.checkout.billingAddress.city}
                  </p>
                  <p>Portugal</p>
                </div>

                <div className="p-4 bg-slate-50 rounded-lg">
                  <p className="font-semibold text-slate-800 mb-2">Entrega</p>
                  {success.checkout.deliveryType === "pickup" ? (
                    <p>Levantamento em loja — Esposende</p>
                  ) : success.checkout.shippingAddress ? (
                    <>
                      <p>{success.checkout.shippingAddress.address1}</p>
                      {success.checkout.shippingAddress.address2 && (
                        <p>{success.checkout.shippingAddress.address2}</p>
                      )}
                      <p>
                        {success.checkout.shippingAddress.postalCode}{" "}
                        {success.checkout.shippingAddress.city}
                      </p>
                      <p>Portugal</p>
                    </>
                  ) : null}
                </div>

                <div className="p-4 bg-slate-50 rounded-lg">
                  <p className="font-semibold text-slate-800 mb-2">Pagamento</p>
                  <p>
                    {{
                      bank_transfer: "Transferência Bancária",
                      multibanco: "Multibanco",
                      mbway: "MB WAY",
                      card: "Cartão",
                    }[success.checkout.paymentMethod as "bank_transfer" | "multibanco" | "mbway" | "card"] || success.checkout.paymentMethod}
                  </p>
                  {success.checkout.notes && (
                    <p className="mt-2 text-slate-600">
                      <span className="font-medium">Notas:</span>{" "}
                      {success.checkout.notes}
                    </p>
                  )}
                </div>
              </div>

              <div className="border rounded-lg overflow-hidden">
                <div className="px-4 py-3 bg-slate-50 border-b font-semibold text-sm text-slate-800">
                  Artigos
                </div>
                <div className="divide-y">
                  {success.checkout.items.map((item: any) => (
                    <div
                      key={item.productId}
                      className="flex justify-between gap-4 px-4 py-3 text-sm"
                    >
                      <span className="text-slate-700">{item.name}</span>
                      <span className="font-medium text-slate-800 whitespace-nowrap">
                        {item.quantity}×
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div>
            <button
              onClick={() => router.push("/")}
              className="px-6 py-3 bg-sky-600 text-white rounded-lg font-medium hover:bg-sky-700 transition"
            >
              Voltar à Loja
            </button>
          </div>
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

              {/* MORADA DE FATURAÇÃO */}
              <div className="space-y-4 mt-4">
                <h3 className="font-medium text-sm text-slate-700">
                  Morada de Faturação
                </h3>

                {accountAddresses.length > 0 && (
                  <div>
                    <label className="text-xs text-slate-500 block mb-1">
                      Morada de faturação guardada
                    </label>
                    <select
                      className="w-full border rounded-lg px-3 py-2 text-sm"
                      value={selectedBillingAddressId ?? ""}
                      onChange={e => {
                        if (!e.target.value) {
                          setSelectedBillingAddressId(null);
                          setSaveBillingAddress(true);
                          return;
                        }

                        const id = Number(e.target.value);
                        const a = accountAddresses.find((x: any) => x.id === id);
                        if (!a) return;

                        setSelectedBillingAddressId(id);
                        setSaveBillingAddress(false);
                        setForm(f => ({
                          ...f,
                          name: a.name || f.name,
                          address1: a.address1 || "",
                          address2: a.address2 || "",
                          city: a.city || "",
                          postalCode: a.postalCode || "",
                          phone: a.phone || f.phone,
                        }));
                      }}
                    >
                      <option value="">Selecionar morada de faturação...</option>
                      {accountAddresses.map((a: any) => (
                        <option key={a.id} value={a.id}>
                          {a.label || "Morada"} - {a.address1}, {a.postalCode} {a.city}
                          {a.isDefaultBilling ? " (predefinida)" : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div>
                  <label className="text-xs text-slate-500 block mb-1">
                    Morada *
                  </label>
                  <input
                    value={form.address1}
                    onChange={e => update("address1", e.target.value)}
                    className="w-full border rounded-lg px-3 py-2 text-sm"
                  />
                </div>

                <div>
                  <label className="text-xs text-slate-500 block mb-1">
                    Complemento
                  </label>
                  <input
                    value={form.address2}
                    onChange={e => update("address2", e.target.value)}
                    className="w-full border rounded-lg px-3 py-2 text-sm"
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs text-slate-500 block mb-1">
                      Cidade *
                    </label>
                    <input
                      value={form.city}
                      onChange={e => update("city", e.target.value)}
                      className="w-full border rounded-lg px-3 py-2 text-sm"
                    />
                  </div>

                  <div>
                    <label className="text-xs text-slate-500 block mb-1">
                      Código Postal *
                    </label>
                    <input
                      value={form.postalCode}
                      onChange={e => update("postalCode", e.target.value)}
                      className="w-full border rounded-lg px-3 py-2 text-sm"
                      placeholder="0000-000"
                    />
                  </div>
                </div>
                {user && (
                  <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={saveBillingAddress}
                      onChange={e => setSaveBillingAddress(e.target.checked)}
                      className="accent-sky-600"
                    />
                    Guardar esta morada de faturação na minha conta
                  </label>
                )}

              </div>

              {/* MORADA DE ENTREGA - APENAS PARA ENVIO */}
              {form.deliveryType === "shipping" && (
                <div className="mt-6 pt-6 border-t">
                  <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={shippingSameAsBilling}
                      onChange={e => setShippingSameAsBilling(e.target.checked)}
                      className="accent-sky-600"
                    />
                    A morada de entrega é igual à morada de faturação
                  </label>
                </div>
              )}

              {form.deliveryType === "shipping" && !shippingSameAsBilling && (
                <div className="space-y-4 mt-4">
                  <h3 className="font-medium text-sm text-slate-700">
                    Morada de Entrega
                  </h3>

                  {accountAddresses.length > 0 && (
                    <div>
                      <label className="text-xs text-slate-500 block mb-1">
                        Morada de entrega guardada
                      </label>
                      <select
                        className="w-full border rounded-lg px-3 py-2 text-sm"
                        value={selectedShippingAddressId ?? ""}
                        onChange={e => {
                          if (!e.target.value) {
                            setSelectedShippingAddressId(null);
                            setSaveShippingAddress(true);
                            return;
                          }

                          const id = Number(e.target.value);
                          const a = accountAddresses.find((x: any) => x.id === id);
                          if (!a) return;

                          setSelectedShippingAddressId(id);
                          setSaveShippingAddress(false);
                          setForm(f => ({
                            ...f,
                            shippingAddress1: a.address1 || "",
                            shippingAddress2: a.address2 || "",
                            shippingCity: a.city || "",
                            shippingPostalCode: a.postalCode || "",
                          }));
                        }}
                      >
                        <option value="">Selecionar morada de entrega...</option>
                        {accountAddresses.map((a: any) => (
                          <option key={a.id} value={a.id}>
                            {a.label || "Morada"} - {a.address1}, {a.postalCode} {a.city}
                            {a.isDefaultShipping ? " (predefinida)" : ""}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  <div>
                    <label className="text-xs text-slate-500 block mb-1">
                      Morada *
                    </label>
                    <input
                      value={form.shippingAddress1}
                      onChange={e => update("shippingAddress1", e.target.value)}
                      className="w-full border rounded-lg px-3 py-2 text-sm"
                    />
                  </div>

                  <div>
                    <label className="text-xs text-slate-500 block mb-1">
                      Complemento
                    </label>
                    <input
                      value={form.shippingAddress2}
                      onChange={e => update("shippingAddress2", e.target.value)}
                      className="w-full border rounded-lg px-3 py-2 text-sm"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-xs text-slate-500 block mb-1">
                        Cidade *
                      </label>
                      <input
                        value={form.shippingCity}
                        onChange={e => update("shippingCity", e.target.value)}
                        className="w-full border rounded-lg px-3 py-2 text-sm"
                      />
                    </div>

                    <div>
                      <label className="text-xs text-slate-500 block mb-1">
                        Código Postal *
                      </label>
                      <input
                        value={form.shippingPostalCode}
                        onChange={e => update("shippingPostalCode", e.target.value)}
                        className="w-full border rounded-lg px-3 py-2 text-sm"
                        placeholder="0000-000"
                      />
                    </div>
                  </div>

                  {user && (
                    <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={saveShippingAddress}
                        onChange={e => setSaveShippingAddress(e.target.checked)}
                        className="accent-sky-600"
                      />
                      Guardar esta morada de entrega na minha conta
                    </label>
                  )}
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
                {[
                  { value: "bank_transfer", title: "Transferência Bancária", description: "Pague através de transferência bancária." },
                  { value: "multibanco", title: "Multibanco", description: "Receba uma entidade e referência para efetuar o pagamento." },
                  { value: "mbway", title: "MB WAY", description: "Receba o pedido de pagamento no seu telemóvel." },
                  { value: "card", title: "Cartão", description: "Pagamento seguro através da página de pagamento Eupago." },
                ].map(method => (
                  <label key={method.value} className={`flex items-center gap-4 p-4 border rounded-xl cursor-pointer transition ${form.paymentMethod === method.value ? "border-sky-300 bg-sky-50" : "hover:border-slate-300"}`}>
                    <input
                      type="radio"
                      name="payment"
                      value={method.value}
                      checked={form.paymentMethod === method.value}
                      onChange={e => update("paymentMethod", e.target.value)}
                      className="accent-sky-600"
                    />
                    <div>
                      <p className="font-medium text-sm">{method.title}</p>
                      <p className="text-xs text-slate-500">{method.description}</p>
                    </div>
                  </label>
                ))}
              </div>
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

              <div className="grid sm:grid-cols-2 gap-3 text-sm">
                <div className="p-4 bg-slate-50 rounded-lg">
                  <p className="font-semibold text-slate-800 mb-2">Dados do cliente</p>
                  <p>{form.name}</p>
                  <p>{form.email}</p>
                  {form.phone && <p>{form.phone}</p>}
                  {form.nif && <p>NIF: {form.nif}</p>}
                  {form.companyName && <p>Empresa: {form.companyName}</p>}
                </div>

                <div className="p-4 bg-slate-50 rounded-lg">
                  <p className="font-semibold text-slate-800 mb-2">Morada de faturação</p>
                  <p>{form.address1}</p>
                  {form.address2 && <p>{form.address2}</p>}
                  <p>{form.postalCode} {form.city}</p>
                  <p>Portugal</p>
                </div>

                <div className="p-4 bg-slate-50 rounded-lg">
                  <p className="font-semibold text-slate-800 mb-2">Entrega</p>
                  {form.deliveryType === "pickup" ? (
                    <p>Levantamento em loja — Esposende</p>
                  ) : shippingSameAsBilling ? (
                    <>
                      <p>{form.address1}</p>
                      {form.address2 && <p>{form.address2}</p>}
                      <p>{form.postalCode} {form.city}</p>
                      <p>Portugal</p>
                    </>
                  ) : (
                    <>
                      <p>{form.shippingAddress1}</p>
                      {form.shippingAddress2 && <p>{form.shippingAddress2}</p>}
                      <p>{form.shippingPostalCode} {form.shippingCity}</p>
                      <p>Portugal</p>
                    </>
                  )}
                </div>

                <div className="p-4 bg-slate-50 rounded-lg">
                  <p className="font-semibold text-slate-800 mb-2">Pagamento</p>
                  <p>
                    {{
                      bank_transfer: "Transferência Bancária",
                      multibanco: "Multibanco",
                      mbway: "MB WAY",
                      card: "Cartão",
                    }[form.paymentMethod] || form.paymentMethod}
                  </p>
                  {form.notes && (
                    <p className="mt-2 text-slate-600">
                      <span className="font-medium">Notas:</span> {form.notes}
                    </p>
                  )}
                </div>
              </div>
              {error && <p className="text-sm text-red-500">{error}</p>}
              <div className="flex gap-3">
                <button onClick={() => setStep(3)} className="px-6 py-2 border rounded-lg text-sm text-slate-600 hover:bg-slate-50 transition">← Voltar</button>
                <button onClick={handleSubmit} disabled={loading || !quote || !quote.allInStock}
                  className="px-6 py-2 bg-lime-600 hover:bg-lime-700 text-white text-sm rounded-lg font-bold transition disabled:opacity-50">
                  {loading ? "A processar..." : `Encomendar e pagar ${quote ? quote.total : "..."}€`}
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
