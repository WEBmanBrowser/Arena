/**
 * C.3.4.2 — API administrativa de fontes: contrato HTTP.
 *
 * Espelha o padrão RBAC/CSRF de suppliers/import:
 *  - leitura = staff+; mutações = manager+ com Origin válida (CSRF);
 *  - o corpo do create NUNCA contém nem aceita valor de segredo — só a
 *    referência; a fonte nova nasce desativada mesmo se o client enviar
 *    enabled:true;
 *  - o Sync Now executa o serviço único (aqui mockado para isolar o transporte
 *    — o engine run é coberto por c342-source-run.test.ts) e devolve só
 *    metadados seguros;
 *  - erros tipados viram { error: CODE, message: texto seguro } com o status
 *    mapeado; nunca stack/SQL/segredo.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { supplierSourceRuns, supplierSources, suppliers, users } from "@/db/schema";
import { eq, sql } from "drizzle-orm";

const getCurrentUserMock = vi.fn();
const runSupplierSourceMock = vi.fn();

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getCurrentUser: () => getCurrentUserMock() };
});
vi.mock("@/lib/services/supplier-source-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/services/supplier-source-service")>();
  return { ...actual, runSupplierSource: (...args: unknown[]) => runSupplierSourceMock(...args) };
});

import { GET as collectionGET, POST as collectionPOST } from "@/app/api/admin/supplier-sources/route";
import {
  GET as detailGET,
  PATCH as detailPATCH,
  PUT as detailPUT,
} from "@/app/api/admin/supplier-sources/[id]/route";
import { POST as syncPOST } from "@/app/api/admin/supplier-sources/[id]/sync/route";
import { SupplierSourceError } from "@/lib/supplier-import/source";

const TAG = "C342API";
const USER_ID = 990043;
const URL_OK = `https://supplier.example.com/files/${TAG}.csv`;

function user(role: string | null) {
  if (!role) return null;
  return { id: USER_ID, email: `${TAG}-${role}@test.local`, name: TAG, role, phone: null, nif: null, company: null };
}

function req(url: string, init: { method?: string; body?: unknown; csrf?: boolean } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.csrf !== false) headers.origin = "http://localhost";
  return new NextRequest(new URL(url, "http://localhost").toString(), {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

const asId = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });

let supplierId: number;

beforeEach(async () => {
  getCurrentUserMock.mockReset();
  runSupplierSourceMock.mockReset();
  await db.insert(users).values({ id: USER_ID, email: `${TAG}@test.local`, password: "x", name: TAG, role: "admin" }).onConflictDoNothing();
  const [s] = await db.insert(suppliers).values({ name: `${TAG}-Fornecedor`, isActive: true }).returning();
  supplierId = s.id;
});

async function cleanup() {
  const pattern = `${TAG}-%`;
  await db.execute(sql`DELETE FROM supplier_source_runs WHERE source_id IN (SELECT id FROM supplier_sources WHERE name LIKE ${pattern})`);
  await db.execute(sql`DELETE FROM supplier_sources WHERE name LIKE ${pattern}`);
  await db.execute(sql`DELETE FROM audit_logs WHERE user_id = ${USER_ID}`);
  await db.execute(sql`DELETE FROM suppliers WHERE name LIKE ${pattern}`);
}

afterEach(cleanup);

// ─── RBAC + CSRF ─────────────────────────────────────────

describe("C.3.4.2 — API de fontes: RBAC/CSRF", () => {
  it("leitura exige staff; anónimo e customer são recusados", async () => {
    for (const role of [null, "customer"] as const) {
      getCurrentUserMock.mockResolvedValue(user(role));
      expect((await collectionGET(req(`/api/admin/supplier-sources?supplierId=${supplierId}`))).status).toBe(403);
      expect((await detailGET(req("/api/admin/supplier-sources/1"), asId(1))).status).toBe(403);
    }
    getCurrentUserMock.mockResolvedValue(user("staff"));
    const res = await collectionGET(req(`/api/admin/supplier-sources?supplierId=${supplierId}`));
    expect(res.status).toBe(200);
    expect(Array.isArray((await res.json()).sources)).toBe(true);
  });

  it("mutações exigem manager (staff 403) e Origin válida (sem CSRF 403)", async () => {
    getCurrentUserMock.mockResolvedValue(user("staff"));
    expect((await collectionPOST(req("/api/admin/supplier-sources", { method: "POST", body: {} }))).status).toBe(403);

    getCurrentUserMock.mockResolvedValue(user("manager"));
    const noCsrf = req("/api/admin/supplier-sources", { method: "POST", body: {}, csrf: false });
    expect((await collectionPOST(noCsrf)).status).toBe(403);
    const noCsrfSync = req("/api/admin/supplier-sources/1/sync", { method: "POST", csrf: false });
    expect((await syncPOST(noCsrfSync, asId(1))).status).toBe(403);
    const noCsrfPut = req("/api/admin/supplier-sources/1", { method: "PUT", body: {}, csrf: false });
    expect((await detailPUT(noCsrfPut, asId(1))).status).toBe(403);
    const noCsrfPatch = req("/api/admin/supplier-sources/1", { method: "PATCH", body: { enabled: true }, csrf: false });
    expect((await detailPATCH(noCsrfPatch, asId(1))).status).toBe(403);
  });

  it("GET ?supplierId inválido → 400; GET fonte inexistente → 404", async () => {
    getCurrentUserMock.mockResolvedValue(user("staff"));
    expect((await collectionGET(req("/api/admin/supplier-sources?supplierId=abc"))).status).toBe(400);
    const missing = await detailGET(req("/api/admin/supplier-sources/999999999"), asId(999999999));
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBe("SOURCE_NOT_FOUND");
  });
});

// ─── CRUD de fontes ──────────────────────────────────────

describe("C.3.4.2 — create/edit/enable via API", () => {
  const createBody = (over: Record<string, unknown> = {}) => ({
    supplierId,
    name: `${TAG}-Lista diária`,
    url: URL_OK,
    format: "auto",
    authType: "bearer",
    secretReference: "SUPPLIER_SRC_1_TOKEN",
    ...over,
  });

  it("create: manager pode; fonte nasce DESATIVADA; a resposta nunca traz valor de segredo", async () => {
    getCurrentUserMock.mockResolvedValue(user("manager"));
    const res = await collectionPOST(req("/api/admin/supplier-sources", { method: "POST", body: { ...createBody(), enabled: true, applyPolicy: "auto_if_clean" } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source.enabled).toBe(false); // enabled recebido é IGNORADO
    expect(body.source.applyPolicy).toBe("preview_only"); // política não é editável
    expect(body.source.secretReference).toBe("SUPPLIER_SRC_1_TOKEN"); // só a referência
    const [row] = await db.select().from(supplierSources).where(eq(supplierSources.id, body.source.id));
    expect(row.username).toBeNull();
    expect(row.url).toBe(URL_OK);
    expect(row.sourceType).toBe("url");
  });

  it("validações de URL/segurança: http, userinfo, localhost e Authorization em headers_config são recusados com 400", async () => {
    getCurrentUserMock.mockResolvedValue(user("manager"));
    for (const over of [
      { url: "http://supplier.example.com/x.csv" },
      { url: "https://user:pw@supplier.example.com/x.csv" },
      { url: "https://supplier.example.com/x.csv?token=abc" }, // query proibida (fail-closed C.3.4.2)
      { url: "https://supplier.example.com/x.csv#planilha" }, // fragmento proibido
      { url: "https://localhost:8443/x.csv" },
      { url: "https://169.254.169.254/latest.csv" },
      { authType: "bearer", secretReference: undefined }, // bearer sem secret_reference
      { authType: "basic", username: undefined }, // basic exige username
      { authType: "header", headersConfig: { Authorization: "secret aqui NÃO" } }, // valor secreto na config
      { headersConfig: { cookie: "sid=x" } }, // header reservado
      { secretReference: "lowercase_secret" }, // nome de env tem de ser canónico
    ]) {
      const res = await collectionPOST(req("/api/admin/supplier-sources", { method: "POST", body: createBody(over) }));
      expect(res.status, JSON.stringify(over)).toBe(400);
    }
  });

  it("C.3.4.2 fix — URL com query: 400 SEM ecoar o token; PUT recusa; nada é gravado", async () => {
    getCurrentUserMock.mockResolvedValue(user("manager"));
    const res = await collectionPOST(
      req("/api/admin/supplier-sources", { method: "POST", body: createBody({ url: "https://supplier.example.com/feed.csv?token=TOKEN-NAO-ECOAR" }) })
    );
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain("TOKEN-NAO-ECOAR"); // o corpo do erro nunca ecoa a query
    expect(text).not.toContain("supplier.example.com");
    expect(text).toContain("query"); // mensagem humana estática da guarda

    // e a fonte não foi criada
    const [countRow] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(supplierSources)
      .where(sql`name = ${`${TAG}-Lista diária`}`);
    expect(countRow.n).toBe(0);

    // PUT com query é recusado e mantém o valor anterior
    const created = await (await collectionPOST(req("/api/admin/supplier-sources", { method: "POST", body: createBody() }))).json();
    const sourceId = created.source.id as number;
    const badPut = await detailPUT(
      req(`/api/admin/supplier-sources/${sourceId}`, { method: "PUT", body: { url: "https://supplier.example.com/feed.csv?k=v" } }),
      asId(sourceId)
    );
    expect(badPut.status).toBe(400);
    const [row] = await db.select().from(supplierSources).where(eq(supplierSources.id, sourceId));
    expect(row.url).toBe(URL_OK);

    // PATCH enable revalida: linha inválida injetada na BD não é ativável
    const [raw] = await db
      .insert(supplierSources)
      .values({ supplierId, name: `${TAG}-QueryRaw`, sourceType: "url", url: "https://supplier.example.com/x.csv?token=dbonly", enabled: false })
      .returning();
    const denied = await detailPATCH(req(`/api/admin/supplier-sources/${raw.id}`, { method: "PATCH", body: { enabled: true } }), asId(raw.id));
    expect(denied.status).toBe(400);
  });

  it("PUT edit muda config mas NÃO enabled; auth→none limpa secret_reference; estado final é revalidado", async () => {
    getCurrentUserMock.mockResolvedValue(user("manager"));
    const created = await (await collectionPOST(req("/api/admin/supplier-sources", { method: "POST", body: createBody() }))).json();
    const sourceId = created.source.id as number;
    await db.update(supplierSources).set({ enabled: true }).where(eq(supplierSources.id, sourceId));

    const res = await detailPUT(
      req(`/api/admin/supplier-sources/${sourceId}`, {
        method: "PUT",
        body: { name: `${TAG}-Renomeada`, authType: "none", secretReference: null, enabled: false },
      }),
      asId(sourceId)
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source.name).toBe(`${TAG}-Renomeada`);
    expect(body.source.enabled).toBe(true); // PUT nunca toca em enabled
    expect(body.source.authType).toBe("none");
    expect(body.source.secretReference).toBeNull();

    // estado final inválido (bearer sem secret) é recusado ANTES de gravar
    const bad = await detailPUT(req(`/api/admin/supplier-sources/${sourceId}`, { method: "PUT", body: { authType: "bearer" } }), asId(sourceId));
    expect(bad.status).toBe(400);
  });

  it("PATCH enable: valida a URL com as guardas puras ao ativar (CHECK do schema não basta)", async () => {
    getCurrentUserMock.mockResolvedValue(user("manager"));
    // linha com https://localhost passa o CHECK '^https://' da BD mas falha a guarda:
    const [evil] = await db
      .insert(supplierSources)
      .values({ supplierId, name: `${TAG}-Evil`, sourceType: "url", url: "https://localhost/x.csv", enabled: false })
      .returning();
    const denied = await detailPATCH(req(`/api/admin/supplier-sources/${evil.id}`, { method: "PATCH", body: { enabled: true } }), asId(evil.id));
    expect(denied.status).toBe(400);
    expect((await denied.json()).error).toBe("SOURCE_URL_LOCAL_HOST");

    const [legacy] = await db
      .insert(supplierSources)
      .values({ supplierId, name: `${TAG}-OK`, sourceType: "url", url: URL_OK, enabled: false })
      .returning();
    const ok = await detailPATCH(req(`/api/admin/supplier-sources/${legacy.id}`, { method: "PATCH", body: { enabled: true } }), asId(legacy.id));
    expect(ok.status).toBe(200);
    expect((await ok.json()).source.enabled).toBe(true);
  });

  it("nome duplicado por fornecedor → 409 SOURCE_NAME_EXISTS (sem vazar o erro do Postgres)", async () => {
    getCurrentUserMock.mockResolvedValue(user("manager"));
    await collectionPOST(req("/api/admin/supplier-sources", { method: "POST", body: createBody() }));
    const dup = await collectionPOST(req("/api/admin/supplier-sources", { method: "POST", body: createBody() }));
    expect(dup.status).toBe(409);
    const body = await dup.json();
    expect(body.error).toBe("SOURCE_NAME_EXISTS");
    expect(JSON.stringify(body)).not.toMatch(/duplicate key|constraint/i);
  });
});

// ─── Sync Now via API ────────────────────────────────────

describe("C.3.4.2 — POST /sync (ligação à rota + serviço único)", () => {
  it("manager passa; a resposta é o resumo da run (sem segredos, sem corpo remoto)", async () => {
    getCurrentUserMock.mockResolvedValue(user("manager"));
    runSupplierSourceMock.mockResolvedValue({
      runId: 5,
      status: "success",
      noChangeReason: undefined,
      httpStatus: 200,
      durationMs: 42,
      importId: 77,
      rowCount: 10,
      newCount: 3,
      updatedCount: 7,
      missingCount: 0,
      etag: '"v3"',
      lastModified: null,
      fileHash: "abc",
      preview: { importId: 77, fileName: URL_OK, status: "preview", truncated: false, summary: { total: 10 } },
    });
    const res = await syncPOST(req(`/api/admin/supplier-sources/1/sync`, { method: "POST" }), asId(1));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.run.status).toBe("success");
    expect(body.run.importId).toBe(77);
    expect(body.run.previewSummary.fileName).toBe(URL_OK);
    expect(body.run.previewSummary.lines).toBeUndefined(); // nunca o dump do snapshot pela rota sync
    expect(runSupplierSourceMock).toHaveBeenCalledWith(1, USER_ID);
  });

  it("erros do serviço viram código estável + status mapeado (409/502), sem internals", async () => {
    getCurrentUserMock.mockResolvedValue(user("admin"));
    runSupplierSourceMock.mockRejectedValueOnce(new SupplierSourceError("SOURCE_ALREADY_RUNNING", 409));
    const conflict = await syncPOST(req("/api/admin/supplier-sources/1/sync", { method: "POST" }), asId(1));
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error).toBe("SOURCE_ALREADY_RUNNING");

    runSupplierSourceMock.mockRejectedValueOnce(new SupplierSourceError("SOURCE_HTTP_401", 502));
    const unauthorized = await syncPOST(req("/api/admin/supplier-sources/1/sync", { method: "POST" }), asId(1));
    expect(unauthorized.status).toBe(502);
    const body = await unauthorized.json();
    expect(body.error).toBe("SOURCE_HTTP_401");
    expect(body.message).toContain("401"); // a frase humana da tabela partilhada

    runSupplierSourceMock.mockRejectedValueOnce(new Error("SELECT secret_connection_string FAILED"));
    const boom = await syncPOST(req("/api/admin/supplier-sources/1/sync", { method: "POST" }), asId(1));
    expect(boom.status).toBe(500);
    const boomBody = await boom.json();
    expect(boomBody.error).toBe("SOURCE_RUN_FAILED");
    expect(JSON.stringify(boomBody)).not.toContain("SELECT");
  });

  it("customer não sincroniza; fonte inexistente é 404 (sem corrida ao serviço)", async () => {
    getCurrentUserMock.mockResolvedValue(user("customer"));
    expect((await syncPOST(req("/api/admin/supplier-sources/1/sync", { method: "POST" }), asId(1))).status).toBe(403);

    getCurrentUserMock.mockResolvedValue(user("manager"));
    const badId = await syncPOST(req("/api/admin/supplier-sources/0/sync", { method: "POST" }), asId("0"));
    expect(badId.status).toBe(404);
    expect(runSupplierSourceMock).not.toHaveBeenCalled();
  });
});

// ─── Detalhe: histórico mínimo + estado ──────────────────

describe("C.3.4.2 — GET detalhe expõe último estado/histórico", () => {
  it("runs recentes e activeRun (running fresca) chegam à UI de forma segura", async () => {
    getCurrentUserMock.mockResolvedValue(user("staff"));
    const [src] = await db
      .insert(supplierSources)
      .values({ supplierId, name: `${TAG}-Hist`, sourceType: "url", url: URL_OK, enabled: true, lastHttpStatus: 200, lastRowCount: 4 })
      .returning();
    const [older] = await db.insert(supplierSourceRuns).values({ sourceId: src.id, status: "success", httpStatus: 200, rowCount: 4 }).returning();
    await db.update(supplierSourceRuns).set({ startedAt: new Date(Date.now() - 3600_000), finishedAt: new Date(Date.now() - 3600_000 + 500) }).where(eq(supplierSourceRuns.id, older.id));
    await db.insert(supplierSourceRuns).values({ sourceId: src.id, status: "running" });

    const res = await detailGET(req(`/api/admin/supplier-sources/${src.id}`), asId(src.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source.lastRowCount).toBe(4);
    expect(body.runs).toHaveLength(2);
    expect(body.runs[0].status).toBe("running"); // mais recente primeiro
    expect(body.activeRun?.status).toBe("running");

    // run fechada → activeRun null
    await db.update(supplierSourceRuns).set({ status: "success", finishedAt: new Date() }).where(eq(supplierSourceRuns.status, "running"));
    const closed = await (await detailGET(req(`/api/admin/supplier-sources/${src.id}`), asId(src.id))).json();
    expect(closed.activeRun).toBeNull();
    expect(closed.runs[0].status).toBe("success");
  });
});
