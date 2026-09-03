/**
 * C.2 — Impact preview and safe mass application.
 *
 * The security-critical half of C.2: signed previews, staleness detection,
 * explicit consent for price decreases and absolute protection of manual
 * products.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { users, suppliers, brands, categories, products, pricingRules, productSuppliers, auditLogs } from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";

const getCurrentUserMock = vi.fn();
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getCurrentUser: () => getCurrentUserMock() };
});

import { POST as recalcPOST } from "@/app/api/admin/pricing/recalculate/route";
import { previewRecalculation, applyRecalculation } from "@/lib/services/pricing-recalc-service";
import { createRecalcToken } from "@/lib/bulk-pricing";

const TAG = "C2REC";
const MANAGER = { id: 9911, email: "c2rmgr@test.local", name: "M", role: "manager" };
const STAFF = { id: 9912, email: "c2rstaff@test.local", name: "S", role: "staff" };

let supplierId = 0, brandId = 0, catId = 0;
let originalSecret: string | undefined;

function post(body: unknown) {
  return new NextRequest("http://localhost/api/admin/pricing/recalculate", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

async function clean() {
  await db.execute(sql`DELETE FROM pricing_rules`);
  await db.execute(sql`DELETE FROM product_suppliers WHERE product_id IN (SELECT id FROM products WHERE sku LIKE ${TAG + "%"})`);
  await db.execute(sql`DELETE FROM products WHERE sku LIKE ${TAG + "%"}`);
}

beforeAll(async () => {
  originalSecret = process.env.BULK_PREVIEW_SECRET;
  process.env.BULK_PREVIEW_SECRET = "c2-test-secret-with-at-least-32-chars!!";
  for (const u of [MANAGER, STAFF]) {
    await db.insert(users).values({ id: u.id, email: u.email, password: "x", name: u.name, role: u.role }).onConflictDoNothing();
  }
  const [s] = await db.insert(suppliers).values({ name: `${TAG} Forn` }).returning();
  const [b] = await db.insert(brands).values({ name: `${TAG} Marca`, slug: `c2rec-b-${Date.now()}` }).returning();
  const [c] = await db.insert(categories).values({ name: `${TAG} Cat`, slug: `c2rec-c-${Date.now()}` }).returning();
  supplierId = s.id; brandId = b.id; catId = c.id;
});

beforeEach(async () => {
  getCurrentUserMock.mockReset();
  getCurrentUserMock.mockResolvedValue(MANAGER);
  await clean();
});

afterAll(async () => {
  await clean();
  await db.execute(sql`DELETE FROM suppliers WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM brands WHERE slug LIKE 'c2rec%'`);
  await db.execute(sql`DELETE FROM categories WHERE slug LIKE 'c2rec%'`);
  await db.execute(sql`DELETE FROM audit_logs WHERE user_id IN (${MANAGER.id}, ${STAFF.id})`);
  await db.execute(sql`DELETE FROM users WHERE id IN (${MANAGER.id}, ${STAFF.id})`);
  if (originalSecret === undefined) delete process.env.BULK_PREVIEW_SECRET;
  else process.env.BULK_PREVIEW_SECRET = originalSecret;
});

let seq = 0;
async function makeProduct(extra: Record<string, unknown> = {}) {
  seq += 1;
  const sku = `${TAG}-${Date.now()}-${seq}`;
  const [p] = await db.insert(products).values({
    name: sku, slug: sku.toLowerCase(), sku, price: "100.00", vatRate: "23.00",
    priceMode: "auto", ...extra,
  }).returning();
  return p;
}

async function makeGlobalRule(rate: number, extra: Record<string, unknown> = {}) {
  const [r] = await db.insert(pricingRules).values({
    scope: "global", method: "markup_on_cost", ratePercent: String(rate), roundingPolicy: "auto", ...extra,
  }).returning();
  return r;
}

describe("C.2 — saving a rule never moves prices on its own", () => {
  it("creating a rule leaves existing prices untouched", async () => {
    const p = await makeProduct({ costPrice: "10.00", price: "50.00" });
    await makeGlobalRule(20);
    const [after] = await db.select().from(products).where(eq(products.id, p.id));
    expect(after.price).toBe("50.00"); // only an explicit apply may change this
  });

  it("the preview writes nothing", async () => {
    const p = await makeProduct({ costPrice: "10.00", price: "50.00" });
    const rule = await makeGlobalRule(20);
    const preview = await previewRecalculation({ ruleId: rule.id });
    expect(preview.summary.affected).toBe(1);
    const [after] = await db.select().from(products).where(eq(products.id, p.id));
    expect(after.price).toBe("50.00");
  });
});

describe("C.2 — preview content", () => {
  it("reports every column the operator needs", async () => {
    await makeProduct({ costPrice: "10.00", price: "50.00" });
    const rule = await makeGlobalRule(20);
    const { lines } = await previewRecalculation({ ruleId: rule.id });
    const line = lines[0];
    expect(line.costPrice).toBe("10.00");
    expect(line.currentPrice).toBe("50.00");
    expect(line.mathematicalPrice).toBe("14.76");
    expect(line.newPrice).toBe("14.99");
    expect(line.diffCents).toBe(-3501);
    expect(line.diffPercent).toBeCloseTo(-70.02, 1);
    expect(line.realMarginPercent).toBeGreaterThan(0);
    expect(line.realMarkupPercent).toBeGreaterThan(20);
    expect(line.status).toBe("down");
  });

  it("names the winning rule so the price is explainable", async () => {
    const p = await makeProduct({ costPrice: "10.00", brandId });
    await db.insert(pricingRules).values({ scope: "brand", brandId, method: "markup_on_cost", ratePercent: "50" });
    const { lines } = await previewRecalculation({ productId: p.id });
    expect(lines[0].ruleLabel).toContain("Marca");
    expect(lines[0].ruleLabel).toContain(`${TAG} Marca`);
  });

  it("shows when a MORE specific rule wins over the one being analysed", async () => {
    const p = await makeProduct({ costPrice: "10.00", brandId });
    const general = await makeGlobalRule(20);
    await db.insert(pricingRules).values({ scope: "brand", brandId, method: "markup_on_cost", ratePercent: "50" });
    // Analysing the general rule still reports the brand rule as the winner.
    const { lines } = await previewRecalculation({ ruleId: general.id });
    const line = lines.find((l) => l.productId === p.id)!;
    expect(line.ruleLabel).toContain("Marca");
  });

  it("classifies manual, no-cost, no-rule and unchanged products", async () => {
    await makeProduct({ costPrice: "10.00", price: "99.00", priceMode: "manual" });
    await makeProduct({ costPrice: null, price: "99.00" });
    const priced = await makeProduct({ costPrice: "10.00", price: "14.99" });

    const noRule = await previewRecalculation({});
    expect(noRule.summary.noRule).toBeGreaterThanOrEqual(1);

    await makeGlobalRule(20);
    const withRule = await previewRecalculation({});
    expect(withRule.summary.manual).toBeGreaterThanOrEqual(1);
    expect(withRule.summary.noCost).toBeGreaterThanOrEqual(1);
    const sameLine = withRule.lines.find((l) => l.productId === priced.id)!;
    expect(sameLine.status).toBe("same");
    expect(withRule.summary.same).toBeGreaterThanOrEqual(1);
  });

  it("counts rises and falls separately", async () => {
    await makeProduct({ costPrice: "10.00", price: "5.00" });   // will rise
    await makeProduct({ costPrice: "10.00", price: "50.00" });  // will fall
    const rule = await makeGlobalRule(20);
    const { summary, requiresDecreaseConfirmation } = await previewRecalculation({ ruleId: rule.id });
    expect(summary.up).toBe(1);
    expect(summary.down).toBe(1);
    expect(summary.affected).toBe(2);
    expect(requiresDecreaseConfirmation).toBe(true);
  });

  it("returns no token when nothing would change", async () => {
    await makeProduct({ costPrice: "10.00", price: "14.99" });
    const rule = await makeGlobalRule(20);
    const preview = await previewRecalculation({ ruleId: rule.id });
    expect(preview.previewToken).toBeNull();
    expect(preview.requiresDecreaseConfirmation).toBe(false);
  });

  it("scopes the analysis to a brand rule's own products", async () => {
    const inBrand = await makeProduct({ costPrice: "10.00", brandId });
    await makeProduct({ costPrice: "10.00" }); // other brand
    const [rule] = await db.insert(pricingRules).values({ scope: "brand", brandId, method: "markup_on_cost", ratePercent: "20" }).returning();
    const { lines } = await previewRecalculation({ ruleId: rule.id });
    expect(lines).toHaveLength(1);
    expect(lines[0].productId).toBe(inBrand.id);
  });

  it("includes descendant categories for a parent category rule", async () => {
    const [child] = await db.insert(categories).values({ name: `${TAG} Sub`, slug: `c2rec-sub-${Date.now()}`, parentId: catId }).returning();
    const p = await makeProduct({ costPrice: "10.00", categoryId: child.id });
    const [rule] = await db.insert(pricingRules).values({ scope: "category", categoryId: catId, method: "markup_on_cost", ratePercent: "20" }).returning();
    const { lines } = await previewRecalculation({ ruleId: rule.id });
    expect(lines.map((l) => l.productId)).toContain(p.id);
    // Products reference the category, so clear them before removing it.
    await db.execute(sql`DELETE FROM products WHERE id = ${p.id}`);
    await db.execute(sql`DELETE FROM categories WHERE id = ${child.id}`);
  });

  it("scopes a supplier rule to its preferred products only", async () => {
    const p = await makeProduct({ costPrice: "10.00" });
    await db.insert(productSuppliers).values({ productId: p.id, supplierId, costPrice: "10.00", isPreferred: true });
    await makeProduct({ costPrice: "10.00" });
    const [rule] = await db.insert(pricingRules).values({ scope: "supplier", supplierId, method: "markup_on_cost", ratePercent: "20" }).returning();
    const { lines } = await previewRecalculation({ ruleId: rule.id });
    expect(lines).toHaveLength(1);
    expect(lines[0].productId).toBe(p.id);
  });
});

describe("C.2 — applying is safe", () => {
  it("applies the previewed prices", async () => {
    const p = await makeProduct({ costPrice: "10.00", price: "5.00" });
    const rule = await makeGlobalRule(20);
    const preview = await previewRecalculation({ ruleId: rule.id });
    const result = await applyRecalculation(preview.previewToken!, { userId: MANAGER.id });
    expect(result.updated).toBe(1);
    expect(result.up).toBe(1);
    const [after] = await db.select().from(products).where(eq(products.id, p.id));
    expect(after.price).toBe("14.99");
    expect(after.priceRuleId).toBe(rule.id);
    expect(after.priceCalculatedAt).not.toBeNull();
  });

  it("refuses decreases without explicit confirmation", async () => {
    await makeProduct({ costPrice: "10.00", price: "50.00" });
    const rule = await makeGlobalRule(20);
    const preview = await previewRecalculation({ ruleId: rule.id });
    await expect(applyRecalculation(preview.previewToken!, { userId: MANAGER.id }))
      .rejects.toThrow("RECALC_DECREASES_NOT_CONFIRMED");
  });

  it("applies decreases once confirmed", async () => {
    const p = await makeProduct({ costPrice: "10.00", price: "50.00" });
    const rule = await makeGlobalRule(20);
    const preview = await previewRecalculation({ ruleId: rule.id });
    const result = await applyRecalculation(preview.previewToken!, { userId: MANAGER.id, confirmDecreases: true });
    expect(result.down).toBe(1);
    const [after] = await db.select().from(products).where(eq(products.id, p.id));
    expect(after.price).toBe("14.99");
  });

  it("never touches manual products", async () => {
    const manual = await makeProduct({ costPrice: "10.00", price: "99.00", priceMode: "manual" });
    await makeProduct({ costPrice: "10.00", price: "5.00" });
    const rule = await makeGlobalRule(20);
    const preview = await previewRecalculation({ ruleId: rule.id });
    await applyRecalculation(preview.previewToken!, { userId: MANAGER.id });
    const [after] = await db.select().from(products).where(eq(products.id, manual.id));
    expect(after.price).toBe("99.00");
  });

  it("rejects a forged token", async () => {
    await expect(applyRecalculation("not-a-token", { userId: MANAGER.id })).rejects.toThrow("RECALC_PREVIEW_INVALID");
  });

  it("rejects a tampered token", async () => {
    const p = await makeProduct({ costPrice: "10.00", price: "5.00" });
    const rule = await makeGlobalRule(20);
    const preview = await previewRecalculation({ ruleId: rule.id });
    // Flip a character inside the signed payload.
    const decoded = Buffer.from(preview.previewToken!, "base64url").toString();
    const tampered = Buffer.from(decoded.replace("14.99", "99.99")).toString("base64url");
    await expect(applyRecalculation(tampered, { userId: MANAGER.id })).rejects.toThrow("RECALC_PREVIEW_INVALID");
    const [after] = await db.select().from(products).where(eq(products.id, p.id));
    expect(after.price).toBe("5.00");
  });

  it("rejects a token signed for a different payload shape (bulk token)", async () => {
    const { createPreviewToken } = await import("@/lib/bulk-pricing");
    const bulk = createPreviewToken("percent_increase", 10, [{ id: 1, price: "10.00" }]);
    await expect(applyRecalculation(bulk, { userId: MANAGER.id })).rejects.toThrow("RECALC_PREVIEW_INVALID");
  });

  it("rejects an expired token", async () => {
    const expired = createRecalcToken([{ i: 1, o: "10.00", n: "12.00", r: null }], 0);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 16 * 60 * 1000);
    await expect(applyRecalculation(expired, { userId: MANAGER.id })).rejects.toThrow("RECALC_PREVIEW_EXPIRED");
    vi.useRealTimers();
  });

  it("detects a concurrent price change between preview and apply", async () => {
    const p = await makeProduct({ costPrice: "10.00", price: "5.00" });
    const rule = await makeGlobalRule(20);
    const preview = await previewRecalculation({ ruleId: rule.id });
    // Someone else edits the price in the meantime.
    await db.update(products).set({ price: "7.77" }).where(eq(products.id, p.id));
    await expect(applyRecalculation(preview.previewToken!, { userId: MANAGER.id })).rejects.toThrow("RECALC_PREVIEW_STALE");
    const [after] = await db.select().from(products).where(eq(products.id, p.id));
    expect(after.price).toBe("7.77"); // the concurrent edit survives
  });

  it("detects a product switched to manual after the preview", async () => {
    const p = await makeProduct({ costPrice: "10.00", price: "5.00" });
    const rule = await makeGlobalRule(20);
    const preview = await previewRecalculation({ ruleId: rule.id });
    await db.update(products).set({ priceMode: "manual" }).where(eq(products.id, p.id));
    await expect(applyRecalculation(preview.previewToken!, { userId: MANAGER.id })).rejects.toThrow("RECALC_PREVIEW_STALE");
    const [after] = await db.select().from(products).where(eq(products.id, p.id));
    expect(after.price).toBe("5.00");
  });

  it("a token cannot be replayed after it was applied", async () => {
    await makeProduct({ costPrice: "10.00", price: "5.00" });
    const rule = await makeGlobalRule(20);
    const preview = await previewRecalculation({ ruleId: rule.id });
    await applyRecalculation(preview.previewToken!, { userId: MANAGER.id });
    // Prices moved, so the same token is now stale.
    await expect(applyRecalculation(preview.previewToken!, { userId: MANAGER.id })).rejects.toThrow("RECALC_PREVIEW_STALE");
  });

  it("applies many products in batches", async () => {
    for (let i = 0; i < 25; i += 1) await makeProduct({ costPrice: "10.00", price: "5.00" });
    const rule = await makeGlobalRule(20);
    const preview = await previewRecalculation({ ruleId: rule.id });
    const result = await applyRecalculation(preview.previewToken!, { userId: MANAGER.id });
    expect(result.updated).toBe(25);
    const rows = await db.select().from(products).where(and(eq(products.price, "14.99"), sql`sku LIKE ${TAG + "%"}`));
    expect(rows).toHaveLength(25);
  });

  it("writes an audit entry", async () => {
    await makeProduct({ costPrice: "10.00", price: "5.00" });
    const rule = await makeGlobalRule(20);
    const preview = await previewRecalculation({ ruleId: rule.id });
    await applyRecalculation(preview.previewToken!, { userId: MANAGER.id });
    const logs = await db.select().from(auditLogs).where(eq(auditLogs.action, "pricing.mass_recalculated"));
    expect(logs.length).toBeGreaterThan(0);
  });
});

describe("C.2 — recalculation route", () => {
  it("previews for staff but refuses to apply", async () => {
    await makeProduct({ costPrice: "10.00", price: "5.00" });
    const rule = await makeGlobalRule(20);
    getCurrentUserMock.mockResolvedValue(STAFF);

    const previewRes = await recalcPOST(post({ mode: "preview", ruleId: rule.id }));
    expect(previewRes.status).toBe(200);
    const preview = await previewRes.json();
    expect(preview.summary.affected).toBe(1);

    const applyRes = await recalcPOST(post({ mode: "apply", previewToken: preview.previewToken }));
    expect(applyRes.status).toBe(403);
  });

  it("managers can apply through the route", async () => {
    await makeProduct({ costPrice: "10.00", price: "5.00" });
    const rule = await makeGlobalRule(20);
    const preview = await (await recalcPOST(post({ mode: "preview", ruleId: rule.id }))).json();
    const res = await recalcPOST(post({ mode: "apply", previewToken: preview.previewToken }));
    expect(res.status).toBe(200);
    expect((await res.json()).updated).toBe(1);
  });

  it("returns 400 with a clear code when decreases are unconfirmed", async () => {
    await makeProduct({ costPrice: "10.00", price: "50.00" });
    const rule = await makeGlobalRule(20);
    const preview = await (await recalcPOST(post({ mode: "preview", ruleId: rule.id }))).json();
    const res = await recalcPOST(post({ mode: "apply", previewToken: preview.previewToken }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("RECALC_DECREASES_NOT_CONFIRMED");
  });

  it("returns 409 on a stale preview", async () => {
    const p = await makeProduct({ costPrice: "10.00", price: "5.00" });
    const rule = await makeGlobalRule(20);
    const preview = await (await recalcPOST(post({ mode: "preview", ruleId: rule.id }))).json();
    await db.update(products).set({ price: "6.00" }).where(eq(products.id, p.id));
    const res = await recalcPOST(post({ mode: "apply", previewToken: preview.previewToken }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("RECALC_PREVIEW_STALE");
  });

  it("rejects anonymous access and malformed bodies", async () => {
    getCurrentUserMock.mockResolvedValue(null);
    expect((await recalcPOST(post({ mode: "preview" }))).status).toBe(403);
    getCurrentUserMock.mockResolvedValue(MANAGER);
    expect((await recalcPOST(post({ mode: "nonsense" }))).status).toBe(400);
    expect((await recalcPOST(post({ mode: "apply" }))).status).toBe(400);
  });

  it("404s when previewing a rule that does not exist", async () => {
    const res = await recalcPOST(post({ mode: "preview", ruleId: 999999 }));
    expect(res.status).toBe(404);
  });
});
