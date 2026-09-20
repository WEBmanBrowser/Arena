import Link from "next/link";

interface PageProps {
  searchParams: Promise<{ order?: string }>;
}

export default async function CheckoutSuccessPage({ searchParams }: PageProps) {
  const { order } = await searchParams;

  return (
    <div className="max-w-3xl mx-auto px-4 py-16 text-center">
      <div className="bg-white rounded-2xl border p-8">
        <h1 className="text-2xl font-bold text-slate-800 mb-3">
          Pagamento submetido
        </h1>

        {order && (
          <p className="text-slate-500 mb-4">
            Encomenda: <strong>{order}</strong>
          </p>
        )}

        <div className="inline-block px-3 py-1 rounded-full text-sm font-medium bg-amber-50 text-amber-700 mb-5">
          A aguardar confirmação do pagamento
        </div>

        <p className="text-sm text-slate-600 mb-6">
          Regressou da página de pagamento. A confirmação final será processada
          automaticamente assim que recebermos a notifica??o do pagamento.
        </p>

        <Link
          href="/"
          className="inline-block px-6 py-3 bg-sky-600 text-white rounded-lg font-medium hover:bg-sky-700 transition"
        >
          Voltar a Loja
        </Link>
      </div>
    </div>
  );
}
