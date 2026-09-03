/**
 * B.6 — Bulk pricing preview/apply response contract.
 *
 * The admin modal previously read `data.preview`, but the API returns
 * `results`, so the preview table was always empty and the operator confirmed
 * a price change blindly. These tests pin the field names the UI depends on.
 *
 * The pricing engine itself (bulk-pricing.ts) is NOT modified — only consumed.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { products } from "@/db/schema";
import { eq, sql } from "drizzle-orm";

const getCurrentUserMock = vi.fn();
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getCurrentUser: () => getCurrentUserMock() };
});

import { POST as bulkPOST } from "@/app/api/admin/bulk/route";

const MANAGER = { id: 9621, email: "b6-bulk@test.local", name: "B6 Bulk", role: "manager", phone: null, nif: null, company: null };

let prevSecret: string | undefined;
let productId = 0;

function req(body: unknown) {
  return new Request("http://localhost/api/admin/bulk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as never;
}

async function cleanup() {
  await db.execute(sql`DELETE FROM products WHERE sku LIKE 'B6BULK-%'`);
}

beforeEach(async () => {
  getCurrentUserMock.mockReset();
  getCurrentUserMock.mockResolvedValue(MANAGER);
  prevSecret = process.env.BULK_PREVIEW_SECRET;
  // Test-only HMAC key for preview tokens; not a real secret.
  process.env.BULK_PREVIEW_SECRET = "b6-test-only-bulk-preview-secret-0123456789";
  await cleanup();
  const [p] = await db.insert(products).values({
    name: "B6BULK Produto", slug: `b6bulk-${Date.now()}`, sku: `B6BULK-${Date.now()}`,
    price: "100.00", vatRate: "23.00",
  }).returning();
  productId = p.id;
});

afterAll(async () => {
  if (prevSecret === undefined) delete process.env.BULK_PREVIEW_SECRET;
  else process.env.BULK_PREVIEW_SECRET = prevSecret;
  await cleanup();
});

const previewBody = (op: string, value: number) => ({
  action: "price_update", mode: "preview",
  target: { type: "selection", productIds: [productId] },
  operation: op, value,
});

describe("B.6 — preview response shape consumed by the modal", () => {
  it("returns results / previewToken / productCount", async () => {
    const res = await bulkPOST(req(previewBody("percent_increase", 10)));
    expect(res.status).toBe(200);
    const data = await res.json();

    // Exact field names the UI reads.
    expect(Array.isArray(data.results)).toBe(true);
    expect(typeof data.previewToken).toBe("string");
    expect(data.productCount).toBe(1);
    // Guards against reintroducing the old, wrong field name.
    expect(data.preview).toBeUndefined();
  });

  it("each row carries the columns rendered in the preview table", async () => {
    const data = await (await bulkPOST(req(previewBody("percent_increase", 10)))).json();
    const row = data.results[0];
    expect(row).toMatchObject({ productId, name: "B6BULK Produto", currentPrice: "100.00", newPrice: "110.00" });
    expect(row.diffCents).toBe(1000);
    expect(row.invalid).toBe(false);
    expect(row.sku).toContain("B6BULK-");
  });

  it("computes a decrease server-side", async () => {
    const data = await (await bulkPOST(req(previewBody("percent_decrease", 25)))).json();
    expect(data.results[0].newPrice).toBe("75.00");
    expect(data.results[0].diffCents).toBe(-2500);
  });

  it("computes fixed operations server-side", async () => {
    const inc = await (await bulkPOST(req(previewBody("fixed_increase", 2.5)))).json();
    expect(inc.results[0].newPrice).toBe("102.50");
    const dec = await (await bulkPOST(req(previewBody("fixed_decrease", 0.5)))).json();
    expect(dec.results[0].newPrice).toBe("99.50");
  });

  it("does NOT change any price at preview time", async () => {
    await bulkPOST(req(previewBody("percent_increase", 50)));
    const [p] = await db.select().from(products).where(eq(products.id, productId));
    expect(p.price).toBe("100.00");
  });

  it("refuses an operation that would produce a negative price", async () => {
    const res = await bulkPOST(req(previewBody("fixed_decrease", 500)));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("NEGATIVE_RESULTING_PRICE");
  });
});

describe("B.6 — apply is token-driven and reports what it changed", () => {
  it("applies exactly the previewed price and returns `updated`", async () => {
    const preview = await (await bulkPOST(req(previewBody("percent_increase", 10)))).json();

    const res = await bulkPOST(req({ action: "price_update", mode: "apply", previewToken: preview.previewToken }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.updated).toBe(1);

    const [p] = await db.select().from(products).where(eq(products.id, productId));
    expect(p.price).toBe("110.00");
  });

  it("leaves cost, VAT and stock untouched", async () => {
    const [before] = await db.select().from(products).where(eq(products.id, productId));
    const preview = await (await bulkPOST(req(previewBody("percent_increase", 10)))).json();
    await bulkPOST(req({ action: "price_update", mode: "apply", previewToken: preview.previewToken }));
    const [after] = await db.select().from(products).where(eq(products.id, productId));

    expect(after.costPrice).toBe(before.costPrice);
    expect(after.vatRate).toBe(before.vatRate);
    expect(after.stock).toBe(before.stock);
    expect(after.comparePrice).toBe(before.comparePrice);
  });

  it("rejects a stale preview when the price changed meanwhile", async () => {
    const preview = await (await bulkPOST(req(previewBody("percent_increase", 10)))).json();
    await db.update(products).set({ price: "123.00" }).where(eq(products.id, productId));

    const res = await bulkPOST(req({ action: "price_update", mode: "apply", previewToken: preview.previewToken }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("BULK_PREVIEW_STALE");

    const [p] = await db.select().from(products).where(eq(products.id, productId));
    expect(p.price).toBe("123.00"); // unchanged by the refused apply
  });

  it("rejects a forged token", async () => {
    const res = await bulkPOST(req({ action: "price_update", mode: "apply", previewToken: "not-a-valid-token" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("BULK_PREVIEW_INVALID");
  });

  it("cannot be told which price to set — only the token decides", async () => {
    const preview = await (await bulkPOST(req(previewBody("percent_increase", 10)))).json();
    // A malicious client adding its own price must not influence the outcome.
    await bulkPOST(req({ action: "price_update", mode: "apply", previewToken: preview.previewToken, newPrice: "1.00", value: 90 }));
    const [p] = await db.select().from(products).where(eq(products.id, productId));
    expect(p.price).toBe("110.00");
  });
});
