export type EnrichmentIdentity = {
  ean: string | null;
  manufacturerPartNumber: string | null;
  manufacturer: string | null;
};

export type EnrichmentProviderResult = {
  status: "found" | "not_found" | "rate_limited" | "error";
  sourceUrl?: string | null;
  shortDescription?: string | null;
  description?: string | null;
  attributes?: Record<string, string>;
  images?: Array<{ url: string; alt?: string | null; sourceRef?: string | null }>;
  matchedEan?: string | null;
  matchedMpn?: string | null;
  detail?: string | null;
  retryAfter?: Date | null;
};

export interface CatalogEnrichmentProvider {
  readonly id: "upcitemdb";
  lookup(identity: EnrichmentIdentity): Promise<EnrichmentProviderResult>;
}
