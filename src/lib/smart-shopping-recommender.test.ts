import { describe, expect, it } from "vitest";
import { availableQuantity, intentForProfile, recommendProducts } from "./smart-shopping-recommender";

const profile = { id: 1, name: "Quero um PC para Gaming", recommendedCategoryIds: [], recommendedProductIds: [] };
const base = { isActive: true, isService: false, reservedStock: 0, supplierAvailableStock: 0, tags: [] as string[] };

describe("S37 Smart Shopping recommender", () => {
  it("uses physical and supplier availability", () => {
    expect(availableQuantity({ id: 1, name: "x", price: "1", stock: 2, reservedStock: 1, supplierAvailableStock: 3 })).toBe(4);
  });
  it("excludes unavailable products", () => {
    expect(recommendProducts([{ ...base, id: 1, name: "GPU", price: "300", stock: 0, categorySlug: "placas-graficas" }], profile)).toHaveLength(0);
  });
  it("respects the maximum budget", () => {
    expect(recommendProducts([{ ...base, id: 1, name: "GPU", price: "600", stock: 1, categorySlug: "placas-graficas" }], profile, 500)).toHaveLength(0);
  });
  it("prioritizes explicit profile products", () => {
    const configured = { ...profile, recommendedProductIds: [2] };
    const result = recommendProducts([
      { ...base, id: 1, name: "GPU A", price: "200", stock: 1, categorySlug: "placas-graficas" },
      { ...base, id: 2, name: "GPU B", price: "300", stock: 1, categorySlug: "outros" },
    ], configured);
    expect(result.map((r) => r.product.id)).toEqual([2]);
  });
  it("uses configured categories instead of fallback intent categories", () => {
    const configured = { ...profile, recommendedCategoryIds: [99] };
    const result = recommendProducts([
      { ...base, id: 1, name: "GPU", price: "200", stock: 1, categoryId: 1, categorySlug: "placas-graficas" },
      { ...base, id: 2, name: "Chosen", price: "300", stock: 1, categoryId: 99, categorySlug: "outros" },
    ], configured);
    expect(result.map((r) => r.product.id)).toEqual([2]);
  });
  it("does not recommend services", () => {
    expect(recommendProducts([{ ...base, id: 1, name: "Service", price: "20", stock: 1, isService: true, categorySlug: "computadores" }], profile)).toHaveLength(0);
  });
  it("marks PC gaming and upgrade profiles for the compatibility configurator", () => {
    expect(intentForProfile("Quero um PC para Gaming").configurator).toBe(true);
    expect(intentForProfile("Quero melhorar o meu PC").configurator).toBe(true);
  });
});
