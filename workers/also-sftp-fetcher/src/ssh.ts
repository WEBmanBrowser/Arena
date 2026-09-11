/**
 * C.3.4.4 — also-sftp-fetcher: cliente SSH-2 mínimo, READ-ONLY por construção.
 *
 * Porquê um cliente próprio: no Cloudflare Workers não há sockets Node
 * (`ssh2`/`node-ssh` não correm no Edge); o transporte usa `cloudflare:sockets`
 * (TCP real) + WebCrypto — zero dependências npm.
 *
 * Âmbito deliberado (fail-closed fora disto):
 *  - kex: ecdh-sha2-nistp256 (ECDH P-256 via WebCrypto);
 *  - host key: ecdsa-sha2-nistp256, rsa-sha2-512, rsa-sha2-256 — a assinatura
 *    do KEX é SEMPRE verificada E o pin SHA256 da host key (OpenSSH) é
 *    OBRIGATÓRIO (TOFU proibido; mismatch aborta antes de auth/dados);
 *  - cifra: aes128-ctr; MAC: hmac-sha2-256; compressão: none;
 *  - auth: password (o valor chega do runtime do worker, nunca da app/BD);
 *  - canal: UM canal `session` + subsistema `sftp` (ver ./sftp.ts).
 *
 * Sem rekey (sessões curtas: stat/read e fecha), sem agentes, sem forwarding,
 * sem shell/exec — só o necessário para stat+read.
 *
 * Este módulo NÃO conhece `cloudflare:sockets`: recebe um `DuplexSocket`
 * (legível+escrevível) e um `connector`. A produção liga o socket real em
 * ./index.ts; os testes injetam pares em memória / servidores scripted.
 */

import { SftpError } from "./errors";
import { SFTP_MAX_CONTENT_BYTES } from "./guards";

// ─── Socket abstrato (compatível com cloudflare:sockets.Socket) ───

export interface DuplexSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): void | Promise<void>;
}

// ─── Binário ──────────────────────────────────────────────

export function concatBytes(...parts: Uint8Array<ArrayBufferLike>[]): Uint8Array<ArrayBuffer> {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function encodeU32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0);
  return b;
}

export function decodeU32(b: Uint8Array, off = 0): number {
  return new DataView(b.buffer, b.byteOffset + off, 4).getUint32(0);
}

export function encodeString(data: Uint8Array | string): Uint8Array {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return concatBytes(encodeU32(bytes.length), bytes);
}

/** string SSH → { bytes, bytes lidos } (lança em truncado). */
export function decodeString(b: Uint8Array, off = 0): { value: Uint8Array; next: number } {
  if (off + 4 > b.length) throw new SftpError("SFTP_PROTOCOL_ERROR");
  const len = decodeU32(b, off);
  if (off + 4 + len > b.length) throw new SftpError("SFTP_PROTOCOL_ERROR");
  return { value: b.slice(off + 4, off + 4 + len), next: off + 4 + len };
}

/** mpint a partir de bytes big-endian (retira zeros, prefixa 0x00 se bit alto). */
export function encodeMpint(raw: Uint8Array): Uint8Array {
  let i = 0;
  while (i < raw.length - 1 && raw[i] === 0) i++;
  let body = raw.slice(i);
  if (body.length > 0 && body[0] & 0x80) body = concatBytes(new Uint8Array([0]), body);
  return concatBytes(encodeU32(body.length), body);
}

export function encodeNameList(names: string[]): Uint8Array {
  return encodeString(names.join(","));
}

export function decodeNameList(b: Uint8Array, off = 0): { value: string[]; next: number } {
  const { value, next } = decodeString(b, off);
  const text = new TextDecoder().decode(value);
  return { value: text === "" ? [] : text.split(","), next };
}

const B64_CHUNK = 0x8000;

export function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + B64_CHUNK));
  }
  return btoa(binary);
}

export function base64EncodeUnpadded(bytes: Uint8Array): string {
  return base64Encode(bytes).replace(/=+$/, "");
}

export function base64Decode(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function base64UrlEncode(bytes: Uint8Array): string {
  return base64Encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ─── Constantes SSH ───────────────────────────────────────

const MSG_DISCONNECT = 1;
const MSG_IGNORE = 2;
const MSG_UNIMPLEMENTED = 3;
const MSG_DEBUG = 4;
const MSG_SERVICE_REQUEST = 5;
const MSG_SERVICE_ACCEPT = 6;
const MSG_EXT_INFO = 7;
const MSG_KEXINIT = 20;
const MSG_NEWKEYS = 21;
const MSG_KEX_ECDH_INIT = 30;
const MSG_KEX_ECDH_REPLY = 31;
const MSG_USERAUTH_REQUEST = 50;
const MSG_USERAUTH_FAILURE = 51;
const MSG_USERAUTH_SUCCESS = 52;
const MSG_USERAUTH_BANNER = 53;
const MSG_CHANNEL_OPEN = 90;
const MSG_CHANNEL_OPEN_CONFIRMATION = 91;
const MSG_CHANNEL_OPEN_FAILURE = 92;
const MSG_CHANNEL_WINDOW_ADJUST = 93;
const MSG_CHANNEL_DATA = 94;
const MSG_CHANNEL_EOF = 96;
const MSG_CHANNEL_CLOSE = 97;
const MSG_CHANNEL_REQUEST = 98;
const MSG_CHANNEL_SUCCESS = 99;
const MSG_CHANNEL_FAILURE = 100;

const VERSION_CLIENT = "SSH-2.0-MDTechSFTP_1.0";
const KEX_ALGS = ["ecdh-sha2-nistp256"];
const HOSTKEY_ALGS = ["ecdsa-sha2-nistp256", "rsa-sha2-512", "rsa-sha2-256"];
const CIPHERS = ["aes128-ctr"];
const MACS = ["hmac-sha2-256"];
const COMPRESSION = ["none"];

const CHANNEL_ID = 0;
const CHANNEL_WINDOW = 0x800000; // 8 MB: cobre o teto de 5 MB sem WINDOW_ADJUST
const CHANNEL_MAXPACKET = 0x8000; // 32 KB

// ─── Leitor com deadline ──────────────────────────────────

function getSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("WebCrypto indisponível (globalThis.crypto.subtle)");
  return subtle;
}

class ByteReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private buf = new Uint8Array(0);
  private eof = false;

  constructor(socket: DuplexSocket) {
    this.reader = socket.readable.getReader();
  }

  release(): void {
    try {
      this.reader.releaseLock();
    } catch {
      /* lock já libertado */
    }
  }

  private async fill(deadlineMs: number): Promise<void> {
    if (this.eof) return;
    const pending = this.reader.read();
    const winner = await Promise.race([
      pending.then((r) => ({ type: "data" as const, r })),
      new Promise<{ type: "timeout" }>((resolve) =>
        setTimeout(() => resolve({ type: "timeout" }), Math.max(0, deadlineMs - Date.now()))
      ),
    ]);
    if (winner.type === "timeout") {
      // Não conseguimos cancelar a leitura pendente de forma portátil; o
      // socket é destruído pelo chamador (operação abortada de qualquer forma).
      throw new SftpError("SFTP_TIMEOUT", { retryable: true });
    }
    if (winner.r.done) {
      this.eof = true;
      return;
    }
    const v = winner.r.value;
    if (v && v.length > 0) this.buf = concatBytes(this.buf, v);
  }

  async readExactly(n: number, deadlineMs: number): Promise<Uint8Array> {
    while (this.buf.length < n) {
      await this.fill(deadlineMs);
      if (this.eof && this.buf.length < n) {
        throw new SftpError("SFTP_FETCH_FAILED", { retryable: true });
      }
      if (Date.now() > deadlineMs) throw new SftpError("SFTP_TIMEOUT", { retryable: true });
    }
    const out = this.buf.slice(0, n);
    this.buf = this.buf.slice(n);
    return out;
  }

  /** Uma linha terminada em \n (para o version exchange). */
  async readLine(deadlineMs: number, maxLen = 512): Promise<string> {
    for (;;) {
      const idx = this.buf.indexOf(10); // \n
      if (idx >= 0) {
        const line = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 1);
        return new TextDecoder().decode(line).replace(/\r$/, "");
      }
      if (this.buf.length > maxLen) throw new SftpError("SFTP_PROTOCOL_ERROR");
      await this.fill(deadlineMs);
      if (this.eof) throw new SftpError("SFTP_FETCH_FAILED", { retryable: true });
      if (Date.now() > deadlineMs) throw new SftpError("SFTP_TIMEOUT", { retryable: true });
    }
  }
}

// ─── Transporte ───────────────────────────────────────────

export interface SshTransportOptions {
  connector: () => Promise<DuplexSocket>;
  /** Deadline TOTAL da operação (handshake+auth+canal+transferência). */
  timeoutMs: number;
  subtle?: SubtleCrypto;
}

interface CipherState {
  encKey: CryptoKey;
  decKey: CryptoKey;
  macEncKey: CryptoKey;
  macDecKey: CryptoKey;
  ivEnc: Uint8Array;
  ivDec: Uint8Array;
  blocksEnc: number;
  blocksDec: number;
  seqEnc: number;
  seqDec: number;
  /** Envio cifra após o NOSSO NEWKEYS; receção só após o NEWKEYS do par. */
  sendActive: boolean;
  recvActive: boolean;
}

export class SshTransport {
  private socket: DuplexSocket | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private reader: ByteReader | null = null;
  private cipher: CipherState | null = null;
  private closed = false;
  private readonly subtle: SubtleCrypto;

  constructor(private readonly opts: SshTransportOptions) {
    this.subtle = opts.subtle ?? getSubtle();
  }

  get closedFlag(): boolean {
    return this.closed;
  }

  async connect(): Promise<void> {
    try {
      this.socket = await this.opts.connector();
    } catch (e) {
      if (e instanceof SftpError) throw e;
      throw new SftpError("SFTP_FETCH_FAILED", { retryable: true });
    }
    this.writer = this.socket.writable.getWriter();
    this.reader = new ByteReader(this.socket);
    this.cipher = {
      encKey: null as unknown as CryptoKey,
      decKey: null as unknown as CryptoKey,
      macEncKey: null as unknown as CryptoKey,
      macDecKey: null as unknown as CryptoKey,
      ivEnc: new Uint8Array(16),
      ivDec: new Uint8Array(16),
      blocksEnc: 0,
      blocksDec: 0,
      seqEnc: 0,
      seqDec: 0,
      sendActive: false,
      recvActive: false,
    };
  }

  async destroy(): Promise<void> {
    this.closed = true;
    try {
      this.reader?.release();
    } catch {
      /* ignore */
    }
    try {
      await this.writer?.abort().catch(() => undefined);
    } catch {
      /* ignore */
    }
    try {
      await this.socket?.close();
    } catch {
      /* ignore */
    }
    this.socket = null;
    this.writer = null;
    this.reader = null;
  }

  private async writeRaw(bytes: Uint8Array): Promise<void> {
    if (!this.writer || this.closed) throw new SftpError("SFTP_FETCH_FAILED", { retryable: true });
    try {
      await this.writer.write(bytes);
    } catch {
      throw new SftpError("SFTP_FETCH_FAILED", { retryable: true });
    }
  }

  private async ctrXor(key: CryptoKey, iv: Uint8Array, blockOffset: number, data: Uint8Array): Promise<Uint8Array> {
    const counter = new Uint8Array(iv);
    let carry = blockOffset;
    for (let i = 15; i >= 0; i--) {
      const sum = counter[i] + (carry % 256);
      counter[i] = sum & 0xff;
      carry = Math.floor(carry / 256) + (sum > 0xff ? 1 : 0);
      if (carry === 0) break;
    }
    const out = await this.subtle.encrypt({ name: "AES-CTR", counter, length: 128 }, key, data as BufferSource);
    return new Uint8Array(out);
  }

  /** Envia UM payload SSH (com cifra/MAC quando ativas). */
  async sendPacket(payload: Uint8Array): Promise<void> {
    const c = this.cipher;
    if (!c) throw new SftpError("SFTP_FETCH_FAILED", { retryable: true });
    const blockSize = c.sendActive ? 16 : 8;
    let padLen = blockSize - ((5 + payload.length) % blockSize);
    if (padLen < 4) padLen += blockSize;
    const padding = new Uint8Array(padLen);
    globalThis.crypto.getRandomValues(padding);
    const plain = concatBytes(encodeU32(1 + payload.length + padLen), new Uint8Array([padLen]), payload, padding);
    if (!c.sendActive) {
      await this.writeRaw(plain);
      c.seqEnc = (c.seqEnc + 1) >>> 0;
      return;
    }
    const enc = await this.ctrXor(c.encKey, c.ivEnc, c.blocksEnc, plain);
    c.blocksEnc += plain.length / 16;
    const macInput = concatBytes(encodeU32(c.seqEnc), plain);
    const mac = new Uint8Array(await this.subtle.sign("HMAC", c.macEncKey, macInput as BufferSource));
    c.seqEnc = (c.seqEnc + 1) >>> 0;
    await this.writeRaw(concatBytes(enc, mac));
  }

  /** Recebe UM payload SSH (verifica MAC quando ativa). */
  async recvPacket(deadlineMs: number): Promise<Uint8Array> {
    const c = this.cipher;
    const r = this.reader;
    if (!c || !r) throw new SftpError("SFTP_FETCH_FAILED", { retryable: true });
    const firstLen = c.recvActive ? 16 : 4;
    const head = await r.readExactly(firstLen, deadlineMs);
    let packetLen: number;
    let rest: Uint8Array;
    if (!c.recvActive) {
      packetLen = decodeU32(head, 0);
      if (packetLen < 1 || packetLen > 35000 + 64) throw new SftpError("SFTP_PROTOCOL_ERROR");
      rest = await r.readExactly(packetLen, deadlineMs);
      c.seqDec = (c.seqDec + 1) >>> 0;
      const padLen = rest[0];
      if (1 + padLen > rest.length) throw new SftpError("SFTP_PROTOCOL_ERROR");
      return rest.slice(1, rest.length - padLen);
    }
    // Cifrado: os primeiros 16 bytes revelam packet_length; o MAC (32 B) fecha.
    const decHead = await this.ctrXor(c.decKey, c.ivDec, c.blocksDec, head);
    packetLen = decodeU32(decHead, 0);
    if (packetLen < 1 || packetLen + 4 > 35000 + 64 || (packetLen + 4) % 16 !== 0) {
      throw new SftpError("SFTP_PROTOCOL_ERROR");
    }
    const remaining = packetLen + 4 - 16;
    const encRest = await r.readExactly(remaining + 32, deadlineMs);
    const encPacket = concatBytes(head, encRest.slice(0, remaining));
    const macRecv = encRest.slice(remaining);
    const plain = await this.ctrXor(c.decKey, c.ivDec, c.blocksDec, encPacket);
    c.blocksDec += plain.length / 16;
    const macInput = concatBytes(encodeU32(c.seqDec), plain);
    const macCalc = new Uint8Array(await this.subtle.sign("HMAC", c.macDecKey, macInput as BufferSource));
    let diff = 0;
    for (let i = 0; i < 32; i++) diff |= macCalc[i] ^ macRecv[i];
    if (diff !== 0) throw new SftpError("SFTP_PROTOCOL_ERROR");
    c.seqDec = (c.seqDec + 1) >>> 0;
    const padLen = plain[4];
    if (1 + padLen > packetLen) throw new SftpError("SFTP_PROTOCOL_ERROR");
    return plain.slice(5, 4 + packetLen - padLen);
  }

  // ─── Handshake ──────────────────────────────────────────

  /**
   * Version exchange + KEX + NEWKEYS. O pin da host key é verificado AQUI
   * (mismatch → SFTP_HOST_KEY_MISMATCH antes de qualquer auth/dado).
   */
  async handshake(deadlineMs: number, hostKeyFingerprint: string): Promise<void> {
    const r = this.reader;
    if (!r) throw new SftpError("SFTP_FETCH_FAILED", { retryable: true });
    // 1) Version exchange (full-duplex: envia e lê).
    await this.writeRaw(new TextEncoder().encode(`${VERSION_CLIENT}\r\n`));
    let serverVersion = "";
    for (let i = 0; i < 16; i++) {
      const line = await r.readLine(deadlineMs);
      if (line.startsWith("SSH-")) {
        serverVersion = line;
        break;
      }
      // Linhas de cabeçalho pré-versão ( banners TCP ) são ignoradas (RFC 4253 §4.2).
    }
    if (!serverVersion.startsWith("SSH-2.0") && !serverVersion.startsWith("SSH-1.99")) {
      throw new SftpError("SFTP_PROTOCOL_ERROR");
    }

    // 2) KEXINIT.
    const cookie = new Uint8Array(16);
    globalThis.crypto.getRandomValues(cookie);
    const kexinitPayload = concatBytes(
      new Uint8Array([MSG_KEXINIT]),
      cookie,
      encodeNameList(KEX_ALGS),
      encodeNameList(HOSTKEY_ALGS),
      encodeNameList(CIPHERS),
      encodeNameList(CIPHERS),
      encodeNameList(MACS),
      encodeNameList(MACS),
      encodeNameList(COMPRESSION),
      encodeNameList(COMPRESSION),
      encodeString(""),
      encodeString(""),
      new Uint8Array([0]),
      encodeU32(0)
    );
    await this.sendPacket(kexinitPayload);
    const serverKex = await this.recvUntil(deadlineMs, [MSG_KEXINIT]);
    const negotiated = negotiate(serverKex);
    if (negotiated.serverFollows && negotiated.serverFirstKex !== negotiated.kex) {
      // O servidor apostou noutro kex: o pacote adivinhado é descartado.
      await this.recvPacket(deadlineMs);
    }

    // 3) ECDH.
    const ecdh = await this.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const qClient = new Uint8Array(await this.subtle.exportKey("raw", ecdh.publicKey));
    await this.sendPacket(concatBytes(new Uint8Array([MSG_KEX_ECDH_INIT]), encodeString(qClient)));
    const reply = await this.recvUntil(deadlineMs, [MSG_KEX_ECDH_REPLY]);
    let off = 1;
    const ks = decodeString(reply, off);
    off = ks.next;
    const qs = decodeString(reply, off);
    off = qs.next;
    const sig = decodeString(reply, off);
    const kS = ks.value;
    const qServer = qs.value;

    // 4) PIN da host key ANTES de tudo o resto (TOFU proibido).
    const digest = new Uint8Array(await this.subtle.digest("SHA-256", kS as BufferSource));
    const pin = `SHA256:${base64EncodeUnpadded(digest)}`;
    if (pin !== hostKeyFingerprint) throw new SftpError("SFTP_HOST_KEY_MISMATCH");

    // 5) Segredo + H + verificação da assinatura do KEX.
    const serverPub = await this.subtle.importKey("raw", qServer as BufferSource, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const shared = new Uint8Array(await this.subtle.deriveBits({ name: "ECDH", public: serverPub }, ecdh.privateKey, 256));
    const enc = new TextEncoder();
    const hInput = concatBytes(
      encodeString(enc.encode(VERSION_CLIENT)),
      encodeString(enc.encode(serverVersion)),
      encodeString(kexinitPayload),
      encodeString(serverKex),
      encodeString(kS),
      encodeString(qClient),
      encodeString(qServer),
      encodeMpint(shared)
    );
    const h = new Uint8Array(await this.subtle.digest("SHA-256", hInput as BufferSource));
    await verifyKexSignature(this.subtle, negotiated.hostkey, kS, sig.value, h);

    // 6) Derivação de chaves (RFC 4253 §7.2) + NEWKEYS.
    const kMpint = encodeMpint(shared);
    const derive = async (letter: string, len: number): Promise<Uint8Array> => {
      const d = new Uint8Array(
        await this.subtle.digest("SHA-256", concatBytes(kMpint, h, enc.encode(letter), h) as BufferSource)
      );
      return d.slice(0, len);
    };
    const c = this.cipher;
    if (!c) throw new SftpError("SFTP_FETCH_FAILED", { retryable: true });
    c.ivEnc = await derive("A", 16);
    c.ivDec = await derive("B", 16);
    const encC2s = await derive("C", 16);
    const encS2c = await derive("D", 16);
    const macC2s = await derive("E", 32);
    const macS2c = await derive("F", 32);
    c.encKey = await this.subtle.importKey("raw", encC2s as BufferSource, "AES-CTR", false, ["encrypt", "decrypt"]);
    c.decKey = await this.subtle.importKey("raw", encS2c as BufferSource, "AES-CTR", false, ["encrypt", "decrypt"]);
    c.macEncKey = await this.subtle.importKey("raw", macC2s as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    c.macDecKey = await this.subtle.importKey("raw", macS2c as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

    await this.sendPacket(new Uint8Array([MSG_NEWKEYS]));
    // Envio cifra a partir do PRÓXIMO pacote; receção só após o NEWKEYS do par.
    c.sendActive = true;
    c.blocksEnc = 0;
    await this.recvUntil(deadlineMs, [MSG_NEWKEYS]);
    c.recvActive = true;
    c.blocksDec = 0;
  }

  /** Recebe até um dos tipos esperados (IGNORE/DEBUG/EXT_INFO saltados). */
  async recvUntil(deadlineMs: number, want: number[]): Promise<Uint8Array> {
    for (;;) {
      const pkt = await this.recvPacket(deadlineMs);
      const t = pkt[0];
      if (want.includes(t)) return pkt;
      if (t === MSG_IGNORE || t === MSG_DEBUG || t === MSG_EXT_INFO) continue;
      if (t === MSG_DISCONNECT) throw disconnectError(pkt, "SFTP_FETCH_FAILED");
      if (t === MSG_UNIMPLEMENTED) throw new SftpError("SFTP_PROTOCOL_ERROR");
      throw new SftpError("SFTP_PROTOCOL_ERROR");
    }
  }

  // ─── Auth ───────────────────────────────────────────────

  /** Password auth (o valor nunca é registado nem devolvido). */
  async authenticatePassword(deadlineMs: number, username: string, password: string): Promise<void> {
    await this.sendPacket(
      concatBytes(new Uint8Array([MSG_SERVICE_REQUEST]), encodeString("ssh-userauth"))
    );
    await this.recvUntil(deadlineMs, [MSG_SERVICE_ACCEPT]);
    await this.sendPacket(
      concatBytes(
        new Uint8Array([MSG_USERAUTH_REQUEST]),
        encodeString(username),
        encodeString("ssh-connection"),
        encodeString("password"),
        new Uint8Array([0]),
        encodeString(password)
      )
    );
    for (;;) {
      const pkt = await this.recvPacket(deadlineMs);
      const t = pkt[0];
      if (t === MSG_USERAUTH_SUCCESS) return;
      if (t === MSG_USERAUTH_FAILURE) throw new SftpError("SFTP_AUTH_FAILED");
      if (t === MSG_USERAUTH_BANNER || t === MSG_IGNORE || t === MSG_DEBUG || t === MSG_EXT_INFO) continue;
      if (t === MSG_DISCONNECT) throw disconnectError(pkt, "SFTP_AUTH_FAILED");
      throw new SftpError("SFTP_PROTOCOL_ERROR");
    }
  }

  // ─── Canal SFTP ─────────────────────────────────────────

  async openSftpChannel(deadlineMs: number): Promise<SshChannel> {
    await this.sendPacket(
      concatBytes(
        new Uint8Array([MSG_CHANNEL_OPEN]),
        encodeString("session"),
        encodeU32(CHANNEL_ID),
        encodeU32(CHANNEL_WINDOW),
        encodeU32(CHANNEL_MAXPACKET)
      )
    );
    const opened = await this.recvUntil(deadlineMs, [MSG_CHANNEL_OPEN_CONFIRMATION, MSG_CHANNEL_OPEN_FAILURE]);
    if (opened[0] === MSG_CHANNEL_OPEN_FAILURE) throw new SftpError("SFTP_PROTOCOL_ERROR");
    const recipient = decodeU32(opened, 1);
    const serverMaxPacket = decodeU32(opened, 9);
    await this.sendPacket(
      concatBytes(
        new Uint8Array([MSG_CHANNEL_REQUEST]),
        encodeU32(recipient),
        encodeString("subsystem"),
        new Uint8Array([1]),
        encodeString("sftp")
      )
    );
    const req = await this.recvUntil(deadlineMs, [MSG_CHANNEL_SUCCESS, MSG_CHANNEL_FAILURE]);
    if (req[0] === MSG_CHANNEL_FAILURE) throw new SftpError("SFTP_PROTOCOL_ERROR");
    return new SshChannel(this, recipient, Math.max(1024, Math.min(serverMaxPacket || CHANNEL_MAXPACKET, 256 * 1024)));
  }
}

/** Negociação: primeira oferta NOSSA presente na lista do servidor. */
export function negotiate(serverKexinit: Uint8Array): {
  kex: string;
  hostkey: string;
  serverFollows: boolean;
  serverFirstKex: string;
} {
  let off = 1 + 16; // msg + cookie
  const lists: string[][] = [];
  for (let i = 0; i < 10; i++) {
    const d = decodeNameList(serverKexinit, off);
    lists.push(d.value);
    off = d.next;
  }
  const follows = serverKexinit[off] === 1;
  const pick = (ours: string[], theirs: string[]): string | null => ours.find((a) => theirs.includes(a)) ?? null;
  const kex = pick(KEX_ALGS, lists[0]);
  const hostkey = pick(HOSTKEY_ALGS, lists[1]);
  const c2s = pick(CIPHERS, lists[2]);
  const s2c = pick(CIPHERS, lists[3]);
  const mC2s = pick(MACS, lists[4]);
  const mS2c = pick(MACS, lists[5]);
  const zC2s = pick(COMPRESSION, lists[6]);
  const zS2c = pick(COMPRESSION, lists[7]);
  if (!kex || !hostkey || !c2s || !s2c || !mC2s || !mS2c || !zC2s || !zS2c) {
    throw new SftpError("SFTP_PROTOCOL_ERROR");
  }
  return { kex, hostkey, serverFollows: follows, serverFirstKex: lists[0][0] ?? "" };
}

function disconnectError(pkt: Uint8Array, fallback: "SFTP_FETCH_FAILED" | "SFTP_AUTH_FAILED"): SftpError {
  // O motivo do servidor NUNCA é exposto (pode conter paths/estado interno).
  void pkt;
  return new SftpError(fallback, { retryable: fallback === "SFTP_FETCH_FAILED" });
}

/** Verifica a assinatura do KEX sobre H (ECDSA P-256 ou RSA/SHA-2). */
async function verifyKexSignature(
  subtle: SubtleCrypto,
  alg: string,
  kS: Uint8Array,
  sigOuter: Uint8Array,
  h: Uint8Array
): Promise<void> {
  const fail = (): SftpError => new SftpError("SFTP_PROTOCOL_ERROR");
  // K_S: string(alg) + resto.
  const ksAlg = decodeString(kS, 0);
  const ksType = new TextDecoder().decode(ksAlg.value);
  // Assinatura: string(algname) + string(sig).
  let off = 0;
  const sigAlg = decodeString(sigOuter, off);
  off = sigAlg.next;
  const sigBytes = decodeString(sigOuter, off);
  const sigName = new TextDecoder().decode(sigAlg.value);

  try {
    if (alg === "ecdsa-sha2-nistp256") {
      if (ksType !== "ecdsa-sha2-nistp256" || sigName !== "ecdsa-sha2-nistp256") throw fail();
      const curve = decodeString(kS, ksAlg.next);
      if (new TextDecoder().decode(curve.value) !== "nistp256") throw fail();
      const q = decodeString(kS, curve.next);
      if (q.value.length !== 65 || q.value[0] !== 0x04) throw fail();
      const key = await subtle.importKey(
        "jwk",
        {
          kty: "EC",
          crv: "P-256",
          x: base64UrlEncode(q.value.slice(1, 33)),
          y: base64UrlEncode(q.value.slice(33, 65)),
          ext: true,
        },
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"]
      );
      // ECDSA WebCrypto espera r||s raw de 64 bytes — é o formato SSH.
      if (sigBytes.value.length !== 64) throw fail();
      const ok = await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sigBytes.value as BufferSource, h as BufferSource);
      if (!ok) throw fail();
      return;
    }
    if (alg === "rsa-sha2-256" || alg === "rsa-sha2-512") {
      if (ksType !== "ssh-rsa" || sigName !== alg) throw fail();
      const e = decodeString(kS, ksAlg.next);
      const n = decodeString(kS, e.next);
      const spki = rsaPublicKeyToSpki(n.value, e.value);
      const key = await subtle.importKey(
        "spki",
        spki as BufferSource,
        { name: "RSASSA-PKCS1-v1_5", hash: alg === "rsa-sha2-256" ? "SHA-256" : "SHA-512" },
        false,
        ["verify"]
      );
      const ok = await subtle.verify(
        { name: "RSASSA-PKCS1-v1_5" },
        key,
        sigBytes.value as BufferSource,
        h as BufferSource
      );
      if (!ok) throw fail();
      return;
    }
    throw fail();
  } catch (e) {
    if (e instanceof SftpError) throw e;
    throw fail();
  }
}

/** RSAPublicKey (n, e) → DER SPKI (para subtle.importKey). */
function rsaPublicKeyToSpki(n: Uint8Array, e: Uint8Array): Uint8Array {
  const strip = (v: Uint8Array): Uint8Array => {
    let i = 0;
    while (i < v.length - 1 && v[i] === 0) i++;
    return v.slice(i);
  };
  const derInt = (v: Uint8Array): Uint8Array => {
    let body = strip(v);
    if (body[0] & 0x80) body = concatBytes(new Uint8Array([0]), body);
    return concatBytes(new Uint8Array([0x02]), derLen(body.length), body);
  };
  const rsaKey = concatBytes(
    new Uint8Array([0x30]),
    (() => {
      const body = concatBytes(derInt(n), derInt(e));
      return concatBytes(derLen(body.length), body);
    })()
  );
  const algId = concatBytes(
    new Uint8Array([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00])
  );
  const bitString = concatBytes(new Uint8Array([0x03]), derLen(rsaKey.length + 1), new Uint8Array([0]), rsaKey);
  const body = concatBytes(algId, bitString);
  return concatBytes(new Uint8Array([0x30]), derLen(body.length), body);
}

function derLen(n: number): Uint8Array {
  if (n < 128) return new Uint8Array([n]);
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

/** UM canal session/sftp: envio fragmentado + receção para o stream SFTP. */
export class SshChannel {
  private streamBuf = new Uint8Array(0);
  private peerClosed = false;
  private expectClose = false;
  private serverWindow = 0x10000;

  constructor(
    private readonly transport: SshTransport,
    private readonly recipient: number,
    private readonly serverMaxPacket: number
  ) {}

  /** Fecha o canal (best-effort; NUNCA falha a operação que já terminou). */
  async close(deadlineMs: number): Promise<void> {
    this.expectClose = true;
    try {
      await this.transport.sendPacket(concatBytes(new Uint8Array([MSG_CHANNEL_CLOSE]), encodeU32(this.recipient)));
    } catch {
      return;
    }
    // Drena o CLOSE do par sem bloquear a resposta (deadline curto interno).
    const drainUntil = Math.min(deadlineMs, Date.now() + 1500);
    try {
      while (!this.peerClosed && Date.now() < drainUntil) {
        await this.fill(drainUntil);
      }
    } catch {
      /* o essencial (dados) já foi entregue */
    }
  }

  async send(data: Uint8Array): Promise<void> {
    let off = 0;
    const chunk = Math.max(1024, this.serverMaxPacket - 64);
    while (off < data.length) {
      const piece = data.slice(off, off + chunk);
      await this.transport.sendPacket(
        concatBytes(new Uint8Array([MSG_CHANNEL_DATA]), encodeU32(this.recipient), encodeString(piece))
      );
      off += piece.length;
    }
  }

  private async fill(deadlineMs: number): Promise<void> {
    const pkt = await this.transport.recvUntil(deadlineMs, [
      MSG_CHANNEL_DATA,
      MSG_CHANNEL_WINDOW_ADJUST,
      MSG_CHANNEL_EOF,
      MSG_CHANNEL_CLOSE,
      MSG_CHANNEL_REQUEST,
    ]);
    const t = pkt[0];
    if (t === MSG_CHANNEL_DATA) {
      const recipient = decodeU32(pkt, 1);
      if (recipient !== CHANNEL_ID) throw new SftpError("SFTP_PROTOCOL_ERROR");
      const { value } = decodeString(pkt, 5);
      this.streamBuf = concatBytes(this.streamBuf, value);
      return;
    }
    if (t === MSG_CHANNEL_WINDOW_ADJUST) {
      this.serverWindow += decodeU32(pkt, 5);
      return;
    }
    if (t === MSG_CHANNEL_REQUEST) {
      // keepalive@ / hostkeys-00@openssh.com etc.: ignorados — nunca bloqueiam
      // o SFTP por um request lateral do servidor.
      return;
    }
    // EOF / CLOSE do par.
    this.peerClosed = true;
    if (!this.expectClose) throw new SftpError("SFTP_PROTOCOL_ERROR");
  }

  /** Lê exatamente n bytes do stream SFTP (ou falha). */
  async readExactly(n: number, deadlineMs: number): Promise<Uint8Array> {
    if (n > SFTP_MAX_CONTENT_BYTES + 1024) throw new SftpError("SFTP_PROTOCOL_ERROR");
    while (this.streamBuf.length < n) {
      if (this.peerClosed) throw new SftpError("SFTP_PROTOCOL_ERROR");
      await this.fill(deadlineMs);
    }
    const out = this.streamBuf.slice(0, n);
    this.streamBuf = this.streamBuf.slice(n);
    return out;
  }
}
