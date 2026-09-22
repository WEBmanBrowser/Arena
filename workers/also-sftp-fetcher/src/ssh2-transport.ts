import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { Client, type SFTPWrapper } from "ssh2";
import { SftpError } from "./errors";
import type { SftpConfig } from "./guards";

export interface Ssh2RunOptions {
  maxBytes: number;
  timeoutMs: number;
}

function normalizePin(pin: string): string {
  return pin.replace(/=+$/, "");
}

export function fingerprintFromHostKey(key: Buffer): string | null {
  try {
    if (!Buffer.isBuffer(key) || key.length <= 8) return null;

    const typeLen = key.readUInt32BE(0);
    if (typeLen <= 0 || 4 + typeLen > key.length) return null;

    return (
      "SHA256:" +
      createHash("sha256")
        .update(key)
        .digest("base64")
        .replace(/=+$/, "")
    );
  } catch {
    return null;
  }
}

function mapSsh2Error(err: unknown, stage: string): SftpError {
  const e = err as {
    code?: string | number;
    level?: string;
    message?: string;
  };

  const code = String(e?.code ?? "").toUpperCase();
  const level = String(e?.level ?? "").toLowerCase();
  const msg = String(e?.message ?? "").toLowerCase();

  if (
    level.includes("client-authentication") ||
    msg.includes("authentication") ||
    msg.includes("all configured authentication methods failed")
  ) {
    return new SftpError("SFTP_AUTH_FAILED");
  }

  if (
    code === "2" ||
    code === "ENOENT" ||
    msg.includes("no such file") ||
    msg.includes("not found")
  ) {
    return new SftpError("SFTP_FILE_NOT_FOUND");
  }

  if (
    code === "3" ||
    code === "EACCES" ||
    code === "EPERM" ||
    msg.includes("permission denied")
  ) {
    return new SftpError("SFTP_PERMISSION_DENIED");
  }

  if (
    code === "ETIMEDOUT" ||
    msg.includes("timed out") ||
    msg.includes("timeout")
  ) {
    return new SftpError("SFTP_TIMEOUT");
  }

  if (
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "EHOSTUNREACH" ||
    code === "ENETUNREACH" ||
    code === "EPIPE"
  ) {
    return new SftpError("SFTP_FETCH_FAILED");
  }

  if (stage === "sftp" || stage === "stat" || stage === "read") {
    return new SftpError("SFTP_PROTOCOL_ERROR");
  }

  return new SftpError("SFTP_FETCH_FAILED");
}

function openSftp(conn: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) reject(err);
      else resolve(sftp);
    });
  });
}

function statRemote(
  sftp: SFTPWrapper,
  remotePath: string
): Promise<{ size: number | null; mtime: number | null }> {
  return new Promise((resolve, reject) => {
    sftp.stat(remotePath, (err, attrs) => {
      if (err) {
        reject(err);
        return;
      }

      resolve({
        size: Number.isFinite(attrs?.size) ? attrs.size : null,
        mtime: Number.isFinite(attrs?.mtime) ? attrs.mtime : null,
      });
    });
  });
}

function readRemote(
  sftp: SFTPWrapper,
  remotePath: string,
  maxBytes: number
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (err?: unknown, bytes?: Uint8Array) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(bytes ?? new Uint8Array());
    };

    const closeHandle = (
      handle: Buffer,
      err?: unknown,
      bytes?: Uint8Array
    ) => {
      // The operation result must not depend on the server
      // acknowledging SSH_FXP_CLOSE.
      finish(err, bytes);

      // Best-effort handle cleanup.
      try {
        sftp.close(handle, () => {
          // Cleanup only; operation is already settled.
        });
      } catch {
        // Ignore cleanup failures.
      }
    };

    sftp.open(remotePath, "r", (openErr, handle) => {
      if (openErr) {
        finish(openErr);
        return;
      }

      const chunks: Buffer[] = [];
      let total = 0;
      let position = 0;

      const readNext = () => {
        if (settled) return;

        // Never request more than the remaining allowed bytes.
        // Requesting one extra byte lets us prove that the remote file
        // exceeds maxBytes without trusting STAT/FSTAT.
        // Keep each SFTP READ below ssh2's internal maxReadLen so
        // ssh2 does not split a single read request into multiple
        // internal READ requests.
        const READ_CHUNK_SIZE = 30 * 1024;
        const requestLength = Math.min(
          READ_CHUNK_SIZE,
          maxBytes - total + 1
        );

        if (requestLength <= 0) {
          closeHandle(
            handle,
            new SftpError("SFTP_TOO_LARGE")
          );
          return;
        }

        const buffer = Buffer.allocUnsafe(requestLength);

        sftp.read(
          handle,
          buffer,
          0,
          requestLength,
          position,
          (err, bytesRead) => {

            if (settled) return;

            if (err) {
              const code = (err as { code?: unknown }).code;

              if (code === "EOF" || code === 1) {
                closeHandle(
                  handle,
                  undefined,
                  new Uint8Array(Buffer.concat(chunks, total))
                );
                return;
              }

              closeHandle(handle, err);
              return;
            }

            if (!bytesRead) {
              closeHandle(
                handle,
                undefined,
                new Uint8Array(Buffer.concat(chunks, total))
              );
              return;
            }

            total += bytesRead;
            position += bytesRead;

            if (total > maxBytes) {
              closeHandle(handle, new SftpError("SFTP_TOO_LARGE"));
              return;
            }

            chunks.push(buffer.subarray(0, bytesRead));

            readNext();
          }
        );
      };

      readNext();
    });
  });
}

export async function runSsh2SftpOp(
  cfg: SftpConfig,
  op: "stat" | "read",
  password: string,
  opts: Ssh2RunOptions
): Promise<{
  size: number | null;
  mtime: number | null;
  bytes: Uint8Array | null;
}> {
  const conn = new Client();

  let stage = "connect";
  let hostKeyMismatch = false;
  let settled = false;

  const operation = new Promise<{
    size: number | null;
    mtime: number | null;
    bytes: Uint8Array | null;
  }>((resolve, reject) => {
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;

      if (hostKeyMismatch) {
        reject(new SftpError("SFTP_HOST_KEY_MISMATCH"));
        return;
      }

      reject(err instanceof SftpError ? err : mapSsh2Error(err, stage));
    };

    conn.once("error", fail);

    conn.once("ready", async () => {
      try {
        stage = "sftp";
        const sftp = await openSftp(conn);

        stage = "stat";
        const st = await statRemote(sftp, cfg.remotePath);

        if (op === "stat") {
          if (!settled) {
            settled = true;
            resolve({ size: st.size, mtime: st.mtime, bytes: null });
          }
          return;
        }

        if (st.size !== null && st.size > opts.maxBytes) {
          throw new SftpError("SFTP_TOO_LARGE");
        }

        stage = "read";
        const bytes = await readRemote(sftp, cfg.remotePath, opts.maxBytes);

        if (!settled) {
          settled = true;
          resolve({
            size: st.size ?? bytes.length,
            mtime: st.mtime,
            bytes,
          });
        }
      } catch (err) {
        fail(err);
      }
    });

    try {
      conn.connect({
        host: cfg.host,
        port: cfg.port,
        username: cfg.username,
        password,
        readyTimeout: Math.min(opts.timeoutMs, 15_000),
        algorithms: { cipher: ["aes128-ctr", "aes256-ctr"] },
        hostVerifier: (key: Buffer) => {
          const actual = fingerprintFromHostKey(key);
          const expected = normalizePin(cfg.hostKeyFingerprint);

          const ok = actual !== null && normalizePin(actual) === expected;
          if (!ok) hostKeyMismatch = true;

          return ok;
        },
      });
    } catch (err) {
      fail(err);
    }
  });

  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new SftpError("SFTP_TIMEOUT"));
      }
    }, opts.timeoutMs);
  });

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);

    try {
      conn.end();
    } catch {
      // noop
    }
  }
}
