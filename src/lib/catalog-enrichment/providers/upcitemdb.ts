import type { CatalogEnrichmentProvider, EnrichmentIdentity, EnrichmentProviderResult } from "./types";

const clean = (v: unknown) => typeof v === "string" && v.trim() ? v.trim() : null;
const compactEan = (v: unknown) => clean(v)?.replace(/\s+/g, "") ?? null;
const normalizedIdentity = (v: unknown) => clean(v)?.toUpperCase().replace(/[^A-Z0-9]/g, "") ?? null;
const httpsImages = (value: unknown) => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && /^https:\/\//i.test(v)).slice(0, 20) : [];

type UpcItem = Record<string, unknown>;
type UpcBody = { items?: UpcItem[] };

function retryAfter(response: Response) {
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  return Number.isFinite(reset) ? new Date(reset * 1000) : null;
}

function found(item: UpcItem, matchedBy: "ean_exact" | "manufacturer_mpn_exact", identity: EnrichmentIdentity): EnrichmentProviderResult {
  const title = clean(item.title);
  const description = clean(item.description);
  const brand = clean(item.brand);
  const model = clean(item.model);
  const matchedEan = compactEan(item.ean) ?? compactEan(item.upc);
  const attributes: Record<string, string> = {};
  if (brand) attributes["Marca (fonte externa)"] = brand;
  if (model) attributes["Modelo (fonte externa)"] = model;
  const sourceRefIdentity = matchedEan ?? normalizedIdentity(model) ?? normalizedIdentity(identity.manufacturerPartNumber) ?? "unknown";
  const images = httpsImages(item.images).map((url, index) => ({ url, alt: title, sourceRef: `upcitemdb:${sourceRefIdentity}:${index + 1}` }));
  return {
    status: "found",
    sourceUrl: matchedEan ? `https://www.upcitemdb.com/upc/${encodeURIComponent(matchedEan)}` : "https://www.upcitemdb.com/upc",
    shortDescription: title,
    description,
    attributes,
    images,
    matchedEan,
    matchedMpn: model,
    matchedBy,
    detail: matchedBy === "ean_exact" ? "EXACT_EAN_MATCH" : "EXACT_MANUFACTURER_MPN_MATCH",
  };
}

async function request(url: string): Promise<{ response: Response; body?: UpcBody }> {
  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "MDTech-Arena-Catalog-Enrichment/1.0" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) return { response };
  return { response, body: await response.json() as UpcBody };
}

/**
 * S35.4 discovery adapter.
 * 1) exact EAN lookup remains authoritative when an EAN exists;
 * 2) only after an EAN miss (or when EAN is absent), search may fall back to
 *    manufacturer + MPN; both normalized values must match exactly.
 * No fuzzy title matching and no commercial price/stock/category data enters
 * the Arena enrichment snapshot.
 */
export const upcItemDbProvider: CatalogEnrichmentProvider = {
  id: "upcitemdb",
  async lookup(identity: EnrichmentIdentity): Promise<EnrichmentProviderResult> {
    const ean = compactEan(identity.ean);
    const expectedMpn = normalizedIdentity(identity.manufacturerPartNumber);
    const expectedManufacturer = normalizedIdentity(identity.manufacturer);
    try {
      if (ean) {
        const { response, body } = await request(`https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(ean)}`);
        if (response.status === 429) return { status: "rate_limited", detail: "UPCITEMDB_RATE_LIMIT_LOOKUP", retryAfter: retryAfter(response) };
        if (!response.ok) return { status: "error", detail: `UPCITEMDB_LOOKUP_HTTP_${response.status}` };
        const items = Array.isArray(body?.items) ? body.items : [];
        const item = items.find(i => compactEan(i.ean) === ean || compactEan(i.upc) === ean);
        if (item) return found(item, "ean_exact", identity);
      }

      if (!expectedMpn || !expectedManufacturer) {
        return { status: "not_found", detail: ean ? "NO_EXACT_EAN_MATCH_AND_MPN_FALLBACK_UNAVAILABLE" : "IDENTITY_INSUFFICIENT" };
      }

      const params = new URLSearchParams({ s: clean(identity.manufacturerPartNumber)!, brand: clean(identity.manufacturer)! });
      const { response, body } = await request(`https://api.upcitemdb.com/prod/trial/search?${params.toString()}`);
      if (response.status === 429) return { status: "rate_limited", detail: "UPCITEMDB_RATE_LIMIT_SEARCH", retryAfter: retryAfter(response) };
      if (!response.ok) return { status: "error", detail: `UPCITEMDB_SEARCH_HTTP_${response.status}` };
      const items = Array.isArray(body?.items) ? body.items : [];
      const exact = items.filter(item => normalizedIdentity(item.model) === expectedMpn && normalizedIdentity(item.brand) === expectedManufacturer);
      if (exact.length !== 1) return { status: "not_found", detail: exact.length > 1 ? "AMBIGUOUS_EXACT_MANUFACTURER_MPN_MATCH" : "NO_EXACT_MANUFACTURER_MPN_MATCH" };
      return found(exact[0], "manufacturer_mpn_exact", identity);
    } catch (error) {
      return { status: "error", detail: error instanceof Error ? error.message.slice(0, 500) : "UPCITEMDB_UNKNOWN_ERROR" };
    }
  },
};
