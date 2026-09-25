export type SmartProduct = {
  id: number;
  name: string;
  price: string | number;
  stock?: number | null;
  reservedStock?: number | null;
  supplierAvailableStock?: number | null;
  isActive?: boolean;
  isService?: boolean;
  isFeatured?: boolean;
  categoryId?: number | null;
  categorySlug?: string | null;
  tags?: string[] | null;
};

export type SmartProfile = {
  id: number;
  name: string;
  recommendedCategoryIds?: number[] | null;
  recommendedProductIds?: number[] | null;
};

export type SmartIntent = {
  categorySlugs: string[];
  tagHints: string[];
  configurator: boolean;
};

const PROFILE_INTENTS: Array<{ match: RegExp; intent: SmartIntent }> = [
  { match: /gaming/i, intent: { categorySlugs: ["computadores", "portateis", "monitores", "placas-graficas", "processadores"], tagHints: ["gaming", "gpu", "monitor"], configurator: true } },
  { match: /trabalhar|teletrabalho|casa/i, intent: { categorySlugs: ["portateis", "computadores", "monitores", "teclados", "ratos"], tagHints: ["office", "business", "monitor"], configurator: false } },
  { match: /melhorar|upgrade/i, intent: { categorySlugs: ["ssd", "memoria-ram", "placas-graficas", "processadores"], tagHints: ["ssd", "ram", "gpu", "cpu"], configurator: true } },
  { match: /wi-?fi|rede/i, intent: { categorySlugs: ["redes", "routers", "access-points"], tagHints: ["wifi", "router", "mesh", "network"], configurator: false } },
  { match: /armazenamento|storage/i, intent: { categorySlugs: ["ssd", "discos", "armazenamento", "nas"], tagHints: ["ssd", "hdd", "nas", "storage"], configurator: false } },
  { match: /empresa|empresarial/i, intent: { categorySlugs: ["computadores", "portateis", "monitores", "redes"], tagHints: ["business", "office", "professional"], configurator: false } },
];

export function intentForProfile(name: string): SmartIntent {
  return PROFILE_INTENTS.find((entry) => entry.match.test(name))?.intent ?? { categorySlugs: [], tagHints: [], configurator: false };
}

export function availableQuantity(product: SmartProduct) {
  const physical = Math.max(0, (product.stock ?? 0) - (product.reservedStock ?? 0));
  return physical + Math.max(0, product.supplierAvailableStock ?? 0);
}

export function recommendProducts(products: SmartProduct[], profile: SmartProfile, budget?: number | null, limit = 12) {
  const intent = intentForProfile(profile.name);
  const explicitProducts = new Set(profile.recommendedProductIds ?? []);
  const explicitCategories = new Set(profile.recommendedCategoryIds ?? []);
  const categorySlugs = new Set(intent.categorySlugs);
  const tagHints = new Set(intent.tagHints.map((v) => v.toLowerCase()));

  return products
    .filter((p) => p.isActive !== false && !p.isService && availableQuantity(p) > 0)
    .filter((p) => budget == null || Number(p.price) <= budget)
    .map((product) => {
      const tags = (product.tags ?? []).map((t) => t.toLowerCase());
      const explicitProduct = explicitProducts.has(product.id);
      const explicitCategory = product.categoryId != null && explicitCategories.has(product.categoryId);
      const categoryMatch = !!product.categorySlug && categorySlugs.has(product.categorySlug);
      const tagMatches = tags.filter((t) => tagHints.has(t)).length;
      const configuredProfile = explicitProducts.size > 0 || explicitCategories.size > 0;
      const relevant = explicitProduct || explicitCategory || (!configuredProfile && (categoryMatch || tagMatches > 0));
      if (!relevant) return null;
      let score = explicitProduct ? 1000 : 0;
      score += explicitCategory ? 300 : 0;
      score += categoryMatch ? 120 : 0;
      score += tagMatches * 25;
      score += product.isFeatured ? 8 : 0;
      score += Math.min(availableQuantity(product), 20) / 20;
      const reason = explicitProduct ? "Seleção MDTech para este objetivo" : explicitCategory ? "Categoria definida para este perfil" : categoryMatch ? "Categoria adequada ao objetivo" : "Características relacionadas com o objetivo";
      return { product, score, reason };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => b.score - a.score || Number(a.product.price) - Number(b.product.price) || a.product.id - b.product.id)
    .slice(0, limit);
}
