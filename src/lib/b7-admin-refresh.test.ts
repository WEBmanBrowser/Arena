/**
 * B.7 — Staleness of the admin product listing after a mutation.
 *
 * Root cause was in the client: the products page reused a 300 ms debounced
 * effect for post-write reloads, so a saved product only appeared seconds
 * later (and the pending timer could be cancelled and restarted).
 *
 * These route-level tests pin the server half of the contract — a read issued
 * straight after a write must already observe it, with no caching layer in
 * between — so the fix cannot silently regress on the API side.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { sql } from "drizzle-orm";

const getCurrentUserMock = vi.fn();
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getCurrentUser: () => getCurrentUserMock() };
});

import { GET as productsGET, POST as productsPOST, PUT as productsPUT } from "@/app/api/admin/products/route";
import { GET as inventoryGET, POST as inventoryPOST } from "@/app/api/admin/inventory/route";

const MANAGER = { id: 9701, email: "b7@test.local", name: "B7", role: "manager", phone: null, nif: null, company: null };

// The route reads `req.nextUrl`, so a plain Request is not enough.
function getReq(qs: string) {
  return new NextRequest(`http://localhost/api/admin/products?${qs}`) as never;
}
function jsonReq(body: unknown) {
  return new NextRequest("http://localhost/api/admin/products", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as never;
}

/** audit_logs.user_id references users(id), so the impersonated user must exist. */
async function ensureManagerRow() {
  await db.insert(users).values({
    id: MANAGER.id, email: MANAGER.email, password: "x", name: MANAGER.name, role: "manager",
  }).onConflictDoNothing();
}

async function cleanup() {
  await db.execute(sql`DELETE FROM stock_movements WHERE product_id IN (SELECT id FROM products WHERE sku LIKE 'B7-%')`);
  await db.execute(sql`DELETE FROM products WHERE sku LIKE 'B7-%'`);
}

beforeEach(async () => {
  getCurrentUserMock.mockReset();
  getCurrentUserMock.mockResolvedValue(MANAGER);
  await cleanup();
});

beforeAll(ensureManagerRow);

afterAll(async () => {
  await cleanup();
  await db.execute(sql`DELETE FROM audit_logs WHERE user_id = ${MANAGER.id}`);
  await db.execute(sql`DELETE FROM users WHERE id = ${MANAGER.id}`);
});

// Both admin listings filter `q` on products.name, so the unique marker has to
// live in the name for the search-scoped assertions to work.
const newProduct = (marker: string, extra: Record<string, unknown> = {}) => ({
  name: marker, sku: marker, price: "100.00", stock: 5, minStock: 1, ...extra,
});

describe("B.7 — a write is immediately visible to the next read", () => {
  it("lists a product created moments earlier", async () => {
    const sku = `B7-NEW-${Date.now()}`;
    const created = await productsPOST(jsonReq(newProduct(sku)));
    expect(created.status).toBe(201);

    // No delay, no retry: the very next read must already see it.
    const listed = await (await productsGET(getReq(`q=${sku}`))).json();
    expect(listed.products).toHaveLength(1);
    expect(listed.products[0].sku).toBe(sku);
    expect(listed.total).toBe(1);
  });

  it("reflects an update (rename + reprice) on the next read", async () => {
    const marker = `B7-UPD-${Date.now()}`;
    const created = await (await productsPOST(jsonReq(newProduct(marker)))).json();

    const renamed = `${marker}-RENOMEADO`;
    const res = await productsPUT(jsonReq({ id: created.product.id, name: renamed, price: "149.99" }));
    expect(res.status).toBe(200);

    const listed = await (await productsGET(getReq(`q=${renamed}`))).json();
    expect(listed.products).toHaveLength(1);
    expect(listed.products[0].name).toBe(renamed);
    expect(listed.products[0].price).toBe("149.99");
  });

  it("reflects a stock adjustment on the next products read", async () => {
    // Stock is moved through the inventory route, not the products PUT; the
    // products listing must still show the new value straight away.
    const marker = `B7-STK-${Date.now()}`;
    const created = await (await productsPOST(jsonReq(newProduct(marker)))).json();

    const adj = new NextRequest("http://localhost/api/admin/inventory", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId: created.product.id, quantity: 37, type: "adjustment", reason: "B7 test" }),
    }) as never;
    expect((await inventoryPOST(adj)).status).toBe(200);

    const listed = await (await productsGET(getReq(`q=${marker}`))).json();
    expect(listed.products[0].stock).toBe(42); // 5 + 37
  });

  it("shows the product in BOTH products and inventory listings at once", async () => {
    // The reported symptom: visible in Inventário first, in Produtos only later.
    const sku = `B7-BOTH-${Date.now()}`;
    await productsPOST(jsonReq(newProduct(sku)));

    const inProducts = await (await productsGET(getReq(`q=${sku}`))).json();
    const inventoryReq = new NextRequest(`http://localhost/api/admin/inventory?q=${sku}`) as never;
    const inInventory = await (await inventoryGET(inventoryReq)).json();

    expect(inProducts.products).toHaveLength(1);
    expect(inInventory.products).toHaveLength(1);
    expect(inInventory.products[0].sku).toBe(inProducts.products[0].sku);
  });

  it("removes a deactivated product from the active filter immediately", async () => {
    const sku = `B7-DEACT-${Date.now()}`;
    const created = await (await productsPOST(jsonReq(newProduct(sku)))).json();

    expect((await (await productsGET(getReq(`q=${sku}&isActive=true`))).json()).products).toHaveLength(1);
    await productsPUT(jsonReq({ id: created.product.id, isActive: false }));
    expect((await (await productsGET(getReq(`q=${sku}&isActive=true`))).json()).products).toHaveLength(0);
    expect((await (await productsGET(getReq(`q=${sku}&isActive=false`))).json()).products).toHaveLength(1);
  });

  it("returns a fresh total on every call (no memoised count)", async () => {
    const prefix = `B7-CNT-${Date.now()}`;
    const first = await (await productsGET(getReq(`q=${prefix}`))).json();
    expect(first.total).toBe(0);

    await productsPOST(jsonReq(newProduct(`${prefix}-A`)));
    expect((await (await productsGET(getReq(`q=${prefix}`))).json()).total).toBe(1);

    await productsPOST(jsonReq(newProduct(`${prefix}-B`)));
    expect((await (await productsGET(getReq(`q=${prefix}`))).json()).total).toBe(2);
  });

  it("does not serve a stale body across repeated identical reads", async () => {
    const sku = `B7-REPEAT-${Date.now()}`;
    const created = await (await productsPOST(jsonReq(newProduct(sku, { price: "10.00" })))).json();

    const before = await (await productsGET(getReq(`q=${sku}`))).json();
    expect(before.products[0].price).toBe("10.00");

    await productsPUT(jsonReq({ id: created.product.id, price: "20.00" }));

    // Same URL as before — must not replay the earlier response.
    const after = await (await productsGET(getReq(`q=${sku}`))).json();
    expect(after.products[0].price).toBe("20.00");
  });
});

describe("B.7 — admin listing routes are dynamic by nature", () => {
  it("does not set any caching header on the response", async () => {
    const res = await productsGET(getReq("page=1"));
    expect(res.status).toBe(200);
    // A cache-control allowing reuse would reintroduce the staleness.
    const cc = res.headers.get("cache-control");
    expect(cc === null || /no-store|no-cache|max-age=0|private/.test(cc)).toBe(true);
  });
});
