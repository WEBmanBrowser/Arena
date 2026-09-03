import Link from "next/link";
import Logo from "@/components/Logo";

export default function Footer() {
  return (
    <footer className="bg-slate-900 text-slate-400">
      <div className="max-w-7xl mx-auto px-4 py-12">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-8">
          <div>
            <div className="mb-4">
              <Logo height={44} />
            </div>
            <p className="text-sm mb-3">Marco Duarte Tech Solutions, Unipessoal Lda.</p>
            <p className="text-sm">📍 Esposende, Braga, Portugal</p>
            <p className="text-sm">📞 +351 917 801 898</p>
            <p className="text-sm">✉️ geral@mdtech.pt</p>
          </div>

          <div>
            <h3 className="text-white font-semibold mb-4 text-sm">LOJA</h3>
            <div className="space-y-2">
              <Link href="/produtos" className="block text-sm hover:text-white transition">Todos os Produtos</Link>
              <Link href="/produtos?cat=componentes" className="block text-sm hover:text-white transition">Componentes</Link>
              <Link href="/produtos?cat=perifericos" className="block text-sm hover:text-white transition">Periféricos</Link>
              <Link href="/produtos?cat=servicos" className="block text-sm hover:text-white transition">Serviços</Link>
              <Link href="/configurador" className="block text-sm hover:text-white transition">Configurador PC</Link>
              <Link href="/comparador" className="block text-sm hover:text-white transition">Comparador</Link>
            </div>
          </div>

          <div>
            <h3 className="text-white font-semibold mb-4 text-sm">CONTA</h3>
            <div className="space-y-2">
              <Link href="/conta" className="block text-sm hover:text-white transition">A Minha Conta</Link>
              <Link href="/conta?tab=orders" className="block text-sm hover:text-white transition">Encomendas</Link>
              <Link href="/conta?tab=wishlist" className="block text-sm hover:text-white transition">Favoritos</Link>
              <Link href="/conta?tab=rma" className="block text-sm hover:text-white transition">RMA / Assistência</Link>
            </div>
          </div>

          <div>
            <h3 className="text-white font-semibold mb-4 text-sm">INFORMAÇÕES</h3>
            <div className="space-y-2">
              <Link href="/pagina/sobre-nos" className="block text-sm hover:text-white transition">Sobre Nós</Link>
              <Link href="/pagina/politica-privacidade" className="block text-sm hover:text-white transition">Política de Privacidade</Link>
              <Link href="/pagina/termos-condicoes" className="block text-sm hover:text-white transition">Termos e Condições</Link>
              <Link href="/pagina/politica-cookies" className="block text-sm hover:text-white transition">Política de Cookies</Link>
              <Link href="/pagina/politica-devolucoes" className="block text-sm hover:text-white transition">Devoluções</Link>
              <Link href="/pagina/garantias" className="block text-sm hover:text-white transition">Garantias</Link>
            </div>
          </div>
        </div>

        <div className="border-t border-slate-800 mt-8 pt-6 flex flex-col sm:flex-row justify-between items-center gap-4">
          <p className="text-xs">© {new Date().getFullYear()} Marco Duarte Tech Solutions, Unipessoal Lda. Todos os direitos reservados.</p>
          <p className="text-xs">Preços com IVA incluído à taxa legal em vigor.</p>
        </div>
      </div>
    </footer>
  );
}
