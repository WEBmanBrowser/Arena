/**
 * Regression tests for the staging incident of 2026-09-03.
 *
 * Two symptoms, one root cause: migration 0009 was present in the repository
 * but had never been executed against the staging database.
 *
 *   - Admin > Produtos showed "0 produto(s)" while Admin > Inventário showed
 *     the very same product. /api/admin/inventory selects an explicit column
 *     list (none of them from 0009) so it survived the old schema, whereas
 *     /api/admin/products uses an unprojected db.select() that expands to every
 *     column declared in schema.ts — including price_mode — and returned 500.
 *
 *   - Admin > Preços automáticos never stopped loading, because the page's
 *     load() awaited .json() with no guard and never reached setLoading(false).
 *
 * These tests lock in the invariants that would have caught it: the two admin
 * routes must agree on a migrated database, the pricing page must work with no
 * global rule, and the declared schema must not drift ahead of the migrations.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { db } from "@/db";
import { users, products, pricingRules } from "@/db/schema";
import { eq, sql } from "drizzle-orm";

const getCurrentUserMock = vi.fn();
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getCurrentUser: () => getCurrentUserMock() };
});

import { GET as productsGET } from "@/app/api/admin/products/route";
import { GET as inventoryGET } from "@/app/api/admin/inventory/route";
import { GET as rulesGET } from "@/app/api/admin/pricing/rules/route";
import { GET as roundingGET } from "@/app/api/admin/pricing/rounding/route";

const TAG = "HOTFIX0909";
const MANAGER = { id: 9951, email: "hotfix-mgr@test.local", name: "M", role: "manager" };

/** The exact SKU from the staging report. */
const SKU = "27272";

let productId = 0;

beforeAll(async () => {
  await db.insert(users).values({
    id: MANAGER.id, email: MANAGER.email, password: "x", name: MANAGER.name, role: MANAGER.role,
  }).onConflictDoNothing();

  const [p] = await db.insert(products).values({
    name: `${TAG} Teste`,
    slug: `${TAG.toLowerCase()}-teste`,
    sku: SKU,
    price: "10.00",
    stock: 0,
    reservedStock: 0,
    minStock: 0,
  }).returning();
  productId = p.id;

  getCurrentUserMock.mockResolvedValue(MANAGER);
});

afterAll(async () => {
  await db.delete(pricingRules);
  await db.delete(products).where(eq(products.id, productId));
  await db.delete(users).where(eq(users.id, MANAGER.id));
});

function get(url: string) {
  return new NextRequest(url);
}

describe("0009 applied: products and inventory agree", () => {
  it("GET /api/admin/products returns 200 and includes SKU 27272", async () => {
    const res = await productsGET(get("http://localhost/api/admin/products?limit=100"));
    expect(res.status).toBe(200);
    const body = await res.json();
    const found = body.products.find((p: { sku: string }) => p.sku === SKU);
    expect(found, "produto SKU 27272 tem de vir na listagem de produtos").toBeTruthy();
    expect(body.total).toBeGreaterThan(0);
  });

  it("GET /api/admin/inventory returns 200 and includes the same product", async () => {
    const res = await inventoryGET(get("http://localhost/api/admin/inventory"));
    expect(res.status).toBe(200);
    const body = await res.json();
    const found = body.products.find((p: { sku: string }) => p.sku === SKU);
    expect(found, "produto SKU 27272 tem de vir no inventário").toBeTruthy();
  });

  it("both routes report the SAME product — this is the exact staging divergence", async () => {
    const [pRes, iRes] = await Promise.all([
      productsGET(get("http://localhost/api/admin/products?limit=100")),
      inventoryGET(get("http://localhost/api/admin/inventory")),
    ]);
    expect(pRes.status).toBe(200);
    expect(iRes.status).toBe(200);
    const pBody = await pRes.json();
    const iBody = await iRes.json();

    const inProducts = pBody.products.some((p: { id: number }) => p.id === productId);
    const inInventory = iBody.products.some((p: { id: number }) => p.id === productId);
    expect(inProducts).toBe(true);
    expect(inInventory).toBe(true);
    // The bug was precisely: visible in one, invisible in the other.
    expect(inProducts).toBe(inInventory);
  });

  it("the unprojected db.select() actually resolves the 0009 columns", async () => {
    // This is what blew up on staging with 42703 column "price_mode" does not exist.
    const res = await productsGET(get("http://localhost/api/admin/products?limit=100"));
    expect(res.status).toBe(200);
    const body = await res.json();
    const found = body.products.find((p: { sku: string }) => p.sku === SKU);
    expect(found).toHaveProperty("priceMode");
    expect(found).toHaveProperty("priceRuleId");
    expect(found).toHaveProperty("priceCalculatedAt");
  });
});

describe("pricing admin works with NO global rule", () => {
  it("GET /api/admin/pricing/rules returns 200 and a coverage object with hasGlobalRule=false", async () => {
    await db.delete(pricingRules);
    const res = await rulesGET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.rules)).toBe(true);
    expect(body.coverage).toBeTruthy();
    // The page relies on this flag to render the "Criar regra geral" banner
    // instead of hanging or erroring.
    expect(body.coverage.hasGlobalRule).toBe(false);
  });

  it("GET /api/admin/pricing/rounding returns 200 with a usable policy and no global rule present", async () => {
    const res = await roundingGET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.policy).toBeTruthy();
    expect(Array.isArray(body.policy.bands)).toBe(true);
    expect(body.policy.bands.length).toBeGreaterThan(0);
  });

  it("both mount requests succeed together — the page can finish loading", async () => {
    // load() does Promise.all over exactly these two endpoints.
    const [a, b] = await Promise.all([
      rulesGET(),
      roundingGET(),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });
});

describe("pricing_rules table and 0009 columns really exist", () => {
  it("pricing_rules is a real relation", async () => {
    const r = await db.execute(sql`SELECT to_regclass('public.pricing_rules') AS t`);
    const row = (r.rows ?? r)[0] as { t: string | null };
    expect(row.t).toBe("pricing_rules");
  });

  it("products has the three 0009 columns", async () => {
    const r = await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'products'
        AND column_name IN ('price_mode', 'price_rule_id', 'price_calculated_at')
    `);
    const names = ((r.rows ?? r) as { column_name: string }[]).map(x => x.column_name).sort();
    expect(names).toEqual(["price_calculated_at", "price_mode", "price_rule_id"]);
  });
});

/**
 * Schema-vs-migration drift guard.
 *
 * Deliberately narrow: it only checks that columns the ORM declares for
 * `products` are actually created by some migration file. A broad structural
 * differ would be fragile and would fail for unrelated reasons; this targets
 * the precise failure mode we hit — schema.ts moving ahead of drizzle/*.sql.
 */
describe("schema/migration coherence", () => {
  it("every 0009 pricing column declared in schema.ts appears in a migration file", () => {
    const dir = path.join(process.cwd(), "drizzle");
    const sqlText = readdirSync(dir)
      .filter(f => f.endsWith(".sql"))
      .map(f => readFileSync(path.join(dir, f), "utf8"))
      .join("\n");

    for (const col of ["price_mode", "price_rule_id", "price_calculated_at"]) {
      expect(sqlText, `${col} está declarada no schema mas nenhuma migration a cria`).toContain(col);
    }
    expect(sqlText).toContain("pricing_rules");
  });

  it("the migration journal lists 0009 and no 0010 was introduced", () => {
    const journal = JSON.parse(
      readFileSync(path.join(process.cwd(), "drizzle", "meta", "_journal.json"), "utf8")
    ) as { entries: { idx: number; tag: string }[] };

    const tags = journal.entries.map(e => e.tag);
    expect(tags).toContain("0009_c1_pricing_engine");
    expect(journal.entries.some(e => e.idx >= 10)).toBe(false);
  });
});
