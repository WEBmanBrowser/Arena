"use client";
import { useState, useEffect } from "react";
import Link from "next/link";

interface CartItem { productId: number; name: string; slug: string; price: number; quantity: number; image?: string | null; }

export default function CarrinhoPage() {
  const [cart, setCart] = useState<CartItem[]>([]);
  const [couponCode, setCouponCode] = useState("");
  const [couponResult, setCouponResult] = useState<{ discount: string; code: string } | null>(null);
  const [couponError, setCouponError] = useState("");

  useEffect(() => {
    queueMicrotask(() => {
      const stored = localStorage.getItem("mdtech_cart");
      if (stored) setCart(JSON.parse(stored));
      const storedCoupon = localStorage.getItem("mdtech_coupon");
      if (storedCoupon) setCouponCode(storedCoupon);
    });
  }, []);

  const saveCart = (items: CartItem[]) => {
    setCart(items);
    localStorage.setItem("mdtech_cart", JSON.stringify(items));
    window.dispatchEvent(new Event("cart-updated"));
  };

  const updateQuantity = (productId: number, qty: number) => {
    if (qty < 1) return removeItem(productId);
    saveCart(cart.map(c => c.productId === productId ? { ...c, quantity: qty } : c));
  };

  const removeItem = (productId: number) => { saveCart(cart.filter(c => c.productId !== productId)); };

  const applyCoupon = async () => {
    setCouponError("");
    setCouponResult(null);
    if (!couponCode.trim()) return;
    // Persist coupon code for checkout
    localStorage.setItem("mdtech_coupon", couponCode.trim());
    try {
      const res = await fetch("/api/cart/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: cart.map(i => ({ productId: i.productId, quantity: i.quantity })),
          couponCode: couponCode.trim(),
          deliveryType: "shipping",
        }),
      });
      const data = await res.json();
      if (data.error) { setCouponError(data.error); }
      else if (data.coupon && parseFloat(data.discount) > 0) {
        setCouponResult({ discount: data.discount, code: data.coupon.code });
      } else {
        setCouponError("Cupão inválido ou não aplicável");
      }
    } catch { setCouponError("Erro ao validar cupão"); }
  };

  // Use localStorage prices for merchandise display only — server recalculates prices, IVA, discounts and shipping at checkout.
  const subtotal = cart.reduce((acc, c) => acc + c.price * c.quantity, 0);
  const discount = couponResult ? parseFloat(couponResult.discount) : 0;
  const estimatedMerchandiseTotal = Math.max(0, subtotal - discount);

  if (cart.length === 0) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-16 text-center">
        <p className="text-5xl mb-4">🛒</p>
        <h1 className="text-2xl font-bold text-slate-800 mb-2">O seu carrinho está vazio</h1>
        <p className="text-slate-500 mb-6">Explore os nossos produtos e encontre o que precisa.</p>
        <Link href="/produtos" className="inline-flex items-center gap-2 px-6 py-3 bg-sky-600 hover:bg-sky-700 text-white font-semibold rounded-lg transition">Explorar Produtos →</Link>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      <h1 className="text-2xl font-bold text-slate-800 mb-6">🛒 Carrinho</h1>
      <p className="text-xs text-slate-400 mb-4">Os valores finais (preços, IVA, portes e descontos) serão recalculados pelo servidor no checkout.</p>

      <div className="grid lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-3">
          {cart.map(item => (
            <div key={item.productId} className="flex items-center gap-4 bg-white border rounded-xl p-4">
              <div className="w-16 h-16 bg-slate-50 rounded-lg flex items-center justify-center text-2xl shrink-0">📦</div>
              <div className="flex-1 min-w-0">
                <Link href={`/produto/${item.slug}`} className="text-sm font-medium text-slate-800 hover:text-sky-600 line-clamp-2">{item.name}</Link>
                <p className="text-sm font-bold text-slate-900 mt-1">{item.price.toFixed(2)}€</p>
              </div>
              <div className="flex items-center gap-1 border rounded-lg">
                <button onClick={() => updateQuantity(item.productId, item.quantity - 1)} className="w-8 h-8 text-slate-500 hover:text-slate-800">−</button>
                <span className="w-8 text-center text-sm">{item.quantity}</span>
                <button onClick={() => updateQuantity(item.productId, item.quantity + 1)} className="w-8 h-8 text-slate-500 hover:text-slate-800">+</button>
              </div>
              <p className="text-sm font-bold text-slate-900 w-20 text-right">{(item.price * item.quantity).toFixed(2)}€</p>
              <button onClick={() => removeItem(item.productId)} className="text-red-400 hover:text-red-600 text-lg">✕</button>
            </div>
          ))}
        </div>

        <div className="bg-white border rounded-xl p-6 h-fit sticky top-24">
          <h2 className="font-bold text-slate-800 mb-4">Resumo</h2>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between text-slate-600"><span>Subtotal</span><span>{subtotal.toFixed(2)}€</span></div>
            <div className="flex justify-between text-slate-600">
              <span>Portes</span>
              <span className="text-slate-400">Calculados no checkout</span>
            </div>
            {discount > 0 && <div className="flex justify-between text-green-600"><span>Desconto ({couponResult?.code})</span><span>-{discount.toFixed(2)}€</span></div>}
            <hr />
            <div className="flex justify-between font-bold text-lg text-slate-900"><span>Subtotal estimado</span><span>{estimatedMerchandiseTotal.toFixed(2)}€</span></div>
            <p className="text-xs text-slate-400">IVA e portes finais recalculados pelo servidor.</p>
          </div>

          <div className="mt-4">
            <div className="flex gap-2">
              <input type="text" placeholder="Código de cupão" value={couponCode} onChange={e => setCouponCode(e.target.value)}
                className="flex-1 border rounded-lg px-3 py-2 text-sm" />
              <button onClick={applyCoupon} className="px-3 py-2 border rounded-lg text-sm text-slate-600 hover:bg-slate-50">Aplicar</button>
            </div>
            {couponError && <p className="text-xs text-red-500 mt-1">{couponError}</p>}
            {couponResult && <p className="text-xs text-green-600 mt-1">✓ Cupão {couponResult.code} aplicado</p>}
          </div>

          <p className="text-xs text-slate-500 mt-3">🚚 Classes, portes e eventual oferta são calculados de forma autoritativa no checkout.</p>

          <Link href="/checkout" className="block w-full mt-4 py-3 bg-sky-600 hover:bg-sky-700 text-white text-center font-semibold rounded-lg transition">
            Finalizar Compra →
          </Link>
          <Link href="/produtos" className="block w-full mt-2 py-2 text-center text-sm text-slate-500 hover:text-sky-600">← Continuar a comprar</Link>
        </div>
      </div>
    </div>
  );
}
