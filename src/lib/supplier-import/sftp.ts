/**
 * C.3.4.4 — Fonte SFTP do lado da app Arena.
 *
 * A app NUNCA fala SSH: valida a config (guardas partilhadas com o worker),
 * chama o worker `also-sftp-fetcher` via Cloudflare Service Binding e recebe
 * stat/conteúdo. A password NUNCA existe neste processo — só o NOME do secret
 * viaja para o worker (que o resolve do SEU runtime).
 *
 * Estratégia de transferência (idempotência §15):
 *  - stat primeiro: size+mtime iguais aos guardados → `not_modified` SEM
 *    transferir (otimização);
 *  - conteúdo transferido → SHA-256 decide a identidade (verificado aqui
 *    contra o hash declarado pelo worker; mismatch falha fechado).
 *
 * Injeção de dependências (padrão do fetch HTTPS): `fetcherImpl` permite
 * testar sem binding/rede; a produção usa a service binding.
 */

import { sha256HexBytes } from "./normalize";
import { looksLikeAlsoPricelist, looksLikeAlsoStock } from "./also";
import type { SupplierFileFormat } from "./file";
import {
  SFTP_MAX_CONTENT_BYTES,
  SFTP_DEFAULT_PORT,
  guardSftpConfig,
  guardSftpFingerprint,
  guardSftpHost,
  guardSftpPath,
  guardSftpPort,
  guardSftpSecretName,
  guardSftpUsername,
  sftpLabel as buildSftpLabel,
  type SftpConfig,
} from "../../../workers/also-sftp-fetcher/src/guards";
import {
  SftpError,
  type SftpErrorCode,
} from "../../../workers/also-sftp-fetcher/src/errors";
import type {
  SftpWorkerRequest,
  SftpWorkerResponse as WorkerEnvelope,
} from "../../../workers/also-sftp-fetcher/src/index";

export { SftpError, SFTP_MAX_CONTENT_BYTES, SFTP_DEFAULT_PORT };
// Guardas puras partilhadas (lançam SftpError; serviços/rotas mapeiam).
export {
  guardSftpConfig,
  guardSftpFingerprint,
  guardSftpHost,
  guardSftpPath,
  guardSftpPort,
  guardSftpSecretName,
  guardSftpUsername,
};
export type { SftpErrorCode };

/** O que o fetch precisa de saber da source (projeção — sem segredos). */
export interface SftpSourceConfig {
  host: string;
  port: number;
  remotePath: string;
  username: string;
  /** NOME do secret no runtime do worker. Nunca o valor. */
  secretReference: string;
  hostKeyFingerprint: string;
  format: SupplierFileFormat | "auto";
  /** Validadores do último stat bom (otimização no_change). */
  lastRemoteSize?: number | null;
  lastRemoteMtime?: string | null;
}

export interface SftpFetchOptions {
  /** Transporte injetável (produção = service binding). */
  fetcherImpl?: (req: SftpWorkerRequest) => Promise<WorkerEnvelope>;
  timeoutMs?: number;
  maxBytes?: number;
  maxAttempts?: number;
}

export const SFTP_FETCH_TIMEOUT_MS = 60_000;
/** Margem do aborto externo sobre o deadline do worker. */
const SFTP_OUTER_TIMEOUT_MARGIN_MS = 15_000;

export interface SftpStat {
  size: number | null;
  /** mtime unix (segundos) normalizado para string decimal. */
  mtime: string | null;
}

export interface SftpContent extends SftpStat {
  bytes: Uint8Array;
  sha256: string;
}

export type SftpFetchResult =
  | { kind: "not_modified"; stat: SftpStat }
  | { kind: "content"; content: SftpContent };

function normalizeMtime(mtime: number | null): string | null {
  if (mtime === null || mtime === undefined) return null;
  if (!Number.isSafeInteger(mtime) || mtime < 0) return null;
  return String(mtime);
}

/** Valida a config da fonte (falha rápido, sem round-trip ao worker). */
export function validatedSftpConfig(cfg: SftpSourceConfig): SftpConfig {
  return guardSftpConfig({
    host: cfg.host,
    port: cfg.port,
    remotePath: cfg.remotePath,
    username: cfg.username,
    secretName: cfg.secretReference,
    hostKeyFingerprint: cfg.hostKeyFingerprint,
  });
}

function bindingFetcher(): ((req: SftpWorkerRequest) => Promise<WorkerEnvelope>) | null {
  try {
    // Padrão do repo (src/db/index.ts, src/lib/storage/r2.ts): o contexto
    // Cloudflare só existe no runtime Edge; fora dele (dev/teste) é null.
    const { getCloudflareContext } = require("@opennextjs/cloudflare") as {
      getCloudflareContext: () => { env: Record<string, unknown> };
    };
    const ctx = getCloudflareContext();
    const binding = ctx.env["ALSO_SFTP_FETCHER"] as { fetch: typeof fetch } | undefined;
    if (!binding || typeof binding.fetch !== "function") return null;
    return async (req: SftpWorkerRequest) => {
      const res = await binding.fetch("https://also-sftp-fetcher/sftp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
        signal: AbortSignal.timeout((req.timeoutMs ?? SFTP_FETCH_TIMEOUT_MS) + SFTP_OUTER_TIMEOUT_MARGIN_MS),
      });
      if (!res.ok) throw new SftpError("SFTP_FETCH_FAILED", { retryable: true });
      const envelope = (await res.json()) as WorkerEnvelope;
      if (!envelope || typeof envelope !== "object" || typeof (envelope as { ok?: unknown }).ok !== "boolean") {
        throw new SftpError("SFTP_FETCH_FAILED", { retryable: true });
      }
      return envelope;
    };
  } catch (e) {
    if (e instanceof SftpError) throw e;
    return null;
  }
}

function envelopeError(envelope: Extract<WorkerEnvelope, { ok: false }>): SftpError {
  return new SftpError(envelope.code);
}

function checkStatEnvelope(envelope: WorkerEnvelope): { size: number | null; mtime: number | null } {
  if (!envelope.ok) throw envelopeError(envelope);
  const size = typeof envelope.size === "number" && Number.isSafeInteger(envelope.size) && envelope.size >= 0 ? envelope.size : null;
  const mtime = typeof envelope.mtime === "number" && Number.isSafeInteger(envelope.mtime) && envelope.mtime >= 0 ? envelope.mtime : null;
  return { size, mtime };
}

/** stat remoto (metadados, sem conteúdo). */
export async function statSftpSource(cfg: SftpSourceConfig, opts: SftpFetchOptions = {}): Promise<SftpStat> {
  const valid = validatedSftpConfig(cfg);
  const fetcher = opts.fetcherImpl ?? bindingFetcher();
  if (!fetcher) throw new SftpError("SFTP_BINDING_UNAVAILABLE");
  const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? SFTP_FETCH_TIMEOUT_MS, 1000), 120_000);
  const envelope = await fetcher({
    op: "stat",
    host: valid.host,
    port: valid.port,
    username: valid.username,
    secretName: valid.secretName,
    remotePath: valid.remotePath,
    hostKeyFingerprint: valid.hostKeyFingerprint,
    timeoutMs,
    maxAttempts: opts.maxAttempts,
  });
  const { size, mtime } = checkStatEnvelope(envelope);
  return { size, mtime: normalizeMtime(mtime) };
}

/** read integral (com verificação de integridade do hash declarado). */
export async function readSftpSource(cfg: SftpSourceConfig, opts: SftpFetchOptions = {}): Promise<SftpContent> {
  const valid = validatedSftpConfig(cfg);
  const fetcher = opts.fetcherImpl ?? bindingFetcher();
  if (!fetcher) throw new SftpError("SFTP_BINDING_UNAVAILABLE");
  const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? SFTP_FETCH_TIMEOUT_MS, 1000), 120_000);
  const maxBytes = Math.min(Math.max(opts.maxBytes ?? SFTP_MAX_CONTENT_BYTES, 1), SFTP_MAX_CONTENT_BYTES);
  const envelope = await fetcher({
    op: "read",
    host: valid.host,
    port: valid.port,
    username: valid.username,
    secretName: valid.secretName,
    remotePath: valid.remotePath,
    hostKeyFingerprint: valid.hostKeyFingerprint,
    maxBytes,
    timeoutMs,
    maxAttempts: opts.maxAttempts,
  });
  if (!envelope.ok) throw envelopeError(envelope);
  if (typeof envelope.contentBase64 !== "string" || typeof envelope.sha256 !== "string") {
    throw new SftpError("SFTP_FETCH_FAILED", { retryable: true });
  }
  const bytes = base64ToBytes(envelope.contentBase64);
  if (bytes.length > maxBytes) throw new SftpError("SFTP_TOO_LARGE");
  // Defesa em profundidade: o hash é recalculado aqui (canal confiável, mas
  // a verificação é barata e trava corrupção/bugs do worker).
  const actual = sha256HexBytes(bytes);
  if (actual !== envelope.sha256.toLowerCase()) throw new SftpError("SFTP_FETCH_FAILED", { retryable: true });
  const { size, mtime } = checkStatEnvelope(envelope);
  return { bytes, size: size ?? bytes.length, mtime: normalizeMtime(mtime), sha256: actual };
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * stat-then-read: `not_modified` quando size+mtime batem nos validadores
 * guardados (sem transferir); senão lê o conteúdo. Também falha fechado
 * quando a config é inválida — antes de qualquer rede.
 */
export async function fetchSftpSource(
  cfg: SftpSourceConfig,
  opts: SftpFetchOptions = {}
): Promise<SftpFetchResult> {
  validatedSftpConfig(cfg);
  const st = await statSftpSource(cfg, opts);
  const sizeHit = st.size !== null && cfg.lastRemoteSize !== null && cfg.lastRemoteSize !== undefined && st.size === cfg.lastRemoteSize;
  const mtimeHit = st.mtime !== null && !!cfg.lastRemoteMtime && st.mtime === cfg.lastRemoteMtime;
  // Otimização CONSERVADORA: só evita a transferência quando AMBOS os
  // validadores existem e batem (servidor que omite attrs → transfere sempre).
  if (sizeHit && mtimeHit) return { kind: "not_modified", stat: st };
  const content = await readSftpSource(cfg, opts);
  return { kind: "content", content };
}

/** Label legível sem credenciais (file_name/source_label do snapshot). */
export function sftpLabel(host: string, port: number, remotePath: string): string {
  return buildSftpLabel(host, port, remotePath);
}

// ─── Formato efetivo do payload SFTP ──────────────────────

/**
 * Basename do remotePath com semântica ALSO canónica (*.txt), espelho de
 * classifySupplierFileName — mas LOCAL ao SFTP (nunca toca no caminho HTTPS):
 *  - /…/pricelist*.txt → also_pricelist (o parser pode falhar UNSUPPORTED);
 *  - /…/stock*.txt     → also_stock;
 *  - senão: sniffing dos bytes (xlsx → xlsx; assinatura ALSO → also_*; csv).
 */
export function sftpAutoFormat(remotePath: string, bytes: Uint8Array): SupplierFileFormat {
  const base = remotePath.split("/").pop() ?? "";
  if (/^pricelist[^/]*\.txt$/i.test(base)) return "also_pricelist";
  if (/^stock[^/]*\.txt$/i.test(base)) return "also_stock";
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    return "xlsx";
  }
  const text = new TextDecoder("utf-8").decode(bytes);
  if (looksLikeAlsoStock(text)) return "also_stock";
  if (looksLikeAlsoPricelist(text)) return "also_pricelist";
  return "csv";
}

/** Formato pedido na config, com `auto` resolvido pelos bytes/path. */
export function resolveSftpFormat(
  configured: SupplierFileFormat | "auto",
  remotePath: string,
  bytes: Uint8Array
): SupplierFileFormat {
  if (configured !== "auto") return configured;
  return sftpAutoFormat(remotePath, bytes);
}
