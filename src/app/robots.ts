import type { MetadataRoute } from "next";

function baseUrl(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || "https://loja.mdtech.pt").replace(/\/+$/, "");
}

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/admin", "/api", "/conta", "/carrinho", "/checkout"],
      },
    ],
    sitemap: `${baseUrl()}/sitemap.xml`,
  };
}
