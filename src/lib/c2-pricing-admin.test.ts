/**
 * C.2 — Pricing rule administration: CRUD, RBAC, validation and coverage.
 *
 * Route-level tests: they call the real API handlers, so authorization,
 * validation and constraint mapping are all exercised together.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { users, suppliers, brands, categories, products, pricingRules } from "@/db/schema";
import { eq, sql } from "drizzle-orm";

const getCurrentUserMock = vi.fn();
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getCurrentUser: () => getCurrentUserMock() };
});

import { GET as rulesGET, POST as rulesPOST, PUT as rulesPUT, DELETE as rulesDELETE } from "@/app/api/admin/pricing/rules/route";
import { GET as roundGET, PUT as roundPUT } from "@/app/api/admin/pricing/rounding/route";
import { ROUNDING_POLICY_KEY } from "@/lib/rounding-policy";
import { DEFAULT_ROUNDING_POLICY } from "@/lib/pricing-calculator";

const TAG = "C2ADM";
const MANAGER = { id: 9901, email: "c2mgr@test.local", name: "M", role: "manager" };
const STAFF = { id: 9902, email: "c2staff@test.local", name: "S", role: "staff" };
const CUSTOMER = { id: 9903, email: "c2cli@test.local", name: "C", role: "customer" };

let supplierId = 0, brandId = 0, rootCatId = 0, childCatId = 0, productId = 0;

function req(body: unknown) {
  return new NextRequest("http://localhost/api/admin/pricing/rules", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

async function cleanRules() {
  await db.execute(sql`DELETE FROM pricing_rules`);
}

beforeAll(async () => {
  for (const u of [MANAGER, STAFF, CUSTOMER]) {
    await db.insert(users).values({ id: u.id, email: u.email, password: "x", name: u.name, role: u.role }).onConflictDoNothing();
  }
  const [s] = await db.insert(suppliers).values({ name: `${TAG} Fornecedor` }).returning();
  const [b] = await db.insert(brands).values({ name: `${TAG} TP-Link`, slug: `c2adm-b-${Date.now()}` }).returning();
  const [root] = await db.insert(categories).values({ name: `${TAG} Redes`, slug: `c2adm-root-${Date.now()}` }).returning();
  const [child] = await db.insert(categories).values({ name: `${TAG} Routers`, slug: `c2adm-child-${Date.now()}`, parentId: root.id }).returning();
  const [p] = await db.insert(products).values({ name: `${TAG} P`, slug: `c2adm-p-${Date.now()}`, sku: `${TAG}-P1`, price: "10.00" }).returning();
  supplierId = s.id; brandId = b.id; rootCatId = root.id; childCatId = child.id; productId = p.id;
});

beforeEach(async () => {
  getCurrentUserMock.mockReset();
  getCurrentUserMock.mockResolvedValue(MANAGER);
  await cleanRules();
});

afterAll(async () => {
  await cleanRules();
  await db.execute(sql`DELETE FROM products WHERE sku LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM suppliers WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM brands WHERE slug LIKE 'c2adm%'`);
  await db.execute(sql`DELETE FROM categories WHERE slug LIKE 'c2adm%'`);
  await db.execute(sql`DELETE FROM audit_logs WHERE user_id IN (${MANAGER.id}, ${STAFF.id})`);
  await db.execute(sql`DELETE FROM users WHERE id IN (${MANAGER.id}, ${STAFF.id}, ${CUSTOMER.id})`);
  await db.execute(sql`DELETE FROM settings WHERE key = ${ROUNDING_POLICY_KEY}`);
});

const globalRule = { scope: "global", method: "markup_on_cost", ratePercent: 20, roundingPolicy: "auto", isActive: true };

describe("C.2 — CRUD of the general rule", () => {
  it("creates a general rule with priority 0 by default", async () => {
    const res = await rulesPOST(req(globalRule));
    expect(res.status).toBe(201);
    const { rule } = await res.json();
    expect(rule.scope).toBe("global");
    expect(rule.priority).toBe(0); // advanced option not exposed in the normal form
    expect(rule.isActive).toBe(true);
  });

  it("lists it with a friendly target name", async () => {
    await rulesPOST(req(globalRule));
    const { rules } = await (await rulesGET()).json();
    expect(rules).toHaveLength(1);
    expect(rules[0].targetName).toBe("Todos os produtos");
  });

  it("refuses a second ACTIVE general rule", async () => {
    await rulesPOST(req(globalRule));
    const res = await rulesPOST(req({ ...globalRule, ratePercent: 30 }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("RULE_ALREADY_EXISTS");
  });

  it("allows an inactive duplicate (history/draft)", async () => {
    await rulesPOST(req(globalRule));
    expect((await rulesPOST(req({ ...globalRule, ratePercent: 30, isActive: false }))).status).toBe(201);
  });

  it("updates the rate", async () => {
    const { rule } = await (await rulesPOST(req(globalRule))).json();
    const res = await rulesPUT(req({ ...globalRule, id: rule.id, ratePercent: 35 }));
    expect(res.status).toBe(200);
    expect(Number((await res.json()).rule.ratePercent)).toBe(35);
  });

  it("toggles without resending the whole rule", async () => {
    const { rule } = await (await rulesPOST(req(globalRule))).json();
    const res = await rulesPUT(req({ id: rule.id, isActive: false }));
    expect(res.status).toBe(200);
    expect((await res.json()).rule.isActive).toBe(false);
  });

  it("deletes a rule", async () => {
    const { rule } = await (await rulesPOST(req(globalRule))).json();
    expect((await rulesDELETE(req({ id: rule.id }))).status).toBe(200);
    expect(await db.select().from(pricingRules).where(eq(pricingRules.id, rule.id))).toHaveLength(0);
  });

  it("404s on updating or deleting a missing rule", async () => {
    expect((await rulesPUT(req({ ...globalRule, id: 999999, ratePercent: 10 }))).status).toBe(404);
    expect((await rulesDELETE(req({ id: 999999 }))).status).toBe(404);
  });
});

describe("C.2 — rules for every scope", () => {
  it("creates a supplier rule", async () => {
    const res = await rulesPOST(req({ ...globalRule, scope: "supplier", supplierId }));
    expect(res.status).toBe(201);
    const { rules } = await (await rulesGET()).json();
    expect(rules[0].targetName).toContain("Fornecedor");
  });

  it("creates a brand rule", async () => {
    expect((await rulesPOST(req({ ...globalRule, scope: "brand", brandId }))).status).toBe(201);
    const { rules } = await (await rulesGET()).json();
    expect(rules[0].targetName).toContain("TP-Link");
  });

  it("creates a category rule", async () => {
    expect((await rulesPOST(req({ ...globalRule, scope: "category", categoryId: childCatId }))).status).toBe(201);
    const { rules } = await (await rulesGET()).json();
    expect(rules[0].targetName).toContain("Routers");
  });

  it("creates a product rule", async () => {
    expect((await rulesPOST(req({ ...globalRule, scope: "product", productId }))).status).toBe(201);
  });

  it("creates a margin_on_sale rule", async () => {
    const res = await rulesPOST(req({ ...globalRule, method: "margin_on_sale", ratePercent: 30 }));
    expect(res.status).toBe(201);
    expect((await res.json()).rule.method).toBe("margin_on_sale");
  });

  it("orders the list by specificity so it reads like the resolution order", async () => {
    await rulesPOST(req(globalRule));
    await rulesPOST(req({ ...globalRule, scope: "supplier", supplierId }));
    await rulesPOST(req({ ...globalRule, scope: "brand", brandId }));
    await rulesPOST(req({ ...globalRule, scope: "category", categoryId: rootCatId }));
    await rulesPOST(req({ ...globalRule, scope: "product", productId }));
    const { rules } = await (await rulesGET()).json();
    expect(rules.map((r: { scope: string }) => r.scope)).toEqual(["product", "category", "brand", "supplier", "global"]);
  });

  it("puts an advanced-priority rule at the top of the list", async () => {
    await rulesPOST(req({ ...globalRule, scope: "product", productId }));
    await rulesPOST(req({ ...globalRule, scope: "supplier", supplierId, priority: 10 }));
    const { rules } = await (await rulesGET()).json();
    expect(rules[0].scope).toBe("supplier");
    expect(rules[0].priority).toBe(10);
  });
});

describe("C.2 — validation", () => {
  it("rejects a scope/target mismatch", async () => {
    const res = await rulesPOST(req({ ...globalRule, scope: "brand", productId }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("VALIDATION_ERROR");
  });

  it("rejects a global rule carrying a target", async () => {
    expect((await rulesPOST(req({ ...globalRule, brandId }))).status).toBe(400);
  });

  it("rejects margin_on_sale at 100% or above", async () => {
    expect((await rulesPOST(req({ ...globalRule, method: "margin_on_sale", ratePercent: 100 }))).status).toBe(400);
    expect((await rulesPOST(req({ ...globalRule, method: "margin_on_sale", ratePercent: 150 }))).status).toBe(400);
  });

  it("accepts a markup above 100% (legitimate)", async () => {
    expect((await rulesPOST(req({ ...globalRule, ratePercent: 250 }))).status).toBe(201);
  });

  it("rejects a negative rate and an unknown method", async () => {
    expect((await rulesPOST(req({ ...globalRule, ratePercent: -5 }))).status).toBe(400);
    expect((await rulesPOST(req({ ...globalRule, method: "nonsense" }))).status).toBe(400);
  });

  it("rejects unknown fields (strict schema)", async () => {
    expect((await rulesPOST(req({ ...globalRule, sneaky: true }))).status).toBe(400);
  });

  it("rejects a non-existent target with a clear error", async () => {
    const res = await rulesPOST(req({ ...globalRule, scope: "brand", brandId: 999999 }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("TARGET_NOT_FOUND");
  });

  it("accepts an optional minimum margin", async () => {
    const res = await rulesPOST(req({ ...globalRule, minMarginPercent: 15 }));
    expect(res.status).toBe(201);
    expect(Number((await res.json()).rule.minMarginPercent)).toBe(15);
  });
});

describe("C.2 — RBAC", () => {
  it("staff can read but not write", async () => {
    getCurrentUserMock.mockResolvedValue(STAFF);
    expect((await rulesGET()).status).toBe(200);
    expect((await rulesPOST(req(globalRule))).status).toBe(403);
    expect((await rulesPUT(req({ ...globalRule, id: 1, ratePercent: 5 }))).status).toBe(403);
    expect((await rulesDELETE(req({ id: 1 }))).status).toBe(403);
  });

  it("customers get nothing", async () => {
    getCurrentUserMock.mockResolvedValue(CUSTOMER);
    expect((await rulesGET()).status).toBe(403);
    expect((await rulesPOST(req(globalRule))).status).toBe(403);
  });

  it("anonymous users get nothing", async () => {
    getCurrentUserMock.mockResolvedValue(null);
    expect((await rulesGET()).status).toBe(403);
    expect((await rulesPOST(req(globalRule))).status).toBe(403);
    expect((await roundGET()).status).toBe(403);
  });
});

describe("C.2 — rounding policy configuration", () => {
  it("returns the default when nothing is stored", async () => {
    await db.execute(sql`DELETE FROM settings WHERE key = ${ROUNDING_POLICY_KEY}`);
    const { policy } = await (await roundGET()).json();
    expect(policy).toEqual(DEFAULT_ROUNDING_POLICY);
  });

  it("saves custom bands", async () => {
    const custom = { enabled: true, bands: [{ fromCents: 0, mode: "end_99" }, { fromCents: 10000, mode: "end_90" }, { fromCents: 50000, mode: "none" }] };
    const res = await roundPUT(req(custom));
    expect(res.status).toBe(200);
    expect((await res.json()).policy.bands).toHaveLength(3);
  });

  it("rejects bands that do not start at 0 (would leave a gap)", async () => {
    const res = await roundPUT(req({ enabled: true, bands: [{ fromCents: 5000, mode: "end_90" }] }));
    expect(res.status).toBe(400);
  });

  it("rejects duplicate/overlapping band boundaries", async () => {
    const res = await roundPUT(req({ enabled: true, bands: [{ fromCents: 0, mode: "end_99" }, { fromCents: 0, mode: "end_90" }] }));
    expect(res.status).toBe(400);
  });

  it("rejects an empty band list and a negative boundary", async () => {
    expect((await roundPUT(req({ enabled: true, bands: [] }))).status).toBe(400);
    expect((await roundPUT(req({ enabled: true, bands: [{ fromCents: -1, mode: "end_90" }] }))).status).toBe(400);
  });

  it("only managers may change it", async () => {
    getCurrentUserMock.mockResolvedValue(STAFF);
    expect((await roundGET()).status).toBe(200);
    expect((await roundPUT(req(DEFAULT_ROUNDING_POLICY))).status).toBe(403);
  });
});

describe("C.2 — catalogue coverage indicators", () => {
  it("reports no general rule when none exists", async () => {
    const { coverage } = await (await rulesGET()).json();
    expect(coverage.hasGlobalRule).toBe(false);
  });

  it("reports the general rule once created", async () => {
    await rulesPOST(req(globalRule));
    const { coverage } = await (await rulesGET()).json();
    expect(coverage.hasGlobalRule).toBe(true);
    expect(coverage.activeRules).toBeGreaterThan(0);
  });

  it("an inactive general rule does not count as coverage", async () => {
    await rulesPOST(req({ ...globalRule, isActive: false }));
    const { coverage } = await (await rulesGET()).json();
    expect(coverage.hasGlobalRule).toBe(false);
  });

  it("counts automatic, manual, without-cost and without-rule products", async () => {
    const stamp = Date.now();
    await db.insert(products).values([
      { name: `${TAG} auto`, slug: `c2cov-a-${stamp}`, sku: `${TAG}-COV-A`, price: "10.00", costPrice: "5.00", priceMode: "auto" },
      { name: `${TAG} manual`, slug: `c2cov-m-${stamp}`, sku: `${TAG}-COV-M`, price: "10.00", costPrice: "5.00", priceMode: "manual" },
      { name: `${TAG} nocost`, slug: `c2cov-n-${stamp}`, sku: `${TAG}-COV-N`, price: "10.00", costPrice: null, priceMode: "auto" },
    ]);

    let { coverage } = await (await rulesGET()).json();
    expect(coverage.manual).toBeGreaterThanOrEqual(1);
    expect(coverage.withoutCost).toBeGreaterThanOrEqual(1);
    // No rule at all yet → the costed automatic product is uncovered.
    expect(coverage.withoutRule).toBeGreaterThanOrEqual(1);

    await rulesPOST(req(globalRule));
    ({ coverage } = await (await rulesGET()).json());
    expect(coverage.withoutRule).toBe(0); // the general rule covers everything
    expect(coverage.ready).toBeGreaterThanOrEqual(1);

    await db.execute(sql`DELETE FROM products WHERE sku LIKE ${TAG + "-COV%"}`);
  });
});
