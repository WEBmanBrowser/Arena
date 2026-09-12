/**
 * C.3.4.2 — Serviço das FONTES REMOTAS de fornecedor.
 *
 * Contrato aprovado:
 *
 *   supplier_source
 *     → fetchSource()            (./supplier-import/source — único I/O remoto)
 *     → SourcePayload
 *     → parseSupplierFile()      (dispatcher C.3.3 — via previewSupplierImport)
 *     → SupplierFileParse → NormalizedSupplierRow[]
 *     → matching → pricing → preview persistido → revisão humana → apply MANUAL
 *
 * Este módulo NÃO é um segundo motor de importação: é o orquestrador em volta
 * do motor C.3.1/C.3.2/C.3.3. O parsing, matching, pricing e o snapshot são
 * produzidos EXCLUSIVAMENTE por `previewSupplierImport` — nada é duplicado.
 *
 * Garantias deliberadas:
 *  - APPLY NUNCA é chamado por aqui. O resultado máximo de um sync é um
 *    preview `status='preview'` à espera de revisão humana (apply_policy só
 *    tem efeito real a partir de C.3.4.5+; valores inesperados nunca disparam
 *    auto-apply);
 *  - concorrência decide-se no POSTGRES (row lock + verificação da run
 *    'running' fresca), nunca em memória do Worker;
 *  - segredos não existem aqui: só o NOME da referência chega da BD; o valor
 *    é resolvido no runtime dentro de `fetchSource` e nunca é persistido,
 *    devolvido nem escrito em mensagem de erro;
 *  - as colunas de observabilidade (last_error_code / error_message / runs)
 *    só recebem códigos estáveis e a frase humana da tabela partilhada
 *    (./supplier-import/error-messages) — nunca stack, SQL, headers, URL com
 *    query ou resposta do remoto.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  supplierImportProfiles,
  supplierImports,
  supplierSourceRuns,
  supplierSources,
} from "@/db/schema";
import { createAuditLog } from "@/lib/audit";
import { SOURCE_RUN_STALE_MS } from "@/lib/supplier-import/constants";
import { SupplierCsvError } from "@/lib/supplier-import/normalize";
import { classifyImportStorageFailure, supplierImportErrorMessage } from "@/lib/supplier-import/error-messages";
import {
  SourceFetchError,
  SupplierSourceError,
  fetchSource,
  guardSupplierSourceUrl,
  sourceSha256Hex,
  type FetchSourceOptions,
  type SourcePayload,
} from "@/lib/supplier-import/source";
import {
  SftpError,
  fetchSftpSource,
  guardSftpFingerprint,
  guardSftpHost,
  guardSftpPath,
  guardSftpPort,
  guardSftpSecretName,
  guardSftpUsername,
  resolveSftpFormat,
  sftpLabel,
  type SftpFetchOptions,
} from "@/lib/supplier-import/sftp";
import {
  SupplierImportError,
  previewSupplierImport,
  type SupplierImportPreview,
} from "@/lib/services/supplier-import-service";

function rowsOf<T = Record<string, unknown>>(result: unknown): T[] {
  const r = result as { rows?: T[] } | T[];
  return Array.isArray(r) ? r : (r.rows ?? []);
}

/** Teto de coluna aplicado SEMPRE antes de escrever (o texto é nosso, curto). */
const clip = (value: string | null | undefined, max: number): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
};

// ─── Erros seguros ───────────────────────────────────────

/**
 * Converte qualquer throw em { code, message } seguros para
 * `supplier_source_runs.error_*` e para a API. Erros tipados já carregam um
 * código estável; qualquer outra coisa é classificada genericamente e o erro
 * bruto fica apenas no log do servidor (nunca no browser nem na BD).
 */
export function safeRunError(err: unknown): { code: string; message: string; remoteStatus: number | null } {
  if (err instanceof SupplierSourceError || err instanceof SupplierCsvError || err instanceof SupplierImportError || err instanceof SftpError) {
    return {
      code: err.code,
      // A tabela partilhada é a ÚNICA origem do texto: nada do remoto (corpo,
      // headers, stack) pode entrar aqui — o construtor dos erros tipados já só
      // transporta o código.
      message: supplierImportErrorMessage(err.code),
      remoteStatus: err instanceof SourceFetchError ? err.remoteStatus : null,
    };
  }
  console.error("supplier source run failure:", err);
  return {
    code: "SOURCE_RUN_FAILED",
    message: supplierImportErrorMessage("SOURCE_RUN_FAILED"),
    remoteStatus: null,
  };
}

// ─── runSupplierSource ───────────────────────────────────

export interface RunSupplierSourceOutcome {
  runId: number;
  status: "success" | "no_change";
  /**
   * Porquê do no_change: HTTP 304 (validadores), metadata SFTP (size+mtime
   * iguais, sem transferir) ou hash de conteúdo igual.
   */
  noChangeReason?: "http_304" | "content_hash" | "remote_metadata";
  httpStatus: number | null;
  durationMs: number;
  importId: number | null;
  rowCount: number | null;
  newCount: number | null;
  updatedCount: number | null;
  missingCount: number | null;
  etag: string | null;
  lastModified: string | null;
  /** C.3.4.4: size+mtime observados (SFTP; null em fontes HTTPS). */
  remoteSize: number | null;
  remoteMtime: string | null;
  fileHash: string | null;
  /** Só presente em success — a UI usa importId/summary; nunca valores do browser. */
  preview?: SupplierImportPreview;
}

/**
 * O serviço ÚNICO de sincronização de uma fonte (Sync Now, futuro cron).
 *
 * 1. carrega a fonte; 2. valida enabled/config; 3. claim atómico Postgres;
 * 4. cria a run `running`; 5. fetchSource; 6. trata 304/hash no_change;
 * 7–8. preview via `previewSupplierImport` (mesmo motor); 9. associa
 * source_id/label/etag/last_modified ao import; 10–11. fecha a run e
 * atualiza a observabilidade da fonte. NUNCA aplica nada.
 */
/** Deps de run: HTTPS (fetchImpl) + SFTP (fetcherImpl) — cada ramo usa as suas. */
export type RunSupplierSourceDeps = FetchSourceOptions & SftpFetchOptions;

export async function runSupplierSource(
  sourceId: number,
  userId: number,
  deps: RunSupplierSourceDeps = {}
): Promise<RunSupplierSourceOutcome> {
  const [source] = await db.select().from(supplierSources).where(eq(supplierSources.id, sourceId)).limit(1);
  if (!source) throw new SupplierSourceError("SOURCE_NOT_FOUND", 404);
  if (source.sourceType !== "url" && source.sourceType !== "sftp") {
    throw new SupplierSourceError("SOURCE_TYPE_UNSUPPORTED", 400);
  }
  if (!source.enabled) throw new SupplierSourceError("SOURCE_DISABLED", 409);
  // C.3.4.4: o ramo SFTP (worker also-sftp-fetcher) partilha o claim atómico,
  // o motor de preview e a observabilidade — só o transporte difere.
  if (source.sourceType === "sftp") return runSftpSourceSync(source, userId, deps);
  if (!source.url) throw new SupplierSourceError("SOURCE_URL_INVALID", 400);

  // Claim ANTES de qualquer rede: duas sincronizações simultâneas da mesma
  // fonte nunca correm em paralelo (SOURCE_ALREADY_RUNNING). O FOR UPDATE na
  // linha da fonte serializa os dois claims; o segundo vê a run 'running' que
  // o primeiro acabou de commitar. Runs presas por um crash deixam de bloquear
  // após SOURCE_RUN_STALE_MS (decisão em Postgres, via started_at).
  const runId = await claimSourceRun(source.id);

  const startedAt = Date.now();
  try {
    const result = await fetchSource(
      {
        url: source.url,
        format: source.format as "auto" | "csv" | "xlsx",
        authType: source.authType as "none" | "basic" | "bearer" | "header",
        username: source.username,
        secretReference: source.secretReference,
        headersConfig: source.headersConfig,
        lastEtag: source.lastEtag,
        lastModified: source.lastModified,
      },
      deps
    );

    if (result.kind === "not_modified") {
      // 304: sem body, sem payload, sem preview, sem catálogo alterado, sem
      // token de apply. A run regista no_change e `last_checked_at` avança;
      // `last_success_at` mantém-se coerente (não houve conteúdo novo).
      const durationMs = Date.now() - startedAt;
      const now = new Date();
      await db.transaction(async (tx) => {
        await tx.update(supplierSourceRuns).set({
          status: "no_change",
          finishedAt: now,
          durationMs,
          httpStatus: 304,
          // snapshot dos validadores QUE PRODUZIRAM o 304 (os guardados na fonte)
          etag: clip(source.lastEtag, 500),
          lastModified: clip(source.lastModified, 100),
        }).where(eq(supplierSourceRuns.id, runId));
        await tx.update(supplierSources).set({
          lastCheckedAt: now,
          lastHttpStatus: 304,
          lastDurationMs: durationMs,
          lastErrorCode: null,
          lastErrorMessage: null,
          updatedAt: now,
        }).where(eq(supplierSources.id, source.id));
      });
      await auditRun(source, userId, { runId, status: "no_change", reason: "http_304", httpStatus: 304 });
      return {
        runId, status: "no_change", noChangeReason: "http_304", httpStatus: 304, durationMs,
        importId: null, rowCount: null, newCount: null, updatedCount: null, missingCount: null,
        etag: source.lastEtag, lastModified: source.lastModified, remoteSize: null, remoteMtime: null, fileHash: null,
      };
    }

    // Hash de IDENTIDADE sobre os bytes reais (a mesma infraestrutura do
    // upload: sourceSha256Hex). ETag é otimização; o hash é a verificação
    // final — mesmo com HTTP 200 pode não haver nada a fazer.
    const hash = sourceSha256Hex(result.payload);
    const [lastRelevant] = await db
      .select({ id: supplierImports.id, fileHash: supplierImports.fileHash, rowCount: supplierImports.rowCount })
      .from(supplierImports)
      .where(and(eq(supplierImports.sourceId, source.id), sql`${supplierImports.status} <> 'failed'`))
      .orderBy(desc(supplierImports.id))
      .limit(1);

    if (lastRelevant && lastRelevant.fileHash === hash) {
      // Conteúdo idêntico ao último snapshot relevante DESTA fonte: nenhum
      // preview duplicado; o fileHash histórico não se toca. Os validadores
      // NOVOS da resposta válida ficam guardados (próxima chamada pode poupar
      // o download com 304).
      const durationMs = Date.now() - startedAt;
      const now = new Date();
      await db.transaction(async (tx) => {
        await tx.update(supplierSourceRuns).set({
          status: "no_change",
          finishedAt: now,
          durationMs,
          httpStatus: result.httpStatus,
          rowCount: lastRelevant.rowCount,
          etag: clip(result.etag, 500),
          lastModified: clip(result.lastModified, 100),
          importId: lastRelevant.id,
        }).where(eq(supplierSourceRuns.id, runId));
        await tx.update(supplierSources).set({
          lastCheckedAt: now,
          // O download foi bem-sucedido (200 + bytes válidos): o último
          // contacto efetivamente bem-sucedido foi agora. O catálogo não muda.
          lastSuccessAt: now,
          lastHttpStatus: result.httpStatus,
          lastDurationMs: durationMs,
          lastRowCount: lastRelevant.rowCount,
          lastEtag: clip(result.etag, 500),
          lastModified: clip(result.lastModified, 100),
          lastErrorCode: null,
          lastErrorMessage: null,
          updatedAt: now,
        }).where(eq(supplierSources.id, source.id));
      });
      await auditRun(source, userId, { runId, status: "no_change", reason: "content_hash", httpStatus: result.httpStatus });
      return {
        runId, status: "no_change", noChangeReason: "content_hash", httpStatus: result.httpStatus, durationMs,
        importId: lastRelevant.id, rowCount: lastRelevant.rowCount, newCount: null, updatedCount: null,
        missingCount: null, etag: result.etag, lastModified: result.lastModified, remoteSize: null, remoteMtime: null, fileHash: hash,
      };
    }

    // O motor recebe APENAS um SourcePayload (o contrato C.3.4.1): parse,
    // matching, pricing, snapshot, token e deteção de desaparecidos são
    // integralmente o caminho C.3.1/C.3.2/C.3.3 — nada reimplementado aqui.
    const mapping = source.profileId ? await loadProfileMappingById(source.profileId) : undefined;
    const preview = await previewSupplierImport({
      supplierId: source.supplierId,
      source: result.payload,
      mapping,
      userId,
      sourceId: source.id,
    });

    // Os contagens da run vêm do que foi PERSISTIDO (releitura da linha do
    // import), não do que o parser devolveu em memória.
    const [persisted] = await db
      .select({ rowCount: supplierImports.rowCount })
      .from(supplierImports)
      .where(eq(supplierImports.id, preview.importId))
      .limit(1);
    const summary = (preview.summary ?? {}) as Record<string, unknown>;
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const newCount = num(summary.newProducts);
    const updatedCount = num(summary.ready);
    const missingCount =
      preview.missingProducts && Number.isFinite(preview.missingProducts.count) ? preview.missingProducts.count : null;

    const durationMs = Date.now() - startedAt;
    const now = new Date();
    await db.transaction(async (tx) => {
      await tx.update(supplierSourceRuns).set({
        status: "success",
        finishedAt: now,
        durationMs,
        rowCount: persisted?.rowCount ?? num(summary.total),
        newCount,
        updatedCount,
        missingCount,
        httpStatus: result.httpStatus,
        etag: clip(result.etag, 500),
        lastModified: clip(result.lastModified, 100),
        importId: preview.importId,
      }).where(eq(supplierSourceRuns.id, runId));
      await tx.update(supplierSources).set({
        lastCheckedAt: now,
        lastSuccessAt: now,
        lastErrorCode: null,
        lastErrorMessage: null,
        lastDurationMs: durationMs,
        lastRowCount: persisted?.rowCount ?? null,
        lastHttpStatus: result.httpStatus,
        lastEtag: clip(result.etag, 500),
        lastModified: clip(result.lastModified, 100),
        updatedAt: now,
      }).where(eq(supplierSources.id, source.id));
    });

    // NUNCA applySupplierImport() aqui — nem com apply_policy='auto_if_clean'.
    // Nesta fase o resultado de um sync é sempre um preview para revisão humana.
    await auditRun(source, userId, { runId, status: "success", importId: preview.importId, rowCount: persisted?.rowCount ?? null });
    return {
      runId,
      status: "success",
      httpStatus: result.httpStatus,
      durationMs,
      importId: preview.importId,
      rowCount: persisted?.rowCount ?? null,
      newCount,
      updatedCount,
      missingCount,
      etag: result.etag,
      lastModified: result.lastModified,
      remoteSize: null,
      remoteMtime: null,
      fileHash: hash,
      preview,
    };
  } catch (e) {
    // A run fecha-se SEMPRE com estado honesto; a fonte ganha observabilidade
    // sanitizada; o browser recebe código + frase da tabela partilhada.
    const { code, message, remoteStatus } = safeRunError(e);
    const durationMs = Date.now() - startedAt;
    const now = new Date();
    try {
      await db.transaction(async (tx) => {
        await tx.update(supplierSourceRuns).set({
          status: "error",
          finishedAt: now,
          durationMs,
          httpStatus: remoteStatus,
          errorCode: clip(code, 80),
          errorMessage: clip(message, 500),
        }).where(eq(supplierSourceRuns.id, runId));
        await tx.update(supplierSources).set({
          lastCheckedAt: now,
          lastErrorCode: clip(code, 80),
          lastErrorMessage: clip(message, 500),
          lastDurationMs: durationMs,
          // last_success_at NUNCA é tocado por um erro; last_http_status só
          // muda se o remoto respondeu (status conhecido).
          ...(remoteStatus !== null ? { lastHttpStatus: remoteStatus } : {}),
          updatedAt: now,
        }).where(eq(supplierSources.id, source.id));
      });
    } catch (finalizeError) {
      // Log de falha de finalização não pode esconder o erro original.
      console.error("supplier source run finalize:", finalizeError);
    }
    if (e instanceof SupplierSourceError) throw e;
    // C.3.4.4: erros SFTP tipados viajam com o código estável (a rota mapeia
    // para a frase segura da tabela partilhada — nunca texto do remoto).
    if (e instanceof SftpError) throw new SupplierSourceError(e.code, 502);
    throw new SupplierSourceError(code, 500);
  }
}

/**
 * C.3.4.4 — sincronização de UMA fonte SFTP (worker also-sftp-fetcher).
 *
 * Espelho do ramo HTTPS: claim atómico → stat/read → no_change (metadata ou
 * hash) → preview pelo MESMO motor → observabilidade. Diferenças:
 *  - transporte = fetchSftpSource (stat-then-read; size+mtime evitam a
 *    transferência, o SHA-256 do conteúdo decide a identidade);
 *  - validadores size+mtime em vez de ETag/Last-Modified; httpStatus é null
 *    (sem HTTP envolvido);
 *  - formato explícito da fonte (incl. also_stock/also_pricelist) ou `auto`
 *    (basename *.txt + sniffing dos bytes — ver sftp.ts);
 *  - NUNCA apply aqui (preview_only); sem cron nesta fase.
 */
async function runSftpSourceSync(
  source: typeof supplierSources.$inferSelect,
  userId: number,
  deps: RunSupplierSourceDeps
): Promise<RunSupplierSourceOutcome> {
  const runId = await claimSourceRun(source.id);
  const startedAt = Date.now();
  const fail = async (e: unknown): Promise<never> => {
    const { code, message } = safeRunError(e);
    const durationMs = Date.now() - startedAt;
    const now = new Date();
    try {
      await db.transaction(async (tx) => {
        await tx.update(supplierSourceRuns).set({
          status: "error",
          finishedAt: now,
          durationMs,
          httpStatus: null,
          errorCode: clip(code, 80),
          errorMessage: clip(message, 500),
        }).where(eq(supplierSourceRuns.id, runId));
        await tx.update(supplierSources).set({
          lastCheckedAt: now,
          lastErrorCode: clip(code, 80),
          lastErrorMessage: clip(message, 500),
          lastDurationMs: durationMs,
          updatedAt: now,
        }).where(eq(supplierSources.id, source.id));
      });
    } catch (finalizeError) {
      console.error("supplier source run finalize:", finalizeError);
    }
    if (e instanceof SupplierSourceError) throw e;
    if (e instanceof SftpError) throw new SupplierSourceError(e.code, 502);
    throw new SupplierSourceError(code, 500);
  };

  try {
    if (!source.sftpHost || !source.sftpRemotePath || !source.username || !source.secretReference || !source.sftpHostKeyFingerprint) {
      throw new SftpError("SFTP_CONFIG_INVALID");
    }
    const result = await fetchSftpSource(
      {
        host: source.sftpHost,
        port: source.sftpPort ?? 22,
        remotePath: source.sftpRemotePath,
        username: source.username,
        secretReference: source.secretReference,
        hostKeyFingerprint: source.sftpHostKeyFingerprint,
        format: source.format as "auto" | "csv" | "xlsx" | "also_stock" | "also_pricelist",
        lastRemoteSize: source.lastRemoteSize,
        lastRemoteMtime: source.lastRemoteMtime,
      },
      deps
    );

    if (result.kind === "not_modified") {
      // size+mtime iguais: sem transferência, sem preview, sem catálogo
      // alterado. last_checked_at avança; last_success_at NÃO (espelho do 304:
      // não houve conteúdo novo).
      const durationMs = Date.now() - startedAt;
      const now = new Date();
      await db.transaction(async (tx) => {
        await tx.update(supplierSourceRuns).set({
          status: "no_change",
          finishedAt: now,
          durationMs,
          httpStatus: null,
          remoteSize: result.stat.size,
          remoteMtime: clip(result.stat.mtime, 100),
        }).where(eq(supplierSourceRuns.id, runId));
        await tx.update(supplierSources).set({
          lastCheckedAt: now,
          lastHttpStatus: null,
          lastDurationMs: durationMs,
          lastErrorCode: null,
          lastErrorMessage: null,
          updatedAt: now,
        }).where(eq(supplierSources.id, source.id));
      });
      await auditRun(source, userId, { runId, status: "no_change", reason: "remote_metadata" });
      return {
        runId, status: "no_change", noChangeReason: "remote_metadata", httpStatus: null, durationMs,
        importId: null, rowCount: null, newCount: null, updatedCount: null, missingCount: null,
        etag: null, lastModified: null, remoteSize: result.stat.size, remoteMtime: result.stat.mtime, fileHash: null,
      };
    }

    // Conteúdo transferido: o formato é o explícito da fonte ou `auto`
    // (basename + sniffing); xlsx viaja em bytes, texto em UTF-8.
    const format = resolveSftpFormat(
      source.format as "auto" | "csv" | "xlsx" | "also_stock" | "also_pricelist",
      source.sftpRemotePath,
      result.content.bytes
    );
    const label = sftpLabel(source.sftpHost, source.sftpPort ?? 22, source.sftpRemotePath);
    const payload: SourcePayload =
      format === "xlsx"
        ? { kind: "sftp", label, format: "xlsx", bytes: result.content.bytes }
        : { kind: "sftp", label, format, text: new TextDecoder("utf-8").decode(result.content.bytes) };

    // Hash de IDENTIDADE sobre os bytes reais (a mesma infraestrutura do
    // upload). size+mtime poupam a transferência; o hash decide no_change.
    const hash = sourceSha256Hex(payload);
    const [lastRelevant] = await db
      .select({ id: supplierImports.id, fileHash: supplierImports.fileHash, rowCount: supplierImports.rowCount })
      .from(supplierImports)
      .where(and(eq(supplierImports.sourceId, source.id), sql`${supplierImports.status} <> 'failed'`))
      .orderBy(desc(supplierImports.id))
      .limit(1);

    if (lastRelevant && lastRelevant.fileHash === hash) {
      const durationMs = Date.now() - startedAt;
      const now = new Date();
      await db.transaction(async (tx) => {
        await tx.update(supplierSourceRuns).set({
          status: "no_change",
          finishedAt: now,
          durationMs,
          httpStatus: null,
          rowCount: lastRelevant.rowCount,
          remoteSize: result.content.size,
          remoteMtime: clip(result.content.mtime, 100),
          importId: lastRelevant.id,
        }).where(eq(supplierSourceRuns.id, runId));
        await tx.update(supplierSources).set({
          lastCheckedAt: now,
          lastSuccessAt: now,
          lastHttpStatus: null,
          lastDurationMs: durationMs,
          lastRowCount: lastRelevant.rowCount,
          lastRemoteSize: result.content.size,
          lastRemoteMtime: clip(result.content.mtime, 100),
          lastErrorCode: null,
          lastErrorMessage: null,
          updatedAt: now,
        }).where(eq(supplierSources.id, source.id));
      });
      await auditRun(source, userId, { runId, status: "no_change", reason: "content_hash" });
      return {
        runId, status: "no_change", noChangeReason: "content_hash", httpStatus: null, durationMs,
        importId: lastRelevant.id, rowCount: lastRelevant.rowCount, newCount: null, updatedCount: null,
        missingCount: null, etag: null, lastModified: null,
        remoteSize: result.content.size, remoteMtime: result.content.mtime, fileHash: hash,
      };
    }

    const mapping = source.profileId ? await loadProfileMappingById(source.profileId) : undefined;
    const preview = await previewSupplierImport({
      supplierId: source.supplierId,
      source: payload,
      mapping,
      userId,
      sourceId: source.id,
    });

    const [persisted] = await db
      .select({ rowCount: supplierImports.rowCount })
      .from(supplierImports)
      .where(eq(supplierImports.id, preview.importId))
      .limit(1);
    const summary = (preview.summary ?? {}) as Record<string, unknown>;
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const newCount = num(summary.newProducts);
    const updatedCount = num(summary.ready);
    const missingCount =
      preview.missingProducts && Number.isFinite(preview.missingProducts.count) ? preview.missingProducts.count : null;

    const durationMs = Date.now() - startedAt;
    const now = new Date();
    await db.transaction(async (tx) => {
      await tx.update(supplierSourceRuns).set({
        status: "success",
        finishedAt: now,
        durationMs,
        rowCount: persisted?.rowCount ?? num(summary.total),
        newCount,
        updatedCount,
        missingCount,
        httpStatus: null,
        remoteSize: result.content.size,
        remoteMtime: clip(result.content.mtime, 100),
        importId: preview.importId,
      }).where(eq(supplierSourceRuns.id, runId));
      await tx.update(supplierSources).set({
        lastCheckedAt: now,
        lastSuccessAt: now,
        lastErrorCode: null,
        lastErrorMessage: null,
        lastDurationMs: durationMs,
        lastRowCount: persisted?.rowCount ?? null,
        lastHttpStatus: null,
        lastRemoteSize: result.content.size,
        lastRemoteMtime: clip(result.content.mtime, 100),
        updatedAt: now,
      }).where(eq(supplierSources.id, source.id));
    });

    // NUNCA applySupplierImport() aqui — o resultado é sempre um preview.
    await auditRun(source, userId, { runId, status: "success", importId: preview.importId, rowCount: persisted?.rowCount ?? null });
    return {
      runId,
      status: "success",
      httpStatus: null,
      durationMs,
      importId: preview.importId,
      rowCount: persisted?.rowCount ?? null,
      newCount,
      updatedCount,
      missingCount,
      etag: null,
      lastModified: null,
      remoteSize: result.content.size,
      remoteMtime: result.content.mtime,
      fileHash: hash,
      preview,
    };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Claim atómico: uma run `running` por fonte. Feito com POSTGRES (SELECT FOR
 * UPDATE + INSERT na mesma transação), não com locks de processo Worker.
 */
async function claimSourceRun(sourceId: number): Promise<number> {
  return db.transaction(async (tx) => {
    const locked = rowsOf<{ id: number }>(
      await tx.execute(sql`SELECT id FROM ${supplierSources} WHERE id = ${sourceId} FOR UPDATE`)
    );
    if (locked.length === 0) throw new SupplierSourceError("SOURCE_NOT_FOUND", 404);
    const active = rowsOf(
      await tx.execute(sql`
        SELECT id FROM ${supplierSourceRuns}
         WHERE source_id = ${sourceId}
           AND status = 'running'
           AND started_at > now() - make_interval(secs => ${SOURCE_RUN_STALE_MS / 1000})
         LIMIT 1
      `)
    );
    if (active.length > 0) throw new SupplierSourceError("SOURCE_ALREADY_RUNNING", 409);
    const [run] = await tx
      .insert(supplierSourceRuns)
      .values({ sourceId, status: "running" })
      .returning({ id: supplierSourceRuns.id });
    return run.id;
  });
}

async function auditRun(
  source: { id: number; supplierId: number; name: string },
  userId: number,
  details: Record<string, unknown>
): Promise<void> {
  await createAuditLog({
    userId,
    action: "supplier_source.synced",
    entity: "supplier_source",
    entityId: source.id,
    details: { supplierId: source.supplierId, name: source.name, ...details },
  });
}

/** Mapping de um perfil específico (source.profile_id); inválido/ausente → undefined. */
async function loadProfileMappingById(profileId: number): Promise<Record<string, string> | undefined> {
  const [row] = await db
    .select({ mapping: supplierImportProfiles.mapping })
    .from(supplierImportProfiles)
    .where(eq(supplierImportProfiles.id, profileId))
    .limit(1);
  const raw = row?.mapping;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k !== "string" || typeof v !== "string") return undefined;
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// ─── Projeções seguras (API) ─────────────────────────────

/**
 * A resposta da API é SEMPRE esta projeção. Não há campo de segredo a
 * esconder por acidente: a BD só guarda `secret_reference` (o NOME) e é esse
 * valor devolvido; nunca qualquer valor resolvido do runtime.
 */
export interface SupplierSourceDto {
  id: number;
  supplierId: number;
  name: string;
  sourceType: string;
  format: string;
  url: string | null;
  enabled: boolean;
  authType: string;
  username: string | null;
  secretReference: string | null;
  headersConfig: Record<string, unknown> | null;
  profileId: number | null;
  applyPolicy: string;
  /** C.3.4.4: config SFTP (null em fontes HTTPS; nunca password). */
  sftpHost: string | null;
  sftpPort: number | null;
  sftpRemotePath: string | null;
  sftpHostKeyFingerprint: string | null;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  lastDurationMs: number | null;
  lastRowCount: number | null;
  lastHttpStatus: number | null;
  lastEtag: string | null;
  lastModified: string | null;
  /** C.3.4.4: validadores remotos SFTP (size+mtime; null em HTTPS). */
  lastRemoteSize: number | null;
  lastRemoteMtime: string | null;
  createdAt: string;
  updatedAt: string;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function toSourceDto(row: typeof supplierSources.$inferSelect): SupplierSourceDto {
  return {
    id: row.id,
    supplierId: row.supplierId,
    name: row.name,
    sourceType: row.sourceType,
    format: row.format,
    url: row.url,
    enabled: row.enabled,
    authType: row.authType,
    username: row.username,
    secretReference: row.secretReference,
    headersConfig: row.headersConfig ?? null,
    profileId: row.profileId,
    applyPolicy: row.applyPolicy,
    sftpHost: row.sftpHost,
    sftpPort: row.sftpPort,
    sftpRemotePath: row.sftpRemotePath,
    sftpHostKeyFingerprint: row.sftpHostKeyFingerprint,
    lastCheckedAt: iso(row.lastCheckedAt),
    lastSuccessAt: iso(row.lastSuccessAt),
    lastErrorCode: row.lastErrorCode,
    lastErrorMessage: row.lastErrorMessage,
    lastDurationMs: row.lastDurationMs,
    lastRowCount: row.lastRowCount,
    lastHttpStatus: row.lastHttpStatus,
    lastEtag: row.lastEtag,
    lastModified: row.lastModified,
    lastRemoteSize: row.lastRemoteSize,
    lastRemoteMtime: row.lastRemoteMtime,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface SupplierSourceRunDto {
  id: number;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  rowCount: number | null;
  newCount: number | null;
  updatedCount: number | null;
  missingCount: number | null;
  httpStatus: number | null;
  etag: string | null;
  lastModified: string | null;
  /** C.3.4.4: size+mtime observados (SFTP; null em HTTPS). */
  remoteSize: number | null;
  remoteMtime: string | null;
  importId: number | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export async function listSupplierSources(supplierId: number): Promise<SupplierSourceDto[]> {
  const rows = await db
    .select()
    .from(supplierSources)
    .where(eq(supplierSources.supplierId, supplierId))
    .orderBy(desc(supplierSources.id));
  return rows.map(toSourceDto);
}

/** Estado atual + histórico mínimo por fonte (o que a UI do Sync Now re-lê). */
export async function getSupplierSourceDetail(sourceId: number): Promise<{
  source: SupplierSourceDto;
  activeRun: SupplierSourceRunDto | null;
  runs: SupplierSourceRunDto[];
} | null> {
  const [source] = await db.select().from(supplierSources).where(eq(supplierSources.id, sourceId)).limit(1);
  if (!source) return null;
  const toRunDto = (r: typeof supplierSourceRuns.$inferSelect): SupplierSourceRunDto => ({
    id: r.id,
    status: r.status,
    startedAt: r.startedAt.toISOString(),
    finishedAt: iso(r.finishedAt),
    durationMs: r.durationMs,
    rowCount: r.rowCount,
    newCount: r.newCount,
    updatedCount: r.updatedCount,
    missingCount: r.missingCount,
    httpStatus: r.httpStatus,
    etag: r.etag,
    lastModified: r.lastModified,
    remoteSize: r.remoteSize,
    remoteMtime: r.remoteMtime,
    importId: r.importId,
    errorCode: r.errorCode,
    errorMessage: r.errorMessage,
  });
  const runs = await db
    .select()
    .from(supplierSourceRuns)
    .where(eq(supplierSourceRuns.sourceId, sourceId))
    .orderBy(desc(supplierSourceRuns.startedAt), desc(supplierSourceRuns.id))
    .limit(10);
  // Run ativa = a mais recente ainda 'running' DENTRO da janela de claim
  // (a UI usa isto para desativar o botão "Sincronizar agora").
  const active = runs.find(
    (r) => r.status === "running" && Date.now() - r.startedAt.getTime() < SOURCE_RUN_STALE_MS
  );
  return { source: toSourceDto(source), activeRun: active ? toRunDto(active) : null, runs: runs.map(toRunDto) };
}

// ─── CRUD administrativo ─────────────────────────────────

/** Linha crua para a rota validar o ESTADO FINAL (nunca exposta em respostas). */
export async function loadSupplierSourceRow(sourceId: number): Promise<typeof supplierSources.$inferSelect | null> {
  const [row] = await db.select().from(supplierSources).where(eq(supplierSources.id, sourceId)).limit(1);
  return row ?? null;
}

export interface CreateSupplierSourceInput {
  supplierId: number;
  name: string;
  url: string;
  format: "auto" | "csv" | "xlsx";
  authType: "none" | "basic" | "bearer" | "header";
  username?: string | null;
  secretReference?: string | null;
  headersConfig?: Record<string, string> | null;
  profileId?: number | null;
}

/**
 * Normalização de estado de auth ANTES de persistir:
 *  - `none` nunca transporta username/secret/headers (config morta some);
 *  - non-none sem header name para `header` fica como está (schema já validou).
 */
export function normalizeAuthState<T extends {
  authType: string;
  username?: string | null;
  secretReference?: string | null;
  headersConfig?: Record<string, string> | null;
}>(state: T): T {
  if (state.authType !== "none") return state;
  return { ...state, username: null, secretReference: null, headersConfig: null };
}

/**
 * Create: a linha nasce SEMPRE desativada (enabled default false do schema —
 * nunca exposto como campo desta API) e com apply_policy='preview_only'.
 * Não existe caminho por aqui para ativar implicitamente uma sincronização.
 */
export async function createSupplierSource(
  input: CreateSupplierSourceInput,
  userId: number
): Promise<SupplierSourceDto> {
  const state = normalizeAuthState(input);
  try {
    const [row] = await db
      .insert(supplierSources)
      .values({
        supplierId: state.supplierId,
        name: state.name,
        sourceType: "url",
        url: state.url,
        format: state.format,
        authType: state.authType,
        username: state.username ?? null,
        secretReference: state.secretReference ?? null,
        headersConfig: state.headersConfig ?? null,
        profileId: state.profileId ?? null,
        applyPolicy: "preview_only",
        enabled: false,
        createdBy: userId,
        updatedBy: userId,
      })
      .returning();
    await createAuditLog({
      userId, action: "supplier_source.created", entity: "supplier_source", entityId: row.id,
      details: { supplierId: row.supplierId, name: row.name, authType: row.authType, format: row.format },
    });
    return toSourceDto(row);
  } catch (e) {
    const storage = classifyImportStorageFailure(e);
    if (storage?.code === "IMPORT_DUPLICATE_ROW") throw new SupplierSourceError("SOURCE_NAME_EXISTS", 409);
    throw e;
  }
}

/**
 * Update: recebe o patch JÁ VALIDADO (a rota valida a forma e o estado final
 * contra o schema de create). Campos de conteúdo de fonte (url/format/auth)
 * podem mudar; `enabled` NÃO muda por aqui (é PATCH dedicado, auditable).
 */
export async function updateSupplierSource(
  sourceId: number,
  patch: Partial<Omit<CreateSupplierSourceInput, "supplierId" | "url">> & { url?: string },
  userId: number
): Promise<SupplierSourceDto> {
  const [existing] = await db.select().from(supplierSources).where(eq(supplierSources.id, sourceId)).limit(1);
  if (!existing) throw new SupplierSourceError("SOURCE_NOT_FOUND", 404);

  const merged = normalizeAuthState({
    supplierId: existing.supplierId,
    name: patch.name ?? existing.name,
    url: patch.url ?? existing.url ?? "",
    format: patch.format ?? (existing.format as CreateSupplierSourceInput["format"]),
    authType: patch.authType ?? (existing.authType as CreateSupplierSourceInput["authType"]),
    username: patch.username !== undefined ? patch.username : existing.username,
    secretReference: patch.secretReference !== undefined ? patch.secretReference : existing.secretReference,
    headersConfig: patch.headersConfig !== undefined ? patch.headersConfig : (existing.headersConfig as Record<string, string> | null),
    profileId: patch.profileId !== undefined ? patch.profileId : existing.profileId,
  });

  try {
    const [row] = await db
      .update(supplierSources)
      .set({
        name: merged.name,
        url: merged.url || null,
        format: merged.format,
        authType: merged.authType,
        username: merged.username,
        secretReference: merged.secretReference,
        headersConfig: merged.headersConfig,
        profileId: merged.profileId,
        updatedBy: userId,
        updatedAt: new Date(),
      })
      .where(eq(supplierSources.id, sourceId))
      .returning();
    await createAuditLog({
      userId, action: "supplier_source.updated", entity: "supplier_source", entityId: sourceId,
      details: { name: row.name, authType: row.authType, format: row.format },
    });
    return toSourceDto(row);
  } catch (e) {
    const storage = classifyImportStorageFailure(e);
    if (storage?.code === "IMPORT_DUPLICATE_ROW") throw new SupplierSourceError("SOURCE_NAME_EXISTS", 409);
    throw e;
  }
}

export interface CreateSftpSourceInput {
  supplierId: number;
  name: string;
  sftpHost: string;
  sftpPort: number;
  sftpRemotePath: string;
  username: string;
  /** NOME do segredo no worker also-sftp-fetcher — nunca o valor. */
  secretReference: string;
  /** Fingerprint SHA-256 da host key (pin obrigatório). */
  sftpHostKeyFingerprint: string;
  format: "auto" | "csv" | "xlsx" | "also_stock" | "also_pricelist";
  profileId?: number | null;
}

/**
 * C.3.4.4 — Create SFTP: a linha nasce SEMPRE desativada e preview_only.
 * As guardas puras correm antes de persistir (config inválida falha na API,
 * não em runtime). SFTP usa sempre auth por password (auth_type='basic' +
 * secret_reference): é o único mecanismo do fetcher read-only.
 */
export async function createSftpSource(
  input: CreateSftpSourceInput,
  userId: number
): Promise<SupplierSourceDto> {
  try {
    const [row] = await db
      .insert(supplierSources)
      .values({
        supplierId: input.supplierId,
        name: input.name,
        sourceType: "sftp",
        url: null,
        format: input.format,
        authType: "basic",
        username: input.username,
        secretReference: input.secretReference,
        headersConfig: null,
        sftpHost: input.sftpHost,
        sftpPort: input.sftpPort,
        sftpRemotePath: input.sftpRemotePath,
        sftpHostKeyFingerprint: input.sftpHostKeyFingerprint,
        profileId: input.profileId ?? null,
        applyPolicy: "preview_only",
        enabled: false,
        createdBy: userId,
        updatedBy: userId,
      })
      .returning();
    await createAuditLog({
      userId, action: "supplier_source.created", entity: "supplier_source", entityId: row.id,
      details: { supplierId: row.supplierId, name: row.name, sourceType: "sftp", format: row.format },
    });
    return toSourceDto(row);
  } catch (e) {
    const storage = classifyImportStorageFailure(e);
    if (storage?.code === "IMPORT_DUPLICATE_ROW") throw new SupplierSourceError("SOURCE_NAME_EXISTS", 409);
    throw e;
  }
}

/**
 * C.3.4.4 — Update SFTP: patch já validado (a rota valida a forma e o estado
 * final). `enabled` NÃO muda por aqui. Rejeita linhas que não sejam SFTP.
 */
export async function updateSftpSource(
  sourceId: number,
  patch: Partial<Omit<CreateSftpSourceInput, "supplierId">>,
  userId: number
): Promise<SupplierSourceDto> {
  const [existing] = await db.select().from(supplierSources).where(eq(supplierSources.id, sourceId)).limit(1);
  if (!existing) throw new SupplierSourceError("SOURCE_NOT_FOUND", 404);
  if (existing.sourceType !== "sftp") throw new SupplierSourceError("SOURCE_TYPE_UNSUPPORTED", 400);

  try {
    const [row] = await db
      .update(supplierSources)
      .set({
        name: patch.name ?? existing.name,
        format: patch.format ?? existing.format,
        username: patch.username ?? existing.username,
        secretReference: patch.secretReference ?? existing.secretReference,
        sftpHost: patch.sftpHost ?? existing.sftpHost,
        sftpPort: patch.sftpPort ?? existing.sftpPort,
        sftpRemotePath: patch.sftpRemotePath ?? existing.sftpRemotePath,
        sftpHostKeyFingerprint: patch.sftpHostKeyFingerprint ?? existing.sftpHostKeyFingerprint,
        profileId: patch.profileId !== undefined ? patch.profileId : existing.profileId,
        updatedBy: userId,
        updatedAt: new Date(),
      })
      .where(eq(supplierSources.id, sourceId))
      .returning();
    await createAuditLog({
      userId, action: "supplier_source.updated", entity: "supplier_source", entityId: sourceId,
      details: { name: row.name, sourceType: "sftp", format: row.format },
    });
    return toSourceDto(row);
  } catch (e) {
    const storage = classifyImportStorageFailure(e);
    if (storage?.code === "IMPORT_DUPLICATE_ROW") throw new SupplierSourceError("SOURCE_NAME_EXISTS", 409);
    throw e;
  }
}

/**
 * Ativar/desativar é o ÚNICO caminho para `enabled=true` e exige fonte com
 * configuração válida (as mesmas guardas puras do fetch são aplicadas aqui —
 * ativar uma fonte malformada/hostil falha na API, não em runtime).
 */
export async function setSupplierSourceEnabled(sourceId: number, enabled: boolean, userId: number): Promise<SupplierSourceDto> {
  const [existing] = await db.select().from(supplierSources).where(eq(supplierSources.id, sourceId)).limit(1);
  if (!existing) throw new SupplierSourceError("SOURCE_NOT_FOUND", 404);
  if (enabled) {
    if (existing.sourceType === "sftp") {
      // C.3.4.4: config SFTP completa + guardas puras antes de ativar.
      if (
        !existing.sftpHost || !existing.sftpRemotePath || !existing.username ||
        !existing.secretReference || !existing.sftpHostKeyFingerprint
      ) {
        throw new SupplierSourceError("SFTP_CONFIG_INVALID", 400);
      }
      try {
        guardSftpHost(existing.sftpHost);
        guardSftpPort(existing.sftpPort ?? 22);
        guardSftpPath(existing.sftpRemotePath);
        guardSftpUsername(existing.username);
        guardSftpSecretName(existing.secretReference);
        guardSftpFingerprint(existing.sftpHostKeyFingerprint);
      } catch (e) {
        if (e instanceof SftpError) throw new SupplierSourceError(e.code, 400);
        throw e;
      }
    } else {
      if (existing.sourceType !== "url" || !existing.url) throw new SupplierSourceError("SOURCE_URL_INVALID", 400);
      const guard = guardSupplierSourceUrl(existing.url);
      if (!guard.ok) throw new SupplierSourceError(guard.code, 400);
    }
  }
  const [row] = await db
    .update(supplierSources)
    .set({ enabled, updatedBy: userId, updatedAt: new Date() })
    .where(eq(supplierSources.id, sourceId))
    .returning();
  await createAuditLog({
    userId,
    action: enabled ? "supplier_source.enabled" : "supplier_source.disabled",
    entity: "supplier_source",
    entityId: sourceId,
    details: { name: row.name },
  });
  return toSourceDto(row);
}
