/**
 * C.3.1 â€” Crash recovery, heartbeats and concurrency.
 *
 * These are the guarantees that only a real database under real concurrency can
 * show: an `applying` import is owned by whoever holds a fresh heartbeat, an
 * abandoned one is reclaimable by exactly one worker, the heartbeat advances
 * with every COMMITTED batch (never with wall-clock time since `started_at`),
 * and a worker that dies mid-batch leaves committed batches alone â€” resumable
 * without the CSV and without a second effect on anything already applied.
 *
 * The apply checkpoint is mocked only to let the test hold, crash or observe
 * the worker at a precise row inside the current batch transaction; production
 * row processing and pricing remain unchanged.
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
import { IMPORT_HEARTBEAT_TTL_MS, SUPPLIER_IMPORT_APPLY_BATCH_SIZE } from "@/lib/supplier-import/constants";

const gate = vi.hoisted(() => ({
  calls: 0,
  /** When the Nth call happens, pause until the test releases it. */
  holdAt: 0,
  hold: null as null | Promise<void>,
  /** When the Nth call happens, explode like a killed worker. */
  throwAt: 0,
}));

vi.mock("@/lib/supplier-import/apply-checkpoint", () => ({
  supplierImportApplyCheckpoint: async () => {
    gate.calls += 1;
    if (gate.throwAt > 0 && gate.calls === gate.throwAt) {
      throw new Error("worker morreu no meio do lote");
    }
    if (gate.holdAt > 0 && gate.calls === gate.holdAt && gate.hold) {
      await Promise.race([gate.hold, new Promise((r) => setTimeout(r, 8000))]);
    }
  },
}));

const getCurrentUserMock = vi.fn();
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getCurrentUser: () => getCurrentUserMock() };
});

/**
 * The audit entry is the LAST step of a successful apply, so failing it lets a
 * test throw exactly where the production code has already committed the
 * completion — the case the post-claim guard must never rewrite.
 */
const audit = vi.hoisted(() => ({ failNextLog: false }));
vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>();
  return {
    ...actual,
    createAuditLog: async (params: Parameters<typeof actual.createAuditLog>[0]) => {
      if (audit.failNextLog) throw new Error("audit indisponível");
      return actual.createAuditLog(params);
    },
  };
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
      started_at = COALESCE(${patch.startedAt ?? null}::timestamp, started_at),
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
  audit.failNextLog = false;
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

describe("C.3.1 â€” heartbeat owns the import", () => {
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

    // Still inside the window â†’ owned, not stealable.
    await setHeartbeatAge(json.importId, IMPORT_HEARTBEAT_TTL_MS - 10_000);
    expect((await getImportProgress(json.importId))!.stale).toBe(false);
    expect((await apply(json.importId)).status).toBe(409);

    // Past it â†’ abandoned, and the progress endpoint says so too.
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

    // Started days ago but the heartbeat is fresh â†’ a second worker stands down:
    // elapsed wall-clock time since started_at proves nothing.
    expect((await apply(json.importId)).json.error).toBe("IMPORT_IN_PROGRESS");
    expect((await getImportProgress(json.importId))!.stale).toBe(false);

    // Same started_at, heartbeat past the TTL â†’ abandoned, and reclaimable.
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

  it("commits one batch per request and recovers a failed continuation", async () => {
    const total = SUPPLIER_IMPORT_APPLY_BATCH_SIZE + 1;
    const created = await makeBulk(total);
    const { json } = await previewWith(created.map((c) => ({ sku: c.sku, cost: "10,00", stock: "1" })));
    expect(json.summary).toMatchObject({ total, actionable: total });
    expect(json.batchesTotal).toBe(2);

    // The first request must return after exactly one committed batch of at
    // most SUPPLIER_IMPORT_APPLY_BATCH_SIZE rows. The first row of the next
    // batch is never reached in this request, and batches_done advances EXACTLY
    // once — one POST is one batch, never more.
    const first = await apply(json.importId, json.previewToken);
    expect(first.json).toMatchObject({
      status: "partial", appliedNow: SUPPLIER_IMPORT_APPLY_BATCH_SIZE,
      batchesDone: 1, pending: 1, batchSize: SUPPLIER_IMPORT_APPLY_BATCH_SIZE,
    });
    expect(first.json.error).toBeUndefined();
    expect(first.json.batchesDone).toBe(1);
    expect(gate.calls).toBe(SUPPLIER_IMPORT_APPLY_BATCH_SIZE);

    // A failure in the next request rolls back that whole batch and is a real
    // error partial, while the first committed batch remains applied.
    gate.throwAt = gate.calls + 1;
    const crashed = await apply(json.importId);
    expect(crashed.status).toBe(200);
    expect(crashed.json).toMatchObject({ status: "partial", appliedNow: 0, batchesDone: 1, pending: 1 });
    expect(crashed.json.error.code).toBe("APPLY_BATCH_FAILED");
    expect(crashed.json.error.message).toContain("worker morreu");

    const rows = await db.select().from(supplierImportRows).where(eq(supplierImportRows.importId, json.importId));
    expect(rows.filter((r) => r.applied)).toHaveLength(SUPPLIER_IMPORT_APPLY_BATCH_SIZE);
    expect(rows.filter((r) => !r.applied)).toHaveLength(1);

    const firstBatchIds = created.slice(0, SUPPLIER_IMPORT_APPLY_BATCH_SIZE).map((c) => c.id);
    const applied = await db.select({ id: products.id, costPrice: products.costPrice, price: products.price })
      .from(products).where(inArray(products.id, firstBatchIds));
    expect(applied).toHaveLength(SUPPLIER_IMPORT_APPLY_BATCH_SIZE);
    expect(applied.every((p) => p.costPrice === "10.00" && p.price === "14.99")).toBe(true);

    const lastProduct = created[created.length - 1];
    const [untouched] = await db.select().from(products).where(eq(products.id, lastProduct.id));
    expect(untouched.costPrice).toBeNull();
    expect(untouched.stock).toBe(0);
    expect(await db.select().from(stockMovements).where(eq(stockMovements.productId, lastProduct.id))).toHaveLength(0);
    const [link] = await db.select().from(productSuppliers).where(eq(productSuppliers.productId, lastProduct.id));
    expect(link.costPrice).toBe("50.00");

    // Resume with no CSV and no token: only the pending row runs.
    gate.throwAt = 0;
    const resumed = await apply(json.importId);
    expect(resumed.json).toMatchObject({ status: "completed", appliedNow: 1, applied: total, resumed: true });
    const [nowApplied] = await db.select().from(products).where(eq(products.id, lastProduct.id));
    expect(nowApplied.costPrice).toBe("10.00");

    const movements = await db.select({ id: stockMovements.id, product: stockMovements.productId })
      .from(stockMovements).where(inArray(stockMovements.productId, created.map((c) => c.id)));
    expect(movements).toHaveLength(total);
    expect(new Set(movements.map((m) => m.product)).size).toBe(total);
  }, 120000);

  it("refreshes the heartbeat during a batch and hands off as partial", async () => {
    const total = SUPPLIER_IMPORT_APPLY_BATCH_SIZE + 1;
    const created = await makeBulk(total);
    const { json } = await previewWith(created.map((c) => ({ sku: c.sku, cost: "10,00" })));

    // An import abandoned long enough to be reclaimed: this worker takes it
    // over, but must return after its first batch rather than entering batch 2.
    await setStatus(json.importId, { status: "partial" });
    await setHeartbeatAge(json.importId, IMPORT_HEARTBEAT_TTL_MS + 60_000);

    let release!: () => void;
    gate.hold = new Promise<void>((r) => { release = r; });
    gate.holdAt = 1;

    const running = applySupplierImport({ importId: json.importId, userId: MANAGER.id });
    for (let i = 0; i < 400; i += 1) {
      if (gate.calls >= 1) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(gate.calls).toBe(1);

    const mid = await getImportProgress(json.importId);
    expect(mid).toMatchObject({ status: "applying", batchesDone: 0, pending: total, canResume: false, stale: false });
    expect((await apply(json.importId)).json.error).toBe("IMPORT_IN_PROGRESS");
    expect((await apply(json.importId, json.previewToken)).json.error).toBe("IMPORT_IN_PROGRESS");

    release();
    const checkpoint = await running;
    expect(checkpoint).toMatchObject({
      status: "partial", appliedNow: SUPPLIER_IMPORT_APPLY_BATCH_SIZE,
      applied: SUPPLIER_IMPORT_APPLY_BATCH_SIZE, pending: 1, batchesDone: 1,
    });
    expect(checkpoint.error).toBeUndefined();
    const afterCheckpoint = await getImportProgress(json.importId);
    expect(afterCheckpoint).toMatchObject({ status: "partial", pending: 1, canResume: true, batchesDone: 1, batchesTotal: 2 });

    // The next request owns the handoff and completes the final row.
    const done = await apply(json.importId);
    expect(done).toMatchObject({ status: 200, json: { status: "completed", applied: total, batchesDone: 2 } });
    expect((await getImportProgress(json.importId))!.canResume).toBe(false);
    await setHeartbeatAge(json.importId, IMPORT_HEARTBEAT_TTL_MS + 60_000);
    expect((await getImportProgress(json.importId))!.canResume).toBe(false);
  }, 120000);

  it("serializes two continuations from the same partial checkpoint", async () => {
    const total = SUPPLIER_IMPORT_APPLY_BATCH_SIZE + 1;
    const created = await makeBulk(total);
    const { json } = await previewWith(created.map((c) => ({ sku: c.sku, cost: "10,00" })));

    const checkpoint = await apply(json.importId, json.previewToken);
    expect(checkpoint.json).toMatchObject({ status: "partial", appliedNow: SUPPLIER_IMPORT_APPLY_BATCH_SIZE, pending: 1 });
    expect(checkpoint.json.error).toBeUndefined();

    const outcomes = await Promise.all([apply(json.importId), apply(json.importId)]);
    const winners = outcomes.filter((outcome) => outcome.json.appliedNow === 1);
    expect(winners).toHaveLength(1);
    const loser = outcomes.find((outcome) => outcome.json.appliedNow !== 1)!;
    expect(loser.status === 409 || loser.json.idempotent === true).toBe(true);
    expect(outcomes.some((outcome) => outcome.json.status === "completed")).toBe(true);

    const rows = await db.select().from(supplierImportRows).where(eq(supplierImportRows.importId, json.importId));
    expect(rows.filter((row) => row.applied)).toHaveLength(total);
    expect((await getImportProgress(json.importId))!.pending).toBe(0);
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

// â”€â”€â”€ C.3.1 audit fix: `completed` is only reachable with nothing pending â”€â”€â”€
//
// Ownership of an import is a heartbeat, not a lease, so a worker that stalls
// past the TTL and then wakes up is still holding a valid-looking run: it can
// write progress, and it can reach the end of its loop while a second worker is
// still applying. Row effects stay safe (the claim is atomic per row), but the
// header must never be closed with rows left behind â€” completed is not
// resumable, so one such write would strand those rows for the life of the
// import. That is decided by the database, in the same statement.
describe("C.3.1 â€” completion cannot outrun the rows", () => {
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

    // The second line joins the snapshot now â€” pending, and invisible to the
    // batch this worker already took.
    await db.insert(supplierImportRows).values({
      importId: json.importId,
      // Line 1 is the header and line 2 is the previewed row, so the late line
      // gets its own row number â€” the snapshot's unique key per import.
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
    expect(done.error).toBeUndefined();
    expect(done).toMatchObject({ appliedNow: 1, pending: 1, resumed: false });

    const mid = await getImportProgress(json.importId);
    expect(mid).toMatchObject({ status: "partial", pending: 1, canResume: true });
    // â€¦and nothing about it looks finished.
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

// ─── C.3.1 — a post-claim failure never rewrites a decided outcome ───
//
// Once an import is claimed, a failure outside the batch transaction must not
// leave it `applying` with no error — but it must also never undo an outcome
// this same request already committed. That is why the guard is conditional on
// status = 'applying'.
describe("C.3.1 — a failure after the claim keeps the committed outcome", () => {
  it("keeps a completed import completed when a post-commit step throws", async () => {
    const p = await makeProduct("SUP-1");
    const { json } = await previewWith([{ sku: "SUP-1", cost: "10,00" }]);

    // The audit entry is written after the completion UPDATE: failing it makes
    // the request throw with the import already finished.
    audit.failNextLog = true;
    const res = await apply(json.importId, json.previewToken);
    expect(res.status).toBe(500);
    expect(res.json.error).toBe("SUPPLIER_IMPORT_APPLY_FAILED");
    audit.failNextLog = false;

    // The failure is reported, but the committed completion is NOT downgraded
    // to partial, and no error summary is invented for it.
    const [stored] = await db.select().from(supplierImports).where(eq(supplierImports.id, json.importId));
    expect(stored.status).toBe("completed");
    expect(stored.errorSummary).toBeNull();
    expect(stored.finishedAt).not.toBeNull();

    const [row] = await db.select().from(products).where(eq(products.id, p.id));
    expect(row.costPrice).toBe("10.00");
    expect(row.price).toBe("14.99");

    // A retry replays the finished import idempotently: nothing is applied twice.
    const replay = await apply(json.importId);
    expect(replay.status).toBe(200);
    expect(replay.json).toMatchObject({ status: "completed", appliedNow: 0, idempotent: true });
    expect(await db.select().from(stockMovements).where(eq(stockMovements.productId, p.id))).toHaveLength(0);
  });
});

// ─── C.3.1 — legacy imports: batches_total rebased once, on the first claim ───
//
// An import persisted BEFORE the Apply batch size was decoupled from the
// snapshot persistence chunk stores a batches_total counted in 500-row batches,
// while its rows are now applied 50 at a time. The stored total would therefore
// understate the work for as long as the import lives. Its FIRST successful
// claim rebases it exactly once — counting, writing, marking and claiming
// happen in the same conditional UPDATE — and later requests must never
// recalculate it again.
describe("C.3.1 — legacy imports are rebased once, on their first claim", () => {
  /** Appends claimable snapshot rows to a planted import, in chunks. */
  async function addPendingRows(importId: number, count: number, firstRowNumber = 2) {
    const rows = Array.from({ length: count }, (_, i) => ({
      importId,
      rowNumber: firstRowNumber + i,
      supplierSku: `${TAG}-LEG-${firstRowNumber + i}`,
      status: "ready" as const,
    }));
    for (let i = 0; i < rows.length; i += 1000) {
      await db.insert(supplierImportRows).values(rows.slice(i, i + 1000));
    }
  }

  /**
   * A legacy import, planted straight in the database: `partial`, heartbeat long
   * past the TTL, batches_total counted with the old 500-row chunk and NO
   * `applyBatchSize` marker in `summary` — the exact shape of an import that
   * existed before this change.
   */
  async function plantLegacyImport(options: {
    pending: number;
    batchesTotal: number;
    batchesDone?: number;
    summary?: Record<string, unknown>;
  }) {
    const [imp] = await db.insert(supplierImports).values({
      supplierId,
      fileName: `${TAG}-legacy.csv`,
      fileHash: "b".repeat(64),
      fileSizeBytes: 2048,
      rowCount: options.pending,
      status: "partial",
      mapping: {},
      summary: options.summary ?? { total: options.pending, actionable: options.pending },
      batchesTotal: options.batchesTotal,
      batchesDone: options.batchesDone ?? 0,
      userId: MANAGER.id,
      startedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      heartbeatAt: new Date(Date.now() - (IMPORT_HEARTBEAT_TTL_MS + 60_000)),
    }).returning();
    await addPendingRows(imp.id, options.pending);
    return imp;
  }

  async function header(importId: number) {
    const [row] = await db.select({
      status: supplierImports.status,
      batchesDone: supplierImports.batchesDone,
      batchesTotal: supplierImports.batchesTotal,
      summary: supplierImports.summary,
    }).from(supplierImports).where(eq(supplierImports.id, importId));
    return row;
  }

  it("rebases the #1020 shape (0/30 + 14786 pending) to 0/296 on the first claim", async () => {
    const pending = 14786;
    const imp = await plantLegacyImport({ pending, batchesTotal: 30, summary: { total: pending, actionable: pending, custom: "keep-me" } });

    // /progress already reports the EFFECTIVE total (batches_done +
    // ceil(pending/50)) and — being read-only — writes nothing.
    const before = await getImportProgress(imp.id);
    expect(before).toMatchObject({
      status: "partial", pending, batchesDone: 0, batchesTotal: 296,
      batchSize: SUPPLIER_IMPORT_APPLY_BATCH_SIZE, canResume: true, stale: false,
    });
    const notYetRebased = await header(imp.id);
    expect(notYetRebased.batchesTotal).toBe(30);
    expect(notYetRebased.summary?.applyBatchSize).toBeUndefined();

    // First claim: the total is rebased to the real number of 50-row batches
    // and the marker is written — with no manual intervention in the database.
    const first = await apply(imp.id);
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({
      status: "partial", appliedNow: SUPPLIER_IMPORT_APPLY_BATCH_SIZE,
      batchesDone: 1, batchesTotal: 296, pending: pending - SUPPLIER_IMPORT_APPLY_BATCH_SIZE,
    });
    expect(first.json.error).toBeUndefined();

    const rebased = await header(imp.id);
    expect(rebased.batchesTotal).toBe(296);
    expect(rebased.batchesDone).toBe(1);
    expect(rebased.summary).toMatchObject({
      applyBatchSize: SUPPLIER_IMPORT_APPLY_BATCH_SIZE,
      // …and every other summary field survives the rebase untouched.
      total: pending,
      actionable: pending,
      custom: "keep-me",
    });

    // The write happens once: the next progress read reports the persisted
    // total, and the summary keeps its marker.
    const after = await getImportProgress(imp.id);
    expect(after).toMatchObject({ batchesTotal: 296, batchSize: SUPPLIER_IMPORT_APPLY_BATCH_SIZE });
    expect((await header(imp.id)).summary?.applyBatchSize).toBe(SUPPLIER_IMPORT_APPLY_BATCH_SIZE);
  }, 180000);

  it("never recalculates a rebased total on the following requests", async () => {
    const pending = 14786;
    const imp = await plantLegacyImport({ pending, batchesTotal: 30 });

    const first = await apply(imp.id);
    expect(first.json).toMatchObject({ batchesTotal: 296, batchesDone: 1, appliedNow: 50 });

    // 15 extra pending rows move the empirical count to
    // batches_done + ceil(14751/50) = 1 + 296 = 297, so a recalculation would be
    // visible. The marker short-circuits it: the total stays exactly as rebased.
    await addPendingRows(imp.id, 15, 20000);

    const second = await apply(imp.id);
    expect(second.json).toMatchObject({ batchesTotal: 296, batchesDone: 2, appliedNow: 50 });
    expect((await header(imp.id)).batchesTotal).toBe(296);
  }, 180000);

  it("keeps historical batches_done and the rest of the summary", async () => {
    const summary = { total: 250, actionable: 250, ignoredColumns: ["notas"], missingProducts: { count: 0 } };
    const imp = await plantLegacyImport({ pending: 250, batchesTotal: 30, batchesDone: 5, summary });

    const first = await apply(imp.id);
    // 5 historical batches + ceil(250/50) pending = 10, and the committed batch
    // advances batches_done to 6 — never reset to zero.
    expect(first.json).toMatchObject({ batchesDone: 6, batchesTotal: 10, appliedNow: 50 });
    const stored = await header(imp.id);
    expect(stored.batchesTotal).toBe(10);
    expect(stored.summary).toMatchObject({ ...summary, applyBatchSize: SUPPLIER_IMPORT_APPLY_BATCH_SIZE });
  }, 60000);

  it("never rebases an import that already carries the marker", async () => {
    // Deliberately inconsistent: a MARKED snapshot whose stored total is not the
    // empirical count. The marker is the only thing that decides, so the total
    // the snapshot persisted (99) must survive the claim untouched.
    const imp = await plantLegacyImport({
      pending: 5, batchesTotal: 99,
      summary: { total: 5, actionable: 5, applyBatchSize: SUPPLIER_IMPORT_APPLY_BATCH_SIZE },
    });

    const applied = await apply(imp.id);
    expect(applied.json).toMatchObject({ status: "completed", appliedNow: 5, batchesTotal: 99 });
    expect((await header(imp.id)).batchesTotal).toBe(99);
    // And /progress never adjusts a marked import either.
    expect(await getImportProgress(imp.id)).toMatchObject({ batchesTotal: 99, pending: 0 });
  });

  it("does not rebase an import whose fresh heartbeat still owns it", async () => {
    const imp = await plantLegacyImport({ pending: 120, batchesTotal: 30 });
    await setStatus(imp.id, { status: "applying", heartbeatAt: new Date().toISOString() });

    // A live `applying` cannot be stolen…
    const thief = await apply(imp.id);
    expect(thief.status).toBe(409);
    expect(thief.json.error).toBe("IMPORT_IN_PROGRESS");
    // …and the rebase belongs to the claim, so it did not happen either.
    const untouched = await header(imp.id);
    expect(untouched.batchesTotal).toBe(30);
    expect(untouched.summary?.applyBatchSize).toBeUndefined();

    // Past the TTL the same request reclaims it and rebases once: ceil(120/50) = 3.
    await setHeartbeatAge(imp.id, IMPORT_HEARTBEAT_TTL_MS + 60_000);
    const resumed = await apply(imp.id);
    expect(resumed.status).toBe(200);
    expect(resumed.json).toMatchObject({
      resumed: true, batchesDone: 1, batchesTotal: 3,
      appliedNow: SUPPLIER_IMPORT_APPLY_BATCH_SIZE,
    });
  }, 60000);

  it("lets exactly one of two racing reclaimers win, rebasing only once", async () => {
    // Fewer pending rows than one batch, so the winner closes the import: the
    // loser either finds it owned (409) or already finished (idempotent replay).
    const imp = await plantLegacyImport({ pending: 40, batchesTotal: 30 });

    const outcomes = await Promise.all([apply(imp.id), apply(imp.id)]);
    const winners = outcomes.filter((outcome) => outcome.json.appliedNow === 40);
    expect(winners).toHaveLength(1);
    const loser = outcomes.find((outcome) => outcome.json.appliedNow !== 40)!;
    expect(loser.status === 409 || loser.json.appliedNow === 0).toBe(true);

    const stored = await header(imp.id);
    // 0 + ceil(40/50) = 1 batch, written by the single winning claim.
    expect(stored.batchesTotal).toBe(1);
    expect(stored.batchesDone).toBe(1);
    expect(stored.summary?.applyBatchSize).toBe(SUPPLIER_IMPORT_APPLY_BATCH_SIZE);
  }, 60000);
});
