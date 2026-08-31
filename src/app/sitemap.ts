import type { MetadataRoute } from "next";
import { db } from "@/db";
import { categories, pages, products } from "@/db/schema";
import { eq } from "drizzle-orm";

function baseUrl(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || "https://loja.mdtech.pt").replace(/\/+$/, "");
}

// Always rendered at request time (products/pages change; build machine may
// not have database access).
export const dynamic = "force-dynamic";

/** Dynamic sitemap: static routes + active products + categories + published pages. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = baseUrl();
  const now = new Date();

  const staticEntries: MetadataRoute.Sitemap = [
    { url: `${base}/`, lastModified: now, changeFrequency: "daily", priority: 1 },
    { url: `${base}/produtos`, lastModified: now, changeFrequency: "daily", priority: 0.9 },
    { url: `${base}/comparador`, lastModified: now, changeFrequency: "weekly", priority: 0.6 },
    { url: `${base}/configurador`, lastModified: now, changeFrequency: "weekly", priority: 0.6 },
    { url: `${base}/smart-shopping`, lastModified: now, changeFrequency: "weekly", priority: 0.6 },
  ];

  try {
    const [productRows, categoryRows, pageRows] = await Promise.all([
      db.select({ slug: products.slug, updatedAt: products.updatedAt }).from(products).where(eq(products.isActive, true)).limit(5000),
      db.select({ slug: categories.slug }).from(categories).limit(500),
      db.select({ slug: pages.slug, updatedAt: pages.updatedAt }).from(pages).where(eq(pages.isPublished, true)).limit(500),
    ]);

    return [
      ...staticEntries,
      ...productRows.map(p => ({ url: `${base}/produto/${p.slug}`, lastModified: p.updatedAt, changeFrequency: "weekly" as const, priority: 0.8 })),
      ...categoryRows.map(c => ({ url: `${base}/produtos?categoria=${c.slug}`, lastModified: now, changeFrequency: "weekly" as const, priority: 0.7 })),
      ...pageRows.map(p => ({ url: `${base}/pagina/${p.slug}`, lastModified: p.updatedAt, changeFrequency: "monthly" as const, priority: 0.5 })),
    ];
  } catch (e) {
    console.error("sitemap generation failed:", e);
    return staticEntries;
  }
}
