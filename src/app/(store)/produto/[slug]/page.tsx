"use client";
import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import ProductCard from "@/components/ProductCard";

export default function ProdutoPage() {
  const params = useParams();
  const slug = params.slug as string;
  const [product, setProduct] = useState<any>(null);
  const [brand, setBrand] = useState<any>(null);
  const [category, setCategory] = useState<any>(null);
  const [related, setRelated] = useState<any[]>([]);
  const [quantity, setQuantity] = useState(1);
  const [loading, setLoading] = useState(true);
  const [addedMsg, setAddedMsg] = useState("");
  const [alertEmail, setAlertEmail] = useState("");
  const [alertSent, setAlertSent] = useState(false);
  const [selectedImg, setSelectedImg] = useState<{ url: string | null; altText: string | null } | null>(null);

  useEffect(() => {
    fetch(`/api/products/${slug}`).then(r => r.json()).then(d => {
      setProduct(d.product);
      setBrand(d.brand);
      setCategory(d.category);
      setRelated(d.related || []);
      // Initialize selected image from gallery
      const imgs = d.product?.images || [];
      const primary = imgs.find((i: { isPrimary: boolean }) => i.isPrimary) || imgs[0];
      setSelectedImg(primary ? { url: primary.url, altText: primary.altText } : null);
      setLoading(false);
    });
  }, [slug]);

  if (loading) return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="animate-pulse grid md:grid-cols-2 gap-8">
        <div className="aspect-square bg-slate-100 rounded-xl"></div>
        <div className="space-y-4">
          <div className="h-8 bg-slate-100 rounded w-3/4"></div>
          <div className="h-6 bg-slate-100 rounded w-1/2"></div>
          <div className="h-20 bg-slate-100 rounded"></div>
        </div>
      </div>
    </div>
  );

  if (!product) return (
    <div className="max-w-7xl mx-auto px-4 py-16 text-center">
      <p className="text-4xl mb-4">😕</p>
      <p className="text-slate-500">Produto não encontrado.</p>
      <Link href="/produtos" className="text-sky-600 mt-2 inline-block">Voltar à loja</Link>
    </div>
  );

  const price = parseFloat(product.price);
  const comparePrice = product.comparePrice ? parseFloat(product.comparePrice) : null;
  const discount = comparePrice ? Math.round((1 - price / comparePrice) * 100) : 0;
  const available = product.availableStock ?? product.stock;
  const inStock = available > 0 || product.isService;

  const addToCart = () => {
    const stored = localStorage.getItem("mdtech_cart");
    const cart = stored ? JSON.parse(stored) : [];
    const existing = cart.find((c: any) => c.productId === product.id);
    if (existing) {
      existing.quantity += quantity;
    } else {
      cart.push({ productId: product.id, name: product.name, slug: product.slug, price, quantity, image: product.primaryImageUrl || null });
    }
    localStorage.setItem("mdtech_cart", JSON.stringify(cart));
    window.dispatchEvent(new Event("cart-updated"));
    setAddedMsg("Adicionado ao carrinho!");
    setTimeout(() => setAddedMsg(""), 3000);
  };

  const toggleWishlist = async () => {
    await fetch("/api/wishlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId: product.id }),
    });
  };

  const addToCompare = () => {
    const stored = localStorage.getItem("mdtech_compare");
    const compare = stored ? JSON.parse(stored) : [];
    if (!compare.find((c: any) => c.id === product.id)) {
      compare.push({ id: product.id, name: product.name, slug: product.slug });
      localStorage.setItem("mdtech_compare", JSON.stringify(compare));
      setAddedMsg("Adicionado ao comparador!");
      setTimeout(() => setAddedMsg(""), 3000);
    }
  };

  const sendStockAlert = async () => {
    if (!alertEmail) return;
    await fetch("/api/stock-alert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: alertEmail, productId: product.id }),
    });
    setAlertSent(true);
  };

  const attrs = product.attributes as Record<string, string> | null;

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      {/* Breadcrumb */}
      <nav className="text-xs text-slate-500 mb-6">
        <Link href="/" className="hover:text-sky-600">Início</Link>
        <span className="mx-1">›</span>
        {category && (<><Link href={`/produtos?cat=${category.slug}`} className="hover:text-sky-600">{category.name}</Link><span className="mx-1">›</span></>)}
        <span className="text-slate-800 truncate">{product.name}</span>
      </nav>

      <div className="grid md:grid-cols-2 gap-8 mb-12">
        {/* Image + Gallery */}
        <div className="relative">
          <div className="aspect-square bg-slate-50 rounded-xl flex items-center justify-center border overflow-hidden">
            {discount > 0 && <span className="absolute top-4 left-4 bg-red-500 text-white text-sm font-bold px-3 py-1 rounded-full z-10">-{discount}%</span>}
            {selectedImg?.url ? (
              <img src={selectedImg.url} alt={selectedImg.altText?.trim() || product.name} className="w-full h-full object-contain" />
            ) : product.primaryImageUrl ? (
              <img src={product.primaryImageUrl} alt={product.name} className="w-full h-full object-contain" />
            ) : (
              <span className="text-8xl">{product.isService ? "🛠️" : "📦"}</span>
            )}
          </div>
          {/* Thumbnails */}
          {product.images && product.images.length > 1 && (
            <div className="flex gap-2 mt-3 overflow-x-auto">
              {product.images.map((img: { id: number | null; url: string | null; altText: string | null; isPrimary: boolean }, i: number) => (
                <button key={img.id || i} onClick={() => setSelectedImg({ url: img.url, altText: img.altText })}
                  className={`w-16 h-16 rounded-lg border-2 overflow-hidden flex-shrink-0 transition ${selectedImg?.url === img.url ? "border-sky-500" : "border-slate-200 hover:border-slate-300"}`}>
                  {img.url ? (
                    <img src={img.url} alt={img.altText?.trim() || product.name} className="w-full h-full object-contain" />
                  ) : (
                    <span className="text-lg">📦</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Info */}
        <div>
          {brand && <p className="text-xs text-sky-600 font-semibold mb-1 uppercase">{brand.name}</p>}
          <h1 className="text-2xl font-bold text-slate-800 mb-2">{product.name}</h1>
          <div className="flex items-center gap-3 text-xs text-slate-400 mb-4">
            {product.sku && <span>SKU: {product.sku}</span>}
            {product.ean && <span>EAN: {product.ean}</span>}
          </div>

          <div className="flex items-baseline gap-3 mb-4">
            <span className="text-3xl font-bold text-slate-900">{price.toFixed(2)}€</span>
            {comparePrice && <span className="text-lg text-slate-400 line-through">{comparePrice.toFixed(2)}€</span>}
          </div>
          <p className="text-xs text-slate-400 mb-4">IVA incluído à taxa legal em vigor ({product.vatRate}%)</p>

          {product.shortDescription && (
            <p className="text-sm text-slate-600 mb-6">{product.shortDescription}</p>
          )}

          {/* Stock */}
          <div className="mb-6 p-4 bg-slate-50 rounded-lg">
            <div className="flex items-center gap-2 mb-2">
              <span className={`w-2 h-2 rounded-full ${inStock ? "bg-green-500 animate-pulse-dot" : "bg-red-500"}`}></span>
              <span className={`text-sm font-medium ${inStock ? "text-green-600" : "text-red-500"}`}>
                {inStock ? (product.isService ? "Serviço Disponível" : "Em Stock") : (product.allowPreorder ? "Pré-encomenda" : "Esgotado")}
              </span>
            </div>
            {!product.isService && available > 0 && available <= 5 && (
              <p className="text-xs text-amber-600">Apenas {available} unidades disponíveis</p>
            )}
            {product.storeStock > 0 && (
              <p className="text-xs text-slate-500 mt-1">📍 Disponível para levantamento na loja de Esposende</p>
            )}
          </div>

          {inStock ? (
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <div className="flex border rounded-lg overflow-hidden">
                  <button onClick={() => setQuantity(Math.max(1, quantity - 1))} className="w-10 h-10 text-slate-600 hover:bg-slate-50 flex items-center justify-center">−</button>
                  <input type="number" value={quantity} onChange={e => setQuantity(Math.max(1, parseInt(e.target.value) || 1))}
                    className="w-14 h-10 text-center border-x text-sm" min="1" />
                  <button onClick={() => setQuantity(quantity + 1)} className="w-10 h-10 text-slate-600 hover:bg-slate-50 flex items-center justify-center">+</button>
                </div>
                <button onClick={addToCart}
                  className="flex-1 h-10 bg-sky-600 hover:bg-sky-700 text-white font-semibold rounded-lg transition text-sm">
                  Adicionar ao Carrinho
                </button>
              </div>
              <div className="flex gap-2">
                <button onClick={toggleWishlist} className="flex-1 h-10 border rounded-lg text-sm text-slate-600 hover:border-sky-300 transition">❤️ Favoritos</button>
                <button onClick={addToCompare} className="flex-1 h-10 border rounded-lg text-sm text-slate-600 hover:border-sky-300 transition">📊 Comparar</button>
              </div>
              {addedMsg && <p className="text-sm text-green-600 font-medium animate-fade-in">✓ {addedMsg}</p>}
            </div>
          ) : (
            <div className="space-y-3">
              {!alertSent ? (
                <div className="flex gap-2">
                  <input type="email" placeholder="O seu email..." value={alertEmail} onChange={e => setAlertEmail(e.target.value)}
                    className="flex-1 h-10 border rounded-lg px-3 text-sm" />
                  <button onClick={sendStockAlert} className="px-4 h-10 bg-amber-500 hover:bg-amber-600 text-white text-sm font-medium rounded-lg transition">
                    Avisar-me
                  </button>
                </div>
              ) : (
                <p className="text-sm text-green-600">✓ Será notificado quando o produto estiver disponível.</p>
              )}
            </div>
          )}

          {/* Shipping info */}
          <div className="mt-6 space-y-2 text-xs text-slate-500">
            <p>🚚 Portes grátis em compras acima de 50€</p>
            <p>📍 Levantamento gratuito em Esposende</p>
            <p>🛡️ Garantia do fabricante</p>
          </div>
        </div>
      </div>

      {/* Attributes */}
      {attrs && Object.keys(attrs).length > 0 && (
        <div className="mb-12">
          <h2 className="text-lg font-bold text-slate-800 mb-4">Especificações</h2>
          <div className="bg-white rounded-xl border">
            {Object.entries(attrs).map(([key, value], i) => (
              <div key={key} className={`flex ${i > 0 ? "border-t" : ""}`}>
                <div className="w-1/3 px-4 py-3 bg-slate-50 text-sm font-medium text-slate-600 capitalize">{key}</div>
                <div className="w-2/3 px-4 py-3 text-sm text-slate-800">{value}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Description */}
      {product.description && (
        <div className="mb-12">
          <h2 className="text-lg font-bold text-slate-800 mb-4">Descrição</h2>
          <div className="prose prose-sm max-w-none text-slate-600">
            <p>{product.description}</p>
          </div>
        </div>
      )}

      {/* Related */}
      {related.length > 0 && (
        <div className="mb-12">
          <h2 className="text-lg font-bold text-slate-800 mb-4">Produtos Relacionados</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {related.map((p: any) => (
              <ProductCard key={p.id} product={p} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
