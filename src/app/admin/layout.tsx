"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Logo from "@/components/Logo";

const navItems = [
  { href: "/admin", label: "Dashboard", icon: "📊" },
  { href: "/admin/products", label: "Produtos", icon: "📦" },
  { href: "/admin/categories", label: "Categorias", icon: "📁" },
  { href: "/admin/brands", label: "Marcas", icon: "🏷️" },
  { href: "/admin/inventory", label: "Inventário", icon: "📋" },
  { href: "/admin/pricing", label: "Preços automáticos", icon: "💶" },
  { href: "/admin/suppliers", label: "Fornecedores", icon: "🏭" },
  { href: "/admin/import", label: "Importar/Exportar", icon: "📥" },
  { href: "/admin/orders", label: "Encomendas", icon: "🧾" },
  { href: "/admin/customers", label: "Clientes", icon: "👥" },
  { href: "/admin/banners", label: "Banners", icon: "🖼️" },
  { href: "/admin/rma", label: "RMA", icon: "🔧" },
  { href: "/admin/settings", label: "Definições", icon: "⚙️" },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    fetch("/api/auth/me").then(r => r.json()).then(d => {
      if (!d.user || !["admin", "manager", "staff"].includes(d.user.role)) {
        router.push("/conta?tab=login");
      } else {
        setUser(d.user);
      }
      setLoading(false);
    });
  }, [router]);

  if (loading) return <div className="min-h-screen flex items-center justify-center text-slate-500">A verificar acesso...</div>;
  if (!user) return null;

  return (
    <div className="min-h-screen bg-slate-100 flex">
      {/* Mobile overlay */}
      {sidebarOpen && <div className="fixed inset-0 bg-black/50 z-40 lg:hidden" onClick={() => setSidebarOpen(false)} />}

      {/* Sidebar */}
      <aside className={`fixed lg:static inset-y-0 left-0 w-56 bg-slate-900 z-50 transform transition-transform lg:transform-none ${sidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"}`}>
        <div className="p-4 border-b border-slate-800">
          <Link href="/" className="block" aria-label="MDTech Solutions — página inicial">
            <Logo height={30} />
            <p className="text-white font-bold text-xs mt-2">Backoffice</p>
          </Link>
        </div>
        <nav className="p-2 space-y-0.5">
          {navItems.map(item => (
            <Link key={item.href} href={item.href} onClick={() => setSidebarOpen(false)}
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-slate-300 hover:bg-slate-800 hover:text-white transition">
              <span>{item.icon}</span> {item.label}
            </Link>
          ))}
        </nav>
        <div className="absolute bottom-0 w-full p-4 border-t border-slate-800">
          <Link href="/" className="block text-xs text-slate-500 hover:text-slate-300 mb-2">← Voltar à loja</Link>
          <p className="text-xs text-slate-600">{user.name}</p>
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 min-w-0">
        <header className="bg-white border-b h-14 flex items-center px-4 gap-4 sticky top-0 z-30">
          <button onClick={() => setSidebarOpen(!sidebarOpen)} className="lg:hidden text-xl">☰</button>
          <h1 className="text-sm font-semibold text-slate-700">Painel Administrativo</h1>
        </header>
        <div className="p-4 lg:p-6">{children}</div>
      </div>
    </div>
  );
}
