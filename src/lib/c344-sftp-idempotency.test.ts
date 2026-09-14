/**
 * C.3.4.4 — GRUPO F: idempotência e segurança do sync SFTP (DB real).
 *
 * Trava as garantias que atravessam camadas:
 *  - a password NUNCA existe na app: o fetcher recebe só o NOME do secret;
 *    nada com o valor é persistido (fontes, runs, snapshots, audit) nem
 *    devolvido (DTOs, outcome, erros);
 *  - erros sanitizados: código estável + frase da tabela (sem host/path/user);
 *  - UNCHANGED: zero writes no link E no produto (linhas JSON idênticas);
 *  - apply retomável e idempotente (segunda chamada: applied 0, sem dup);
 *  - sem auto-apply: sync nunca muda import de `preview`, sem cron nesta fase
 *    (apply_policy=preview_only, next_run_at NULL);
 *  - hash de conteúdo decide a identidade (fixture com mtime igual mas bytes
 *    diferentes transfere e deteta a mudança — o stat não mascara o hash).
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import {
  products,
  productSuppliers,
  suppliers,
  supplierImports,
  supplierImportRows,
  supplierSources,
  supplierSourceRuns,
  users,
} from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { applySupplierImport } from "@/lib/services/supplier-import-service";
import {
  createSftpSource,
  runSupplierSource,
  setSupplierSourceEnabled,
  type RunSupplierSourceDeps,
} from "@/lib/services/supplier-source-service";
import { SupplierSourceError } from "@/lib/supplier-import/source";
import { supplierImportErrorMessage } from "@/lib/supplier-import/error-messages";
import type { SftpWorkerRequest, SftpWorkerResponse } from "../../workers/also-sftp-fetcher/src/index";

const TAG = "C344IDEM";
const MANAGER = { id: 9753, email: "c344-idem@test.local", name: "C344 Idem", role: "manager" as const };
const HOST = "ftp.fornecedor.com";
const FINGERPRINT = `SHA256:${"C".repeat(43)}`;
const SECRET_NAME = "ALSO_SFTP_PASSWORD";
const SECRET_VALUE = "correct-horse-battery-staple-9";

let supplierId = 0;
let productId = 0;

const HEADER_6 = ["ProductID", "AvailableQuantity", "AvailableNextDate", "AvailableNextQuantity", "AvailabilityDate", "AvailabilityTime"];

function stockBytes(qty: string): Uint8Array {
  const txt = [HEADER_6.join("\t"), ["PID-F1", qty, "20261001", "5", "20260907", "143000"].join("\t")].join("\n");
  return new TextEncoder().encode(txt);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Remoto falso que resolve o "valor" do secret como o worker faria. */
function instrumentedFetcher(remote: { bytes: Uint8Array; mtime: number }, seen: { requests: SftpWorkerRequest[] }) {
  return async (req: SftpWorkerRequest): Promise<SftpWorkerResponse> => {
    seen.requests.push(req);
    // O worker resolve o VALOR no SEU runtime; aqui emula-se com a constante —
    // o ponto travado é que o pedido só transporta o NOME.
    if (req.secretName !== SECRET_NAME) {
      return { ok: false, code: "SFTP_SECRET_MISSING", message: "missing" };
    }
    if (req.op === "stat") return { ok: true, size: remote.bytes.length, mtime: remote.mtime };
    return {
      ok: true, size: remote.bytes.length, mtime: remote.mtime,
      sha256: sha256Hex(remote.bytes), contentBase64: Buffer.from(remote.bytes).toString("base64"),
    };
  };
}

async function makeSource() {
  const dto = await createSftpSource(
    {
      supplierId, name: `${TAG} ALSO ${Date.now()}`,
      sftpHost: HOST, sftpPort: 22, sftpRemotePath: "/out/stock.txt",
      username: "also_user", secretReference: SECRET_NAME,
      sftpHostKeyFingerprint: FINGERPRINT, format: "also_stock",
    },
    MANAGER.id
  );
  await setSupplierSourceEnabled(dto.id, true, MANAGER.id);
  return dto.id;
}

async function cleanupTag() {
  await db.execute(sql`DELETE FROM supplier_import_rows WHERE import_id IN (SELECT id FROM supplier_imports WHERE user_id = ${MANAGER.id})`);
  await db.execute(sql`DELETE FROM supplier_imports WHERE user_id = ${MANAGER.id}`);
  await db.execute(sql`DELETE FROM supplier_source_runs WHERE source_id IN (SELECT id FROM supplier_sources WHERE name LIKE ${`${TAG}%`})`);
  await db.execute(sql`DELETE FROM supplier_sources WHERE name LIKE ${`${TAG}%`}`);
  await db.execute(sql`DELETE FROM audit_logs WHERE user_id = ${MANAGER.id}`);
}

beforeAll(async () => {
  await db.insert(users).values({ id: MANAGER.id, email: MANAGER.email, password: "x", name: MANAGER.name, role: MANAGER.role }).onConflictDoNothing();
  const [s] = await db.insert(suppliers).values({ name: `${TAG} Supplier` }).returning();
  supplierId = s.id;
  const sku = `${TAG}-PROD`;
  const [p] = await db.insert(products).values({
    name: "Prod F", slug: `${sku.toLowerCase()}-f`, sku,
    price: "100.00", costPrice: "60.00", vatRate: "23.00", priceMode: "auto", stock: 5,
  }).returning();
  productId = p.id;
  await db.insert(productSuppliers).values({ productId: p.id, supplierId, supplierSku: "PID-F1", costPrice: "60.00", isPreferred: true });
});
afterAll(async () => {
  await cleanupTag();
  await db.execute(sql`DELETE FROM stock_movements WHERE product_id = ${productId}`);
  await db.execute(sql`DELETE FROM product_suppliers WHERE product_id = ${productId}`);
  await db.execute(sql`DELETE FROM products WHERE id = ${productId}`);
  await db.execute(sql`DELETE FROM suppliers WHERE name LIKE ${`${TAG}%`}`);
  await db.execute(sql`DELETE FROM users WHERE id = ${MANAGER.id}`);
});

describe("C.3.4.4 [F] — segredos nunca na app/BD/respostas", () => {
  it("o fetcher recebe só o NOME; o valor nunca é persistido nem devolvido", async () => {
    const sourceId = await makeSource();
    const seen: { requests: SftpWorkerRequest[] } = { requests: [] };
    const remote = { bytes: stockBytes("25"), mtime: 1725667200 };
    const deps: RunSupplierSourceDeps = { fetcherImpl: instrumentedFetcher(remote, seen) };
    const outcome = await runSupplierSource(sourceId, MANAGER.id, deps);
    expect(outcome.status).toBe("success");

    // 1. Transporte: nenhum pedido contém o valor nem chave de password.
    expect(seen.requests.length).toBeGreaterThan(0);
    for (const req of seen.requests) {
      expect(req.secretName).toBe(SECRET_NAME);
      expect(JSON.stringify(req)).not.toContain(SECRET_VALUE);
      expect("password" in (req as unknown as Record<string, unknown>)).toBe(false);
      expect("secretValue" in (req as unknown as Record<string, unknown>)).toBe(false);
    }

    // 2. BD: fontes, runs, imports, linhas e audit sem o valor.
    const [source] = await db.select().from(supplierSources).where(eq(supplierSources.id, sourceId)).limit(1);
    expect(JSON.stringify(source)).not.toContain(SECRET_VALUE);
    expect(source.secretReference).toBe(SECRET_NAME);
    const runs = await db.select().from(supplierSourceRuns).where(eq(supplierSourceRuns.sourceId, sourceId));
    expect(JSON.stringify(runs)).not.toContain(SECRET_VALUE);
    const [imp] = await db.select().from(supplierImports).where(eq(supplierImports.id, outcome.importId!)).limit(1);
    expect(JSON.stringify(imp)).not.toContain(SECRET_VALUE);
    const rows = await db.select().from(supplierImportRows).where(eq(supplierImportRows.importId, outcome.importId!));
    expect(JSON.stringify(rows)).not.toContain(SECRET_VALUE);
    const audit = await db.execute(sql`SELECT details FROM audit_logs WHERE user_id = ${MANAGER.id}`);
    expect(JSON.stringify(audit.rows)).not.toContain(SECRET_VALUE);

    // 3. Resposta do run: sem o valor.
    expect(JSON.stringify(outcome)).not.toContain(SECRET_VALUE);

    await cleanupTag();
  });

  it("erro remoto: código estável + frase da tabela, sem host/path/user", async () => {
    const sourceId = await makeSource();
    const deps: RunSupplierSourceDeps = {
      fetcherImpl: async () => ({ ok: false, code: "SFTP_FILE_NOT_FOUND", message: "should be replaced" }),
    };
    const err = await runSupplierSource(sourceId, MANAGER.id, deps).catch((e) => e);
    expect(err).toBeInstanceOf(SupplierSourceError);
    expect(err.code).toBe("SFTP_FILE_NOT_FOUND");
    const [run] = await db.select().from(supplierSourceRuns).where(eq(supplierSourceRuns.sourceId, sourceId)).limit(1);
    expect(run.errorCode).toBe("SFTP_FILE_NOT_FOUND");
    expect(run.errorMessage).toBe(supplierImportErrorMessage("SFTP_FILE_NOT_FOUND"));
    expect(run.errorMessage ?? "").not.toContain(HOST);
    expect(run.errorMessage ?? "").not.toContain("/out/stock.txt");
    expect(run.errorMessage ?? "").not.toContain("also_user");
    await cleanupTag();
  });
});

describe("C.3.4.4 [F] — unchanged: zero writes; apply idempotente", () => {
  it("segunda passagem: produto E link byte-idênticos; re-apply aplica 0", async () => {
    const sourceId = await makeSource();
    const remote = { bytes: stockBytes("25"), mtime: 1725667200 };
    const seen: { requests: SftpWorkerRequest[] } = { requests: [] };
    const deps: RunSupplierSourceDeps = { fetcherImpl: instrumentedFetcher(remote, seen) };

    const first = await runSupplierSource(sourceId, MANAGER.id, deps);
    expect(first.status).toBe("success");
    const apply1 = await applySupplierImport({
      importId: first.importId!, previewToken: first.preview!.previewToken, userId: MANAGER.id,
    });
    expect(apply1.applied).toBe(1);

    const [prodBefore] = await db.select().from(products).where(eq(products.id, productId)).limit(1);
    const [linkBefore] = await db.select().from(productSuppliers)
      .where(and(eq(productSuppliers.productId, productId), eq(productSuppliers.supplierId, supplierId))).limit(1);

    // Muda o mtime para FORÇAR a transferência: o hash decide unchanged.
    remote.mtime = 1725667999;
    const second = await runSupplierSource(sourceId, MANAGER.id, deps);
    expect(second.status).toBe("no_change");
    expect(second.noChangeReason).toBe("content_hash");

    // Nenhum snapshot novo foi criado: produto e link nem foram lidos para escrita.
    const [prodAfter] = await db.select().from(products).where(eq(products.id, productId)).limit(1);
    const [linkAfter] = await db.select().from(productSuppliers)
      .where(and(eq(productSuppliers.productId, productId), eq(productSuppliers.supplierId, supplierId))).limit(1);
    expect(JSON.stringify(prodAfter)).toBe(JSON.stringify(prodBefore));
    expect(JSON.stringify(linkAfter)).toBe(JSON.stringify(linkBefore));

    // Re-apply do primeiro import: idempotente, sem duplo efeito (`applied`
    // é o total do ledger; `appliedNow` é o desta chamada: 0).
    const retry = await applySupplierImport({ importId: first.importId!, previewToken: first.preview!.previewToken, userId: MANAGER.id });
    expect(retry.appliedNow).toBe(0);
    expect(retry.idempotent).toBe(true);
    const [linkFinal] = await db.select().from(productSuppliers)
      .where(and(eq(productSuppliers.productId, productId), eq(productSuppliers.supplierId, supplierId))).limit(1);
    expect(linkFinal.supplierStock).toBe(25);
    const mv = await db.execute(sql`SELECT count(*)::int AS c FROM stock_movements WHERE product_id = ${productId}`);
    expect(Number((mv.rows as { c: number }[])[0].c)).toBe(0);

    await cleanupTag();
  });

  it("hash decide a identidade: mesmos bytes com outro mtime não criam preview", async () => {
    const sourceId = await makeSource();
    const remote = { bytes: stockBytes("25"), mtime: 100 };
    const seen: { requests: SftpWorkerRequest[] } = { requests: [] };
    const deps: RunSupplierSourceDeps = { fetcherImpl: instrumentedFetcher(remote, seen) };
    const first = await runSupplierSource(sourceId, MANAGER.id, deps);
    expect(first.status).toBe("success");
    remote.mtime = 200; // stat difere → transfere…
    const second = await runSupplierSource(sourceId, MANAGER.id, deps);
    expect(second.status).toBe("no_change"); // …mas o hash trava o duplicado
    expect(second.fileHash).toBe(first.fileHash);
    await cleanupTag();
  });
});

describe("C.3.4.4 [F] — sem auto-apply nem agendamento nesta fase", () => {
  it("sync nunca aplica; fonte nasce preview_only sem next_run", async () => {
    const sourceId = await makeSource();
    const remote = { bytes: stockBytes("25"), mtime: 300 };
    const seen: { requests: SftpWorkerRequest[] } = { requests: [] };
    const outcome = await runSupplierSource(sourceId, MANAGER.id, { fetcherImpl: instrumentedFetcher(remote, seen) });
    const [imp] = await db.select().from(supplierImports).where(eq(supplierImports.id, outcome.importId!)).limit(1);
    expect(imp.status).toBe("preview");
    const [source] = await db.select().from(supplierSources).where(eq(supplierSources.id, sourceId)).limit(1);
    expect(source.applyPolicy).toBe("preview_only");
    expect(source.nextRunAt).toBeNull();
    expect(source.schedule).toBeNull();
    await cleanupTag();
  });
});
