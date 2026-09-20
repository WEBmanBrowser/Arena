import Link from "next/link";

interface PageProps {
  searchParams: Promise<{ order?: string }>;
}

export default async function CheckoutFailurePage({ searchParams }: PageProps) {
  const { order } = await searchParams;

  return (
    <div className="max-w-3xl mx-auto px-4 py-16 text-center">
      <div className="bg-white rounded-2xl border p-8">
        <h1 className="text-2xl font-bold text-slate-800 mb-3">
          Pagamento não concluído
        </h1>

        {order && (
          <p className="text-slate-500 mb-4">
            Encomenda: <strong>{order}</strong>
          </p>
        )}

        <div className="max-w-md mx-auto mb-6 rounded-xl border border-amber-200 bg-amber-50 p-5">
          <p className="text-sm text-amber-800">
            O pagamento por cartão não foi concluído. A encomenda pode já estar
            registada, por isso não volte a criar uma nova encomenda.
          </p>
        </div>

        <p className="text-sm text-slate-600 mb-6">
          Consulte a sua área de cliente ou contacte-nos para verificar o estado
          da encomenda e concluir o pagamento.
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
