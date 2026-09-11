/**
 * C.3.4.4 — also-sftp-fetcher: cliente SFTP v3 estritamente READ-ONLY.
 *
 * Operações emitidas — e SÓ estas: INIT, STAT, OPEN (modo READ), READ, CLOSE.
 * Não existe neste módulo qualquer construtor de pedido de escrita, remoção,
 * renomeação, criação de diretórios ou alteração de atributos — a
 * read-only-ness é estrutural (não há código para o fazer) e é travada por
 * teste (captura dos tipos emitidos em stat+read + auditoria estática).
 *
 * O texto de erro do servidor (STATUS message/lang) NUNCA é exposto: os
 * códigos mapeiam para a tabela segura partilhada (./errors.ts).
 */

import { SftpError } from "./errors";
import { SFTP_MAX_CONTENT_BYTES } from "./guards";
import { concatBytes, decodeString, decodeU32, encodeString, encodeU32 } from "./ssh";

/** Canal mínimo que o SFTP precisa (SshChannel satisfaz estruturalmente). */
export interface SftpChannel {
  send(data: Uint8Array): Promise<void>;
  readExactly(n: number, deadlineMs: number): Promise<Uint8Array>;
}

// Tipos SFTP emitidos pelo cliente (o conjunto READ-ONLY permitido).
const FXP_INIT = 1;
const FXP_OPEN = 3;
const FXP_CLOSE = 4;
const FXP_READ = 5;
const FXP_STAT = 17;
// Tipos recebidos.
const FXP_VERSION = 2;
const FXP_STATUS = 101;
const FXP_HANDLE = 102;
const FXP_DATA = 103;
const FXP_ATTRS = 105;
// STATUS codes.
const STATUS_OK = 0;
const STATUS_EOF = 1;
const STATUS_NO_SUCH_FILE = 2;
const STATUS_PERMISSION_DENIED = 3;
// OPEN pflags: READ apenas.
const OPEN_READ = 0x00000001;

const SFTP_VERSION = 3;
const READ_CHUNK = 32768;

export function encodeU64(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) throw new SftpError("SFTP_PROTOCOL_ERROR");
  const hi = Math.floor(n / 0x100000000);
  const lo = n >>> 0;
  return concatBytes(encodeU32(hi), encodeU32(lo));
}

export function decodeU64(b: Uint8Array, off = 0): number {
  const hi = decodeU32(b, off);
  const lo = decodeU32(b, off + 4);
  const n = hi * 0x100000000 + lo;
  if (!Number.isSafeInteger(n)) throw new SftpError("SFTP_TOO_LARGE");
  return n;
}

export interface SftpAttrs {
  size: number | null;
  mtime: number | null; // unix seconds
}

/** Attrs SSH_FILEXFER_ATTR_*: só SIZE e ACMODTIME interessam (o resto é saltado). */
export function parseAttrs(b: Uint8Array, off = 0): { attrs: SftpAttrs; next: number } {
  if (off + 4 > b.length) throw new SftpError("SFTP_PROTOCOL_ERROR");
  const flags = decodeU32(b, off);
  off += 4;
  let size: number | null = null;
  let mtime: number | null = null;
  if (flags & 0x01) {
    if (off + 8 > b.length) throw new SftpError("SFTP_PROTOCOL_ERROR");
    size = decodeU64(b, off);
    off += 8;
  }
  if (flags & 0x02) off += 8; // uid+gid
  if (flags & 0x04) off += 4; // permissions
  if (flags & 0x08) {
    if (off + 8 > b.length) throw new SftpError("SFTP_PROTOCOL_ERROR");
    off += 4; // atime (ignorado)
    mtime = decodeU32(b, off);
    off += 4;
  }
  if (flags & 0x80000000) {
    if (off + 4 > b.length) throw new SftpError("SFTP_PROTOCOL_ERROR");
    const count = decodeU32(b, off);
    off += 4;
    if (count > 1024) throw new SftpError("SFTP_PROTOCOL_ERROR");
    for (let i = 0; i < count; i++) {
      const k = decodeString(b, off);
      off = k.next;
      const v = decodeString(b, off);
      off = v.next;
    }
  }
  if (off > b.length) throw new SftpError("SFTP_PROTOCOL_ERROR");
  return { attrs: { size, mtime }, next: off };
}

function statusError(code: number): SftpError {
  // O message/lang do servidor é descartado pelo chamador (nunca exposto).
  if (code === STATUS_NO_SUCH_FILE) return new SftpError("SFTP_FILE_NOT_FOUND");
  if (code === STATUS_PERMISSION_DENIED) return new SftpError("SFTP_PERMISSION_DENIED");
  return new SftpError("SFTP_FETCH_FAILED", { retryable: true });
}

export class SftpClient {
  private nextId = 1;

  constructor(private readonly channel: SftpChannel) {}

  private async send(type: number, id: number | null, payload: Uint8Array): Promise<void> {
    const body =
      id === null
        ? concatBytes(new Uint8Array([type]), payload)
        : concatBytes(new Uint8Array([type]), encodeU32(id), payload);
    await this.channel.send(concatBytes(encodeU32(body.length), body));
  }

  private async recv(deadlineMs: number): Promise<{ type: number; id: number | null; payload: Uint8Array }> {
    const lenBytes = await this.channel.readExactly(4, deadlineMs);
    const len = decodeU32(lenBytes, 0);
    if (len < 1 || len > SFTP_MAX_CONTENT_BYTES + READ_CHUNK + 1024) {
      throw new SftpError("SFTP_PROTOCOL_ERROR");
    }
    const body = await this.channel.readExactly(len, deadlineMs);
    const type = body[0];
    if (type === FXP_VERSION) return { type, id: null, payload: body.slice(1) };
    if (body.length < 5) throw new SftpError("SFTP_PROTOCOL_ERROR");
    return { type, id: decodeU32(body, 1), payload: body.slice(5) };
  }

  /** INIT → VERSION (qualquer versão ≥ 3; usa-se sempre o subset v3). */
  async init(deadlineMs: number): Promise<number> {
    await this.send(FXP_INIT, null, encodeU32(SFTP_VERSION));
    const r = await this.recv(deadlineMs);
    if (r.type === FXP_STATUS) {
      const code = r.payload.length >= 4 ? decodeU32(r.payload, 0) : 4;
      throw statusError(code);
    }
    if (r.type !== FXP_VERSION || r.payload.length < 4) throw new SftpError("SFTP_PROTOCOL_ERROR");
    const version = decodeU32(r.payload, 0);
    if (version < 3) throw new SftpError("SFTP_PROTOCOL_ERROR");
    return version;
  }

  /** STAT: size+mtime sem transferir conteúdo (otimização no_change). */
  async stat(deadlineMs: number, path: string): Promise<SftpAttrs> {
    const id = this.nextId++;
    await this.send(FXP_STAT, id, encodeString(path));
    const r = await this.recv(deadlineMs);
    if (r.id !== id) throw new SftpError("SFTP_PROTOCOL_ERROR");
    if (r.type === FXP_ATTRS) return parseAttrs(r.payload, 0).attrs;
    if (r.type === FXP_STATUS) {
      throw statusError(r.payload.length >= 4 ? decodeU32(r.payload, 0) : 4);
    }
    throw new SftpError("SFTP_PROTOCOL_ERROR");
  }

  /**
   * READ integral do ficheiro (OPEN→READ…→CLOSE). Aborta com SFTP_TOO_LARGE
   * acima de `maxBytes` — por stat antecipado ou a meio do stream.
   */
  async read(deadlineMs: number, path: string, maxBytes: number): Promise<{ bytes: Uint8Array }> {
    const openId = this.nextId++;
    await this.send(FXP_OPEN, openId, concatBytes(encodeString(path), encodeU32(OPEN_READ), encodeU32(0)));
    const opened = await this.recv(deadlineMs);
    if (opened.id !== openId) throw new SftpError("SFTP_PROTOCOL_ERROR");
    if (opened.type === FXP_STATUS) {
      throw statusError(opened.payload.length >= 4 ? decodeU32(opened.payload, 0) : 4);
    }
    if (opened.type !== FXP_HANDLE) throw new SftpError("SFTP_PROTOCOL_ERROR");
    const handle = decodeString(opened.payload, 0).value;

    // fstat opcional? Não — o stat separado já correu a montante (otimização);
    // aqui lê-se em stream com teto, mesmo sem tamanho anunciado.
    const chunks: Uint8Array[] = [];
    let total = 0;
    let offset = 0;
    try {
      for (;;) {
        const id = this.nextId++;
        await this.send(FXP_READ, id, concatBytes(encodeString(handle), encodeU64(offset), encodeU32(READ_CHUNK)));
        const r = await this.recv(deadlineMs);
        if (r.id !== id) throw new SftpError("SFTP_PROTOCOL_ERROR");
        if (r.type === FXP_DATA) {
          const data = decodeString(r.payload, 0).value;
          if (data.length === 0) break; // DATA vazio = fim (servidores defensivos)
          total += data.length;
          if (total > maxBytes) throw new SftpError("SFTP_TOO_LARGE");
          chunks.push(data);
          offset += data.length;
          continue;
        }
        if (r.type === FXP_STATUS) {
          const code = r.payload.length >= 4 ? decodeU32(r.payload, 0) : 4;
          if (code === STATUS_OK || code === STATUS_EOF) break;
          throw statusError(code);
        }
        throw new SftpError("SFTP_PROTOCOL_ERROR");
      }
    } finally {
      // CLOSE best-effort: o resultado da leitura não depende dele, mas a
      // resposta é consumida para não dessincronizar o canal.
      try {
        const id = this.nextId++;
        await this.send(FXP_CLOSE, id, encodeString(handle));
        await this.recv(deadlineMs);
      } catch {
        /* leitura já terminada; fecha o canal na mesma */
      }
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.length;
    }
    return { bytes };
  }
}

/**
 * Conjunto de tipos SFTP que este cliente pode EMITIR (auditoria read-only).
 * Qualquer tipo fora deste conjunto num teste de captura = regressão.
 */
export const SFTP_READONLY_SENT_TYPES = [FXP_INIT, FXP_STAT, FXP_OPEN, FXP_READ, FXP_CLOSE] as const;
