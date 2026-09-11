/**
 * C.3.4.4 — also-sftp-fetcher: guardas PURAS da config SFTP.
 *
 * Módulo PURO (sem I/O, sem DNS, sem rede): importado pelo worker E pela app,
 * para que a validação seja UMA só nos dois lados (a app falha rápido sem um
 * round-trip; o worker revalida tudo e nunca confia no chamador).
 *
 * Regras (fail-closed, espelho da política HTTPS C.3.4.1/C.3.4.2):
 *  - host: hostname DNS (labels), sem scheme/userinfo/porta/path; literais IP
 *    e hosts locais/metadados por convenção são recusados — a camada 2 é a
 *    allowlist exata do worker (SFTP_ALLOWED_HOSTS);
 *  - port: 1–65535 (default 22 fora daqui);
 *  - remotePath: absoluto (`/…`), sem NUL/CRLF;
 *  - username: não-vazio, sem NUL/CRLF;
 *  - secretName: nome de env (`^[A-Z][A-Z0-9_]{0,254}$`) — o VALOR só existe
 *    no runtime do worker, nunca viaja para aqui;
 *  - fingerprint: pin OpenSSH SHA256 (`SHA256:<base64-43-sem-padding>`) —
 *    OBRIGATÓRIO (TOFU proibido).
 */
import { SftpError } from "./errors";

export const SFTP_DEFAULT_PORT = 22;
export const SFTP_PORT_MIN = 1;
export const SFTP_PORT_MAX = 65535;
export const SFTP_HOST_MAX_LENGTH = 255;
export const SFTP_PATH_MAX_LENGTH = 1000;
export const SFTP_USERNAME_MAX_LENGTH = 255;
/** Teto de bytes ACEITES: o mesmo 5 MB dos parsers (CSV_MAX_SIZE). */
export const SFTP_MAX_CONTENT_BYTES = 5 * 1024 * 1024;

export const SFTP_SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{0,254}$/;
/** OpenSSH SHA256 sem padding: 32 bytes → 43 chars base64. */
export const SFTP_FINGERPRINT_RE = /^SHA256:[A-Za-z0-9+/]{43}$/;

const HOST_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const BLOCKED_SUFFIXES = [
  ".local",
  ".internal",
  ".home.arpa",
  ".localdomain",
  ".test",
  ".invalid",
  ".example",
  ".onion",
  ".localhost",
];
const BLOCKED_HOSTS = [
  "localhost",
  "localhost.localdomain",
  "metadata",
  "metadata.google.internal",
  "instance-data",
  "instance-data.ec2.internal",
];

export interface SftpConfig {
  host: string;
  port: number;
  remotePath: string;
  username: string;
  /** NOME do secret no runtime do worker. Nunca o valor. */
  secretName: string;
  /** Pin `SHA256:…` da host key. Obrigatório. */
  hostKeyFingerprint: string;
}

export function guardSftpHost(rawHost: unknown): string {
  if (typeof rawHost !== "string") throw new SftpError("SFTP_CONFIG_INVALID");
  const host = rawHost.trim().toLowerCase().replace(/\.$/, "");
  if (!host || host.length > SFTP_HOST_MAX_LENGTH) throw new SftpError("SFTP_CONFIG_INVALID");
  // Sem scheme, userinfo, porta, path, query ou fragmento — o host é só o host.
  if (
    host.includes("://") ||
    host.includes("@") ||
    host.includes("/") ||
    host.includes("?") ||
    host.includes("#") ||
    host.includes(":") ||
    host.includes(" ") ||
    /[\r\n\0]/.test(host)
  ) {
    throw new SftpError("SFTP_CONFIG_INVALID");
  }
  // Literais IP recusados (a allowlist do worker é de hostnames exatos).
  if (IPV4_RE.test(host)) throw new SftpError("SFTP_CONFIG_INVALID");
  if (BLOCKED_HOSTS.includes(host)) throw new SftpError("SFTP_CONFIG_INVALID");
  if (BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) throw new SftpError("SFTP_CONFIG_INVALID");
  const labels = host.split(".");
  if (labels.length < 1 || labels.some((l) => !HOST_LABEL_RE.test(l))) {
    throw new SftpError("SFTP_CONFIG_INVALID");
  }
  return host;
}

export function guardSftpPort(rawPort: unknown): number {
  const port = typeof rawPort === "string" && rawPort.trim() !== "" ? Number(rawPort) : rawPort;
  if (typeof port !== "number" || !Number.isInteger(port) || port < SFTP_PORT_MIN || port > SFTP_PORT_MAX) {
    throw new SftpError("SFTP_CONFIG_INVALID");
  }
  return port;
}

export function guardSftpPath(rawPath: unknown): string {
  if (typeof rawPath !== "string") throw new SftpError("SFTP_CONFIG_INVALID");
  const path = rawPath.trim();
  if (!path || path.length > SFTP_PATH_MAX_LENGTH) throw new SftpError("SFTP_CONFIG_INVALID");
  // Absoluto e sem controlo: o worker nunca resolve relativos nem "."/"..".
  if (!path.startsWith("/") || /[\r\n\0]/.test(path)) throw new SftpError("SFTP_CONFIG_INVALID");
  return path;
}

export function guardSftpUsername(rawUsername: unknown): string {
  if (typeof rawUsername !== "string") throw new SftpError("SFTP_CONFIG_INVALID");
  const username = rawUsername.trim();
  if (!username || username.length > SFTP_USERNAME_MAX_LENGTH || /[\r\n\0]/.test(username)) {
    throw new SftpError("SFTP_CONFIG_INVALID");
  }
  return username;
}

export function guardSftpSecretName(rawName: unknown): string {
  if (typeof rawName !== "string" || !SFTP_SECRET_NAME_RE.test(rawName)) {
    throw new SftpError("SFTP_CONFIG_INVALID");
  }
  return rawName;
}

export function guardSftpFingerprint(rawFp: unknown): string {
  if (typeof rawFp !== "string" || !SFTP_FINGERPRINT_RE.test(rawFp.trim())) {
    throw new SftpError("SFTP_CONFIG_INVALID");
  }
  return rawFp.trim();
}

/** Valida a config COMPLETA (o worker nunca confia no chamador). */
export function guardSftpConfig(raw: Record<string, unknown>): SftpConfig {
  return {
    host: guardSftpHost(raw.host),
    port: guardSftpPort(raw.port),
    remotePath: guardSftpPath(raw.remotePath),
    username: guardSftpUsername(raw.username),
    secretName: guardSftpSecretName(raw.secretName),
    hostKeyFingerprint: guardSftpFingerprint(raw.hostKeyFingerprint),
  };
}

/** `sftp://host[:port]/path` — label legível sem credenciais (histórico). */
export function sftpLabel(host: string, port: number, remotePath: string): string {
  return port === SFTP_DEFAULT_PORT
    ? `sftp://${host}${remotePath}`
    : `sftp://${host}:${port}${remotePath}`;
}
