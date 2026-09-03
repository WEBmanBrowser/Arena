/**
 * B.6 — Product ↔ Supplier route behaviour backing the new admin UI.
 *
 * These exercise the EXISTING /api/admin/products/[id]/suppliers endpoints
 * against real PostgreSQL, so the UI is built on verified behaviour:
 *  - link / list / update / unlink;
 *  - preferred supplier is exclusive per product;
 *  - products.costPrice is synced from the preferred supplier (server rule);
 *  - duplicate links are refused;
 *  - product CRUD is unaffected (regression guard).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { products, suppliers, productSuppliers } from "@/db/schema";
import { eq, sql } from "drizzle-orm";

const getCurrentUserMock = vi.fn();
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getCurrentUser: () => getCurrentUserMock() };
});

import {
  GET as suppliersGET,
  POST as suppliersPOST,
  PUT as suppliersPUT,
  DELETE as suppliersDELETE,
} from "@/app/api/admin/products/[id]/suppliers/route";

const MANAGER = { id: 9611, email: "b6-ps-manager@test.local", name: "B6 Manager", role: "manager", phone: null, nif: null, company: null };

let productId = 0;
let supplierA = 0;
let supplierB = 0;

function req(body: unknown) {
  return new Request("http://localhost/api/admin/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as never;
}

const ctx = () => ({ params: Promise.resolve({ id: String(productId) }) });

async function cleanup() {
  await db.execute(sql`DELETE FROM product_suppliers WHERE product_id IN (SELECT id FROM products WHERE sku LIKE 'B6PS-%')`);
  await db.execute(sql`DELETE FROM products WHERE sku LIKE 'B6PS-%'`);
  await db.execute(sql`DELETE FROM suppliers WHERE name LIKE 'B6PS %'`);
}

beforeEach(async () => {
  getCurrentUserMock.mockReset();
  getCurrentUserMock.mockResolvedValue(MANAGER);
  await cleanup();

  const [p] = await db.insert(products).values({
    name: "B6PS Produto", slug: `b6ps-produto-${Date.now()}`, sku: `B6PS-${Date.now()}`,
    price: "100.00", vatRate: "23.00",
  }).returning();
  productId = p.id;

  const [a] = await db.insert(suppliers).values({ name: "B6PS Fornecedor A" }).returning();
  const [b] = await db.insert(suppliers).values({ name: "B6PS Fornecedor B" }).returning();
  supplierA = a.id;
  supplierB = b.id;
});

afterAll(cleanup);

describe("B.6 — product supplier linking", () => {
  it("starts with no suppliers linked", async () => {
    const res = await suppliersGET({} as never, ctx());
    expect(res.status).toBe(200);
    expect((await res.json()).suppliers).toHaveLength(0);
  });

  it("links a supplier with the fields the UI sends", async () => {
    const res = await suppliersPOST(req({ supplierId: supplierA, supplierSku: "REF-A1", costPrice: "42.50", leadTimeDays: 3, isPreferred: false }), ctx());
    expect(res.status).toBe(201);

    const rows = (await (await suppliersGET({} as never, ctx())).json()).suppliers;
    expect(rows).toHaveLength(1);
    expect(rows[0].supplierName).toBe("B6PS Fornecedor A");
    expect(rows[0].supplierSku).toBe("REF-A1");
    expect(rows[0].costPrice).toBe("42.50");
    expect(rows[0].leadTimeDays).toBe(3);
    expect(rows[0].isPreferred).toBe(false);
  });

  it("accepts null optional fields (empty inputs in the UI)", async () => {
    const res = await suppliersPOST(req({ supplierId: supplierA, supplierSku: null, costPrice: null, leadTimeDays: null, isPreferred: false }), ctx());
    expect(res.status).toBe(201);
    const rows = (await (await suppliersGET({} as never, ctx())).json()).suppliers;
    expect(rows[0].supplierSku).toBeNull();
    expect(rows[0].costPrice).toBeNull();
  });

  it("refuses linking the same supplier twice", async () => {
    await suppliersPOST(req({ supplierId: supplierA }), ctx());
    const res = await suppliersPOST(req({ supplierId: supplierA }), ctx());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("PRODUCT_SUPPLIER_ALREADY_EXISTS");
  });

  it("syncs products.costPrice from the preferred supplier", async () => {
    await suppliersPOST(req({ supplierId: supplierA, costPrice: "55.00", isPreferred: true }), ctx());
    const [p] = await db.select().from(products).where(eq(products.id, productId));
    expect(p.costPrice).toBe("55.00");
  });

  it("keeps the preferred supplier exclusive and re-syncs the cost", async () => {
    await suppliersPOST(req({ supplierId: supplierA, costPrice: "55.00", isPreferred: true }), ctx());
    await suppliersPOST(req({ supplierId: supplierB, costPrice: "31.00", isPreferred: true }), ctx());

    const rows = (await (await suppliersGET({} as never, ctx())).json()).suppliers;
    expect(rows.filter((r: { isPreferred: boolean }) => r.isPreferred)).toHaveLength(1);
    expect(rows.find((r: { isPreferred: boolean }) => r.isPreferred).supplierId).toBe(supplierB);

    const [p] = await db.select().from(products).where(eq(products.id, productId));
    expect(p.costPrice).toBe("31.00");
  });

  it("promotes an existing link to preferred via PUT (the UI's Preferencial button)", async () => {
    await suppliersPOST(req({ supplierId: supplierA, costPrice: "10.00", isPreferred: true }), ctx());
    await suppliersPOST(req({ supplierId: supplierB, costPrice: "20.00" }), ctx());
    const rows = (await (await suppliersGET({} as never, ctx())).json()).suppliers;
    const linkB = rows.find((r: { supplierId: number }) => r.supplierId === supplierB);

    const res = await suppliersPUT(req({ psId: linkB.id, isPreferred: true }), ctx());
    expect(res.status).toBe(200);

    const [p] = await db.select().from(products).where(eq(products.id, productId));
    expect(p.costPrice).toBe("20.00");
  });

  it("records the previous cost when the cost changes", async () => {
    await suppliersPOST(req({ supplierId: supplierA, costPrice: "10.00" }), ctx());
    const before = (await (await suppliersGET({} as never, ctx())).json()).suppliers[0];
    await suppliersPUT(req({ psId: before.id, costPrice: "12.00" }), ctx());
    const after = (await (await suppliersGET({} as never, ctx())).json()).suppliers[0];
    expect(after.costPrice).toBe("12.00");
    expect(after.lastCostPrice).toBe("10.00");
  });

  it("unlinks a supplier", async () => {
    await suppliersPOST(req({ supplierId: supplierA }), ctx());
    const row = (await (await suppliersGET({} as never, ctx())).json()).suppliers[0];
    const res = await suppliersDELETE(req({ psId: row.id }), ctx());
    expect(res.status).toBe(200);
    expect((await (await suppliersGET({} as never, ctx())).json()).suppliers).toHaveLength(0);
  });

  it("rejects a delete without psId", async () => {
    expect((await suppliersDELETE(req({}), ctx())).status).toBe(400);
  });

  it("does not leak links across products", async () => {
    await suppliersPOST(req({ supplierId: supplierA }), ctx());
    const [other] = await db.insert(products).values({
      name: "B6PS Outro", slug: `b6ps-outro-${Date.now()}`, sku: `B6PS-OTHER-${Date.now()}`, price: "10.00",
    }).returning();
    const res = await suppliersGET({} as never, { params: Promise.resolve({ id: String(other.id) }) });
    expect((await res.json()).suppliers).toHaveLength(0);
  });
});

describe("B.6 — regression: product row is untouched by supplier linking", () => {
  it("preserves price, VAT and stock when linking a supplier", async () => {
    const [before] = await db.select().from(products).where(eq(products.id, productId));
    await suppliersPOST(req({ supplierId: supplierA, costPrice: "9.99", isPreferred: true }), ctx());
    const [after] = await db.select().from(products).where(eq(products.id, productId));

    expect(after.price).toBe(before.price);
    expect(after.vatRate).toBe(before.vatRate);
    expect(after.stock).toBe(before.stock);
    expect(after.isActive).toBe(before.isActive);
    // Only costPrice is intentionally synced by the server rule.
    expect(after.costPrice).toBe("9.99");
  });

  it("clears the product cost when the preferred link is removed", async () => {
    await suppliersPOST(req({ supplierId: supplierA, costPrice: "77.00", isPreferred: true }), ctx());
    const row = (await (await suppliersGET({} as never, ctx())).json()).suppliers[0];
    await suppliersDELETE(req({ psId: row.id }), ctx());
    const [p] = await db.select().from(products).where(eq(products.id, productId));
    expect(p.costPrice).toBeNull();
  });
});

describe("B.6 — margin calculation used by the Preços tab", () => {
  // Mirrors computeMargin() in src/app/admin/products/page.tsx.
  const margin = (price: number, cost: number, vat: number) => {
    const net = price / (1 + vat / 100);
    return { value: net - cost, percent: ((net - cost) / net) * 100 };
  };

  it("removes VAT before comparing against cost", async () => {
    const m = margin(123, 50, 23);
    expect(m.value).toBeCloseTo(50, 2); // 123 / 1.23 = 100 net
    expect(m.percent).toBeCloseTo(50, 2);
  });

  it("goes negative when cost exceeds the net price", async () => {
    expect(margin(100, 200, 23).value).toBeLessThan(0);
  });

  it("is display-only and never persisted", async () => {
    const [p] = await db.select().from(products).where(eq(products.id, productId));
    expect(Object.keys(p)).not.toContain("margin");
  });
});
