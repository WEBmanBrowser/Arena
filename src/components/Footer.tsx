import Image from "next/image";
import Link from "next/link";
import Logo from "@/components/Logo";

const ANYDESK_DOWNLOAD_URL = "https://anydesk.com/pt/downloads/windows";
const LIVRO_RECLAMACOES_URL = "https://www.livroreclamacoes.pt/inicio/";

export default function Footer() {
  return (
    <footer className="bg-slate-900 text-slate-400">
      <div className="max-w-7xl mx-auto px-4 py-12">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-8">
          <div>
            <div className="mb-4">
              <Logo height={44} />
            </div>
            <p className="text-sm mb-3">Marco Duarte Tech Solutions Unipessoal Lda</p>
            <p className="text-sm">📍 Rua Sargento Álvaro Fernandes, n.º 7, 2.º B, 4740-567 Esposende</p>
            <p className="text-sm">NIPC: 519 445 902</p>
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
            <h3 className="text-white font-semibold mb-4 text-sm">CONTA E SUPORTE</h3>
            <div className="space-y-2">
              <Link href="/conta" className="block text-sm hover:text-white transition">A Minha Conta</Link>
              <Link href="/conta?tab=orders" className="block text-sm hover:text-white transition">Encomendas</Link>
              <Link href="/conta?tab=wishlist" className="block text-sm hover:text-white transition">Favoritos</Link>
              <Link href="/conta?tab=rma" className="block text-sm hover:text-white transition">RMA / Assistência</Link>
            </div>

            <div className="mt-5">
              <a
                href={ANYDESK_DOWNLOAD_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-lg bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-400 focus:ring-offset-2 focus:ring-offset-slate-900"
                aria-label="Acesso Remoto — descarregar AnyDesk numa nova janela"
              >
                <span aria-hidden="true">🖥️</span>
                Acesso Remoto
              </a>
              <p className="mt-2 max-w-xs text-xs leading-relaxed text-slate-500">
                Descarregue o AnyDesk e forneça o ID apenas quando estiver em contacto com a MDTech Solutions.
              </p>
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
              <Link href="/pagina/resolucao-litigios" className="block text-sm hover:text-white transition">Resolução de Litígios</Link>
              <a href={LIVRO_RECLAMACOES_URL} target="_blank" rel="noopener noreferrer" className="block text-sm hover:text-white transition">Livro de Reclamações</a>
              <a href="https://ciab.pt/" target="_blank" rel="noopener noreferrer" className="block text-sm hover:text-white transition">CIAB — Tribunal Arbitral de Consumo</a>
            </div>

            <a
              href={LIVRO_RECLAMACOES_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-5 inline-block rounded focus:outline-none focus:ring-2 focus:ring-white focus:ring-offset-2 focus:ring-offset-slate-900"
              aria-label="Livro de Reclamações Eletrónico — abrir portal oficial numa nova janela"
            >
              <Image
                src="/legal/livro-reclamacoes-eletronico.png"
                alt="Livro de Reclamações"
                width={140}
                height={58}
                className="h-[58px] w-[140px]"
              />
            </a>
          </div>
        </div>

        <div className="border-t border-slate-800 mt-8 pt-6 flex flex-col sm:flex-row justify-between items-center gap-4">
          <p className="text-xs">© {new Date().getFullYear()} Marco Duarte Tech Solutions Unipessoal Lda Todos os direitos reservados.</p>
          <p className="text-xs">Preços com IVA incluído à taxa legal em vigor.</p>
        </div>
      </div>
    </footer>
  );
}
