import type { CatalogEnrichmentProvider, EnrichmentIdentity, EnrichmentProviderResult } from "./types";

const clean = (v: unknown) => typeof v === "string" && v.trim() ? v.trim() : null;
const httpsImages = (value: unknown) => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && /^https:\/\//i.test(v)).slice(0, 20) : [];

/**
 * S35.3 discovery adapter. The public trial is intentionally conservative:
 * EAN-only, exact EAN validation, no fuzzy title matching, and no commercial
 * price/stock/category fields are returned to the Arena snapshot.
 */
export const upcItemDbProvider: CatalogEnrichmentProvider = {
  id: "upcitemdb",
  async lookup(identity: EnrichmentIdentity): Promise<EnrichmentProviderResult> {
    const ean = clean(identity.ean)?.replace(/\s+/g, "") ?? null;
    if (!ean) return { status: "not_found", detail: "EAN_MISSING" };
    try {
      const response = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(ean)}`, {
        headers: { Accept: "application/json", "User-Agent": "MDTech-Arena-Catalog-Enrichment/1.0" },
        signal: AbortSignal.timeout(12_000),
      });
      if (response.status === 429) {
        const reset = Number(response.headers.get("x-ratelimit-reset"));
        return { status: "rate_limited", detail: "UPCITEMDB_RATE_LIMIT", retryAfter: Number.isFinite(reset) ? new Date(reset * 1000) : null };
      }
      if (!response.ok) return { status: "error", detail: `UPCITEMDB_HTTP_${response.status}` };
      const body = await response.json() as { items?: Array<Record<string, unknown>> };
      const items = Array.isArray(body.items) ? body.items : [];
      const item = items.find(i => clean(i.ean)?.replace(/\s+/g, "") === ean || clean(i.upc)?.replace(/\s+/g, "") === ean);
      if (!item) return { status: "not_found", detail: "NO_EXACT_EAN_MATCH" };
      const title = clean(item.title);
      const description = clean(item.description);
      const brand = clean(item.brand);
      const model = clean(item.model);
      const attributes: Record<string, string> = {};
      if (brand) attributes["Marca (fonte externa)"] = brand;
      if (model) attributes["Modelo (fonte externa)"] = model;
      const images = httpsImages(item.images).map((url, index) => ({ url, alt: title, sourceRef: `upcitemdb:${ean}:${index + 1}` }));
      return { status: "found", sourceUrl: `https://www.upcitemdb.com/upc/${encodeURIComponent(ean)}`, shortDescription: title, description, attributes, images, matchedEan: ean, matchedMpn: model };
    } catch (error) {
      return { status: "error", detail: error instanceof Error ? error.message.slice(0, 500) : "UPCITEMDB_UNKNOWN_ERROR" };
    }
  },
};
