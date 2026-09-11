/**
 * C.3.4.4 — also-sftp-fetcher: worker de transporte SFTP (READ-ONLY).
 *
 * Arquitetura: a app Arena NÃO fala SSH. Chama este worker via Cloudflare
 * Service Binding; o worker abre TCP (`cloudflare:sockets`), faz o handshake
 * SSH-2, autentica com o secret do SEU runtime e executa stat/read.
 *
 * Contrato RPC (POST JSON — sem segredos, só o NOME do secret):
 *   pedido:  { op, host, port, username, secretName, remotePath,
 *              hostKeyFingerprint, maxBytes?, timeoutMs?, maxAttempts? }
 *   stat ok: { ok: true, size: number|null, mtime: number|null }
 *   read ok: { ok: true, size, mtime, sha256, contentBase64 }
 *   erro:    { ok: false, code, message } (tabela segura — sem segredos,
 *            sem bytes do remoto, sem paths, sem stack)
 *
 * Segurança:
 *  - pin da host key OBRIGATÓRIO (mismatch aborta antes de auth/dados);
 *  - allowlist exata de hosts (env SFTP_ALLOWED_HOSTS, default paco.also.com);
 *  - secret resolvido SÓ do env do worker, pelo NOME (fail-closed);
 *  - teto 5 MB (stat antecipado + aborto a meio do stream);
 *  - retry SÓ para transitórios de rede (timeout/fetch), nunca auth/hostkey;
 *  - READ-ONLY estrutural (ver ./sftp.ts).
 *
 * Deploy: este worker NÃO deve ter routes/domínios públicos — é chamado só
 * via service binding `ALSO_SFTP_FETCHER` (ver wrangler.jsonc da app).
 */

import { SftpError, sftpErrorMessage, type SftpErrorCode } from "./errors";
import {
  SFTP_MAX_CONTENT_BYTES,
  guardSftpConfig,
  type SftpConfig,
} from "./guards";
import { SshChannel, SshTransport, base64Encode, type DuplexSocket } from "./ssh";
import { SftpClient } from "./sftp";

export interface FetcherEnv {
  /** Hosts exatos permitidos (csv, default `paco.also.com`). */
  SFTP_ALLOWED_HOSTS?: string;
  /** Secrets (ex.: ALSO_SFTP_PASSWORD) + quaisquer outras vars. */
  [key: string]: string | undefined;
}

export type SftpOp = "stat" | "read";

export interface SftpWorkerRequest {
  op: SftpOp;
  host: string;
  port: number;
  username: string;
  secretName: string;
  remotePath: string;
  hostKeyFingerprint: string;
  maxBytes?: number;
  timeoutMs?: number;
  maxAttempts?: number;
}

export type SftpWorkerResponse =
  | { ok: true; size: number | null; mtime: number | null; sha256?: string; contentBase64?: string }
  | { ok: false; code: SftpErrorCode; message: string };

/** Deadline default por operação (handshake+auth+transferência ≤5 MB). */
export const SFTP_OP_TIMEOUT_MS = 60_000;
/** Teto absoluto do deadline pedido pelo chamador. */
const SFTP_OP_TIMEOUT_MAX_MS = 120_000;
/** Máximo de tentativas (só transitórios de rede são repetidos). */
const SFTP_MAX_ATTEMPTS_DEFAULT = 3;
const SFTP_MAX_ATTEMPTS_MAX = 5;
/** Teto do corpo do pedido RPC (só config — nunca conteúdo). */
const MAX_REQUEST_BYTES = 8192;

const DEFAULT_ALLOWED_HOSTS = ["paco.also.com"];

function allowedHosts(env: FetcherEnv): string[] {
  const raw = (env.SFTP_ALLOWED_HOSTS ?? "").trim();
  if (!raw) return DEFAULT_ALLOWED_HOSTS;
  const list = raw
    .split(",")
    .map((h) => h.trim().toLowerCase().replace(/\.$/, ""))
    .filter(Boolean);
  return list.length > 0 ? list : DEFAULT_ALLOWED_HOSTS;
}

/** Resolve o VALOR do secret pelo NOME (fail-closed; nunca em erros/logs). */
export function resolveWorkerSecret(secretName: string, env: FetcherEnv): string {
  const value = env[secretName];
  if (typeof value !== "string" || value.length === 0 || /[\r\n\0]/.test(value)) {
    throw new SftpError("SFTP_SECRET_MISSING");
  }
  return value;
}

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : def;
  return Math.min(max, Math.max(min, n));
}

export interface RunSftpOpOptions {
  connector: () => Promise<DuplexSocket>;
  subtle?: SubtleCrypto;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Executa UMA operação (stat/read) com retry de transitórios. Cada tentativa
 * abre uma conexão NOVA (nunca se reutiliza uma sessão a meio de um erro).
 */
export async function runSftpOp(
  cfg: SftpConfig,
  op: SftpOp,
  password: string,
  opts: RunSftpOpOptions & { maxBytes: number; timeoutMs: number; maxAttempts: number }
): Promise<{ size: number | null; mtime: number | null; bytes: Uint8Array | null }> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastError: SftpError = new SftpError("SFTP_FETCH_FAILED");
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    const transport = new SshTransport({ connector: opts.connector, timeoutMs: opts.timeoutMs, subtle: opts.subtle });
    try {
      await transport.connect();
      const deadline = Date.now() + opts.timeoutMs;
      await transport.handshake(deadline, cfg.hostKeyFingerprint);
      await transport.authenticatePassword(deadline, cfg.username, password);
      const channel: SshChannel = await transport.openSftpChannel(deadline);
      try {
        const sftp = new SftpClient(channel);
        await sftp.init(deadline);
        const st = await sftp.stat(deadline, cfg.remotePath);
        if (op === "stat") {
          await channel.close(deadline);
          return { size: st.size, mtime: st.mtime, bytes: null };
        }
        // Teto antecipado por stat; o stream re-verifica (size pode mentir).
        if (st.size !== null && st.size > opts.maxBytes) throw new SftpError("SFTP_TOO_LARGE");
        const { bytes } = await sftp.read(deadline, cfg.remotePath, opts.maxBytes);
        await channel.close(deadline);
        return { size: st.size ?? bytes.length, mtime: st.mtime, bytes };
      } finally {
        await transport.destroy();
      }
    } catch (e) {
      await transport.destroy().catch(() => undefined);
      const err = e instanceof SftpError ? e : new SftpError("SFTP_FETCH_FAILED", { retryable: true });
      if (!(e instanceof SftpError)) console.error("[sftp-fetch] unexpected:", e);
      lastError = err;
      if (!err.retryable || attempt >= opts.maxAttempts) throw err;
      await sleep(250 * attempt);
    }
  }
  throw lastError;
}

/** Núcleo testável: pedido validado + env → envelope (sem Request/Response). */
export async function handleSftpRequest(
  raw: unknown,
  env: FetcherEnv,
  opts: RunSftpOpOptions
): Promise<SftpWorkerResponse> {
  let cfg: SftpConfig;
  let op: SftpOp;
  let maxBytes: number;
  let timeoutMs: number;
  let maxAttempts: number;
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new SftpError("SFTP_CONFIG_INVALID");
    const body = raw as Record<string, unknown>;
    if (body.op !== "stat" && body.op !== "read") throw new SftpError("SFTP_CONFIG_INVALID");
    op = body.op;
    cfg = guardSftpConfig(body);
    maxBytes = Math.min(
      SFTP_MAX_CONTENT_BYTES,
      clampInt(body.maxBytes, SFTP_MAX_CONTENT_BYTES, 1, SFTP_MAX_CONTENT_BYTES)
    );
    timeoutMs = clampInt(body.timeoutMs, SFTP_OP_TIMEOUT_MS, 1000, SFTP_OP_TIMEOUT_MAX_MS);
    maxAttempts = clampInt(body.maxAttempts, SFTP_MAX_ATTEMPTS_DEFAULT, 1, SFTP_MAX_ATTEMPTS_MAX);
  } catch (e) {
    const code = e instanceof SftpError ? e.code : "SFTP_CONFIG_INVALID";
    return { ok: false, code, message: sftpErrorMessage(code) };
  }

  // Allowlist EXATA (camada 2; a camada 1 são as guardas puras acima).
  if (!allowedHosts(env).includes(cfg.host)) {
    // Log mínimo: op+host+código (sem path/username/segredos).
    console.log(`[sftp-fetch] op=${op} host=${cfg.host} code=SFTP_HOST_NOT_ALLOWED`);
    return { ok: false, code: "SFTP_HOST_NOT_ALLOWED", message: sftpErrorMessage("SFTP_HOST_NOT_ALLOWED") };
  }

  let password: string;
  try {
    password = resolveWorkerSecret(cfg.secretName, env);
  } catch (e) {
    const code = e instanceof SftpError ? e.code : "SFTP_SECRET_MISSING";
    console.log(`[sftp-fetch] op=${op} host=${cfg.host} code=${code}`);
    return { ok: false, code, message: sftpErrorMessage(code) };
  }

  try {
    const result = await runSftpOp(cfg, op, password, { ...opts, maxBytes, timeoutMs, maxAttempts });
    if (op === "stat" || result.bytes === null) {
      console.log(`[sftp-fetch] op=stat host=${cfg.host} code=OK`);
      return { ok: true, size: result.size, mtime: result.mtime };
    }
    const subtle = opts.subtle ?? globalThis.crypto?.subtle;
    if (!subtle) throw new SftpError("SFTP_FETCH_FAILED");
    const digest = new Uint8Array(await subtle.digest("SHA-256", result.bytes as BufferSource));
    const sha256 = Array.from(digest)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    console.log(`[sftp-fetch] op=read host=${cfg.host} code=OK bytes=${result.bytes.length}`);
    return { ok: true, size: result.size, mtime: result.mtime, sha256, contentBase64: base64Encode(result.bytes) };
  } catch (e) {
    const code: SftpErrorCode = e instanceof SftpError ? e.code : "SFTP_FETCH_FAILED";
    if (!(e instanceof SftpError)) console.error("[sftp-fetch] unexpected:", e);
    // Só op+host+código no log — nunca path, username, segredos ou bytes.
    console.log(`[sftp-fetch] op=${op} host=${cfg.host} code=${code}`);
    return { ok: false, code, message: sftpErrorMessage(code) };
  }
}

// ─── Entry point (service binding) ────────────────────────

async function readCappedText(req: Request): Promise<string> {
  const reader = req.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.length > 0) {
      total += value.length;
      if (total > MAX_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new SftpError("SFTP_CONFIG_INVALID");
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  return new TextDecoder().decode(bytes);
}

async function realConnector(host: string, port: number): Promise<DuplexSocket> {
  // Import estático-tipado, carregado só aqui (os testes nunca tocam nisto).
  const { connect } = await import("cloudflare:sockets");
  return connect({ hostname: host, port });
}

const worker = {
  async fetch(req: Request, env: FetcherEnv): Promise<Response> {
    if (req.method !== "POST") {
      return Response.json(
        { ok: false, code: "SFTP_CONFIG_INVALID", message: sftpErrorMessage("SFTP_CONFIG_INVALID") },
        { status: 405 }
      );
    }
    let raw: unknown;
    try {
      const text = await readCappedText(req);
      raw = JSON.parse(text || "null");
    } catch {
      return Response.json(
        { ok: false, code: "SFTP_CONFIG_INVALID", message: sftpErrorMessage("SFTP_CONFIG_INVALID") },
        { status: 200 }
      );
    }
    // O connector é criado por pedido a partir da config validada (o núcleo
    // revalida tudo — o worker nunca confia em validação externa).
    let validated: SftpConfig;
    try {
      validated = guardSftpConfig((raw ?? {}) as Record<string, unknown>);
    } catch (e) {
      const code = e instanceof SftpError ? e.code : "SFTP_CONFIG_INVALID";
      return Response.json({ ok: false, code, message: sftpErrorMessage(code) }, { status: 200 });
    }
    const envelope = await handleSftpRequest(raw, env, {
      connector: () => realConnector(validated.host, validated.port),
    });
    return Response.json(envelope, { status: 200 });
  },
};

export default worker;
