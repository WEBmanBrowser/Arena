import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

/**
 * Database connection layer compatible with both:
 * - Local development (using DATABASE_URL from .env)
 * - Cloudflare Workers (using Hyperdrive binding via @opennextjs/cloudflare)
 *
 * In Cloudflare Workers, connections cannot persist across requests.
 * The `db` export uses a Proxy to lazily create connections on access.
 */

function resolveConnectionString(): string {
  // 1. Try Cloudflare Hyperdrive binding (production on Cloudflare Workers)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getCloudflareContext } = require("@opennextjs/cloudflare") as {
      getCloudflareContext: () => { env: Record<string, unknown> };
    };
    const ctx = getCloudflareContext();
    const hd = ctx?.env?.HYPERDRIVE as { connectionString?: string } | undefined;
    if (hd?.connectionString) {
      return hd.connectionString;
    }
  } catch {
    // Not running in Cloudflare context — fall through
  }

  // 2. Fall back to DATABASE_URL (local dev / standard Node.js)
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  throw new Error(
    "DATABASE_URL is required. Set it in .env for local dev or configure Hyperdrive for Cloudflare Workers."
  );
}

// ── Global singleton for local development ───────────────
const globalForDb = globalThis as typeof globalThis & {
  __mdtechDbPool?: Pool;
  __mdtechDb?: NodePgDatabase;
};

function getDbInstance(): NodePgDatabase {
  // In local/standard Node.js development, reuse a global singleton
  if (process.env.DATABASE_URL) {
    if (!globalForDb.__mdtechDb) {
      const connectionString = resolveConnectionString();
      globalForDb.__mdtechDbPool = new Pool({ connectionString });
      globalForDb.__mdtechDb = drizzle(globalForDb.__mdtechDbPool);
    }
    return globalForDb.__mdtechDb;
  }

  // In Cloudflare Workers: create a fresh pool per access (request-scoped)
  const connectionString = resolveConnectionString();
  const requestPool = new Pool({ connectionString, max: 1 });
  return drizzle(requestPool);
}

/**
 * Backward-compatible database client.
 * Usage: `import { db } from "@/db"`
 *
 * Uses a Proxy to lazily initialize the connection on first property access.
 * This is critical for Cloudflare Workers where module-level I/O is not allowed.
 */
export const db: NodePgDatabase = new Proxy({} as NodePgDatabase, {
  get(_target, prop, receiver) {
    const instance = getDbInstance();
    const value = Reflect.get(instance, prop, receiver);
    if (typeof value === "function") {
      return value.bind(instance);
    }
    return value;
  },
});

/**
 * Pool export for backward compatibility (used by health check).
 */
export const pool = new Proxy({} as Pool, {
  get(_target, prop, receiver) {
    // Ensure global pool exists
    getDbInstance();
    if (globalForDb.__mdtechDbPool) {
      const value = Reflect.get(globalForDb.__mdtechDbPool, prop, receiver);
      if (typeof value === "function") {
        return value.bind(globalForDb.__mdtechDbPool);
      }
      return value;
    }
    // Fallback: create new pool
    const connectionString = resolveConnectionString();
    const p = new Pool({ connectionString });
    const value = Reflect.get(p, prop, receiver);
    if (typeof value === "function") {
      return value.bind(p);
    }
    return value;
  },
});
