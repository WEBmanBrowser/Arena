import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Server, utils } from "ssh2";
import { SftpError } from "../../workers/also-sftp-fetcher/src/errors";
import { runSftpOp } from "../../workers/also-sftp-fetcher/src/index";
import {
  fingerprintFromHostKey,
  runSsh2SftpOp,
} from "../../workers/also-sftp-fetcher/src/ssh2-transport";

const MAX_BYTES = 5 * 1024 * 1024;
const REMOTE_PATH = "/stock.txt";
const USERNAME = "test-user";
const PASSWORD = "test-password";

interface TestServer {
  port: number;
  fingerprint: string;
  authAttempts: () => number;
  openCount: () => number;
  close: () => Promise<void>;
}

const servers: TestServer[] = [];

async function startSftpServer(options: {
  content: Buffer;
  reportedSize?: number;
}): Promise<TestServer> {
  const keys = utils.generateKeyPairSync("ed25519");
  const parsed = utils.parseKey(keys.private);

  if (parsed instanceof Error) {
    throw parsed;
  }

  const publicBlob = parsed.getPublicSSH();
  const fingerprint = fingerprintFromHostKey(publicBlob);

  if (!fingerprint) {
    throw new Error("TEST_HOST_KEY_FINGERPRINT_FAILED");
  }

  let authAttempts = 0;
  let openCount = 0;

  const handle = Buffer.from("test-handle");

  const server = new Server(
    {
      hostKeys: [keys.private],
      algorithms: {
        cipher: ["aes128-ctr", "aes256-ctr"],
      },
    },
    (client) => {
      client.on("error", () => {});

      client
        .on("authentication", (ctx) => {
          if (ctx.method !== "password") {
            ctx.reject(["password"]);
            return;
          }

          authAttempts += 1;

          if (ctx.username === USERNAME && ctx.password === PASSWORD) {
            ctx.accept();
          } else {
            ctx.reject(["password"]);
          }
        })
        .on("ready", () => {
          client.on("session", (accept) => {
            const session = accept();

            session.on("sftp", (acceptSftp) => {
              const sftp = acceptSftp();

              const attrs = {
                size: options.reportedSize ?? options.content.length,
                atime: 1_700_000_000,
                mtime: 1_700_000_000,
                mode: 0o100644,
                uid: 0,
                gid: 0,
              };

              sftp.on("STAT", (reqId, path) => {
                if (path !== REMOTE_PATH) {
                  sftp.status(reqId, utils.sftp.STATUS_CODE.NO_SUCH_FILE);
                  return;
                }

                sftp.attrs(reqId, attrs);
              });

              sftp.on("OPEN", (reqId, filename, flags) => {
                openCount += 1;

                if (
                  filename !== REMOTE_PATH ||
                  (flags & utils.sftp.OPEN_MODE.READ) === 0
                ) {
                  sftp.status(reqId, utils.sftp.STATUS_CODE.PERMISSION_DENIED);
                  return;
                }

                sftp.handle(reqId, handle);
              });

              sftp.on("FSTAT", (reqId, requestHandle) => {
                if (!requestHandle.equals(handle)) {
                  sftp.status(reqId, utils.sftp.STATUS_CODE.FAILURE);
                  return;
                }

                sftp.attrs(reqId, attrs);
              });

              sftp.on("READ", (reqId, requestHandle, offset, len) => {
                if (!requestHandle.equals(handle)) {
                  sftp.status(reqId, utils.sftp.STATUS_CODE.FAILURE);
                  return;
                }

                if (offset >= options.content.length) {
                  sftp.status(reqId, utils.sftp.STATUS_CODE.EOF);
                  return;
                }

                const end = Math.min(offset + len, options.content.length);
                sftp.data(reqId, options.content.subarray(offset, end));
              });

              sftp.on("CLOSE", (reqId) => {
                sftp.status(reqId, utils.sftp.STATUS_CODE.OK);
              });
            });
          });
        });
    }
  );

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("TEST_SERVER_ADDRESS_FAILED");
  }

  const testServer: TestServer = {
    port: address.port,
    fingerprint,
    authAttempts: () => authAttempts,
    openCount: () => openCount,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  };

  servers.push(testServer);
  return testServer;
}

function config(server: TestServer, fingerprint = server.fingerprint) {
  return {
    host: "127.0.0.1",
    port: server.port,
    username: USERNAME,
    remotePath: REMOTE_PATH,
    secretName: "TEST_SECRET",
    hostKeyFingerprint: fingerprint,
  };
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (!server) continue;

    try {
      await server.close();
    } catch {
      // noop
    }
  }
});

describe("C.3.4.4 [P0] - ssh2 local E2E", () => {
  it("rejects a wrong host-key pin", async () => {
    const server = await startSftpServer({
      content: Buffer.from("hello"),
    });

    await expect(
      runSsh2SftpOp(
        config(server, `SHA256:${"A".repeat(43)}`),
        "stat",
        PASSWORD,
        { maxBytes: MAX_BYTES, timeoutMs: 5_000 }
      )
    ).rejects.toMatchObject({
      code: "SFTP_HOST_KEY_MISMATCH",
    });

    expect(server.authAttempts()).toBe(0);
  });

  it("does not retry an authentication failure", async () => {
    const server = await startSftpServer({
      content: Buffer.from("hello"),
    });

    const sleep = vi.fn(async () => {});

    await expect(
      runSftpOp(config(server), "stat", "wrong-password", {
        maxBytes: MAX_BYTES,
        timeoutMs: 5_000,
        maxAttempts: 3,
        sleep,
      })
    ).rejects.toMatchObject({
      code: "SFTP_AUTH_FAILED",
    });

    expect(server.authAttempts()).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("reads exact bytes and produces the exact SHA-256", async () => {
    const content = Buffer.from(
      "1009318\t12\t20260928\t-1\t20260910\t134950\n",
      "utf8"
    );

    const expectedSha256 = createHash("sha256")
      .update(content)
      .digest("hex");

    const server = await startSftpServer({ content });

    const result = await runSsh2SftpOp(
      config(server),
      "read",
      PASSWORD,
      { maxBytes: MAX_BYTES, timeoutMs: 5_000 }
    );

    expect(Buffer.from(result.bytes ?? [])).toEqual(content);

    const actualSha256 = createHash("sha256")
      .update(Buffer.from(result.bytes ?? []))
      .digest("hex");

    expect(actualSha256).toBe(expectedSha256);
    expect(result.size).toBe(content.length);
  });

  it("rejects an honest file over 5 MB before OPEN", async () => {
    const content = Buffer.alloc(MAX_BYTES + 1, 0x41);

    const server = await startSftpServer({
      content,
      reportedSize: content.length,
    });

    await expect(
      runSsh2SftpOp(
        config(server),
        "read",
        PASSWORD,
        { maxBytes: MAX_BYTES, timeoutMs: 5_000 }
      )
    ).rejects.toMatchObject({
      code: "SFTP_TOO_LARGE",
    });

    expect(server.openCount()).toBe(0);
  });

  it("enforces the stream limit when STAT lies", async () => {
    const content = Buffer.alloc(MAX_BYTES + 64 * 1024, 0x42);

    const server = await startSftpServer({
      content,
      reportedSize: 1024,
    });

    await expect(
      runSsh2SftpOp(
        config(server),
        "read",
        PASSWORD,
        { maxBytes: MAX_BYTES, timeoutMs: 10_000 }
      )
    ).rejects.toMatchObject({
      code: "SFTP_TOO_LARGE",
    });

    expect(server.openCount()).toBe(1);
  });
});
