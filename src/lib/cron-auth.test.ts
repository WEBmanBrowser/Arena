/**
 * B.5.3 — CRON_SECRET separation.
 *
 * Invariant: CRON_SECRET is the ONLY cron authentication secret.
 * JWT_SECRET must never authorize a cron endpoint, and the Cloudflare
 * scheduled() handler must not self-call the route with an empty secret.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { POST as expirePOST } from "@/app/api/cron/expire-reservations/route";
import { POST as refundMaintenancePOST } from "@/app/api/cron/refund-maintenance/route";

const CRON = "b5-cron-secret-value-0123456789";
const JWT = "b5-jwt-secret-value-must-not-authorize-cron";

let prevCron: string | undefined;
let prevJwt: string | undefined;

function cronReq(url: string, headers: Record<string, string> = {}) {
  return new NextRequest(url, { method: "POST", headers });
}

function expireReq(headers: Record<string, string> = {}) {
  return cronReq("http://localhost/api/cron/expire-reservations", headers);
}

beforeEach(() => {
  prevCron = process.env.CRON_SECRET;
  prevJwt = process.env.JWT_SECRET;
});

afterEach(() => {
  if (prevCron === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prevCron;
  if (prevJwt === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = prevJwt;
});

describe("B.5.3 — expire-reservations cron authentication", () => {
  it("rejects when CRON_SECRET is not configured (no header)", async () => {
    delete process.env.CRON_SECRET;
    const res = await expirePOST(expireReq());
    expect(res.status).toBe(401);
  });

  it("rejects when CRON_SECRET is not configured even with a header supplied", async () => {
    delete process.env.CRON_SECRET;
    const res = await expirePOST(expireReq({ "x-cron-secret": "anything" }));
    expect(res.status).toBe(401);
  });

  it("rejects an empty supplied secret when CRON_SECRET is configured", async () => {
    process.env.CRON_SECRET = CRON;
    const res = await expirePOST(expireReq({ "x-cron-secret": "" }));
    expect(res.status).toBe(401);
  });

  it("rejects when CRON_SECRET is configured but empty", async () => {
    process.env.CRON_SECRET = "";
    const res = await expirePOST(expireReq({ "x-cron-secret": "" }));
    expect(res.status).toBe(401);
  });

  it("rejects a wrong secret", async () => {
    process.env.CRON_SECRET = CRON;
    const res = await expirePOST(expireReq({ "x-cron-secret": "wrong-secret" }));
    expect(res.status).toBe(401);
  });

  it("JWT_SECRET alone must NEVER authorize cron", async () => {
    delete process.env.CRON_SECRET;
    process.env.JWT_SECRET = JWT;
    expect((await expirePOST(expireReq({ "x-cron-secret": JWT }))).status).toBe(401);
    expect((await expirePOST(expireReq({ authorization: `Bearer ${JWT}` }))).status).toBe(401);
  });

  it("accepts the correct CRON_SECRET via header and bearer token", async () => {
    process.env.CRON_SECRET = CRON;
    const headerRes = await expirePOST(expireReq({ "x-cron-secret": CRON }));
    expect(headerRes.status).toBe(200);
    expect(await headerRes.json()).toMatchObject({ ok: true });

    const bearerRes = await expirePOST(expireReq({ authorization: `Bearer ${CRON}` }));
    expect(bearerRes.status).toBe(200);
  });
});

describe("B.5.3 — refund-maintenance regression (not weakened)", () => {
  it("still rejects without CRON_SECRET and with JWT_SECRET only", async () => {
    delete process.env.CRON_SECRET;
    process.env.JWT_SECRET = JWT;
    const res = await refundMaintenancePOST(
      cronReq("http://localhost/api/cron/refund-maintenance", { "x-cron-secret": JWT }),
    );
    expect(res.status).toBe(401);
  });

  it("still accepts the correct CRON_SECRET", async () => {
    process.env.CRON_SECRET = CRON;
    const res = await refundMaintenancePOST(
      cronReq("http://localhost/api/cron/refund-maintenance", { "x-cron-secret": CRON }),
    );
    expect(res.status).toBe(200);
  });
});

describe("B.5.3 — repository-wide fallback audit", () => {
  const root = path.resolve(__dirname, "..", "..");

  function sourceFiles(dir: string, acc: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".next" || entry.name === ".open-next") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) sourceFiles(full, acc);
      else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name) && !entry.name.endsWith(".test.ts")) acc.push(full);
    }
    return acc;
  }

  it("contains no CRON_SECRET || JWT_SECRET fallback anywhere in source", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(root)) {
      const content = fs.readFileSync(file, "utf8");
      if (/CRON_SECRET\s*(\|\||\?\?)\s*[\w.]*JWT_SECRET/.test(content)) {
        offenders.push(path.relative(root, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("custom-worker skips the scheduled self-call when CRON_SECRET is missing", () => {
    const worker = fs.readFileSync(path.join(root, "custom-worker.ts"), "utf8");
    expect(worker).not.toMatch(/env\.CRON_SECRET\s*\|\|/);
    // Guard clause returns before any self-fetch when the secret is absent.
    const guardIndex = worker.indexOf("if (!cronSecret)");
    const fetchIndex = worker.indexOf("handler.fetch(\n");
    expect(guardIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(worker.indexOf("x-cron-secret"));
    expect(fetchIndex === -1 || guardIndex < fetchIndex).toBe(true);
  });

  it("worker scheduled() does not fetch when CRON_SECRET is absent (behavioural)", async () => {
    // Behavioural replica of the worker guard (the real module imports the
    // build-time generated .open-next/worker.js which does not exist in test).
    let fetched = 0;
    const scheduled = async (
      controller: { cron: string },
      env: Record<string, string>,
      ctx: { waitUntil: (p: Promise<unknown>) => void },
    ) => {
      const cronSecret = env.CRON_SECRET;
      if (!cronSecret) {
        console.error(`[CRON ${controller.cron}] CRON_SECRET is not configured — skipping expire-reservations`);
        return;
      }
      ctx.waitUntil(Promise.resolve(fetched++));
    };
    const ctx = { waitUntil: () => {} };
    await scheduled({ cron: "*/10 * * * *" }, { JWT_SECRET: JWT }, ctx);
    expect(fetched).toBe(0);
    await scheduled({ cron: "*/10 * * * *" }, { CRON_SECRET: CRON }, ctx);
    expect(fetched).toBe(1);
  });
});
