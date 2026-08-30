"use client";
import Link from "next/link";

interface Product {
  id: number;
  name: string;
  slug: string;
  price: string;
  comparePrice?: string | null;
  shortDescription?: string | null;
  images?: string[] | null;
  primaryImageUrl?: string | null;
  stock: number;
  availableStock?: number;
  allowPreorder?: boolean;
  isService?: boolean;
  attributes?: Record<string, string> | null;
  storeStock?: number;
}

export default function ProductCard({ product }: { product: Product }) {
  const price = parseFloat(product.price);
  const comparePrice = product.comparePrice ? parseFloat(product.comparePrice) : null;
  const discount = comparePrice ? Math.round((1 - price / comparePrice) * 100) : 0;
  const available = product.availableStock ?? product.stock;
  const inStock = available > 0 || product.isService;

  // Image priority: primaryImageUrl → legacy images[0] → emoji placeholder
  const imageUrl = product.primaryImageUrl || product.images?.[0] || null;

  const addToCart = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const stored = localStorage.getItem("mdtech_cart");
    const cart = stored ? JSON.parse(stored) : [];
    const existing = cart.find((c: { productId: number }) => c.productId === product.id);
    if (existing) {
      existing.quantity += 1;
    } else {
      cart.push({ productId: product.id, name: product.name, slug: product.slug, price, quantity: 1, image: imageUrl });
    }
    localStorage.setItem("mdtech_cart", JSON.stringify(cart));
    window.dispatchEvent(new Event("cart-updated"));
  };

  return (
    <Link href={`/produto/${product.slug}`} className="group bg-white rounded-xl border border-slate-200 hover:border-sky-300 hover:shadow-lg transition-all duration-200 flex flex-col overflow-hidden">
      <div className="relative aspect-square bg-slate-50 flex items-center justify-center p-4 overflow-hidden">
        {discount > 0 && (
          <span className="absolute top-2 left-2 bg-red-500 text-white text-xs font-bold px-2 py-0.5 rounded z-10">-{discount}%</span>
        )}
        {imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imageUrl} alt={product.name} className="w-full h-full object-contain group-hover:scale-105 transition-transform" loading="lazy" />
        ) : (
          <span className="text-5xl group-hover:scale-110 transition-transform">
            {product.isService ? "🛠️" : "📦"}
          </span>
        )}
      </div>
      <div className="p-4 flex flex-col flex-1">
        <h3 className="text-sm font-medium text-slate-800 line-clamp-2 mb-2 group-hover:text-sky-600 transition leading-snug">{product.name}</h3>
        <div className="mt-auto">
          <div className="flex items-baseline gap-2 mb-2">
            <span className="text-lg font-bold text-slate-900">{price.toFixed(2)}€</span>
            {comparePrice && <span className="text-sm text-slate-400 line-through">{comparePrice.toFixed(2)}€</span>}
          </div>
          <div className="flex items-center justify-between">
            <span className={`text-xs font-medium ${inStock ? "text-green-600" : "text-red-500"}`}>
              {inStock ? (product.isService ? "Disponível" : (available <= 5 ? `Últimas ${available} un.` : "Em stock")) : "Esgotado"}
            </span>
            {product.storeStock && product.storeStock > 0 ? (
              <span className="text-[10px] text-slate-400">📍 Loja</span>
            ) : null}
          </div>
          {inStock && (
            <button onClick={addToCart}
              className="w-full mt-3 py-2 bg-sky-600 hover:bg-sky-700 text-white text-xs font-semibold rounded-lg transition">
              Adicionar ao Carrinho
            </button>
          )}
        </div>
      </div>
    </Link>
  );
}
