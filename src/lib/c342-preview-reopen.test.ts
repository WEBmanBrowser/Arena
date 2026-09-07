/**
 * C.3.4.2 — Reabrir um preview PERSISTIDO para revisão manual e apply.
 *
 * O problema que esta suite fixa: "Sincronizar agora" cria um import em
 * status=preview, mas o token de apply nunca é persistido e o First Apply
 * exige um token válido. Sem um endpoint que reabra o snapshot e reemita o
 * token, o preview remoto (e um upload manual seguido de reload) ficava
 * inalcançável a partir da UI.
 *
 * Cobertura (BD real via runner; transporte remoto 100% mockado):
 *  A. Sync Now cria preview: status preview, batchesDone 0, nada aplicado;
 *  B. GET reopen devolve o snapshot correto + token novo; não muda estado;
 *     nada do token/segredo aparece em logs, source config ou na BD;
 *  C. deep-link supplierImportReviewHref(20) === "/admin/import?open=20";
 *  D. apply manual com o token reemitido → import completed (C.3.1 Apply);
 *  E. completed não é reaplicado (idempotente) e reopen de completed → 409;
 *  F. preview de upload manual CSV também reabre; source_id continua NULL;
 *  G. preview XLSX reabre e aplica (C.3.3 intacto);
 *  H. RBAC/erros na rota: staff GET ok; sem sessão 403; id inválido 400;
 *     inexistente 404; partial/applying 409; failed 409;
 *  I. perfis C.3.2: o reopen não toca em supplier_import_profiles.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import * as XLSX from "@e965/xlsx";
import { db } from "@/db";
import {
  auditLogs,
  productSuppliers,
  products,
  supplierImportProfiles,
  supplierImportRows,
  supplierImports,
  supplierSourceRuns,
  supplierSources,
  suppliers,
  users,
} from "@/db/schema";
import { asc, eq, sql } from "drizzle-orm";

const getCurrentUserMock = vi.fn();
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getCurrentUser: () => getCurrentUserMock() };
});

import { runSupplierSource } from "@/lib/services/supplier-source-service";
import {
  SupplierImportError,
  applySupplierImport,
  countRows,
  previewSupplierImport,
  reopenSupplierImportPreview,
} from "@/lib/services/supplier-import-service";
import { uploadSource } from "@/lib/supplier-import/source";
import {
  SUPPLIER_IMPORT_TOKEN_KIND,
  tokenMatchesImport,
  verifySupplierImportToken,
} from "@/lib/supplier-import/token";
import { SUPPLIER_IMPORT_PREVIEW_LIMIT, SUPPLIER_IMPORT_TOKEN_TTL_MS } from "@/lib/supplier-import/constants";
import { SUPPLIER_IMPORT_MESSAGES, supplierImportErrorMessage } from "@/lib/supplier-import/error-messages";
import {
  IMPORT_REVIEW_QUERY_PARAM,
  parseSupplierImportReviewParam,
  supplierImportReviewHref,
} from "@/lib/import-review-link";
import { GET as reopenGET } from "@/app/api/admin/supplier-import/[id]/preview/route";
import { POST as applyPOST } from "@/app/api/admin/supplier-import/apply/route";

const TAG = "C342RO";
const USER_ID = 990044;
const URL_OK = `https://supplier.example.com/files/${TAG}.csv`;
const SECRET_VALUE = "c342-reopen-super-sekret-value";

const CSV_REMOTE = `skuFornecedor;nome;custo;stock;ean\n${TAG}-R1;Produto ${TAG} Remoto 1;10,00;5;5901234123457\n${TAG}-R2;Produto ${TAG} Remoto 2;12,50;3;`;
const CSV_MANUAL = `skuFornecedor;nome;custo;stock\n${TAG}-M1;Produto ${TAG} Manual 1;7,00;4`;

let supplierId: number;

async function cleanup() {
  const pattern = `${TAG}-%`;
  await db.execute(sql`DELETE FROM supplier_source_runs WHERE source_id IN (SELECT id FROM supplier_sources WHERE name LIKE ${pattern})`);
  await db.execute(sql`DELETE FROM supplier_sources WHERE name LIKE ${pattern}`);
  await db.execute(sql`DELETE FROM supplier_import_rows WHERE import_id IN (SELECT id FROM supplier_imports WHERE file_name LIKE ${`%${TAG}%`} OR source_label LIKE ${`%${TAG}%`})`);
  await db.execute(sql`DELETE FROM supplier_imports WHERE source_label LIKE ${`%${TAG}%`} OR file_name LIKE ${`%${TAG}%`}`);
  await db.execute(sql`DELETE FROM supplier_import_profiles WHERE supplier_id IN (SELECT id FROM suppliers WHERE name LIKE ${pattern})`);
  await db.execute(sql`DELETE FROM stock_movements WHERE user_id = ${USER_ID} OR product_id IN (SELECT id FROM products WHERE name LIKE ${`%${TAG}%`} OR sku LIKE ${pattern})`);
  await db.execute(sql`DELETE FROM product_suppliers WHERE supplier_sku LIKE ${pattern} OR product_id IN (SELECT id FROM products WHERE name LIKE ${`%${TAG}%`})`);
  await db.execute(sql`DELETE FROM products WHERE name LIKE ${`%${TAG}%`} OR sku LIKE ${pattern}`);
}

beforeAll(async () => {
  await db.insert(users).values({
    id: USER_ID, email: `${TAG}@example.test`, password: "x", name: TAG, role: "admin",
  }).onConflictDoNothing();
  const [s] = await db.insert(suppliers).values({ name: `${TAG}-Fornecedor`, isActive: true }).returning();
  supplierId = s.id;
});

beforeEach(async () => {
  getCurrentUserMock.mockReset();
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await db.execute(sql`DELETE FROM audit_logs WHERE user_id = ${USER_ID}`);
  await db.execute(sql`DELETE FROM suppliers WHERE name LIKE ${`${TAG}-%`}`);
  await db.execute(sql`DELETE FROM users WHERE id = ${USER_ID}`);
});

// ─── helpers ─────────────────────────────────────────────

function user(role: string | null) {
  if (!role) return null;
  return { id: USER_ID, email: `${TAG}-${role}@test.local`, name: TAG, role, phone: null, nif: null, company: null };
}

const asId = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });

function getReq(id: number | string) {
  return new NextRequest(`http://localhost/api/admin/supplier-import/${id}/preview`, { method: "GET" });
}

function applyReq(body: unknown) {
  return new NextRequest("http://localhost/api/admin/supplier-import/apply", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify(body),
  });
}

/** Stub de transporte no MESMO contrato de c342-source-run.test.ts. */
function stubFetch(text: string, headers: Record<string, string> = {}) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (input: unknown, init: unknown) => {
    const i = init as { headers?: Record<string, string> };
    calls.push({ url: String(input), headers: { ...(i.headers ?? {}) } });
    const bytes = new TextEncoder().encode(text);
    let sent = false;
    return {
      status: 200,
      headers: new Headers(headers),
      body: {
        getReader() {
          return {
            async read() {
              if (sent) return { done: true as const, value: undefined };
              sent = true;
              return { done: false as const, value: bytes };
            },
            async cancel() {},
          };
        },
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

async function insertSource(over: Partial<typeof supplierSources.$inferInsert> = {}) {
  const [row] = await db.insert(supplierSources).values({
    supplierId,
    name: `${TAG}-Fonte ${Math.random().toString(36).slice(2, 8)}`,
    sourceType: "url",
    url: URL_OK,
    format: "csv",
    authType: "none",
    enabled: true,
    ...over,
  }).returning();
  return row;
}

/** Sync Now com sucesso → id do preview persistido. */
async function syncToPreview(over: Partial<typeof supplierSources.$inferInsert> = {}, env: Record<string, string> = {}) {
  const src = await insertSource(over);
  const { fetchImpl } = stubFetch(CSV_REMOTE, { etag: '"v1"' });
  const outcome = await runSupplierSource(src.id, USER_ID, { fetchImpl, env });
  expect(outcome.status).toBe("success");
  expect(outcome.importId).toBeTypeOf("number");
  return { src, outcome, importId: outcome.importId as number };
}

async function importRow(id: number) {
  const [row] = await db.select().from(supplierImports).where(eq(supplierImports.id, id)).limit(1);
  return row;
}

async function snapshotRows(id: number) {
  return db.select().from(supplierImportRows).where(eq(supplierImportRows.importId, id)).orderBy(asc(supplierImportRows.rowNumber));
}

const expectImportError = async (promise: Promise<unknown>, code: string, httpStatus: number) => {
  let caught: unknown;
  try {
    await promise;
    throw new Error(`expected rejection ${code}`);
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(SupplierImportError);
  expect((caught as SupplierImportError).code).toBe(code);
  expect((caught as SupplierImportError).httpStatus).toBe(httpStatus);
};

function buildXlsx(rows: Array<Array<string | number>>): Uint8Array {
  const ws: any = {};
  rows.forEach((row, r) =>
    row.forEach((v, c) => { ws[XLSX.utils.encode_cell({ r, c })] = typeof v === "number" ? { t: "n", v } : { t: "s", v }; })
  );
  ws["!ref"] = `A1:${XLSX.utils.encode_col(rows[0].length - 1)}${rows.length}`;
  return new Uint8Array(XLSX.write({ SheetNames: ["Lista"], Sheets: { Lista: ws } }, { type: "buffer", bookType: "xlsx" }));
}

// ─── A. Sync Now cria preview e PARA ─────────────────────

describe("A — Sync Now cria um preview persistido e nunca aplica", () => {
  it("import fica status=preview, batchesDone 0, applied 0, catálogo intacto", async () => {
    const { importId, outcome } = await syncToPreview();
    const imp = await importRow(importId);
    expect(imp.status).toBe("preview");
    expect(imp.batchesDone).toBe(0);
    expect(imp.batchesTotal).toBeGreaterThan(0);
    expect(imp.startedAt).toBeNull();
    expect(imp.finishedAt).toBeNull();

    const counts = await countRows(importId);
    expect(counts.total).toBe(2);
    expect(counts.applied).toBe(0);
    expect(counts.pending).toBe(2);

    // Nenhum produto criado pelo sync — só o apply manual pode fazê-lo.
    const created = await db.select({ id: products.id }).from(products).where(sql`${products.name} LIKE ${`%${TAG}%`}`);
    expect(created).toHaveLength(0);

    // A resposta do sync traz o preview (com token) mas o estado é "preview".
    expect(outcome.preview?.status).toBe("preview");
    const [run] = await db.select().from(supplierSourceRuns).where(eq(supplierSourceRuns.id, outcome.runId));
    expect(run.status).toBe("success");
    expect(run.importId).toBe(importId);
  });
});

// ─── B. GET reopen ───────────────────────────────────────

describe("B — reopenSupplierImportPreview devolve o snapshot e um token novo, sem mudar estado", () => {
  it("mapping/summary/rows iguais ao persistido; token novo válido e vinculado; status intacto", async () => {
    const { importId, outcome } = await syncToPreview();
    const before = await importRow(importId);
    const rowsBefore = await snapshotRows(importId);

    const reopened = await reopenSupplierImportPreview(importId);

    expect(reopened.reopened).toBe(true);
    expect(reopened.importId).toBe(importId);
    expect(reopened.supplierId).toBe(supplierId);
    expect(reopened.supplierName).toBe(`${TAG}-Fornecedor`);
    expect(reopened.status).toBe("preview");
    expect(reopened.fileName).toBe(before.fileName);
    expect(reopened.fileHash).toBe(before.fileHash);
    expect(reopened.fileSizeBytes).toBe(before.fileSizeBytes);
    expect(reopened.sourceId).toBe(before.sourceId);
    expect(reopened.sourceLabel).toBe(URL_OK);
    expect(reopened.batchesTotal).toBe(before.batchesTotal);

    // mapping/summary: exatamente o snapshot persistido (nada recalculado).
    expect(reopened.mapping).toEqual(before.mapping);
    expect(reopened.summary).toEqual(before.summary);
    expect(reopened.summary.total).toBe(2);
    expect(reopened.summary.newProducts).toBe(2);
    expect(reopened.summary.actionable).toBe(2);
    expect(reopened.ignoredColumns).toEqual((before.summary as Record<string, unknown>).ignoredColumns);
    expect(reopened.missingProducts).toEqual((before.summary as Record<string, unknown>).missingProducts);

    // rows: mesma ordem, mesmos valores do snapshot.
    expect(reopened.lines).toHaveLength(rowsBefore.length);
    expect(reopened.truncated).toBe(false);
    rowsBefore.forEach((r, i) => {
      const l = reopened.lines[i];
      expect(l.rowNumber).toBe(r.rowNumber);
      expect(l.supplierSku).toBe(r.supplierSku);
      expect(l.ean).toBe(r.ean);
      expect(l.name).toBe(r.name);
      expect(l.status).toBe(r.status);
      expect(l.matchType).toBe(r.matchType);
      expect(l.costPrice).toBe(r.costPrice);
      expect(l.stock).toBe(r.stock);
      expect(l.productId).toBe(r.productId);
      expect(l.computedPrice).toBe(r.computedPrice);
      expect(l.currentPrice).toBe(r.currentPrice);
      expect(l.priceMode).toBe(r.priceMode);
      expect(l.message).toBe(r.message);
      expect(l.isPreferredSupplier).toBe(r.isPreferredSupplier);
    });
    expect(reopened.lines[0].supplierSku).toBe(`${TAG}-R1`);
    expect(reopened.lines[0].costPrice).toBe("10.00");
    expect(reopened.lines[1].costPrice).toBe("12.50");

    // Token: novo (não é o do preview original), mesmo módulo, mesmo binding.
    expect(reopened.previewToken).toBeTruthy();
    expect(reopened.previewToken).not.toBe(outcome.preview!.previewToken);
    const check = verifySupplierImportToken(reopened.previewToken);
    expect(check.valid).toBe(true);
    expect(check.payload!.kind).toBe(SUPPLIER_IMPORT_TOKEN_KIND);
    expect(check.payload!.v).toBe(1);
    expect(tokenMatchesImport(check.payload!, {
      id: importId, supplierId, fileHash: before.fileHash, rowCount: before.rowCount,
    })).toBe(true);
    // Mesmo TTL do preview original.
    expect(check.payload!.exp - check.payload!.iat).toBe(SUPPLIER_IMPORT_TOKEN_TTL_MS);

    // GET não muda estado: header + rows byte a byte iguais.
    const after = await importRow(importId);
    expect(after).toEqual(before);
    expect(await snapshotRows(importId)).toEqual(rowsBefore);
  });

  it("segundo reopen emite outro token válido; ambos vinculam o mesmo import", async () => {
    const { importId } = await syncToPreview();
    const a = await reopenSupplierImportPreview(importId);
    await new Promise((r) => setTimeout(r, 2)); // iat distinto
    const b = await reopenSupplierImportPreview(importId);
    expect(a.previewToken).not.toBe(b.previewToken);
    for (const t of [a.previewToken, b.previewToken]) {
      const c = verifySupplierImportToken(t);
      expect(c.valid).toBe(true);
      expect(c.payload!.importId).toBe(importId);
    }
  });

  it("truncated: snapshot maior do que a janela devolve SUPPLIER_IMPORT_PREVIEW_LIMIT linhas e truncated=true", async () => {
    const n = SUPPLIER_IMPORT_PREVIEW_LIMIT + 5;
    const lines = Array.from({ length: n }, (_, i) => `${TAG}-BIG-${String(i + 1).padStart(4, "0")};Produto ${TAG} ${i + 1};1,00;1`);
    const csv = `skuFornecedor;nome;custo;stock\n${lines.join("\n")}`;
    const preview = await previewSupplierImport({
      supplierId, source: uploadSource({ fileName: `${TAG}-big.csv`, csvText: csv }), userId: USER_ID,
    });
    expect(preview.truncated).toBe(true);

    const reopened = await reopenSupplierImportPreview(preview.importId);
    expect(reopened.truncated).toBe(true);
    expect(reopened.lines).toHaveLength(SUPPLIER_IMPORT_PREVIEW_LIMIT);
    expect(reopened.lines[0].rowNumber).toBe(2);
    expect(reopened.lines[SUPPLIER_IMPORT_PREVIEW_LIMIT - 1].rowNumber).toBe(SUPPLIER_IMPORT_PREVIEW_LIMIT + 1);
    expect(reopened.summary.total).toBe(n);
    // O token vincula o rowCount TOTAL do snapshot, não a janela visível.
    const check = verifySupplierImportToken(reopened.previewToken);
    expect(check.payload!.rowCount).toBe(n);
  });

  it("productSku/productName vêm por LEFT JOIN só para display; o snapshot (product_id) não é reescrito", async () => {
    const [p] = await db.insert(products).values({
      name: `Produto ${TAG} existente`, slug: `md-${TAG.toLowerCase()}-existente`, sku: `${TAG}-EXIST`,
      price: "100.00", vatRate: "23.00", priceMode: "auto", stock: 10, costPrice: "8.00",
      ean: "5901234123457",
    }).returning();
    const preview = await previewSupplierImport({
      supplierId, source: uploadSource({ fileName: `${TAG}-join.csv`, csvText: CSV_REMOTE }), userId: USER_ID,
    });
    expect(preview.lines[0].status).toBe("ready");
    expect(preview.lines[0].productId).toBe(p.id);

    const rowsBefore = await snapshotRows(preview.importId);
    const reopened = await reopenSupplierImportPreview(preview.importId);
    expect(reopened.lines[0].productId).toBe(p.id);
    expect(reopened.lines[0].productSku).toBe(`${TAG}-EXIST`);
    expect(reopened.lines[0].productName).toBe(`Produto ${TAG} existente`);
    expect(reopened.lines[1].productId).toBeNull();
    expect(reopened.lines[1].productSku).toBeNull();
    // Campos lidos "ao vivo" no preview original não fazem parte do snapshot:
    // são devolvidos a null (a UI já guarda contra null), nunca recalculados.
    expect(reopened.lines[0].costBefore).toBeNull();
    expect(reopened.lines[0].stockBefore).toBeNull();
    expect(await snapshotRows(preview.importId)).toEqual(rowsBefore);
  });

  it("segurança: token e segredo da fonte não aparecem em logs, config da fonte, runs nem no import", async () => {
    const { src, importId } = await syncToPreview(
      { authType: "bearer", secretReference: "C342RO_SECRET" },
      { C342RO_SECRET: SECRET_VALUE }
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const reopened = await reopenSupplierImportPreview(importId);
      const token = reopened.previewToken;
      const logged = [...warn.mock.calls, ...error.mock.calls, ...log.mock.calls].map((c) => c.map(String).join(" ")).join("\n");
      expect(logged).not.toContain(token);
      expect(logged).not.toContain(SECRET_VALUE);

      const [source] = await db.select().from(supplierSources).where(eq(supplierSources.id, src.id));
      const sourceJson = JSON.stringify(source);
      expect(sourceJson).not.toContain(token);
      expect(sourceJson).not.toContain(SECRET_VALUE);
      expect(source.secretReference).toBe("C342RO_SECRET"); // só a REFERÊNCIA

      const importsJson = JSON.stringify(await db.select().from(supplierImports).where(eq(supplierImports.id, importId)));
      const rowsJson = JSON.stringify(await snapshotRows(importId));
      const runsJson = JSON.stringify(await db.select().from(supplierSourceRuns).where(eq(supplierSourceRuns.sourceId, src.id)));
      const auditJson = JSON.stringify(await db.select().from(auditLogs).where(eq(auditLogs.userId, USER_ID)));
      for (const blob of [importsJson, rowsJson, runsJson, auditJson]) {
        expect(blob).not.toContain(token); // o token NUNCA é persistido
        expect(blob).not.toContain(SECRET_VALUE);
      }
      // A resposta do reopen também não transporta a configuração da fonte.
      const reopenedJson = JSON.stringify(reopened);
      expect(reopenedJson).not.toContain(SECRET_VALUE);
      expect(reopenedJson).not.toContain("C342RO_SECRET");
    } finally {
      warn.mockRestore();
      error.mockRestore();
      log.mockRestore();
    }
  });
});

// ─── C. Deep-link ────────────────────────────────────────

describe("C — deep-link helper", () => {
  it('supplierImportReviewHref(20) === "/admin/import?open=20"', () => {
    expect(supplierImportReviewHref(20)).toBe("/admin/import?open=20");
    expect(IMPORT_REVIEW_QUERY_PARAM).toBe("open");
  });

  it("recusa ids inválidos e nunca coloca um token na URL", () => {
    expect(() => supplierImportReviewHref(0)).toThrow(RangeError);
    expect(() => supplierImportReviewHref(-1)).toThrow(RangeError);
    expect(() => supplierImportReviewHref(1.5)).toThrow(RangeError);
    expect(() => supplierImportReviewHref(Number.NaN)).toThrow(RangeError);
    expect(supplierImportReviewHref(7)).not.toMatch(/token/i);
  });

  it("parseSupplierImportReviewParam aceita só inteiros positivos", () => {
    expect(parseSupplierImportReviewParam("20")).toBe(20);
    expect(parseSupplierImportReviewParam(" 20 ")).toBe(20);
    expect(parseSupplierImportReviewParam("0")).toBeNull();
    expect(parseSupplierImportReviewParam("-3")).toBeNull();
    expect(parseSupplierImportReviewParam("20abc")).toBeNull();
    expect(parseSupplierImportReviewParam("1e3")).toBeNull();
    expect(parseSupplierImportReviewParam("")).toBeNull();
    expect(parseSupplierImportReviewParam(null)).toBeNull();
    expect(parseSupplierImportReviewParam(undefined)).toBeNull();
  });
});

// ─── D. Apply manual com o token reemitido ───────────────

describe("D — o token reemitido pelo reopen alimenta o Apply C.3.1 existente", () => {
  it("serviço: reopen → applySupplierImport(token novo) → completed, produtos criados uma vez", async () => {
    const { importId } = await syncToPreview();
    const reopened = await reopenSupplierImportPreview(importId);

    const outcome = await applySupplierImport({ importId, previewToken: reopened.previewToken, userId: USER_ID });
    expect(outcome.status).toBe("completed");
    expect(outcome.appliedNow).toBe(2);
    expect(outcome.created).toBe(2);
    expect(outcome.pending).toBe(0);

    const imp = await importRow(importId);
    expect(imp.status).toBe("completed");
    expect(imp.batchesDone).toBe(imp.batchesTotal);
    expect(imp.finishedAt).not.toBeNull();

    const created = await db.select({ id: products.id, sku: products.sku }).from(products).where(sql`${products.name} LIKE ${`%${TAG}%`}`);
    expect(created).toHaveLength(2);
    for (const p of created) expect(p.sku).toMatch(/^MD-\d{6}$/); // SKU interno MDTech, nunca o do fornecedor
    const links = await db.select().from(productSuppliers).where(eq(productSuppliers.supplierId, supplierId));
    expect(links.map((l) => l.supplierSku).sort()).toEqual([`${TAG}-R1`, `${TAG}-R2`]);
  });

  it("HTTP: GET …/preview (staff) → POST /apply (manager + CSRF) com o token devolvido → completed", async () => {
    const { importId } = await syncToPreview();

    getCurrentUserMock.mockResolvedValue(user("staff"));
    const res = await reopenGET(getReq(importId), asId(importId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.importId).toBe(importId);
    expect(body.reopened).toBe(true);
    expect(body.previewToken).toBeTruthy();
    expect(body.lines).toHaveLength(2);

    // O mesmo pedido que o botão "Aplicar" do painel faz: run(importId, previewToken).
    getCurrentUserMock.mockResolvedValue(user("manager"));
    const applied = await applyPOST(applyReq({ importId: body.importId, previewToken: body.previewToken }));
    expect(applied.status).toBe(200);
    const outcome = await applied.json();
    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe("completed");
    expect((await importRow(importId)).status).toBe("completed");
  });

  it("o token reemitido vincula ESTE import: não serve para aplicar outro preview do mesmo fornecedor", async () => {
    const { importId: a } = await syncToPreview();
    const b = await previewSupplierImport({
      supplierId, source: uploadSource({ fileName: `${TAG}-other.csv`, csvText: CSV_MANUAL }), userId: USER_ID,
    });
    const reopenedA = await reopenSupplierImportPreview(a);
    await expectImportError(
      applySupplierImport({ importId: b.importId, previewToken: reopenedA.previewToken, userId: USER_ID }),
      "PREVIEW_TOKEN_MISMATCH", 403
    );
    expect((await importRow(b.importId)).status).toBe("preview"); // nada aplicado
    expect((await importRow(a)).status).toBe("preview");
  });

  it("o preview continua a exigir token: apply sem token depois do reopen é recusado (nada mudou no First Apply)", async () => {
    const { importId } = await syncToPreview();
    await reopenSupplierImportPreview(importId);
    await expectImportError(applySupplierImport({ importId, userId: USER_ID }), "PREVIEW_TOKEN_REQUIRED", 403);
    expect((await importRow(importId)).status).toBe("preview");
  });
});

// ─── E. Reapply / completed ──────────────────────────────

describe("E — completed não é reaplicado; reopen de completed → 409", () => {
  it("segundo apply com o mesmo token é idempotente; reopen recusa com IMPORT_NOT_REOPENABLE", async () => {
    const { importId } = await syncToPreview();
    const reopened = await reopenSupplierImportPreview(importId);
    const first = await applySupplierImport({ importId, previewToken: reopened.previewToken, userId: USER_ID });
    expect(first.status).toBe("completed");

    const again = await applySupplierImport({ importId, previewToken: reopened.previewToken, userId: USER_ID });
    expect(again.status).toBe("completed");
    expect(again.idempotent).toBe(true);
    expect(again.appliedNow).toBe(0);
    expect(again.created).toBe(0);

    const created = await db.select({ id: products.id }).from(products).where(sql`${products.name} LIKE ${`%${TAG}%`}`);
    expect(created).toHaveLength(2); // sem duplicados

    await expectImportError(reopenSupplierImportPreview(importId), "IMPORT_NOT_REOPENABLE", 409);
    expect((await importRow(importId)).status).toBe("completed"); // reopen não mexe no estado

    getCurrentUserMock.mockResolvedValue(user("staff"));
    const res = await reopenGET(getReq(importId), asId(importId));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("IMPORT_NOT_REOPENABLE");
    expect(body.message).toBe(SUPPLIER_IMPORT_MESSAGES.IMPORT_NOT_REOPENABLE);
    expect(body.message).not.toMatch(/sql|select|stack/i);
  });
});

// ─── F. Upload manual CSV ────────────────────────────────

describe("F — preview de upload manual também reabre (reload antes do Apply)", () => {
  it("reopen devolve o snapshot; source_id continua NULL; apply com o token novo → completed", async () => {
    const preview = await previewSupplierImport({
      supplierId, source: uploadSource({ fileName: `${TAG}-manual.csv`, csvText: CSV_MANUAL }), userId: USER_ID,
    });
    expect((await importRow(preview.importId)).sourceId).toBeNull();

    // "Reload": o token original perdeu-se; só o id sobrevive.
    const reopened = await reopenSupplierImportPreview(preview.importId);
    expect(reopened.sourceId).toBeNull();
    expect(reopened.sourceLabel).toBe(`${TAG}-manual.csv`);
    expect(reopened.fileName).toBe(`${TAG}-manual.csv`);
    expect(reopened.lines).toHaveLength(1);
    expect(reopened.lines[0].supplierSku).toBe(`${TAG}-M1`);
    expect(reopened.lines[0].costPrice).toBe("7.00");
    expect(reopened.summary).toEqual(preview.summary);
    expect(reopened.mapping).toEqual(preview.mapping);

    const outcome = await applySupplierImport({ importId: preview.importId, previewToken: reopened.previewToken, userId: USER_ID });
    expect(outcome.status).toBe("completed");
    const after = await importRow(preview.importId);
    expect(after.status).toBe("completed");
    expect(after.sourceId).toBeNull(); // o apply não inventa uma fonte
  });
});

// ─── G. XLSX ─────────────────────────────────────────────

describe("G — preview XLSX reabre e aplica (C.3.3 intacto)", () => {
  it("upload XLSX → reopen (delimiter null, hash dos bytes) → apply → completed", async () => {
    const bytes = buildXlsx([
      ["skuFornecedor", "nome", "custo", "stock", "ean"],
      [`${TAG}-X1`, `Produto ${TAG} X1`, 12.5, 4, "5901234123471"],
      [`${TAG}-X2`, `Produto ${TAG} X2`, 3, 9, ""],
    ]);
    const preview = await previewSupplierImport({
      supplierId, source: uploadSource({ fileName: `${TAG}-lista.xlsx`, xlsxBytes: bytes }), userId: USER_ID,
    });
    expect(preview.delimiter).toBeNull();
    expect(preview.lines).toHaveLength(2);

    const reopened = await reopenSupplierImportPreview(preview.importId);
    expect(reopened.fileHash).toBe(preview.fileHash);
    expect(reopened.delimiter).toBeNull();
    expect(reopened.lines.map((l) => l.supplierSku)).toEqual([`${TAG}-X1`, `${TAG}-X2`]);
    expect(reopened.lines[0].costPrice).toBe("12.50");
    expect(reopened.lines[1].costPrice).toBe("3.00");
    expect(reopened.summary).toEqual(preview.summary);

    const outcome = await applySupplierImport({ importId: preview.importId, previewToken: reopened.previewToken, userId: USER_ID });
    expect(outcome.status).toBe("completed");
    expect(outcome.created).toBe(2);
  });

  it("XLSX remoto (Sync Now com format auto) → preview reabre com o mesmo hash dos bytes", async () => {
    const bytes = buildXlsx([
      ["skuFornecedor", "nome", "custo", "stock"],
      [`${TAG}-RX`, `Produto ${TAG} remoto XLSX`, 5, 2],
    ]);
    const src = await insertSource({ format: "auto" });
    const fetchImpl = (async () => {
      let sent = false;
      return {
        status: 200,
        headers: new Headers({ "content-type": "application/octet-stream" }),
        body: {
          getReader() {
            return {
              async read() {
                if (sent) return { done: true as const, value: undefined };
                sent = true;
                return { done: false as const, value: bytes };
              },
              async cancel() {},
            };
          },
        },
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const outcome = await runSupplierSource(src.id, USER_ID, { fetchImpl, env: {} });
    expect(outcome.status).toBe("success");
    const imp = await importRow(outcome.importId!);
    expect(imp.status).toBe("preview");

    const reopened = await reopenSupplierImportPreview(imp.id);
    expect(reopened.fileHash).toBe(imp.fileHash);
    expect(reopened.sourceId).toBe(src.id);
    expect(reopened.lines[0].supplierSku).toBe(`${TAG}-RX`);
    const applied = await applySupplierImport({ importId: imp.id, previewToken: reopened.previewToken, userId: USER_ID });
    expect(applied.status).toBe("completed");
  });
});

// ─── H. RBAC / erros na rota ─────────────────────────────

describe("H — GET /api/admin/supplier-import/[id]/preview: RBAC e erros seguros", () => {
  it("sem sessão e customer → 403; staff, manager e admin → 200", async () => {
    const { importId } = await syncToPreview();
    for (const role of [null, "customer"] as const) {
      getCurrentUserMock.mockResolvedValue(user(role));
      const res = await reopenGET(getReq(importId), asId(importId));
      expect(res.status).toBe(403);
      expect(JSON.stringify(await res.json())).not.toContain("previewToken");
    }
    for (const role of ["staff", "manager", "admin"]) {
      getCurrentUserMock.mockResolvedValue(user(role));
      const res = await reopenGET(getReq(importId), asId(importId));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.previewToken).toBeTruthy();
      expect(verifySupplierImportToken(body.previewToken).valid).toBe(true);
    }
    // Três GETs não alteraram nada.
    expect((await importRow(importId)).status).toBe("preview");
    expect((await countRows(importId)).applied).toBe(0);
  });

  it("id inválido → 400 INVALID_IMPORT_ID; inexistente → 404 IMPORT_NOT_FOUND", async () => {
    getCurrentUserMock.mockResolvedValue(user("staff"));
    for (const bad of ["abc", "0", "-1", "1.5", "12abc", ""]) {
      const res = await reopenGET(getReq(bad), asId(bad));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("INVALID_IMPORT_ID");
    }
    const missing = await reopenGET(getReq(999999999), asId(999999999));
    expect(missing.status).toBe(404);
    const body = await missing.json();
    expect(body.error).toBe("IMPORT_NOT_FOUND");
    expect(body.message).toBe(supplierImportErrorMessage("IMPORT_NOT_FOUND"));
  });

  it("partial e applying → 409 IMPORT_NOT_REOPENABLE (fluxo de resume); failed → 409 IMPORT_FAILED", async () => {
    getCurrentUserMock.mockResolvedValue(user("staff"));
    for (const status of ["partial", "applying"]) {
      const { importId } = await syncToPreview();
      await db.update(supplierImports).set({ status, heartbeatAt: new Date() }).where(eq(supplierImports.id, importId));
      await expectImportError(reopenSupplierImportPreview(importId), "IMPORT_NOT_REOPENABLE", 409);
      const res = await reopenGET(getReq(importId), asId(importId));
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("IMPORT_NOT_REOPENABLE");
      expect((await importRow(importId)).status).toBe(status); // intacto
    }
    const { importId } = await syncToPreview();
    await db.update(supplierImports).set({ status: "failed", finishedAt: new Date() }).where(eq(supplierImports.id, importId));
    await expectImportError(reopenSupplierImportPreview(importId), "IMPORT_FAILED", 409);
    const res = await reopenGET(getReq(importId), asId(importId));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("IMPORT_FAILED");
    expect(body.message).toBeTruthy();
  });

  it("a rota só expõe GET (apply continua manager + CSRF na rota própria)", async () => {
    const mod = await import("@/app/api/admin/supplier-import/[id]/preview/route");
    expect(typeof mod.GET).toBe("function");
    for (const verb of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect((mod as Record<string, unknown>)[verb]).toBeUndefined();
    }
    // Apply com staff é recusado — reabrir não concede permissão de aplicar.
    const { importId } = await syncToPreview();
    getCurrentUserMock.mockResolvedValue(user("staff"));
    const got = await reopenGET(getReq(importId), asId(importId));
    const { previewToken } = await got.json();
    const denied = await applyPOST(applyReq({ importId, previewToken }));
    expect(denied.status).toBe(403);
    expect((await importRow(importId)).status).toBe("preview");
  });
});

// ─── I. Perfis C.3.2 ─────────────────────────────────────

describe("I — perfis C.3.2 continuam intactos", () => {
  it("preview com saveProfile grava o perfil; reopen não o altera nem o apaga; o preview seguinte reutiliza-o", async () => {
    const first = await previewSupplierImport({
      supplierId, source: uploadSource({ fileName: `${TAG}-perfil-1.csv`, csvText: CSV_MANUAL }), userId: USER_ID, saveProfile: true,
    });
    expect(first.profileUsed).toBe("profile_valid");
    const [profileBefore] = await db.select().from(supplierImportProfiles).where(eq(supplierImportProfiles.supplierId, supplierId));
    expect(profileBefore).toBeTruthy();

    const reopened = await reopenSupplierImportPreview(first.importId);
    expect(reopened.mapping).toEqual(first.mapping);
    const [profileAfter] = await db.select().from(supplierImportProfiles).where(eq(supplierImportProfiles.supplierId, supplierId));
    expect(profileAfter).toEqual(profileBefore);

    const second = await previewSupplierImport({
      supplierId, source: uploadSource({ fileName: `${TAG}-perfil-2.csv`, csvText: CSV_MANUAL }), userId: USER_ID,
    });
    expect(second.profileUsed).toBe("profile_valid");
    expect(second.profileName).toBe(`Perfil #${profileBefore.id}`);
  });
});
