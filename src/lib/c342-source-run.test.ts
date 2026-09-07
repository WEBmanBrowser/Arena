/**
 * C.3.4.2 — runSupplierSource: orquestração do motor EXISTENTE sobre uma
 * fonte HTTPS remota (BD real via runner; transporte 100% mockado).
 *
 * O que estas testes fixam:
 *  1. sucesso: fetch 200 → preview persistido pelo motor C.3.1/C.3.2/C.3.3,
 *     supplier_imports com source_id + source_label + http_etag/http_last_modified,
 *     run `success` com contagens/estado, `last_*` da fonte atualizados;
 *  2. idempotência: mesmo ETag → 304 pedido e run `no_change` (sem preview);
 *     mesmo HASH com HTTP 200 → run `no_change` e validadores NOVOS guardados;
 *     conteúdo diferente → preview novo (o fileHash histórico não se toca);
 *  3. concorrência: dois Sync Now simultâneos → exatamente um claim
 *     (SOURCE_ALREADY_RUNNING para o outro), decidido no Postgres;
 *  4. erros: códigos seguros em run + fonte; segredo ausente NUNCA chega a
 *     haver rede; mensagens sem segredos; apply NUNCA acontece automaticamente;
 *  5. fonte desativada não sincroniza (SOURCE_DISABLED, sem run).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import * as XLSX from "@e965/xlsx";
import { db } from "@/db";
import {
  supplierImports,
  supplierSourceRuns,
  supplierSources,
  suppliers,
  users,
} from "@/db/schema";
import { desc, eq, sql } from "drizzle-orm";
import {
  runSupplierSource,
  safeRunError,
  updateSupplierSource,
} from "@/lib/services/supplier-source-service";
import { SupplierSourceError, sourceSha256Hex } from "@/lib/supplier-import/source";
import { previewSupplierImport } from "@/lib/services/supplier-import-service";
import { uploadSource } from "@/lib/supplier-import/source";

const TAG = "C342R";
const USER_ID = 990042;
const URL_OK = `https://supplier.example.com/files/${TAG}.csv`;
const SECRET_VALUE = "c342-super-sekret";

const CSV_A = `skuFornecedor;nome;custo;stock;ean\n${TAG}-A;Produto A;10,00;5;5901234123457`;
const CSV_B = `skuFornecedor;nome;custo;stock;ean\n${TAG}-B;Produto B;11,00;6;5901234123464`;

let supplierId: number;

async function cleanup() {
  const pattern = `${TAG}-%`;
  await db.execute(sql`DELETE FROM supplier_source_runs WHERE source_id IN (SELECT id FROM supplier_sources WHERE name LIKE ${pattern})`);
  await db.execute(sql`DELETE FROM supplier_sources WHERE name LIKE ${pattern}`);
  await db.execute(sql`DELETE FROM supplier_import_rows WHERE import_id IN (SELECT id FROM supplier_imports WHERE file_name LIKE ${`%${TAG}%`} OR source_label LIKE ${`%${TAG}%`})`);
  await db.execute(sql`DELETE FROM supplier_imports WHERE source_label LIKE ${`%${TAG}%`} OR file_name LIKE ${`%${TAG}%`}`);
  await db.execute(sql`DELETE FROM product_suppliers WHERE product_id IN (SELECT id FROM products WHERE sku LIKE ${pattern})`);
  await db.execute(sql`DELETE FROM products WHERE sku LIKE ${pattern}`);
}

beforeAll(async () => {
  await db.insert(users).values({
    id: USER_ID, email: `${TAG}@example.test`, password: "x", name: TAG, role: "admin",
  }).onConflictDoNothing();
  const [s] = await db.insert(suppliers).values({ name: `${TAG}-Fornecedor`, isActive: true }).returning();
  supplierId = s.id;
});

beforeEach(cleanup);

afterAll(async () => {
  await cleanup();
  await db.execute(sql`DELETE FROM audit_logs WHERE user_id = ${USER_ID}`);
  await db.execute(sql`DELETE FROM suppliers WHERE name LIKE ${`${TAG}-%`}`);
  await db.execute(sql`DELETE FROM users WHERE id = ${USER_ID}`);
});

// ─── stub de transporte (o contrato que fetchSource consome) ───

interface StubResponse {
  status: number;
  headers: Headers;
  body: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> } } | null;
}

function response(
  status: number,
  opts: { headers?: Record<string, string>; text?: string; bytes?: Uint8Array } = {}
): StubResponse {
  const headers = new Headers(opts.headers ?? {});
  const bytes = opts.bytes ?? (opts.text === undefined ? undefined : new TextEncoder().encode(opts.text));
  const body = bytes
    ? {
        getReader() {
          let sent = false;
          return {
            async read() {
              if (sent) return { done: true as const, value: undefined };
              sent = true;
              return { done: false as const, value: bytes };
            },
            async cancel() {},
          };
        },
      }
    : null;
  return { status, headers, body };
}

type Stub = (url: string, init: { headers?: Record<string, string>; signal?: AbortSignal }, call: number) => StubResponse | Promise<StubResponse>;

function stubFetch(stub: Stub) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (input: unknown, init: unknown) => {
    const i = init as { headers?: Record<string, string> };
    const headers = { ...(i.headers ?? {}) };
    calls.push({ url: String(input), headers });
    const result = await stub(String(input), { headers, signal: (i as { signal?: AbortSignal }).signal }, calls.length - 1);
    return result as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

async function insertSource(over: Partial<typeof supplierSources.$inferInsert> = {}) {
  const [row] = await db
    .insert(supplierSources)
    .values({
      supplierId,
      name: `${TAG}-Fonte ${Math.random().toString(36).slice(2, 8)}`,
      sourceType: "url",
      url: URL_OK,
      format: "csv",
      authType: "none",
      enabled: true,
      ...over,
    })
    .returning();
  return row;
}

const expectRejected = async (promise: Promise<unknown>, code: string) => {
  let caught: unknown;
  try {
    await promise;
    throw new Error(`expected rejection ${code}`);
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(SupplierSourceError);
  expect((caught as SupplierSourceError).code).toBe(code);
  return caught as SupplierSourceError;
};

// ─── 1. Caminho feliz: fetch → preview do motor ──────────

describe("C.3.4.2 — runSupplierSource sucesso (motor único reutilizado)", () => {
  it("200 CSV → preview persistido; import com source_id/label/etag; run e last_* atualizados", async () => {
    const src = await insertSource();
    const { fetchImpl, calls } = stubFetch(() =>
      response(200, { headers: { etag: '"v1"', "last-modified": "Mon, 07 Sep 2026 10:00:00 GMT" }, text: CSV_A })
    );
    const outcome = await runSupplierSource(src.id, USER_ID, { fetchImpl, env: {} });
    expect(outcome.status).toBe("success");
    expect(outcome.importId).toBeTypeOf("number");
    expect(outcome.rowCount).toBe(1);
    expect(calls[0].headers["accept-encoding"]).toBe("identity");

    const [imp] = await db.select().from(supplierImports).where(eq(supplierImports.id, outcome.importId!)).limit(1);
    expect(imp.sourceId).toBe(src.id); // ligação import ↔ fonte
    expect(imp.sourceLabel).toBe(URL_OK); // snapshot do nome da fonte
    expect(imp.httpEtag).toBe('"v1"');
    expect(imp.httpLastModified).toBe("Mon, 07 Sep 2026 10:00:00 GMT");
    expect(imp.status).toBe("preview"); // NUNCA aplicado automaticamente
    expect(imp.fileName).toBe(URL_OK.slice(0, 255));

    const [run] = await db.select().from(supplierSourceRuns).where(eq(supplierSourceRuns.id, outcome.runId)).limit(1);
    expect(run.status).toBe("success");
    expect(run.httpStatus).toBe(200);
    expect(run.etag).toBe('"v1"');
    expect(run.importId).toBe(imp.id);
    expect(run.rowCount).toBe(1);
    expect(run.newCount).toBe(1); // linha nova (nada no catálogo)
    expect(run.errorCode).toBeNull();
    expect(run.finishedAt).not.toBeNull();
    expect(run.durationMs).toBeGreaterThanOrEqual(0);

    const [after] = await db.select().from(supplierSources).where(eq(supplierSources.id, src.id)).limit(1);
    expect(after.lastCheckedAt).not.toBeNull();
    expect(after.lastSuccessAt).not.toBeNull();
    expect(after.lastErrorCode).toBeNull();
    expect(after.lastErrorMessage).toBeNull();
    expect(after.lastDurationMs).toBeGreaterThanOrEqual(0);
    expect(after.lastRowCount).toBe(1);
    expect(after.lastHttpStatus).toBe(200);
    expect(after.lastEtag).toBe('"v1"');
    expect(after.lastModified).toBe("Mon, 07 Sep 2026 10:00:00 GMT");
  });

  it("200 XLSX remoto (bytes reais, format auto): deteta OOXML e passa pelo dispatcher C.3.3", async () => {
    const ws: any = {};
    const cells: Array<Array<string | number>> = [
      ["skuFornecedor", "nome", "custo", "stock", "ean"],
      [`${TAG}-X`, "Produto X", 12.5, 4, "5901234123471"],
    ];
    cells.forEach((row, r) =>
      row.forEach((v, c) => { ws[XLSX.utils.encode_cell({ r, c })] = typeof v === "number" ? { t: "n", v } : { t: "s", v }; })
    );
    ws["!ref"] = "A1:E2";
    const xlsxBytes = new Uint8Array(XLSX.write({ SheetNames: ["Lista"], Sheets: { Lista: ws } }, { type: "buffer", bookType: "xlsx" }));
    // Assinatura ZIP que o sniffing do auto tem de encontrar:
    expect(Array.from(xlsxBytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);

    const src = await insertSource({ format: "auto" });
    const outcome = await runSupplierSource(src.id, USER_ID, {
      fetchImpl: stubFetch(() => response(200, { headers: { "content-type": "application/octet-stream" }, bytes: xlsxBytes })).fetchImpl,
      env: {},
    });
    expect(outcome.status).toBe("success");
    const [imp] = await db.select().from(supplierImports).where(eq(supplierImports.id, outcome.importId!));
    expect(imp.fileHash).toBe(sourceSha256Hex({ kind: "url", label: "x", format: "xlsx", bytes: xlsxBytes }));
    expect(imp.sourceId).toBe(src.id);
    const lineRes = await db.execute(sql`SELECT supplier_sku FROM supplier_import_rows WHERE import_id = ${imp.id} LIMIT 1`);
    const lineRows = (lineRes as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? [];
    expect(lineRows[0]?.supplier_sku).toBe(`${TAG}-X`);
  });

  it("o preview de um run usa o PERFIL do fornecedor (C.3.2) e o token de apply é emitido — mas apply não corre", async () => {
    const src = await insertSource();
    const { fetchImpl } = stubFetch(() => response(200, { text: CSV_A }));
    const outcome = await runSupplierSource(src.id, USER_ID, { fetchImpl, env: {} });
    expect(outcome.preview?.previewToken).toBeTruthy();
    expect(outcome.preview?.profileUsed).toBe("no_profile");
    const [imp] = await db.select({ status: supplierImports.status }).from(supplierImports).where(eq(supplierImports.id, outcome.importId!));
    expect(imp.status).toBe("preview"); // humano tem de rever e aplicar
  });
});

// ─── 2. Idempotência: ETag/304 + hash ────────────────────

describe("C.3.4.2 — idempotência (304 e hash)", () => {
  const countImports = (sourceId: number) =>
    db.select({ c: sql<number>`count(*)::int` }).from(supplierImports).where(eq(supplierImports.sourceId, sourceId));

  it("ETag guardado → pedido envia If-None-Match; 304 → run no_change SEM preview e catálogo intacto", async () => {
    const src = await insertSource({ lastEtag: '"v1"' });
    const { fetchImpl, calls } = stubFetch((url, init) =>
      init.headers?.["if-none-match"] === '"v1"' ? response(304) : response(200, { text: CSV_A })
    );
    const before = await db.select().from(supplierSources).where(eq(supplierSources.id, src.id));
    const outcome = await runSupplierSource(src.id, USER_ID, { fetchImpl, env: {} });

    expect(calls[0].headers["if-none-match"]).toBe('"v1"');
    expect(outcome.status).toBe("no_change");
    expect(outcome.noChangeReason).toBe("http_304");
    expect(outcome.importId).toBeNull();
    expect((await countImports(src.id))[0].c).toBe(0); // nenhum preview duplicado

    const [run] = await db.select().from(supplierSourceRuns).where(eq(supplierSourceRuns.id, outcome.runId));
    expect(run.status).toBe("no_change");
    expect(run.httpStatus).toBe(304);
    expect(run.importId).toBeNull();

    const after = await db.select().from(supplierSources).where(eq(supplierSources.id, src.id));
    expect(after[0].lastCheckedAt).not.toBeNull(); // check registado
    expect(after[0].lastSuccessAt).toEqual(before[0].lastSuccessAt); // coerente: sem conteúdo novo
    expect(after[0].lastHttpStatus).toBe(304);
    expect(after[0].lastEtag).toBe('"v1"'); // validadores mantidos
  });

  it("HTTP 200 com o MESMO hash do último snapshot → no_change; ETag novo é guardado", async () => {
    const src = await insertSource();
    const first = stubFetch(() => response(200, { headers: { etag: '"v1"' }, text: CSV_A }));
    const r1 = await runSupplierSource(src.id, USER_ID, { fetchImpl: first.fetchImpl, env: {} });
    expect(r1.status).toBe("success");

    // Servidor não suporta a condicionante e responde 200 com bytes idênticos
    // (só o ETag mudou): a verificação final é o HASH — não se cria preview.
    const second = stubFetch(() => response(200, { headers: { etag: '"v2"' }, text: CSV_A }));
    const r2 = await runSupplierSource(src.id, USER_ID, { fetchImpl: second.fetchImpl, env: {} });
    expect(r2.status).toBe("no_change");
    expect(r2.noChangeReason).toBe("content_hash");
    expect(r2.importId).toBe(r1.importId); // a run aponta para o snapshot anterior

    expect((await countImports(src.id))[0].c).toBe(1); // exatamente 1 import

    const [after] = await db.select().from(supplierSources).where(eq(supplierSources.id, src.id));
    expect(after.lastEtag).toBe('"v2"'); // validadores NOVOS de uma resposta válida
    const [run] = await db.select().from(supplierSourceRuns).where(eq(supplierSourceRuns.id, r2.runId));
    expect(run.status).toBe("no_change");
    expect(run.etag).toBe('"v2"');
    expect(run.importId).toBe(r1.importId);
  });

  it("conteúdo DIFERENTE → novo preview (o snapshot antigo fica intacto)", async () => {
    const src = await insertSource();
    const r1 = await runSupplierSource(src.id, USER_ID, {
      fetchImpl: stubFetch(() => response(200, { text: CSV_A })).fetchImpl,
      env: {},
    });
    const [imp1] = await db.select().from(supplierImports).where(eq(supplierImports.id, r1.importId!));

    const r2 = await runSupplierSource(src.id, USER_ID, {
      fetchImpl: stubFetch(() => response(200, { headers: { etag: '"v2"' }, text: CSV_B })).fetchImpl,
      env: {},
    });
    expect(r2.status).toBe("success");
    expect(r2.importId).not.toBe(r1.importId);
    expect((await countImports(src.id))[0].c).toBe(2);

    const [imp1After] = await db.select().from(supplierImports).where(eq(supplierImports.id, r1.importId!));
    expect(imp1After.fileHash).toBe(imp1.fileHash); // fileHash histórico NUNCA alterado
    expect(imp1After.sourceLabel).toBe(URL_OK);
  });

  it("o upload manual continua sem fonte: source_id NULL (não é preciso criar supplier_source)", async () => {
    const preview = await previewSupplierImport({
      supplierId,
      source: uploadSource({ fileName: `${TAG}-manual.csv`, csvText: CSV_A }),
      userId: USER_ID,
    });
    const [row] = await db.select().from(supplierImports).where(eq(supplierImports.id, preview.importId));
    expect(row.sourceId).toBeNull();
    expect(row.httpEtag).toBeNull();
    expect(row.sourceLabel).toBe(`${TAG}-manual.csv`);
  });
});

// ─── 3. Concorrência (claim em Postgres) ──────────────────

describe("C.3.4.2 — claim de execução", () => {
  it("dois Sync Now simultâneos: exatamente 1 claim; o outro recebe SOURCE_ALREADY_RUNNING", async () => {
    const src = await insertSource();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { fetchImpl, calls } = stubFetch(async () => {
      await gate; // o vencedor fica em "rede" até ao segundo claim
      return response(200, { text: CSV_A });
    });

    const winner = runSupplierSource(src.id, USER_ID, { fetchImpl, env: {} });
    await waitUntil(() => calls.length >= 1); // o 1.º já fez o claim e foi para a rede
    const loser = runSupplierSource(src.id, USER_ID, { fetchImpl, env: {} });
    await expectRejected(loser, "SOURCE_ALREADY_RUNNING");
    release();
    const outcome = await winner;
    expect(outcome.status).toBe("success");

    const runs = await db.select().from(supplierSourceRuns).where(eq(supplierSourceRuns.sourceId, src.id));
    expect(runs).toHaveLength(1); // a perda do claim não cria run fantasma
    expect(runs[0].status).toBe("success");
  });

  it("após fechar a run (success/no_change/error), a fonte volta a poder sincronizar", async () => {
    const src = await insertSource();
    await runSupplierSource(src.id, USER_ID, { fetchImpl: stubFetch(() => response(200, { text: CSV_A })).fetchImpl, env: {} });
    const again = await runSupplierSource(src.id, USER_ID, { fetchImpl: stubFetch(() => response(200, { text: CSV_B })).fetchImpl, env: {} });
    expect(again.status).toBe("success");
  });

  it("uma run 'running' presa por crash deixa de bloquear após a janela de stale", async () => {
    const src = await insertSource();
    await db.insert(supplierSourceRuns).values({ sourceId: src.id, status: "running", startedAt: new Date(Date.now() - 10 * 60 * 1000) });
    const outcome = await runSupplierSource(src.id, USER_ID, { fetchImpl: stubFetch(() => response(200, { text: CSV_A })).fetchImpl, env: {} });
    expect(outcome.status).toBe("success"); // reclaim do zombie permitiu continuar
  });
});

// ─── 4. Auth, erros e segurança ──────────────────────────

describe("C.3.4.2 — auth e erros seguros no run", () => {
  it("bearer: segredo só do env entra no pedido; nunca é devolvido nem persistido", async () => {
    const src = await insertSource({ authType: "bearer", secretReference: "C342_SECRET" });
    const { fetchImpl, calls } = stubFetch(() => response(200, { text: CSV_A }));
    const outcome = await runSupplierSource(src.id, USER_ID, { fetchImpl, env: { C342_SECRET: SECRET_VALUE } });
    expect(outcome.status).toBe("success");
    expect(calls[0].headers.authorization).toBe(`Bearer ${SECRET_VALUE}`);

    const persisted = JSON.stringify(await db.select().from(supplierSourceRuns).where(eq(supplierSourceRuns.sourceId, src.id)));
    const imported = JSON.stringify(await db.select().from(supplierImports).where(eq(supplierImports.sourceId, src.id)));
    const [row] = await db.select().from(supplierSources).where(eq(supplierSources.id, src.id));
    expect(persisted).not.toContain(SECRET_VALUE);
    expect(imported).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(row)).not.toContain(SECRET_VALUE);
    expect(row.secretReference).toBe("C342_SECRET"); // apenas a REFERÊNCIA na BD
  });

  it("defense in depth: row com query na URL injetada DIRETAMENTE na BD é recusada antes da rede", async () => {
    // Contorna a API de propósito: mesmo assim o fetch tem de recusar.
    const src = await insertSource({ url: `https://supplier.example.com/files/${TAG}.csv?token=SEGREDO-NA-QUERY` });
    const { fetchImpl, calls } = stubFetch(() => response(200, { text: CSV_A }));
    await expectRejected(runSupplierSource(src.id, USER_ID, { fetchImpl, env: {} }), "SOURCE_URL_QUERY_NOT_ALLOWED");
    expect(calls).toHaveLength(0); // zero rede

    const [run] = await db.select().from(supplierSourceRuns).where(eq(supplierSourceRuns.sourceId, src.id)).orderBy(desc(supplierSourceRuns.id)).limit(1);
    expect(run.status).toBe("error");
    expect(run.errorCode).toBe("SOURCE_URL_QUERY_NOT_ALLOWED");
    expect(run.errorMessage).toBeTruthy();
    expect(run.errorMessage!).not.toContain("SEGREDO-NA-QUERY");
    expect(run.errorMessage!).not.toContain("token");
    expect(run.errorMessage!).not.toContain("supplier.example.com");

    const [row] = await db.select().from(supplierSources).where(eq(supplierSources.id, src.id));
    expect(row.lastErrorCode).toBe("SOURCE_URL_QUERY_NOT_ALLOWED");
    expect(row.lastErrorMessage!).not.toContain("SEGREDO-NA-QUERY");
    // nenhum import/preview criado para esta fonte
    const imports = await db.select().from(supplierImports).where(eq(supplierImports.sourceId, src.id));
    expect(imports).toHaveLength(0);
  });

  it("segredo ausente: SOURCE_AUTH_SECRET_MISSING sem qualquer tentativa de rede + run error segura", async () => {
    const src = await insertSource({ authType: "bearer", secretReference: "C342_NOT_SET" });
    const { fetchImpl, calls } = stubFetch(() => response(200, { text: CSV_A }));
    const err = await expectRejected(runSupplierSource(src.id, USER_ID, { fetchImpl, env: {} }), "SOURCE_AUTH_SECRET_MISSING");
    expect(calls).toHaveLength(0);
    const [run] = await db.select().from(supplierSourceRuns).where(eq(supplierSourceRuns.sourceId, src.id)).orderBy(desc(supplierSourceRuns.id)).limit(1);
    expect(run.status).toBe("error");
    expect(run.errorCode).toBe("SOURCE_AUTH_SECRET_MISSING");
    expect(run.errorMessage).toBeTruthy();
    expect(run.errorMessage!).not.toContain("C342"); // mensagem humana genérica, sem detalhes
    expect(err.httpStatus).toBe(500);
  });

  it("401 do remoto: run error com código seguro; last_success_at intacta; segredo fora das mensagens", async () => {
    const src = await insertSource({ authType: "bearer", secretReference: "C342_SECRET" });
    const err = await expectRejected(
      runSupplierSource(src.id, USER_ID, { fetchImpl: stubFetch(() => response(401)).fetchImpl, env: { C342_SECRET: SECRET_VALUE } }),
      "SOURCE_HTTP_401"
    );
    expect(err.httpStatus).toBe(502);
    const [row] = await db.select().from(supplierSources).where(eq(supplierSources.id, src.id));
    expect(row.lastErrorCode).toBe("SOURCE_HTTP_401");
    expect(row.lastHttpStatus).toBe(401);
    expect(row.lastSuccessAt).toBeNull(); // nunca houve sucesso para preservar
    expect(row.lastErrorMessage!).not.toContain(SECRET_VALUE);
    expect(row.lastErrorMessage!).not.toContain("Bearer");
    const [run] = await db.select().from(supplierSourceRuns).where(eq(supplierSourceRuns.sourceId, src.id));
    expect(run.status).toBe("error");
    expect(run.httpStatus).toBe(401);
  });

  it("conteúdo não-parseável: erro do motor é registado na run SEM stack/SQL", async () => {
    const src = await insertSource();
    await expectRejected(
      runSupplierSource(src.id, USER_ID, { fetchImpl: stubFetch(() => response(200, { text: "coluna1,coluna2\nx,y" })).fetchImpl, env: {} }),
      "CSV_MISSING_KEY_COLUMN"
    );
    const [run] = await db.select().from(supplierSourceRuns).where(eq(supplierSourceRuns.sourceId, src.id));
    expect(run.status).toBe("error");
    expect(run.errorCode).toBe("CSV_MISSING_KEY_COLUMN"); // código do MOTOR C.3.1 — não há 2.º pipeline
    const [row] = await db.select().from(supplierSources).where(eq(supplierSources.id, src.id));
    expect(row.lastErrorCode).toBe("CSV_MISSING_KEY_COLUMN");
    expect((await db.select({ c: sql<number>`count(*)::int` }).from(supplierImports).where(eq(supplierImports.sourceId, src.id)))[0].c).toBe(0);
  });

  it("safeRunError classifica o inesperado em SOURCE_RUN_FAILED sem revelar o original", () => {
    const { code, message } = safeRunError(new Error("SELECT * FROM super_secret_table FAILED near '…'"));
    expect(code).toBe("SOURCE_RUN_FAILED");
    expect(message).not.toContain("SELECT");
    expect(message).not.toContain("super_secret_table");
  });

  it("fonte desativada → SOURCE_DISABLED sem run e sem rede", async () => {
    const src = await insertSource({ enabled: false });
    const { fetchImpl, calls } = stubFetch(() => response(200, { text: CSV_A }));
    await expectRejected(runSupplierSource(src.id, USER_ID, { fetchImpl, env: {} }), "SOURCE_DISABLED");
    expect(calls).toHaveLength(0);
    expect((await db.select({ c: sql<number>`count(*)::int` }).from(supplierSourceRuns).where(eq(supplierSourceRuns.sourceId, src.id)))[0].c).toBe(0);
  });

  it("apply_policy nunca dispara apply: só preview (auto_if_clean ignorado nesta fase)", async () => {
    const src = await insertSource({ applyPolicy: "auto_if_clean" });
    const outcome = await runSupplierSource(src.id, USER_ID, { fetchImpl: stubFetch(() => response(200, { text: CSV_A })).fetchImpl, env: {} });
    const [imp] = await db.select().from(supplierImports).where(eq(supplierImports.id, outcome.importId!));
    expect(imp.status).toBe("preview"); // o policy do schema não ativa apply
  });
});

// ─── 5. Observabilidade mínima pedida ────────────────────

describe("C.3.4.2 — estado por fonte", () => {
  it("sucesso → last_checked/last_success/linhas/duração; erro posterior → só erro; sucesso seguinte limpa", async () => {
    const src = await insertSource();
    await runSupplierSource(src.id, USER_ID, { fetchImpl: stubFetch(() => response(200, { text: CSV_A })).fetchImpl, env: {} });
    let [row] = await db.select().from(supplierSources).where(eq(supplierSources.id, src.id));
    const okCheckedAt = row.lastCheckedAt!.getTime();
    const okSuccessAt = row.lastSuccessAt!.getTime();
    expect(row.lastRowCount).toBe(1);

    await expectRejected(runSupplierSource(src.id, USER_ID, { fetchImpl: stubFetch(() => response(503)).fetchImpl, env: {} }), "SOURCE_HTTP_5XX");
    [row] = await db.select().from(supplierSources).where(eq(supplierSources.id, src.id));
    expect(row.lastErrorCode).toBe("SOURCE_HTTP_5XX");
    expect(row.lastSuccessAt!.getTime()).toBe(okSuccessAt); // sucesso anterior preservado
    expect(row.lastCheckedAt!.getTime()).toBeGreaterThan(okCheckedAt);

    // Mesmo conteúdo do sucesso (hash igual) → no_change limpa o erro sem tocar no catálogo.
    await runSupplierSource(src.id, USER_ID, { fetchImpl: stubFetch(() => response(200, { text: CSV_A })).fetchImpl, env: {} });
    [row] = await db.select().from(supplierSources).where(eq(supplierSources.id, src.id));
    expect(row.lastErrorCode).toBeNull();
    expect(row.lastErrorMessage).toBeNull();
    expect(row.lastHttpStatus).toBe(200);
  });

  it("edit de fonte mantém as colunas de observabilidade e troca só a config", async () => {
    const src = await insertSource();
    await runSupplierSource(src.id, USER_ID, { fetchImpl: stubFetch(() => response(200, { text: CSV_A })).fetchImpl, env: {} });
    const [before] = await db.select().from(supplierSources).where(eq(supplierSources.id, src.id));
    const updated = await updateSupplierSource(src.id, { name: `${TAG}-Renomeada` }, USER_ID);
    expect(updated.lastSuccessAt).toBe(before.lastSuccessAt!.toISOString());
    expect(updated.name).toBe(`${TAG}-Renomeada`);
  });
});

/** tiny wait helper sem import extra de timers. */
async function waitUntil(cond: () => boolean, ms = 500): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
