/**
 * C.3.4.4 â€” GRUPO D: transporte SFTP (worker also-sftp-fetcher, sem rede).
 *
 * Os mÃ³dulos do worker sÃ£o importados diretamente (sÃ£o puros; o Ãºnico
 * `cloudflare:sockets` Ã© dinÃ¢mico e nunca Ã© executado aqui). Trava:
 *  - guardas puras: host/port/path/username/secret/fingerprint;
 *  - secret resolvido SÃ“ pelo nome, do env do worker (fail-closed);
 *  - allowlist exata (conector nunca chamado quando o host Ã© recusado);
 *  - retry SÃ“ de transitÃ³rios, sempre com conexÃ£o NOVA;
 *  - SFTP estruturalmente READ-ONLY: captura dos tipos emitidos num stat+read
 *    scripted âŠ† SFTP_READONLY_SENT_TYPES; OPEN sempre em modo READ;
 *  - texto do servidor / segredos / paths nunca vazam para erros nem logs.
 */
import { describe, expect, it, vi } from "vitest";
import {
  SftpError,
  isSftpRetryableCode,
  sftpErrorMessage,
} from "../../workers/also-sftp-fetcher/src/errors";
import {
  SFTP_MAX_CONTENT_BYTES,
  guardSftpConfig,
  guardSftpFingerprint,
  guardSftpHost,
  guardSftpPath,
  guardSftpPort,
  guardSftpSecretName,
  guardSftpUsername,
} from "../../workers/also-sftp-fetcher/src/guards";
import {
  handleSftpRequest,
  resolveWorkerSecret,
  runSftpOp,
  type FetcherEnv,
} from "../../workers/also-sftp-fetcher/src/index";
import {
  SFTP_READONLY_SENT_TYPES,
  SftpClient,
  parseAttrs,
  type SftpChannel,
} from "../../workers/also-sftp-fetcher/src/sftp";
import { concatBytes, decodeU32, encodeString, encodeU32 } from "../../workers/also-sftp-fetcher/src/ssh";

const HOST = "ftp.fornecedor.com";
const FINGERPRINT = `SHA256:${"A".repeat(43)}`;

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    op: "stat",
    host: HOST,
    port: 22,
    username: "also_user",
    secretName: "ALSO_SFTP_PASSWORD",
    remotePath: "/out/stock.txt",
    hostKeyFingerprint: FINGERPRINT,
    ...overrides,
  };
}

const envWithSecret: FetcherEnv = {
  SFTP_ALLOWED_HOSTS: HOST,
  ALSO_SFTP_PASSWORD: "super-secret-value",
};

describe("C.3.4.4 [D] â€” guardas puras da config", () => {
  it("host: normaliza (lowercase, ponto final) e rejeita o resto", () => {
    expect(guardSftpHost("FTP.Fornecedor.COM.")).toBe(HOST);
    for (const bad of [
      "",
      "   ",
      "1.2.3.4",
      "10.0.0.1",
      "localhost",
      "localhost.localdomain",
      "metadata.google.internal",
      "x.local",
      "x.internal",
      "x.test",
      "x.invalid",
      "x.example",
      "x.onion",
      "https://ftp.fornecedor.com",
      "user@ftp.fornecedor.com",
      "ftp.fornecedor.com:22",
      "ftp.fornecedor.com/path",
      "ftp fornecedor.com",
      "a".repeat(256),
      22,
      null,
      undefined,
    ]) {
      expect(() => guardSftpHost(bad), JSON.stringify(bad)).toThrow(SftpError);
    }
  });

  it("port: 1â€“65535 (strings numÃ©ricas aceites, como de env/form)", () => {
    expect(guardSftpPort(22)).toBe(22);
    expect(guardSftpPort("22")).toBe(22);
    expect(guardSftpPort(65535)).toBe(65535);
    for (const bad of [0, -1, 65536, 1.5, NaN, "", "abc", "22.5", null, undefined]) {
      expect(() => guardSftpPort(bad), String(bad)).toThrow(SftpError);
    }
  });

  it("remotePath: absoluto, sem controlo", () => {
    expect(guardSftpPath("/out/stock.txt")).toBe("/out/stock.txt");
    for (const bad of ["", "relativo/stock.txt", "/x\ny", "/x\0y", "/x\ry", "a".repeat(1001), null]) {
      expect(() => guardSftpPath(bad), JSON.stringify(bad)).toThrow(SftpError);
    }
  });

  it("username: nÃ£o-vazio, sem controlo", () => {
    expect(guardSftpUsername("also_user")).toBe("also_user");
    for (const bad of ["", "   ", "a\nb", "a\0b", "u".repeat(256), null]) {
      expect(() => guardSftpUsername(bad), JSON.stringify(bad)).toThrow(SftpError);
    }
  });

  it("secretName: nome de env vÃ¡lido (nunca um valor)", () => {
    expect(guardSftpSecretName("ALSO_SFTP_PASSWORD")).toBe("ALSO_SFTP_PASSWORD");
    for (const bad of ["", "lowercase", "COM ESPAÃ‡O", "COM-HÃFEN", "9ABC", "p@ssw0rd!", null]) {
      expect(() => guardSftpSecretName(bad), JSON.stringify(bad)).toThrow(SftpError);
    }
  });

  it("fingerprint: pin SHA256 obrigatÃ³rio (TOFU proibido)", () => {
    expect(guardSftpFingerprint(FINGERPRINT)).toBe(FINGERPRINT);
    for (const bad of [
      "",
      "SHA256:short",
      `SHA256:${"A".repeat(44)}=`, // com padding â†’ formato errado
      "MD5:aa:bb:cc",
      "ssh-ed25519 AAAAâ€¦",
      null,
      undefined,
    ]) {
      expect(() => guardSftpFingerprint(bad), JSON.stringify(bad)).toThrow(SftpError);
    }
  });

  it("guardSftpConfig valida o conjunto e devolve normalizado", () => {
    const cfg = guardSftpConfig(validBody({ host: "FTP.Fornecedor.COM." }));
    expect(cfg).toEqual({
      host: HOST,
      port: 22,
      remotePath: "/out/stock.txt",
      username: "also_user",
      secretName: "ALSO_SFTP_PASSWORD",
      hostKeyFingerprint: FINGERPRINT,
    });
    expect(() => guardSftpConfig({ ...validBody(), port: 0 })).toThrow(SftpError);
    expect(() => guardSftpConfig({})).toThrow(SftpError);
  });

  it("teto de conteÃºdo = 5 MB", () => {
    expect(SFTP_MAX_CONTENT_BYTES).toBe(5 * 1024 * 1024);
  });
});

describe("C.3.4.4 [D] â€” segredos: sÃ³ pelo nome, sÃ³ do env do worker", () => {
  it("resolve o valor pelo nome", () => {
    expect(resolveWorkerSecret("ALSO_SFTP_PASSWORD", envWithSecret)).toBe("super-secret-value");
  });

  it("ausente/vazio/com CRLF â†’ SFTP_SECRET_MISSING (nunca o valor no erro)", () => {
    for (const env of [{}, { ALSO_SFTP_PASSWORD: "" }, { ALSO_SFTP_PASSWORD: "a\nb" }, { OTHER: "x" }]) {
      let caught: unknown = null;
      try {
        resolveWorkerSecret("ALSO_SFTP_PASSWORD", env);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(SftpError);
      expect((caught as SftpError).code).toBe("SFTP_SECRET_MISSING");
      expect(String(caught)).not.toContain("super-secret-value");
    }
  });
});

describe("C.3.4.4 [D] â€” handleSftpRequest: validaÃ§Ã£o, allowlist, envelopes", () => {
  it("corpo invÃ¡lido/op invÃ¡lida â†’ envelope de erro, conector nunca chamado", async () => {
    const runAttempt = vi.fn(async () => {
      throw new Error("must not connect");
    });
    for (const raw of [null, undefined, [], "x", {}, { op: "write" }, { op: "stat" }]) {
      const res = await handleSftpRequest(raw, envWithSecret, { runAttempt });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe("SFTP_CONFIG_INVALID");
        expect(res.message).toBe(sftpErrorMessage("SFTP_CONFIG_INVALID"));
      }
    }
    expect(runAttempt).not.toHaveBeenCalled();
  });

  it("host fora da allowlist â†’ SFTP_HOST_NOT_ALLOWED, sem conexÃ£o", async () => {
    const runAttempt = vi.fn(async () => {
      throw new Error("must not connect");
    });
    const res = await handleSftpRequest(validBody({ host: "evil.example.net" }), envWithSecret, { runAttempt });
    expect(res).toEqual({
      ok: false,
      code: "SFTP_HOST_NOT_ALLOWED",
      message: sftpErrorMessage("SFTP_HOST_NOT_ALLOWED"),
    });
    expect(runAttempt).not.toHaveBeenCalled();
  });

  it("allowlist vazia â†’ default; lista CSV respeitada", async () => {
    const runAttempt = vi.fn(async () => {
      throw new Error("must not connect");
    });
    // Sem SFTP_ALLOWED_HOSTS: sÃ³ o default passa (o pedido falha depois, no secret).
    const resDefault = await handleSftpRequest(validBody(), { ALSO_SFTP_PASSWORD: "x" }, { runAttempt });
    expect(resDefault.ok).toBe(false);
    if (!resDefault.ok) expect(resDefault.code).toBe("SFTP_HOST_NOT_ALLOWED");

    const resCsv = await handleSftpRequest(
      validBody(),
      { SFTP_ALLOWED_HOSTS: `outro.com, ${HOST} `, ALSO_SFTP_PASSWORD: undefined },
      { runAttempt }
    );
    expect(resCsv.ok).toBe(false);
    if (!resCsv.ok) expect(resCsv.code).toBe("SFTP_SECRET_MISSING"); // passou a allowlist
  });

  it("secret em falta â†’ SFTP_SECRET_MISSING (o valor nunca aparece)", async () => {
    const runAttempt = vi.fn(async () => {
      throw new Error("must not connect");
    });
    const res = await handleSftpRequest(validBody(), { SFTP_ALLOWED_HOSTS: HOST }, { runAttempt });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("SFTP_SECRET_MISSING");
      expect(JSON.stringify(res)).not.toContain("super-secret-value");
      expect(JSON.stringify(res)).not.toContain("/out/stock.txt");
      expect(JSON.stringify(res)).not.toContain("also_user");
    }
    expect(runAttempt).not.toHaveBeenCalled();
  });
});

describe("C.3.4.4 [D] â€” retry: sÃ³ transitÃ³rios, sempre conexÃ£o nova", () => {
  const cfg = guardSftpConfig(validBody());

  it("falha de rede Ã© repetida atÃ© maxAttempts (conector novo por tentativa)", async () => {
    let calls = 0;
    const delays: number[] = [];
    const runAttempt = async () => {
      calls++;
      throw new Error("boom");
    };
    await expect(
      runSftpOp(cfg, "stat", "pw", {
        runAttempt: runAttempt as never,
        maxBytes: 1024,
        timeoutMs: 1000,
        maxAttempts: 3,
        sleep: async (ms: number) => {
          delays.push(ms);
        },
      })
    ).rejects.toMatchObject({ code: "SFTP_FETCH_FAILED" });
    expect(calls).toBe(3);
    expect(delays).toEqual([250, 500]); // backoff entre tentativas, nÃ£o apÃ³s a Ãºltima
  });

  it("erro NÃƒO transitÃ³rio (host key) nÃ£o Ã© repetido", async () => {
    let calls = 0;
    const runAttempt = async () => {
      calls++;
      throw new SftpError("SFTP_HOST_KEY_MISMATCH");
    };
    await expect(
      runSftpOp(cfg, "stat", "pw", {
        runAttempt: runAttempt as never,
        maxBytes: 1024,
        timeoutMs: 1000,
        maxAttempts: 5,
        sleep: async () => {},
      })
    ).rejects.toMatchObject({ code: "SFTP_HOST_KEY_MISMATCH" });
    expect(calls).toBe(1);
  });

  it("tabela de retry: rede sim, auth/hostkey/config nÃ£o", () => {
    expect(isSftpRetryableCode("SFTP_FETCH_FAILED")).toBe(true);
    expect(isSftpRetryableCode("SFTP_TIMEOUT")).toBe(true);
    expect(isSftpRetryableCode("SFTP_AUTH_FAILED")).toBe(false);
    expect(isSftpRetryableCode("SFTP_HOST_KEY_MISMATCH")).toBe(false);
    expect(isSftpRetryableCode("SFTP_HOST_NOT_ALLOWED")).toBe(false);
    expect(isSftpRetryableCode("SFTP_FILE_NOT_FOUND")).toBe(false);
    expect(isSftpRetryableCode("SFTP_CONFIG_INVALID")).toBe(false);
    expect(isSftpRetryableCode("SFTP_TOO_LARGE")).toBe(false);
  });
});

// â”€â”€â”€ Canal SFTP scripted (servidor falso em memÃ³ria) â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// Constantes do protocolo (RFC draft-ietf-secsh-filexfer-02, estÃ¡veis).
const FXP_VERSION = 2;
const FXP_STATUS = 101;
const FXP_HANDLE = 102;
const FXP_DATA = 103;
const FXP_ATTRS = 105;
const STATUS_OK = 0;
const STATUS_EOF = 1;
const STATUS_NO_SUCH_FILE = 2;
const STATUS_PERMISSION_DENIED = 3;

function packet(type: number, id: number | null, payload: Uint8Array): Uint8Array {
  const body =
    id === null ? concatBytes(new Uint8Array([type]), payload) : concatBytes(new Uint8Array([type]), encodeU32(id), payload);
  return concatBytes(encodeU32(body.length), body);
}

function statusPacket(id: number, code: number, message: string): Uint8Array {
  return packet(FXP_STATUS, id, concatBytes(encodeU32(code), encodeString(message), encodeString("en")));
}

function attrsPacket(id: number, size: number | null, mtime: number | null): Uint8Array {
  let flags = 0;
  const parts: Uint8Array[] = [];
  if (size !== null) {
    flags |= 0x01;
    parts.push(encodeU32(Math.floor(size / 0x100000000)), encodeU32(size >>> 0));
  }
  if (mtime !== null) {
    flags |= 0x08;
    parts.push(encodeU32(mtime), encodeU32(mtime)); // atime ignorado + mtime
  }
  return packet(FXP_ATTRS, id, concatBytes(encodeU32(flags), ...parts));
}

/** Servidor falso: serve bytes enlatados e regista os tipos EMITIDOS. */
class ScriptedChannel implements SftpChannel {
  readonly sentTypes: number[] = [];
  readonly sentBodies: Uint8Array[] = [];
  private inbox: Uint8Array;
  private at = 0;

  constructor(responses: Uint8Array[]) {
    this.inbox = concatBytes(...responses);
  }

  async send(data: Uint8Array): Promise<void> {
    const len = decodeU32(data, 0);
    const body = data.slice(4, 4 + len);
    this.sentTypes.push(body[0]);
    this.sentBodies.push(body);
  }

  async readExactly(n: number, _deadlineMs: number): Promise<Uint8Array> {
    if (this.at + n > this.inbox.length) throw new SftpError("SFTP_PROTOCOL_ERROR");
    const out = this.inbox.slice(this.at, this.at + n);
    this.at += n;
    return out;
  }
}

describe("C.3.4.4 [D] â€” SFTP read-only estrutural (stat+read scripted)", () => {
  it("stat: emite INIT+STAT, lÃª size+mtime", async () => {
    const ch = new ScriptedChannel([
      packet(FXP_VERSION, null, encodeU32(3)),
      attrsPacket(1, 1234, 1725667200),
    ]);
    const client = new SftpClient(ch);
    expect(await client.init(Date.now() + 5000)).toBe(3);
    const st = await client.stat(Date.now() + 5000, "/out/stock.txt");
    expect(st).toEqual({ size: 1234, mtime: 1725667200 });
    expect(ch.sentTypes).toEqual([1, 17]); // INIT, STAT
  });

  it("read: OPENâ†’READâ€¦â†’CLOSE; OPEN sempre em modo READ; bytes remontados", async () => {
    const part1 = new TextEncoder().encode("ProductID\tAvailableQuantity\n");
    const part2 = new TextEncoder().encode("PID1\t5\n");
    const ch = new ScriptedChannel([
      packet(FXP_VERSION, null, encodeU32(3)),
      packet(FXP_HANDLE, 1, encodeString("h1")),
      packet(FXP_DATA, 2, encodeString(part1)),
      packet(FXP_DATA, 3, encodeString(part2)),
      statusPacket(4, STATUS_EOF, ""),
      statusPacket(5, STATUS_OK, ""),
    ]);
    const client = new SftpClient(ch);
    await client.init(Date.now() + 5000);
    const { bytes } = await client.read(Date.now() + 5000, "/out/stock.txt", 1024);
    expect(new TextDecoder().decode(bytes)).toBe("ProductID\tAvailableQuantity\nPID1\t5\n");
    // INIT, OPEN, READ, READ, READ(â†’EOF), CLOSE
    expect(ch.sentTypes).toEqual([1, 3, 5, 5, 5, 4]);
    // OPEN: string(path) + pflags + attrs(flags=0) â€” pflags tem de ser READ=1.
    const openBody = ch.sentBodies[1];
    const pathLen = decodeU32(openBody, 5);
    const pflags = decodeU32(openBody, 5 + 4 + pathLen);
    expect(pflags).toBe(1);
  });

  it("auditoria: tudo o que foi emitido âŠ† SFTP_READONLY_SENT_TYPES", async () => {
    const ch = new ScriptedChannel([
      packet(FXP_VERSION, null, encodeU32(3)),
      attrsPacket(1, 10, 100),
      packet(FXP_HANDLE, 2, encodeString("h")),
      packet(FXP_DATA, 3, encodeString(new Uint8Array([1, 2]))),
      statusPacket(4, STATUS_EOF, ""),
      statusPacket(5, STATUS_OK, ""),
    ]);
    const client = new SftpClient(ch);
    await client.init(Date.now() + 5000);
    await client.stat(Date.now() + 5000, "/out/stock.txt");
    await client.read(Date.now() + 5000, "/out/stock.txt", 1024);
    const allowed = new Set<number>([...SFTP_READONLY_SENT_TYPES]);
    expect(allowed).toEqual(new Set([1, 17, 3, 5, 4])); // INIT STAT OPEN READ CLOSE
    for (const t of ch.sentTypes) expect(allowed.has(t), `tipo emitido ${t}`).toBe(true);
  });

  it("STATUS do servidor mapeia para cÃ³digos seguros (texto descartado)", async () => {
    const chNotFound = new ScriptedChannel([
      packet(FXP_VERSION, null, encodeU32(3)),
      statusPacket(1, STATUS_NO_SUCH_FILE, "/out/segredo.txt: detalhe interno do servidor"),
    ]);
    const c1 = new SftpClient(chNotFound);
    await c1.init(Date.now() + 5000);
    await expect(c1.stat(Date.now() + 5000, "/out/stock.txt")).rejects.toMatchObject({ code: "SFTP_FILE_NOT_FOUND" });

    const chPerm = new ScriptedChannel([
      packet(FXP_VERSION, null, encodeU32(3)),
      statusPacket(1, STATUS_PERMISSION_DENIED, "permission denied for user also_user"),
    ]);
    const c2 = new SftpClient(chPerm);
    await c2.init(Date.now() + 5000);
    const err = await c2.stat(Date.now() + 5000, "/out/stock.txt").catch((e) => e);
    expect(err).toBeInstanceOf(SftpError);
    expect(err.code).toBe("SFTP_PERMISSION_DENIED");
    expect(String(err)).not.toContain("also_user");
    expect(String(err)).not.toContain("permission denied");
  });

  it("resposta com id errado â†’ SFTP_PROTOCOL_ERROR", async () => {
    const ch = new ScriptedChannel([packet(FXP_VERSION, null, encodeU32(3)), attrsPacket(999, 1, 1)]);
    const client = new SftpClient(ch);
    await client.init(Date.now() + 5000);
    await expect(client.stat(Date.now() + 5000, "/out/stock.txt")).rejects.toMatchObject({
      code: "SFTP_PROTOCOL_ERROR",
    });
  });

  it("read acima do teto a meio do stream â†’ SFTP_TOO_LARGE", async () => {
    const big = new Uint8Array(100).fill(65);
    const ch = new ScriptedChannel([
      packet(FXP_VERSION, null, encodeU32(3)),
      packet(FXP_HANDLE, 1, encodeString("h")),
      packet(FXP_DATA, 2, encodeString(big)),
      statusPacket(3, STATUS_OK, ""), // CLOSE best-effort
    ]);
    const client = new SftpClient(ch);
    await client.init(Date.now() + 5000);
    await expect(client.read(Date.now() + 5000, "/f", 10)).rejects.toMatchObject({ code: "SFTP_TOO_LARGE" });
  });

  it("parseAttrs: sÃ³ SIZE+MTIME interessam; resto saltado sem falhar", () => {
    // flags SIZE|UIDGID|PERM|ACMODTIME
    const b = concatBytes(
      encodeU32(0x01 | 0x02 | 0x04 | 0x08),
      encodeU32(0),
      encodeU32(777),
      encodeU32(1000),
      encodeU32(1000),
      encodeU32(0o644),
      encodeU32(111),
      encodeU32(222)
    );
    expect(parseAttrs(b, 0).attrs).toEqual({ size: 777, mtime: 222 });
    // sem flags â†’ tudo null (servidor que omite attrs)
    expect(parseAttrs(encodeU32(0), 0).attrs).toEqual({ size: null, mtime: null });
  });
});

describe("C.3.4.4 [D] â€” mensagens seguras", () => {
  it("cÃ³digo desconhecido cai no genÃ©rico (fail-closed)", () => {
    expect(sftpErrorMessage("NOPE")).toBe(sftpErrorMessage("SFTP_FETCH_FAILED"));
  });

  it("SftpError transporta sÃ³ o cÃ³digo (message = cÃ³digo)", () => {
    const e = new SftpError("SFTP_AUTH_FAILED");
    expect(e.message).toBe("SFTP_AUTH_FAILED");
    expect(e.retryable).toBe(false);
  });
});
