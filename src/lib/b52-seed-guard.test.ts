/**
 * B.5.2 — Production seed guard (runtime test, not source inspection).
 *
 * Runs the real seed script in an isolated child process against a FRESH
 * migrated PostgreSQL database (created and dropped by this test, so the
 * shared test database is never polluted with demo data) and proves that:
 *  - NODE_ENV=production exits non-zero and mutates nothing
 *  - non-production seeding still works
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { Client } from "pg";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { assertSeedAllowed } from "@/db/seed";

const root = path.resolve(__dirname, "..", "..");
const SEED = path.join("src", "db", "seed.ts");
const DB_NAME = `b52_seed_guard_${Date.now()}`;

const baseUrl = process.env.DATABASE_URL ?? "";
const freshUrl = baseUrl.replace(/\/[^/?]+(\?|$)/, `/${DB_NAME}$1`);

/** Demo-data tables the seed writes into. */
const TABLES = ["users", "brands", "categories", "products", "pages", "banners"];

async function countsOn(url: string) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const out: Record<string, number> = {};
    for (const t of TABLES) {
      const res = await client.query(`SELECT count(*)::int AS c FROM ${t}`);
      out[t] = res.rows[0].c as number;
    }
    return out;
  } finally {
    await client.end();
  }
}

function runSeed(nodeEnv: string) {
  return spawnSync("npx", ["tsx", SEED], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: nodeEnv as NodeJS.ProcessEnv["NODE_ENV"], DATABASE_URL: freshUrl },
    timeout: 180_000,
  });
}

beforeAll(async () => {
  await db.execute(sql.raw(`CREATE DATABASE ${DB_NAME}`));
  const migrate = spawnSync("npx", ["drizzle-kit", "migrate", "--config=drizzle.config.ts"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: freshUrl },
    timeout: 180_000,
  });
  if (migrate.status !== 0) {
    throw new Error(`migration of fresh DB failed: ${migrate.stdout}\n${migrate.stderr}`);
  }
}, 240_000);

afterAll(async () => {
  await db.execute(sql.raw(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`));
});

describe("B.5.2 — seed guard unit behaviour", () => {
  it("throws for production", () => {
    expect(() => assertSeedAllowed("production")).toThrowError(/Refusing to seed/);
  });

  it("permits development and test", () => {
    expect(() => assertSeedAllowed("development")).not.toThrow();
    expect(() => assertSeedAllowed("test")).not.toThrow();
    expect(() => assertSeedAllowed(undefined)).not.toThrow();
  });
});

describe("B.5.2 — seed runtime behaviour (fresh migrated PostgreSQL, isolated process)", () => {
  it("refuses with a non-zero exit under NODE_ENV=production and creates zero rows", async () => {
    const before = await countsOn(freshUrl);
    expect(before.users).toBe(0);
    expect(before.products).toBe(0);

    const result = runSeed("production");
    expect(result.status, `stdout=${result.stdout}\nstderr=${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/Refusing to seed/);

    const after = await countsOn(freshUrl);
    expect(after).toEqual(before);
    expect(after.users).toBe(0);
    expect(after.products).toBe(0);
  }, 240_000);

  it("still operates under a non-production NODE_ENV (regression)", async () => {
    const result = runSeed("development");
    expect(result.status, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/Seed completed/);

    const after = await countsOn(freshUrl);
    expect(after.users).toBeGreaterThan(0);
    expect(after.brands).toBeGreaterThan(0);
    expect(after.products).toBeGreaterThan(0);
  }, 240_000);
});
