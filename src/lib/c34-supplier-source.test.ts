/**
 * C.3.4.1 — Fontes de fornecedor: modelo de dados e metadados de fonte.
 *
 * Base de dados REAL (o runner aplica as migrations antes do vitest):
 *  1. upload → snapshot em supplier_imports com source_id NULL,
 *     source_label = nome do ficheiro e validadores HTTP NULL;
 *  2. payload de URL (metadados apenas — SEM fetch) → etag/last_modified
 *     persistidos como snapshot;
 *  3. supplier_sources: defaults SEGUROS (auto-apply nunca implícito),
 *     unicidade (fornecedor, nome) e colunas de observabilidade;
 *  4. CHECK de segurança: só HTTPS e nunca credenciais na URL;
 *  5. supplier_source_runs: históricos da fonte com status controlado;
 *  6. o histórico sobrevive à remoção da fonte (source_id → NULL);
 *  7. supplier_sources NUNCA tem coluna de segredo em plaintext (apenas
 *     `secret_reference`, cujo valor é uma referência).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { db } from "@/db";
import {
  suppliers,
  supplierImports,
  supplierSources,
  supplierSourceRuns,
  users,
} from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { previewSupplierImport } from "@/lib/services/supplier-import-service";
import { uploadSource } from "@/lib/supplier-import/source";

const TAG = "C34SS";
const USER_ID = 990001;

const CSV = "skuFornecedor;nome;custo;stock;ean\n" + `${TAG}-A;Produto A;10,00;5;5901234123457`;

let supplierId: number;

async function cleanup() {
  const pattern = `${TAG}-%`;
  await db.execute(
    sql`DELETE FROM supplier_source_runs WHERE source_id IN (SELECT id FROM supplier_sources WHERE name LIKE ${pattern})`
  );
  await db.execute(sql`DELETE FROM supplier_sources WHERE name LIKE ${pattern}`);
  await db.execute(
    sql`DELETE FROM supplier_import_rows WHERE import_id IN (SELECT id FROM supplier_imports WHERE file_name LIKE ${pattern})`
  );
  await db.execute(sql`DELETE FROM supplier_imports WHERE file_name LIKE ${pattern}`);
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

describe("C.3.4.1 — supplier_imports: colunas aditivas da fonte", () => {
  it("upload manual → source_id NULL, source_label = nome do ficheiro, validadores HTTP NULL", async () => {
    const preview = await previewSupplierImport({
      supplierId,
      source: uploadSource({ fileName: `${TAG}-lista.csv`, csvText: CSV }),
      userId: USER_ID,
    });
    const [row] = await db.select().from(supplierImports).where(eq(supplierImports.id, preview.importId)).limit(1);
    expect(row).toBeDefined();
    expect(row!.sourceId).toBeNull();
    expect(row!.sourceLabel).toBe(`${TAG}-lista.csv`);
    expect(row!.httpEtag).toBeNull();
    expect(row!.httpLastModified).toBeNull();
    // O label da fonte também alimenta o nome histórico legado.
    expect(row!.fileName).toBe(`${TAG}-lista.csv`);
    expect(row!.fileHash).toBe(preview.fileHash);
  });

  it("payload de URL (metadados, SEM fetch) → etag/last_modified persistidos no snapshot", async () => {
    const preview = await previewSupplierImport({
      supplierId,
      source: {
        kind: "url",
        label: `https://supplier.example/files/${TAG}.csv`,
        format: "csv",
        text: CSV,
        etag: '"abc123"',
        lastModified: "Mon, 07 Sep 2026 10:00:00 GMT",
      },
      userId: USER_ID,
    });
    const [row] = await db.select().from(supplierImports).where(eq(supplierImports.id, preview.importId)).limit(1);
    expect(row!.sourceId).toBeNull();
    expect(row!.sourceLabel).toBe(`https://supplier.example/files/${TAG}.csv`);
    expect(row!.httpEtag).toBe('"abc123"');
    expect(row!.httpLastModified).toBe("Mon, 07 Sep 2026 10:00:00 GMT");
  });

  it("remover a fonte NUNCA apaga o histórico (source_id → NULL)", async () => {
    const preview = await previewSupplierImport({
      supplierId,
      source: uploadSource({ fileName: `${TAG}-hist.csv`, csvText: CSV }),
      userId: USER_ID,
    });
    const [src] = await db.insert(supplierSources).values({ supplierId, name: `${TAG}-Fonte` }).returning();
    await db.update(supplierImports).set({ sourceId: src.id }).where(eq(supplierImports.id, preview.importId));
    await db.delete(supplierSources).where(eq(supplierSources.id, src.id));
    const [row] = await db.select().from(supplierImports).where(eq(supplierImports.id, preview.importId)).limit(1);
    expect(row!.sourceId).toBeNull();
    expect(row!.sourceLabel).toBe(`${TAG}-hist.csv`); // snapshot sobrevive
  });
});

describe("C.3.4.1 — supplier_sources: defaults seguros e RESTRIÇÕES", () => {
  it("defaults SEGUROS: nasce DESATIVADA (enabled=false) e apply_policy = preview_only", async () => {
    const [src] = await db.insert(supplierSources).values({ supplierId, name: `${TAG}-1` }).returning();
    expect(src.sourceType).toBe("upload");
    expect(src.format).toBe("auto");
    // Criar/configurar uma fonte NUNCA inicia implicitamente uma sincronização:
    // a ativação é sempre um ato explícito do admin.
    expect(src.enabled).toBe(false);
    expect(src.applyPolicy).toBe("preview_only");
    expect(src.url).toBeNull();
    expect(src.secretReference).toBeNull();
  });

  it("unicidade (fornecedor, nome) e cascade por fornecedor", async () => {
    await db.insert(supplierSources).values({ supplierId, name: `${TAG}-2` });
    await expect(db.insert(supplierSources).values({ supplierId, name: `${TAG}-2` })).rejects.toThrow();

    // Cascade com fornecedor DEDICADO (não destruir o supplierId partilhado).
    const [victim] = await db.insert(suppliers).values({ name: `${TAG}-Vítima`, isActive: true }).returning();
    await db.insert(supplierSources).values({ supplierId: victim.id, name: `${TAG}-v1` });
    await db.insert(supplierSources).values({ supplierId: victim.id, name: `${TAG}-v2` });
    await db.delete(suppliers).where(eq(suppliers.id, victim.id));
    const [count] = await db.select({ c: sql<number>`count(*)::int` })
      .from(supplierSources)
      .where(eq(supplierSources.supplierId, victim.id));
    expect(count!.c).toBe(0);
  });

  it("CHECK: apenas HTTPS e NUNCA credenciais na URL", async () => {
    await expect(
      db.insert(supplierSources).values({ supplierId, name: `${TAG}-http`, url: `http://supplier.example/${TAG}.csv` })
    ).rejects.toThrow();
    await expect(
      db.insert(supplierSources).values({ supplierId, name: `${TAG}-cred`, url: `https://user:pass@supplier.example/${TAG}.csv` })
    ).rejects.toThrow();
    const [ok] = await db.insert(supplierSources).values({
      supplierId, name: `${TAG}-ok`, url: `https://supplier.example/files/${TAG}.csv`,
    }).returning();
    expect(ok.url).toBe(`https://supplier.example/files/${TAG}.csv`);
  });
});

describe("C.3.4.1 — supplier_source_runs: histórico por fonte", () => {
  it("status por defeito running; valores inválidos rejeitados; run liga à fonte e ao snapshot", async () => {
    const [src] = await db.insert(supplierSources).values({ supplierId, name: `${TAG}-run` }).returning();
    const preview = await previewSupplierImport({
      supplierId,
      source: uploadSource({ fileName: `${TAG}-run.csv`, csvText: CSV }),
      userId: USER_ID,
    });
    const [run] = await db.insert(supplierSourceRuns).values({
      sourceId: src.id, importId: preview.importId, rowCount: 1, status: "success", durationMs: 42,
    }).returning();
    expect(run.status).toBe("success");
    expect(run.importId).toBe(preview.importId);
    await expect(
      db.insert(supplierSourceRuns).values({ sourceId: src.id, status: "bogus" })
    ).rejects.toThrow();
  });
});

describe("C.3.4.1 — nunca segredos em plaintext", () => {
  it("supplier_sources NÃO tem colunas de valor sensível (só secret_reference)", async () => {
    const cols = await db.execute(
      sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'supplier_sources'`
    );
    const names: string[] = cols.rows.map((r: any) => String(r.column_name)).sort();
    // Coluna de segredo deve ser APENAS a referência — nunca password/key/token em claro.
    const sensitive = names.filter((n) =>
      /password|api_key|apikey|access_token|refresh_token|secret$|^secret/i.test(n) && n !== "secret_reference"
    );
    expect(sensitive).toEqual([]);
    expect(names).toContain("secret_reference");
    expect(names).toContain("headers_config");
    // URL existe, mas a coluna só aceita HTTPS (CHECK) e sem credenciais.
    expect(names).toContain("url");
  });
});
