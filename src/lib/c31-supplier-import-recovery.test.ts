/**
 * C.3.1 — Crash recovery, heartbeats and concurrency.
 *
 * These are the guarantees that only a real database under real concurrency can
 * show: an `applying` import is owned by whoever holds a fresh heartbeat, an
 * abandoned one is reclaimable by exactly one worker, the heartbeat advances
 * with every COMMITTED batch (never with wall-clock time since `started_at`),
 * and a worker that dies mid-batch leaves committed batches alone — resumable
 * without the CSV and without a second effect on anything already applied.
 *
 * `syncProductCost` is wrapped (not replaced) so the engine still runs; the
 * wrapper is only a checkpoint that lets the test hold, crash or observe the
 * apply loop at a precise row.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/db";
import {
  pricingRules,
  productSuppliers,
  products,
  stockMovements,
  suppliers,
  supplierImportRows,
  supplierImports,
  users,
} from "@/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { IMPORT_HEARTBEAT_TTL_MS, SUPPLIER_IMPORT_BATCH_SIZE } from "@/lib/supplier-import/constants";

const gate = vi.hoisted(() => ({
  calls: 0,
  /** When the Nth call happens, pause until the test releases it. */
  holdAt: 0,
  hold: null as null | Promise<void>,
  /** When the Nth call happens, explode like a killed worker. */
  throwAt: 0,
}));

vi.mock("@/lib/services/product-supplier-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/services/product-supplier-service")>();
  return {
    ...actual,
    syncProductCost: async (tx: Parameters<typeof actual.syncProductCost>[0], productId: number) => {
      gate.calls += 1;
      if (gate.throwAt > 0 && gate.calls === gate.throwAt) {
        throw new Error("worker morreu no meio do lote");
      }
      if (gate.holdAt > 0 && gate.calls === gate.holdAt && gate.hold) {
        await Promise.race([gate.hold, new Promise((r) => setTimeout(r, 8000))]);
      }
      return actual.syncProductCost(tx, productId);
    },
  };
});

const getCurrentUserMock = vi.fn();
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getCurrentUser: () => getCurrentUserMock() };
});

import { POST as previewPOST } from "@/app/api/admin/supplier-import/route";
import { POST as applyPOST } from "@/app/api/admin/supplier-import/apply/route";
import { GET as progressGET } from "@/app/api/admin/supplier-import/[id]/progress/route";
import { applySupplierImport, getImportProgress } from "@/lib/services/supplier-import-service";

const TAG = "C31RECO";
const MANAGER = { id: 9751, email: "c31-reco@test.local", name: "C31 Reco", role: "manager", phone: null, nif: null, company: null };
let supplierId = 0;
let seq = 0;

async function makeProduct(supplierSku: string, extra: Record<string, unknown> = {}) {
  seq += 1;
  const sku = `${TAG}-${seq}`;
  const [p] = await db.insert(products).values({
    name: `Produto ${sku}`, slug: `${sku.toLowerCase()}-${seq}`, sku,
    price: "100.00", vatRate: "23.00", priceMode: "auto", stock: 0, ...extra,
  }).returning();
  await db.insert(productSuppliers).values({
    productId: p.id, supplierId, costPrice: "50.00", isPreferred: true, supplierSku,
  });
  return p;
}

/** Many products at once, so the batch tests stay fast. */
async function makeBulk(count: number) {
  seq += 1;
  const start = seq;
  const rows = Array.from({ length: count }, (_, i) => {
    const sku = `${TAG}-SKU-${start + i}`;
    return { name: `Produto ${sku}`, slug: sku.toLowerCase(), sku, price: "100.00", vatRate: "23.00", priceMode: "auto" as const, stock: 0 };
  });
  const created = await db.insert(products).values(rows).returning({ id: products.id });
  const withSkus = created.map((c, i) => ({ id: c.id, sku: rows[i].sku }));
  await db.insert(productSuppliers).values(withSkus.map((p) => ({
    productId: p.id, supplierId, costPrice: "50.00", isPreferred: true, supplierSku: p.sku,
  })));
  return withSkus;
}

function post(path: string, body: unknown) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "http://localhost" },
    body: JSON.stringify(body),
  });
}

async function previewWith(rows: { sku: string; cost: string; stock?: string }[]) {
  const csvText = ["skuFornecedor;nome;custo;stock", ...rows.map((r) => `${r.sku};nome ${r.sku};${r.cost};${r.stock ?? ""}`)].join("\n");
  const res = await previewPOST(post("/api/admin/supplier-import", { supplierId, fileName: `${TAG}.csv`, data: csvText }));
  return { status: res.status, json: await res.json() as any };
}

async function apply(importId: number, previewToken?: string) {
  const res = await applyPOST(post("/api/admin/supplier-import/apply", { importId, ...(previewToken ? { previewToken } : {}) }));
  return { status: res.status, json: await res.json() as any };
}

async function setStatus(importId: number, patch: Record<string, string>) {
  // Raw SQL so the test can plant timestamps the API would never produce.
  await db.execute(sql`
    UPDATE supplier_imports SET
      status = COALESCE(${patch.status ?? null}::text, status),
      started_at = COALESCE(${patch.startedAt ?? null}::timestamptz, started_at),
      heartbeat_at = COALESCE(${patch.heartbeatAt ?? null}::timestamptz, heartbeat_at)
    WHERE id = ${importId}
  `);
}

async function setHeartbeatAge(importId: number, millis: number) {
  const secs = Number((millis / 1000).toFixed(3));
  await db.execute(sql`UPDATE supplier_imports SET heartbeat_at = now() - make_interval(secs => ${secs}::numeric) WHERE id = ${importId}`);
}

async function cleanup() {
  await db.execute(sql`DELETE FROM supplier_import_rows WHERE import_id IN (SELECT id FROM supplier_imports WHERE user_id = ${MANAGER.id})`);
  await db.execute(sql`DELETE FROM supplier_imports WHERE user_id = ${MANAGER.id}`);
  await db.execute(sql`DELETE FROM pricing_rules WHERE notes LIKE ${`${TAG}%`}`);
  await db.execute(sql`DELETE FROM stock_movements WHERE product_id IN (SELECT id FROM products WHERE sku LIKE ${`${TAG}-%`})`);
  await db.execute(sql`DELETE FROM product_suppliers WHERE product_id IN (SELECT id FROM products WHERE sku LIKE ${`${TAG}-%`})`);
  await db.execute(sql`DELETE FROM products WHERE sku LIKE ${`${TAG}-%`}`);
}

beforeAll(async () => {
  await db.insert(users).values({ id: MANAGER.id, email: MANAGER.email, password: "x", name: MANAGER.name, role: "manager" }).onConflictDoNothing();
  const [s] = await db.insert(suppliers).values({ name: `${TAG} Fornecedor` }).returning();
  supplierId = s.id;
});

beforeEach(async () => {
  getCurrentUserMock.mockReset();
  getCurrentUserMock.mockResolvedValue(MANAGER);
  gate.calls = 0;
  gate.holdAt = 0;
  gate.hold = null;
  gate.throwAt = 0;
  await cleanup();
  await db.insert(pricingRules).values({
    scope: "global", method: "markup_on_cost", ratePercent: "20", roundingPolicy: "auto", notes: `${TAG} global`,
  });
});

afterAll(async () => {
  await cleanup();
  await db.execute(sql`DELETE FROM audit_logs WHERE user_id = ${MANAGER.id}`);
  await db.execute(sql`DELETE FROM suppliers WHERE name LIKE ${`${TAG}%`}`);
  await db.execute(sql`DELETE FROM users WHERE id = ${MANAGER.id}`);
});

describe("C.3.1 — heartbeat owns the import", () => {
  it("refuses to steal an import whose heartbeat is recent", async () => {
    const p = await makeProduct("SUP-1");
    const { json } = await previewWith([{ sku: "SUP-1", cost: "10,00" }]);
    await setStatus(json.importId, { status: "applying", startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() });

    const thief = await apply(json.importId);
    expect(thief.status).toBe(409);
    expect(thief.json.error).toBe("IMPORT_IN_PROGRESS");

    // Nothing was touched, and the running import's heartbeat is unchanged.
    const rows = await db.select().from(supplierImportRows).where(eq(supplierImportRows.importId, json.importId));
    expect(rows).toHaveLength(1);
    expect(rows[0].applied).toBe(false);
    const [after] = await db.select().from(products).where(eq(products.id, p.id));
    expect(after.costPrice).toBeNull();
    expect(after.price).toBe("100.00");
  });

  it("reclaims an abandoned import without a token and finishes it", async () => {
    const p = await makeProduct("SUP-1");
    const { json } = await previewWith([{ sku: "SUP-1", cost: "10,00" }]);
    await setStatus(json.importId, { status: "applying" });
    await setHeartbeatAge(json.importId, IMPORT_HEARTBEAT_TTL_MS + 60_000);

    const res = await apply(json.importId); // no previewToken: a resume never needs one
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ status: "completed", appliedNow: 1, resumed: true });
    const [row] = await db.select().from(products).where(eq(products.id, p.id));
    expect(row.costPrice).toBe("10.00");
    expect(row.price).toBe("14.99");
  });

  it("decides staleness on the TTL, on both sides of the boundary", async () => {
    await makeProduct("SUP-1");
    const { json } = await previewWith([{ sku: "SUP-1", cost: "10,00" }]);
    await setStatus(json.importId, { status: "applying" });

    // Still inside the window → owned, not stealable.
    await setHeartbeatAge(json.importId, IMPORT_HEARTBEAT_TTL_MS - 10_000);
    expect((await getImportProgress(json.importId))!.stale).toBe(false);
    expect((await apply(json.importId)).status).toBe(409);

    // Past it → abandoned, and the progress endpoint says so too.
    await setHeartbeatAge(json.importId, IMPORT_HEARTBEAT_TTL_MS + 10_000);
    const progress = await progressGET(new NextRequest("http://localhost/x"), { params: Promise.resolve({ id: String(json.importId) }) });
    expect(await progress.json()).toMatchObject({ status: "applying", stale: true, canResume: true });
    expect((await apply(json.importId)).status).toBe(200);
  });

  it("never uses started_at to decide abandonment, and keeps it across a resume", async () => {
    await makeProduct("SUP-1");
    const { json } = await previewWith([{ sku: "SUP-1", cost: "10,00" }]);
    const ancient = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    await setStatus(json.importId, { status: "applying", startedAt: ancient, heartbeatAt: new Date().toISOString() });

    // Started days ago but the heartbeat is fresh → a second worker stands down:
    // elapsed wall-clock time since started_at proves nothing.
    expect((await apply(json.importId)).json.error).toBe("IMPORT_IN_PROGRESS");
    expect((await getImportProgress(json.importId))!.stale).toBe(false);

    // Same started_at, heartbeat past the TTL → abandoned, and reclaimable.
    await setHeartbeatAge(json.importId, IMPORT_HEARTBEAT_TTL_MS + 1000);
    expect((await getImportProgress(json.importId))!.stale).toBe(true);
    expect((await apply(json.importId)).status).toBe(200);

    // The claim never rewrites the original started_at: the run's start is its
    // start, so duration reporting survives a takeover.
    const [stored] = await db.select().from(supplierImports).where(eq(supplierImports.id, json.importId));
    expect(stored.status).toBe("completed");
    expect(new Date(stored.startedAt!).getTime()).toBe(new Date(ancient).getTime());
    expect(stored.finishedAt!.getTime()).toBeGreaterThan(stored.startedAt!.getTime());
  });

  it("two workers racing for the same abandoned import: exactly one applies it", async () => {
    const p = await makeProduct("SUP-1");
    const { json } = await previewWith([{ sku: "SUP-1", cost: "10,00", stock: "7" }]);
    await setStatus(json.importId, { status: "applying" });
    await setHeartbeatAge(json.importId, IMPORT_HEARTBEAT_TTL_MS + 1000);

    const [first, second] = await Promise.all([apply(json.importId), apply(json.importId)]);
    const outcomes = [first, second];
    // Exactly one of them did the work: the loser either found the import owned
    // (409) or found it already finished (idempotent replay, appliedNow 0).
    const workers = outcomes.filter((o) => o.json.appliedNow === 1);
    expect(workers).toHaveLength(1);
    const losers = outcomes.filter((o) => !workers.includes(o));
    expect(losers).toHaveLength(1);
    expect(losers[0].status === 409 || losers[0].json.idempotent === true).toBe(true);
    expect(outcomes.some((o) => o.json.status === "completed")).toBe(true);

    const rows = await db.select().from(supplierImportRows).where(eq(supplierImportRows.importId, json.importId));
    expect(rows[0].applied).toBe(true);
    const [after] = await db.select().from(products).where(eq(products.id, p.id));
    expect(after.costPrice).toBe("10.00");
    expect(after.stock).toBe(7);
    // one effect total, not one per worker
    expect(await db.select().from(stockMovements).where(eq(stockMovements.productId, p.id))).toHaveLength(1);
    const [link] = await db.select().from(productSuppliers)
      .where(and(eq(productSuppliers.productId, p.id), eq(productSuppliers.supplierId, supplierId)));
    expect(link.lastCostPrice).toBe("50.00"); // a single cost transition
  });

  it("a worker killed mid-run leaves the committed batch applied and the rest pending", async () => {
    const total = SUPPLIER_IMPORT_BATCH_SIZE + 1;
    const created = await makeBulk(total);
    const { json } = await previewWith(created.map((c) => ({ sku: c.sku, cost: "10,00", stock: "1" })));
    expect(json.summary).toMatchObject({ total, actionable: total });
    expect(json.batchesTotal).toBe(2);

    // Die on the first row of the second batch.
    gate.throwAt = SUPPLIER_IMPORT_BATCH_SIZE + 1;
    const crashed = await apply(json.importId, json.previewToken);
    expect(crashed.status).toBe(200);
    expect(crashed.json).toMatchObject({
      status: "partial", appliedNow: SUPPLIER_IMPORT_BATCH_SIZE, batchesDone: 1,
    });
    expect(crashed.json.error.code).toBe("APPLY_BATCH_FAILED");
    expect(crashed.json.error.message).toContain("worker morreu");

    // Batch 1 is committed; the rolled-back batch is fully pending again.
    const rows = await db.select().from(supplierImportRows).where(eq(supplierImportRows.importId, json.importId));
    expect(rows.filter((r) => r.applied)).toHaveLength(SUPPLIER_IMPORT_BATCH_SIZE);
    expect(rows.filter((r) => !r.applied)).toHaveLength(1);

    const firstBatchIds = created.slice(0, SUPPLIER_IMPORT_BATCH_SIZE).map((c) => c.id);
    const applied = await db.select({ id: products.id, costPrice: products.costPrice, price: products.price })
      .from(products).where(inArray(products.id, firstBatchIds));
    expect(applied).toHaveLength(SUPPLIER_IMPORT_BATCH_SIZE);
    expect(applied.every((p) => p.costPrice === "10.00" && p.price === "14.99")).toBe(true);

    const lastProduct = created[created.length - 1];
    const [untouched] = await db.select().from(products).where(eq(products.id, lastProduct.id));
    expect(untouched.costPrice).toBeNull();
    expect(untouched.stock).toBe(0);
    expect(await db.select().from(stockMovements).where(eq(stockMovements.productId, lastProduct.id))).toHaveLength(0);
    // and no half-written link for the rolled-back row
    const [link] = await db.select().from(productSuppliers).where(eq(productSuppliers.productId, lastProduct.id));
    expect(link.costPrice).toBe("50.00");

    // Resume with no CSV and no token: only the pending row runs.
    gate.throwAt = 0;
    const resumed = await apply(json.importId);
    expect(resumed.json).toMatchObject({ status: "completed", appliedNow: 1, applied: total, resumed: true });
    const [nowApplied] = await db.select().from(products).where(eq(products.id, lastProduct.id));
    expect(nowApplied.costPrice).toBe("10.00");

    // Exactly one movement per product for the whole saga, crash included.
    const movements = await db.select({ id: stockMovements.id, product: stockMovements.productId })
      .from(stockMovements).where(inArray(stockMovements.productId, created.map((c) => c.id)));
    expect(movements).toHaveLength(total);
    expect(new Set(movements.map((m) => m.product)).size).toBe(total);
  }, 120000);

  it("a live worker refreshes the heartbeat every committed batch, so it is never stealable", async () => {
    const total = SUPPLIER_IMPORT_BATCH_SIZE + 1;
    const created = await makeBulk(total);
    const { json } = await previewWith(created.map((c) => ({ sku: c.sku, cost: "10,00" })));

    // An import abandoned long enough to be reclaimed: this worker takes it over.
    await setStatus(json.importId, { status: "partial" });
    await setHeartbeatAge(json.importId, IMPORT_HEARTBEAT_TTL_MS + 60_000);

    let release!: () => void;
    gate.hold = new Promise<void>((r) => { release = r; });
    gate.holdAt = SUPPLIER_IMPORT_BATCH_SIZE + 1; // first row of the second batch

    const running = applySupplierImport({ importId: json.importId, userId: MANAGER.id });

    // Wait until batch 1 has committed and the worker is inside batch 2.
    for (let i = 0; i < 400; i += 1) {
      const progress = await getImportProgress(json.importId);
      if (progress && progress.batchesDone >= 1 && gate.calls > SUPPLIER_IMPORT_BATCH_SIZE) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(gate.calls).toBeGreaterThan(SUPPLIER_IMPORT_BATCH_SIZE);

    // The heartbeat that makes it "alive" is the one batch 1 wrote, not the one
    // the claim wrote: the pre-existing stale timestamp is gone.
    const mid = await getImportProgress(json.importId);
    expect(mid).toMatchObject({ status: "applying", batchesDone: 1, pending: 1, canResume: false, stale: false });
    expect((await apply(json.importId)).json.error).toBe("IMPORT_IN_PROGRESS");
    expect((await apply(json.importId, json.previewToken)).json.error).toBe("IMPORT_IN_PROGRESS");

    release();
    const done = await running;
    expect(done).toMatchObject({ status: "completed", applied: total, batchesDone: 2 });
    const after = await getImportProgress(json.importId);
    expect(after).toMatchObject({ status: "completed", pending: 0, canResume: false, batchesDone: 2, batchesTotal: 2 });
    // A finished import is never offered as resumable, however old its heartbeat gets.
    await setHeartbeatAge(json.importId, IMPORT_HEARTBEAT_TTL_MS + 60_000);
    expect((await getImportProgress(json.importId))!.canResume).toBe(false);
  }, 120000);

  it("refuses to resume an import marked failed, and demands a new preview", async () => {
    await makeProduct("SUP-1");
    const { json } = await previewWith([{ sku: "SUP-1", cost: "10,00" }]);
    await setStatus(json.importId, { status: "failed", heartbeatAt: new Date(0).toISOString() });
    expect((await apply(json.importId)).json.error).toBe("IMPORT_FAILED");
    const rows = await db.select().from(supplierImportRows).where(eq(supplierImportRows.importId, json.importId));
    expect(rows[0].applied).toBe(false);
  });
});

// ─── C.3.1 audit fix: `completed` is only reachable with nothing pending ───
//
// Ownership of an import is a heartbeat, not a lease, so a worker that stalls
// past the TTL and then wakes up is still holding a valid-looking run: it can
// write progress, and it can reach the end of its loop while a second worker is
// still applying. Row effects stay safe (the claim is atomic per row), but the
// header must never be closed with rows left behind — completed is not
// resumable, so one such write would strand those rows for the life of the
// import. That is decided by the database, in the same statement.
describe("C.3.1 — completion cannot outrun the rows", () => {
  it("leaves the import resumable when a line arrives after the worker's last batch", async () => {
    await makeProduct("SUP-1");
    const late = await makeProduct("SUP-2");
    const { json } = await previewWith([{ sku: "SUP-1", cost: "10,00" }]);

    let release!: () => void;
    gate.hold = new Promise<void>((r) => { release = r; });
    gate.holdAt = 1; // the worker is inside the only batch it will ever claim

    const running = applySupplierImport({ importId: json.importId, previewToken: json.previewToken, userId: MANAGER.id });
    for (let i = 0; i < 400 && gate.calls === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(gate.calls).toBe(1);

    // The second line joins the snapshot now — pending, and invisible to the
    // batch this worker already took.
    await db.insert(supplierImportRows).values({
      importId: json.importId,
      // Line 1 is the header and line 2 is the previewed row, so the late line
      // gets its own row number — the snapshot's unique key per import.
      rowNumber: 3,
      supplierSku: "SUP-2",
      name: "linha chegada depois",
      productId: late.id,
      matchType: "supplier_sku",
      status: "ready",
      costPrice: "11.00",
    });

    release();
    const done = await running;
    expect(done.status).toBe("partial");
    expect(done.error?.code).toBe("PENDING_ROWS_REMAIN");
    expect(done).toMatchObject({ appliedNow: 1, pending: 1, resumed: false });

    const mid = await getImportProgress(json.importId);
    expect(mid).toMatchObject({ status: "partial", pending: 1, canResume: true });
    // …and nothing about it looks finished.
    const [header] = await db.select().from(supplierImports).where(eq(supplierImports.id, json.importId));
    expect(header.finishedAt).toBeNull();
    expect((await db.select().from(products).where(eq(products.id, late.id)))[0].costPrice).toBeNull();

    // The resume applies the missing line and only then completes.
    gate.holdAt = 0;
    gate.hold = null;
    const resumed = await apply(json.importId);
    expect(resumed.json).toMatchObject({ status: "completed", appliedNow: 1, pending: 0, resumed: true });
    expect(resumed.json.error).toBeUndefined();
    expect((await db.select().from(products).where(eq(products.id, late.id)))[0].costPrice).toBe("11.00");
    expect((await getImportProgress(json.importId))!.canResume).toBe(false);
  }, 60000);

  it("keeps the invariant globally: no completed import has pending rows", async () => {
    await makeProduct("SUP-1");
    const { json } = await previewWith([{ sku: "SUP-1", cost: "10,00" }]);
    expect((await apply(json.importId, json.previewToken)).json.status).toBe("completed");

    // A completed import whose snapshot still has claimable rows is, by
    // definition, unreachable: the resume refuses it. So it must not exist.
    const result = await db.execute(sql`
      SELECT i.id
        FROM supplier_imports i
       WHERE i.status = 'completed'
         AND EXISTS (
           SELECT 1 FROM supplier_import_rows r
            WHERE r.import_id = i.id AND r.applied = false AND r.status IN ('ready','new_product')
         )
       LIMIT 1
    `) as unknown as { rows?: { id: number }[] };
    expect(result.rows ?? []).toEqual([]);
  });
});
