/**
 * C.3.4.4 — GRUPO E: runs de fontes SFTP (DB real + fetcher injetado).
 *
 * O transporte é injetado (`fetcherImpl`: stat/read enlatados); tudo o resto
 * é real: claim atómico, preview pelo motor, runs e observabilidade. Trava:
 *  - success: preview criado, run+fonte com size+mtime, last_success_at,
 *    fileHash = sha256 dos bytes, import fica em `preview` (nunca apply);
 *  - stat igual → no_change/remote_metadata SEM transferir (read nem corre);
 *  - conteúdo igual (hash) → no_change/content_hash sem duplicar preview;
 *  - erro SFTP → run error + observabilidade sanitizada, sem tocar no
 *    last_success_at e sem criar snapshot;
 *  - formato explícito also_stock respeitado; `auto` resolve por basename;
 *  - CRUD: enable valida a config guardada; update recusa trocar de tipo.
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
import {
  createSftpSource,
  loadSupplierSourceRow,
  runSupplierSource,
  setSupplierSourceEnabled,
  updateSftpSource,
  type RunSupplierSourceDeps,
} from "@/lib/services/supplier-source-service";
import { SupplierSourceError } from "@/lib/supplier-import/source";
import { supplierImportErrorMessage } from "@/lib/supplier-import/error-messages";
import type { SftpWorkerRequest, SftpWorkerResponse } from "../../workers/also-sftp-fetcher/src/index";

const TAG = "C344RUN";
const MANAGER = { id: 9752, email: "c344-run@test.local", name: "C344 Run", role: "manager" as const };
const HOST = "ftp.fornecedor.com";
const FINGERPRINT = `SHA256:${"B".repeat(43)}`;
const SECRET_NAME = "ALSO_SFTP_PASSWORD";

let supplierId = 0;

const HEADER_6 = ["ProductID", "AvailableQuantity", "AvailableNextDate", "AvailableNextQuantity", "AvailabilityDate", "AvailabilityTime"];

function stockBytes(qty: string): Uint8Array {
  const txt = [HEADER_6.join("\t"), ["PID-R1", qty, "20261001", "5", "20260907", "143000"].join("\t")].join("\n");
  return new TextEncoder().encode(txt);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function toB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

interface FakeRemote {
  bytes: Uint8Array;
  mtime: number;
  /** Chamadas observadas (stat/read) por ordem. */
  calls: string[];
  /** Quando definido, o stat falha com este código. */
  statError?: string;
}

function fakeFetcher(remote: FakeRemote) {
  const impl = async (req: SftpWorkerRequest): Promise<SftpWorkerResponse> => {
    remote.calls.push(req.op);
    if (req.op === "stat") {
      if (remote.statError) return { ok: false, code: remote.statError as never, message: "x" };
      return { ok: true, size: remote.bytes.length, mtime: remote.mtime };
    }
    return {
      ok: true,
      size: remote.bytes.length,
      mtime: remote.mtime,
      sha256: sha256Hex(remote.bytes),
      contentBase64: toB64(remote.bytes),
    };
  };
  return impl;
}

const depsFor = (remote: FakeRemote): RunSupplierSourceDeps => ({ fetcherImpl: fakeFetcher(remote) });

async function makeSource(format = "also_stock") {
  const dto = await createSftpSource(
    {
      supplierId,
      name: `${TAG} ALSO stock ${Date.now()}`,
      sftpHost: HOST,
      sftpPort: 22,
      sftpRemotePath: "/out/stock.txt",
      username: "also_user",
      secretReference: SECRET_NAME,
      sftpHostKeyFingerprint: FINGERPRINT,
      format: format as never,
    },
    MANAGER.id
  );
  await setSupplierSourceEnabled(dto.id, true, MANAGER.id);
  return dto.id;
}

async function getSource(id: number) {
  const [row] = await db.select().from(supplierSources).where(eq(supplierSources.id, id)).limit(1);
  return row;
}

async function getRun(id: number) {
  const [row] = await db.select().from(supplierSourceRuns).where(eq(supplierSourceRuns.id, id)).limit(1);
  return row;
}

async function cleanupTag() {
  const tagged = await db.select({ id: products.id }).from(products)
    .where(sql`sku LIKE ${`${TAG}%`} OR slug LIKE ${`${TAG.toLowerCase()}%`}`);
  const ids = tagged.map((p) => p.id);
  if (ids.length) {
    const idList = sql.join(ids.map((id) => sql`${id}`), sql`,`);
    await db.execute(sql`DELETE FROM stock_movements WHERE product_id IN (${idList})`);
    await db.execute(sql`DELETE FROM product_suppliers WHERE product_id IN (${idList})`);
    await db.execute(sql`DELETE FROM supplier_import_rows WHERE product_id IN (${idList})`);
    await db.delete(products).where(sql`id IN (${idList})`);
  }
  await db.execute(sql`DELETE FROM supplier_import_rows WHERE import_id IN (SELECT id FROM supplier_imports WHERE user_id = ${MANAGER.id})`);
  await db.execute(sql`DELETE FROM supplier_imports WHERE user_id = ${MANAGER.id}`);
  await db.execute(sql`DELETE FROM supplier_source_runs WHERE source_id IN (SELECT id FROM supplier_sources WHERE name LIKE ${`${TAG}%`})`);
  await db.execute(sql`DELETE FROM supplier_sources WHERE name LIKE ${`${TAG}%`}`);
  await db.execute(sql`DELETE FROM pricing_rules WHERE notes LIKE ${`${TAG}%`}`);
}

beforeAll(async () => {
  await db.insert(users).values({ id: MANAGER.id, email: MANAGER.email, password: "x", name: MANAGER.name, role: MANAGER.role }).onConflictDoNothing();
  const [s] = await db.insert(suppliers).values({ name: `${TAG} Supplier` }).returning();
  supplierId = s.id;
  const sku = `${TAG}-PROD`;
  const [p] = await db.insert(products).values({
    name: "Prod R", slug: `${sku.toLowerCase()}-r`, sku,
    price: "100.00", costPrice: "60.00", vatRate: "23.00", priceMode: "auto", stock: 5,
  }).returning();
  await db.insert(productSuppliers).values({ productId: p.id, supplierId, supplierSku: "PID-R1", costPrice: "60.00", isPreferred: true });
});
afterAll(async () => {
  await db.execute(sql`DELETE FROM audit_logs WHERE user_id = ${MANAGER.id}`);
  await cleanupTag();
  await db.execute(sql`DELETE FROM audit_logs WHERE user_id = ${MANAGER.id}`);
  await db.execute(sql`DELETE FROM suppliers WHERE name LIKE ${`${TAG}%`}`);
  await db.execute(sql`DELETE FROM users WHERE id = ${MANAGER.id}`);
});
beforeEach(async () => {
  // Mantém o produto/link do beforeAll; limpa apenas imports/runs/fontes.
  await db.execute(sql`DELETE FROM supplier_import_rows WHERE import_id IN (SELECT id FROM supplier_imports WHERE user_id = ${MANAGER.id})`);
  await db.execute(sql`DELETE FROM supplier_imports WHERE user_id = ${MANAGER.id}`);
  await db.execute(sql`DELETE FROM supplier_source_runs WHERE source_id IN (SELECT id FROM supplier_sources WHERE name LIKE ${`${TAG}%`})`);
  await db.execute(sql`DELETE FROM supplier_sources WHERE name LIKE ${`${TAG}%`}`);
});

describe("C.3.4.4 [E] — run success: preview + observabilidade, nunca apply", () => {
  it("primeira run: preview criado, size+mtime+hash persistidos", async () => {
    const sourceId = await makeSource();
    const remote: FakeRemote = { bytes: stockBytes("25"), mtime: 1725667200, calls: [] };
    const outcome = await runSupplierSource(sourceId, MANAGER.id, depsFor(remote));

    expect(remote.calls).toEqual(["stat", "read"]);
    expect(outcome.status).toBe("success");
    expect(outcome.importId).not.toBeNull();
    expect(outcome.preview).toBeDefined();
    expect(outcome.preview!.lines[0].supplierStock).toBe(25);
    expect(outcome.remoteSize).toBe(remote.bytes.length);
    expect(outcome.remoteMtime).toBe("1725667200");
    expect(outcome.fileHash).toBe(sha256Hex(remote.bytes));
    expect(outcome.httpStatus).toBeNull(); // sem HTTP envolvido

    const run = await getRun(outcome.runId);
    expect(run.status).toBe("success");
    expect(run.importId).toBe(outcome.importId);
    expect(run.remoteSize).toBe(remote.bytes.length);
    expect(run.remoteMtime).toBe("1725667200");
    expect(run.httpStatus).toBeNull();

    const source = await getSource(sourceId);
    expect(source.lastSuccessAt).not.toBeNull();
    expect(source.lastCheckedAt).not.toBeNull();
    expect(source.lastRowCount).toBe(1);
    expect(source.lastRemoteSize).toBe(remote.bytes.length);
    expect(source.lastRemoteMtime).toBe("1725667200");
    expect(source.lastErrorCode).toBeNull();

    // O resultado máximo é um preview: nada aplicado, catálogo intacto.
    const [imp] = await db.select().from(supplierImports).where(eq(supplierImports.id, outcome.importId!)).limit(1);
    expect(imp.status).toBe("preview");
    const [prodRow] = await db.select().from(products).where(eq(products.sku, `${TAG}-PROD`)).limit(1);
    expect(prodRow.stock).toBe(5);
    const [link] = await db.select().from(productSuppliers)
      .where(and(eq(productSuppliers.productId, prodRow.id), eq(productSuppliers.supplierId, supplierId))).limit(1);
    expect(link.supplierStock).toBeNull();
  });
});

describe("C.3.4.4 [E] — no_change: metadata e hash", () => {
  it("stat igual → remote_metadata SEM transferir; last_success_at não avança", async () => {
    const sourceId = await makeSource();
    const remote: FakeRemote = { bytes: stockBytes("25"), mtime: 1725667200, calls: [] };
    const first = await runSupplierSource(sourceId, MANAGER.id, depsFor(remote));
    expect(first.status).toBe("success");
    const successAt = (await getSource(sourceId)).lastSuccessAt!;

    remote.calls = [];
    const second = await runSupplierSource(sourceId, MANAGER.id, depsFor(remote));
    expect(second.status).toBe("no_change");
    expect(second.noChangeReason).toBe("remote_metadata");
    expect(second.importId).toBeNull();
    expect(remote.calls).toEqual(["stat"]); // o read nem correu

    const source = await getSource(sourceId);
    expect(source.lastCheckedAt!.getTime()).toBeGreaterThanOrEqual(successAt.getTime());
    expect(source.lastSuccessAt!.getTime()).toBe(successAt.getTime()); // sem conteúdo novo
    const run = await getRun(second.runId);
    expect(run.status).toBe("no_change");
    expect(run.importId).toBeNull();
  });

  it("mtime mudou mas hash igual → content_hash sem duplicar preview", async () => {
    const sourceId = await makeSource();
    const remote: FakeRemote = { bytes: stockBytes("25"), mtime: 1725667200, calls: [] };
    const first = await runSupplierSource(sourceId, MANAGER.id, depsFor(remote));
    expect(first.status).toBe("success");

    remote.mtime = 1725667300; // toca no ficheiro sem lhe mudar o conteúdo
    const second = await runSupplierSource(sourceId, MANAGER.id, depsFor(remote));
    expect(second.status).toBe("no_change");
    expect(second.noChangeReason).toBe("content_hash");
    expect(second.importId).toBe(first.importId); // aponta para o snapshot existente
    expect(remote.calls).toEqual(["stat", "read", "stat", "read"]);

    const imports = await db.select({ id: supplierImports.id }).from(supplierImports)
      .where(eq(supplierImports.sourceId, sourceId));
    expect(imports).toHaveLength(1); // nenhum preview duplicado
    const source = await getSource(sourceId);
    expect(source.lastSuccessAt).not.toBeNull();
    expect(source.lastRemoteMtime).toBe("1725667300"); // validadores atualizados
  });

  it("conteúdo mudou → novo preview", async () => {
    const sourceId = await makeSource();
    const remote: FakeRemote = { bytes: stockBytes("25"), mtime: 1725667200, calls: [] };
    await runSupplierSource(sourceId, MANAGER.id, depsFor(remote));
    remote.bytes = stockBytes("26");
    remote.mtime = 1725667400;
    const second = await runSupplierSource(sourceId, MANAGER.id, depsFor(remote));
    expect(second.status).toBe("success");
    expect(second.preview!.lines[0].supplierStock).toBe(26);
  });
});

describe("C.3.4.4 [E] — run error: código estável + frase segura", () => {
  it("falha de auth: run error, fonte observável, sem snapshot, sem last_success", async () => {
    const sourceId = await makeSource();
    const remote: FakeRemote = { bytes: stockBytes("25"), mtime: 1, calls: [], statError: "SFTP_AUTH_FAILED" };
    const err = await runSupplierSource(sourceId, MANAGER.id, depsFor(remote)).catch((e) => e);
    expect(err).toBeInstanceOf(SupplierSourceError);
    expect(err.code).toBe("SFTP_AUTH_FAILED");

    const runs = await db.select().from(supplierSourceRuns).where(eq(supplierSourceRuns.sourceId, sourceId));
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("error");
    expect(runs[0].errorCode).toBe("SFTP_AUTH_FAILED");
    expect(runs[0].errorMessage).toBe(supplierImportErrorMessage("SFTP_AUTH_FAILED"));
    expect(runs[0].importId).toBeNull();

    const source = await getSource(sourceId);
    expect(source.lastErrorCode).toBe("SFTP_AUTH_FAILED");
    expect(source.lastErrorMessage).toBe(supplierImportErrorMessage("SFTP_AUTH_FAILED"));
    expect(source.lastCheckedAt).not.toBeNull();
    expect(source.lastSuccessAt).toBeNull(); // erro nunca marca sucesso
    const imports = await db.select({ id: supplierImports.id }).from(supplierImports)
      .where(eq(supplierImports.sourceId, sourceId));
    expect(imports).toHaveLength(0);
  });
});

describe("C.3.4.4 [E] — formato: explícito e auto", () => {
  it("formato explícito also_stock é respeitado", async () => {
    const sourceId = await makeSource("also_stock");
    const remote: FakeRemote = { bytes: stockBytes("7"), mtime: 10, calls: [] };
    const outcome = await runSupplierSource(sourceId, MANAGER.id, depsFor(remote));
    expect(outcome.status).toBe("success");
    expect(outcome.preview!.lines[0].supplierStock).toBe(7);
  });

  it("auto resolve stock.txt por basename (caminho SFTP local, sem tocar no HTTPS)", async () => {
    const sourceId = await makeSource("auto");
    const remote: FakeRemote = { bytes: stockBytes("9"), mtime: 11, calls: [] };
    const outcome = await runSupplierSource(sourceId, MANAGER.id, depsFor(remote));
    expect(outcome.status).toBe("success");
    expect(outcome.preview!.lines[0].supplierStock).toBe(9);
  });
});

describe("C.3.4.4 [E] — CRUD: enable valida, tipo é imutável", () => {
  it("ativar valida a config guardada (fingerprint mau → 400)", async () => {
    const dto = await createSftpSource(
      {
        supplierId, name: `${TAG} má config ${Date.now()}`,
        sftpHost: HOST, sftpPort: 22, sftpRemotePath: "/out/stock.txt",
        username: "u", secretReference: SECRET_NAME,
        sftpHostKeyFingerprint: "SHA256:curto",
        format: "also_stock",
      },
      MANAGER.id
    );
    expect(dto.enabled).toBe(false); // nasce desativada
    const err = await setSupplierSourceEnabled(dto.id, true, MANAGER.id).catch((e) => e);
    expect(err).toBeInstanceOf(SupplierSourceError);
    expect(err.code).toBe("SFTP_CONFIG_INVALID");
    expect((await loadSupplierSourceRow(dto.id))!.enabled).toBe(false);
  });

  it("updateSftpSource recusa linhas HTTPS", async () => {
    const [urlRow] = await db.insert(supplierSources).values({
      supplierId, name: `${TAG} url ${Date.now()}`, sourceType: "url",
      url: "https://supplier.example.com/lista.csv", format: "csv", authType: "none",
      applyPolicy: "preview_only", enabled: false, createdBy: MANAGER.id, updatedBy: MANAGER.id,
    }).returning();
    const err = await updateSftpSource(urlRow.id, { sftpHost: HOST }, MANAGER.id).catch((e) => e);
    expect(err).toBeInstanceOf(SupplierSourceError);
    expect(err.code).toBe("SOURCE_TYPE_UNSUPPORTED");
  });

  it("update SFTP persiste e devolve a projeção (com config, sem password)", async () => {
    const sourceId = await makeSource();
    const updated = await updateSftpSource(sourceId, { sftpRemotePath: "/out/stock2.txt", format: "auto" }, MANAGER.id);
    expect(updated.sftpRemotePath).toBe("/out/stock2.txt");
    expect(updated.format).toBe("auto");
    expect(updated.secretReference).toBe(SECRET_NAME);
    expect(JSON.stringify(updated)).not.toContain("also_user_password");
  });
});
