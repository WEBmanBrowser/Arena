import { db } from "@/db";
import { pages } from "@/db/schema";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function PaginaPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [page] = await db.select().from(pages).where(eq(pages.slug, slug)).limit(1);
  if (!page) notFound();

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <nav className="text-xs text-slate-500 mb-6">
        <Link href="/" className="hover:text-sky-600">Início</Link>
        <span className="mx-1">›</span>
        <span className="text-slate-800">{page.title}</span>
      </nav>
      <h1 className="text-2xl font-bold text-slate-800 mb-6">{page.title}</h1>
      <div className="prose prose-sm max-w-none text-slate-600">
        <p>{page.content}</p>
      </div>
    </div>
  );
}
