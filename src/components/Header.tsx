"use client";
import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { isStaffRole } from "@/lib/roles";
import { useRouter } from "next/navigation";
import Logo from "@/components/Logo";

interface CartItem {
  productId: number;
  name: string;
  price: number;
  quantity: number;
  image?: string;
}

export default function Header() {
  const [user, setUser] = useState<{ name: string; role: string } | null>(null);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<{ products: any[]; categories: any[]; brands: any[] }>({ products: [], categories: [], brands: [] });
  const [showSearch, setShowSearch] = useState(false);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    fetch("/api/auth/me").then(r => r.json()).then(d => d.user && setUser(d.user));
    queueMicrotask(() => {
      const stored = localStorage.getItem("mdtech_cart");
      if (stored) setCart(JSON.parse(stored));
    });
    const handler = () => {
      const s = localStorage.getItem("mdtech_cart");
      setCart(s ? JSON.parse(s) : []);
    };
    window.addEventListener("storage", handler);
    window.addEventListener("cart-updated", handler);
    return () => { window.removeEventListener("storage", handler); window.removeEventListener("cart-updated", handler); };
  }, []);

  useEffect(() => {
    if (searchQuery.length >= 2) {
      const timer = setTimeout(() => {
        fetch(`/api/search?q=${encodeURIComponent(searchQuery)}`).then(r => r.json()).then(d => {
          setSearchResults(d);
          setShowSearch(true);
        });
      }, 300);
      return () => clearTimeout(timer);
    } else {
      queueMicrotask(() => setShowSearch(false));
    }
  }, [searchQuery]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) setShowSearch(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const cartCount = cart.reduce((a, c) => a + c.quantity, 0);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) { router.push(`/produtos?q=${encodeURIComponent(searchQuery.trim())}`); setShowSearch(false); }
  };

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    setUser(null);
    setShowUserMenu(false);
    router.push("/");
  };

  return (
    <header className="sticky top-0 z-50 bg-slate-900 shadow-lg">
      {/* Top bar */}
      <div className="bg-slate-950 text-xs text-slate-400">
        <div className="max-w-7xl mx-auto px-4 flex items-center justify-between h-8">
          <span>📍 Esposende, Portugal — Seg-Sex 9:00-18:30</span>
          <div className="hidden md:flex gap-4">
            <Link href="/pagina/sobre-nos" className="hover:text-white transition">Sobre Nós</Link>
            <Link href="/smart-shopping" className="hover:text-white transition">Smart Shopping</Link>
            <Link href="/configurador" className="hover:text-white transition">Configurador PC</Link>
            {isStaffRole(user?.role) && <Link href="/admin" className="text-brand-green hover:text-white transition">⚙️ Backoffice</Link>}
          </div>
        </div>
      </div>

      {/* Main header */}
      <div className="max-w-7xl mx-auto px-4 flex items-center gap-4 h-16">
        {/* Logo */}
        <Link href="/" className="shrink-0 flex items-center" aria-label="MDTech Solutions — página inicial">
          {/* Logótipo oficial: pequeno em mobile, maior a partir de sm */}
          <Logo height={28} priority className="sm:hidden" />
          <Logo height={40} priority className="hidden sm:block" />
        </Link>

        {/* Search */}
        <div className="flex-1 max-w-2xl relative" ref={searchRef}>
          <form onSubmit={handleSearch}>
            <input
              type="text"
              placeholder="Pesquisar produtos, marcas, categorias..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full h-10 pl-4 pr-10 rounded-lg bg-slate-800 text-white placeholder-slate-400 border border-slate-700 focus:border-sky-500 focus:outline-none text-sm"
            />
            <button type="submit" className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white">
              🔍
            </button>
          </form>
          {showSearch && (searchResults.products.length > 0 || searchResults.categories.length > 0 || searchResults.brands.length > 0) && (
            <div className="absolute top-full left-0 right-0 bg-white rounded-lg shadow-2xl border mt-1 z-50 max-h-96 overflow-y-auto animate-fade-in">
              {searchResults.categories.length > 0 && (
                <div className="p-3 border-b">
                  <p className="text-xs text-slate-500 font-semibold mb-1">CATEGORIAS</p>
                  {searchResults.categories.map((c: any) => (
                    <Link key={c.id} href={`/produtos?cat=${c.slug}`} onClick={() => setShowSearch(false)}
                      className="flex items-center gap-2 py-1 text-sm text-slate-700 hover:text-sky-600">
                      <span>{c.icon}</span> {c.name}
                    </Link>
                  ))}
                </div>
              )}
              {searchResults.brands.length > 0 && (
                <div className="p-3 border-b">
                  <p className="text-xs text-slate-500 font-semibold mb-1">MARCAS</p>
                  {searchResults.brands.map((b: any) => (
                    <Link key={b.id} href={`/produtos?brand=${b.slug}`} onClick={() => setShowSearch(false)}
                      className="block py-1 text-sm text-slate-700 hover:text-sky-600">{b.name}</Link>
                  ))}
                </div>
              )}
              {searchResults.products.length > 0 && (
                <div className="p-3">
                  <p className="text-xs text-slate-500 font-semibold mb-1">PRODUTOS</p>
                  {searchResults.products.map((p: any) => (
                    <Link key={p.id} href={`/produto/${p.slug}`} onClick={() => setShowSearch(false)}
                      className="flex items-center gap-3 py-2 text-sm text-slate-700 hover:text-sky-600 hover:bg-slate-50 rounded px-2">
                      <div className="w-10 h-10 bg-slate-100 rounded flex items-center justify-center text-lg">📦</div>
                      <div className="flex-1 min-w-0">
                        <p className="truncate font-medium">{p.name}</p>
                        <p className="text-sky-600 font-semibold">{parseFloat(p.price).toFixed(2)}€</p>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 sm:gap-3">
          <div className="relative">
            <button onClick={() => setShowUserMenu(!showUserMenu)}
              className="flex items-center gap-1 text-slate-300 hover:text-white transition text-sm p-2">
              <span className="text-lg">👤</span>
              <span className="hidden lg:block">{user ? user.name.split(" ")[0] : "Conta"}</span>
            </button>
            {showUserMenu && (
              <div className="absolute right-0 top-full mt-1 bg-white rounded-lg shadow-xl border w-48 z-50 animate-fade-in">
                {user ? (
                  <>
                    <div className="px-4 py-2 border-b text-sm text-slate-500">{user.name}</div>
                    {isStaffRole(user.role) && (
                      <Link href="/admin" className="block px-4 py-2 text-sm font-medium text-sky-700 hover:bg-sky-50 border-b" onClick={() => setShowUserMenu(false)}>⚙️ Backoffice</Link>
                    )}
                    <Link href="/conta" className="block px-4 py-2 text-sm text-slate-700 hover:bg-slate-50" onClick={() => setShowUserMenu(false)}>A Minha Conta</Link>
                    <Link href="/conta?tab=orders" className="block px-4 py-2 text-sm text-slate-700 hover:bg-slate-50" onClick={() => setShowUserMenu(false)}>Encomendas</Link>
                    <Link href="/conta?tab=wishlist" className="block px-4 py-2 text-sm text-slate-700 hover:bg-slate-50" onClick={() => setShowUserMenu(false)}>Favoritos</Link>
                    <button onClick={handleLogout} className="block w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50">Sair</button>
                  </>
                ) : (
                  <>
                    <Link href="/conta?tab=login" className="block px-4 py-2 text-sm text-slate-700 hover:bg-slate-50" onClick={() => setShowUserMenu(false)}>Iniciar Sessão</Link>
                    <Link href="/conta?tab=register" className="block px-4 py-2 text-sm text-slate-700 hover:bg-slate-50" onClick={() => setShowUserMenu(false)}>Criar Conta</Link>
                  </>
                )}
              </div>
            )}
          </div>

          <Link href="/conta?tab=wishlist" className="text-slate-300 hover:text-white p-2 text-lg">❤️</Link>

          <Link href="/carrinho" className="relative text-slate-300 hover:text-white p-2 text-lg">
            🛒
            {cartCount > 0 && (
              <span className="absolute -top-1 -right-1 bg-lime-500 text-slate-900 text-[10px] font-bold w-5 h-5 rounded-full flex items-center justify-center">{cartCount}</span>
            )}
          </Link>

          <button onClick={() => setMobileMenu(!mobileMenu)} className="md:hidden text-white text-xl p-2">☰</button>
        </div>
      </div>

      {/* Categories bar */}
      <nav className="hidden md:block bg-slate-800 border-t border-slate-700">
        <div className="max-w-7xl mx-auto px-4 flex items-center gap-1 h-10 overflow-x-auto hide-scrollbar">
          <Link href="/produtos" className="px-3 py-1 text-sm text-slate-300 hover:text-white hover:bg-slate-700 rounded transition whitespace-nowrap">Todos</Link>
          <Link href="/produtos?cat=computadores" className="px-3 py-1 text-sm text-slate-300 hover:text-white hover:bg-slate-700 rounded transition whitespace-nowrap">💻 Computadores</Link>
          <Link href="/produtos?cat=componentes" className="px-3 py-1 text-sm text-slate-300 hover:text-white hover:bg-slate-700 rounded transition whitespace-nowrap">🔧 Componentes</Link>
          <Link href="/produtos?cat=perifericos" className="px-3 py-1 text-sm text-slate-300 hover:text-white hover:bg-slate-700 rounded transition whitespace-nowrap">🖱️ Periféricos</Link>
          <Link href="/produtos?cat=redes" className="px-3 py-1 text-sm text-slate-300 hover:text-white hover:bg-slate-700 rounded transition whitespace-nowrap">🌐 Redes</Link>
          <Link href="/produtos?cat=armazenamento" className="px-3 py-1 text-sm text-slate-300 hover:text-white hover:bg-slate-700 rounded transition whitespace-nowrap">💾 Armazenamento</Link>
          <Link href="/produtos?cat=gaming" className="px-3 py-1 text-sm text-slate-300 hover:text-white hover:bg-slate-700 rounded transition whitespace-nowrap">🎮 Gaming</Link>
          <Link href="/produtos?cat=smartphones" className="px-3 py-1 text-sm text-slate-300 hover:text-white hover:bg-slate-700 rounded transition whitespace-nowrap">📱 Smartphones</Link>
          <Link href="/produtos?cat=servicos" className="px-3 py-1 text-sm text-brand-green hover:text-white hover:bg-slate-700 rounded transition whitespace-nowrap font-medium">🛠️ Serviços</Link>
          <Link href="/comparador" className="px-3 py-1 text-sm text-slate-300 hover:text-white hover:bg-slate-700 rounded transition whitespace-nowrap">📊 Comparador</Link>
        </div>
      </nav>

      {/* Mobile menu */}
      {mobileMenu && (
        <div className="md:hidden bg-slate-800 border-t border-slate-700 animate-fade-in">
          <div className="p-4 space-y-1">
            {[
              { href: "/produtos", label: "Todos os Produtos" },
              { href: "/produtos?cat=computadores", label: "💻 Computadores" },
              { href: "/produtos?cat=componentes", label: "🔧 Componentes" },
              { href: "/produtos?cat=perifericos", label: "🖱️ Periféricos" },
              { href: "/produtos?cat=redes", label: "🌐 Redes" },
              { href: "/produtos?cat=armazenamento", label: "💾 Armazenamento" },
              { href: "/produtos?cat=gaming", label: "🎮 Gaming" },
              { href: "/produtos?cat=servicos", label: "🛠️ Serviços" },
              { href: "/configurador", label: "🖥️ Configurador PC" },
              { href: "/smart-shopping", label: "🧠 Smart Shopping" },
              { href: "/comparador", label: "📊 Comparador" },
            ].map(item => (
              <Link key={item.href} href={item.href} onClick={() => setMobileMenu(false)}
                className="block py-2 px-3 text-sm text-slate-300 hover:text-white hover:bg-slate-700 rounded">{item.label}</Link>
            ))}
          </div>
        </div>
      )}
    </header>
  );
}
