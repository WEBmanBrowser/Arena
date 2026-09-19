/**
 * PAYMENT P0 (M3) — test-harness guards.
 *
 * Three invariants, enforced for every test file:
 *
 * 1. DATABASE BINDING. The suite must talk to the DISPOSABLE PostgreSQL started
 *    by `scripts/test-runner.cjs`, never to anything else. When the runner
 *    signals that it owns the process (`ARENA_TEST_GUARD=1`) we verify the
 *    effective connection by QUERYING it (`current_database()` +
 *    `inet_server_port()`), not by trusting an environment variable.
 *
 * 2. HYPERDRIVE IS UNREACHABLE. `src/db/index.ts` prefers a Cloudflare
 *    Hyperdrive binding when one is available; inside the suite that could
 *    silently redirect every statement to a real database. `@opennextjs/
 *    cloudflare` is therefore intercepted at module-load time so that
 *    `getCloudflareContext()` throws: a Hyperdrive connection string can never
 *    replace the validated one.
 *
 * 3. NO REAL OUTBOUND HTTP. Every provider call in the suite must go through an
 *    injected `fetchImpl`. `globalThis.fetch` is wrapped so that any attempt to
 *    reach a real host is COUNTED and fails the test — including attempts whose
 *    application-level error handling would otherwise turn the failure into an
 *    "ambiguous/UNKNOWN" outcome. A swallowed error can never hide a real
 *    network call again.
 */

import { afterAll, afterEach } from "vitest";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);

// ─── 2. Hyperdrive / Cloudflare context must be unreachable ──

type ModuleLoader = {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};

const moduleLoader = require_("node:module") as unknown as ModuleLoader;
const originalLoad = moduleLoader._load;
moduleLoader._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === "@opennextjs/cloudflare") {
    return {
      getCloudflareContext: () => {
        throw new Error(
          "ARENA_TEST_HYPERDRIVE_FORBIDDEN: Cloudflare bindings (Hyperdrive) must never be reachable from the test suite"
        );
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

// The suite never sends real email: a transport key passed by the caller's
// environment is neutralized here (the outbox rows then report
// `EMAIL_API_KEY_NOT_CONFIGURED`, which is the documented "no transport" state).
if (process.env.EMAIL_API_KEY) {
  delete process.env.EMAIL_API_KEY;
  console.warn("[test-guard] EMAIL_API_KEY removed: the suite never sends real email");
}

// ─── 3. Outbound HTTP accounting ──

interface HttpAttempt {
  method: string;
  url: string;
}

const httpAttempts: HttpAttempt[] = [];
const originalFetch = globalThis.fetch;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  httpAttempts.push({ method: init?.method ?? "GET", url });
  throw new Error(
    `ARENA_TEST_REAL_HTTP_FORBIDDEN: outbound request to ${url} — the suite must use an injected fetchImpl (simulated transport)`
  );
}) as typeof fetch;

export function unexpectedHttpAttempts(): readonly HttpAttempt[] {
  return httpAttempts;
}

/**
 * Drain the recorder. Used ONLY by the M3 self-test, which deliberately triggers
 * the guard once to prove it is installed.
 */
export function consumeHttpAttempts(): readonly HttpAttempt[] {
  const drained = [...httpAttempts];
  httpAttempts.length = 0;
  return drained;
}

/**
 * Fail the current test when anything tried to reach a real host. It runs after
 * every test (not only after the file) so the failing test is the one that
 * attempted the call.
 */
afterEach(() => {
  if (httpAttempts.length === 0) return;
  const list = httpAttempts.map((attempt) => `${attempt.method} ${attempt.url}`).join("; ");
  httpAttempts.length = 0;
  throw new Error(`ARENA_TEST_REAL_HTTP_FORBIDDEN: ${list}`);
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

// ─── 1. Database binding ──

const guardRequested = process.env.ARENA_TEST_GUARD === "1";

if (guardRequested) {
  const expectedUrl = process.env.ARENA_TEST_PG_URL;
  const expectedPort = process.env.ARENA_TEST_PG_PORT;
  const actualUrl = process.env.DATABASE_URL;

  if (!expectedUrl || !expectedPort) {
    throw new Error(
      "ARENA_TEST_DB_GUARD_MISCONFIGURED: ARENA_TEST_PG_URL/ARENA_TEST_PG_PORT were not exported by the runner"
    );
  }
  if (actualUrl !== expectedUrl) {
    throw new Error(
      "ARENA_TEST_DB_GUARD_FAILED: DATABASE_URL does not match the disposable PostgreSQL URL provided by the runner"
    );
  }

  const { Pool } = require_("pg") as typeof import("pg");
  const pool = new Pool({ connectionString: actualUrl, max: 1 });
  const verification = pool
    .query<{ db: string; port: number; host: string }>(
      "select current_database() as db, inet_server_port() as port, inet_server_addr()::text as host"
    )
    .then((result) => {
      const row = result.rows[0];
      if (!row) throw new Error("ARENA_TEST_DB_GUARD_FAILED: no connection metadata returned");
      if (String(row.port) !== String(expectedPort)) {
        throw new Error(
          `ARENA_TEST_DB_GUARD_FAILED: connected to port ${row.port}, expected the disposable server on ${expectedPort}`
        );
      }
      const host = row.host.split("/")[0];
      if (!["127.0.0.1", "::1", "localhost"].includes(host)) {
        throw new Error(`ARENA_TEST_DB_GUARD_FAILED: unexpected database host ${row.host}`);
      }
      return row;
    })
    .finally(() => pool.end().catch(() => undefined));

  // Awaited by the first test file's collection through the global registry.
  afterAll(async () => {
    await verification;
  });
  void verification;
}
