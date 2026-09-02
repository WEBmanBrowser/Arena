#!/usr/bin/env node
// Run vitest against an embedded PostgreSQL 18.4 (real postgres, real migrations).
// 1) Start embedded-postgres
// 2) Run drizzle migrations
// 3) Set DATABASE_URL
// 4) Run vitest with provided args
// 5) Stop postgres

const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawnSync, spawn } = require('child_process');
const EmbeddedPostgres = require('embedded-postgres').default;

function log(...args) {
  console.error('[test-runner]', ...args);
}

function pickPort() {
  const base = 54320;
  for (let i = 0; i < 20; i += 1) return base + i;
  return base;
}

async function main() {
  const port = Number(process.env.PG_PORT || pickPort());
  const databaseDir = path.join(os.tmpdir(), `pg-arena-${process.pid}-${Date.now()}`);
  fs.mkdirSync(databaseDir, { recursive: true });
  log('data dir =', databaseDir, 'port =', port);

  const pg = new EmbeddedPostgres({
    databaseDir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: false,
  });

  await pg.initialise();
  await pg.start();
  await pg.createDatabase('app_db');

  const databaseUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/app_db`;
  log('DATABASE_URL =', databaseUrl);

  // Run migrations
  log('applying migrations...');
  const migrateResult = spawnSync(
    'npx',
    ['drizzle-kit', 'migrate', '--config=drizzle.config.ts'],
    {
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: databaseUrl },
      cwd: process.cwd(),
    }
  );
  if (migrateResult.status !== 0) {
    log('migration failed');
    await pg.stop().catch(() => {});
    process.exit(1);
  }
  log('migrations applied');

  // Now run vitest with the provided args
  const testArgs = process.argv.slice(2);
  log('running vitest with args:', testArgs);

  // Test infrastructure only: export BULK_PREVIEW_SECRET for the test
  // process BEFORE vitest spawns. The runtime production path reads it from
  // a secret manager and is never affected by this fallback.
  if (!process.env.BULK_PREVIEW_SECRET) {
    process.env.BULK_PREVIEW_SECRET = 'test-bulk-preview-secret-' + Date.now() + '-' + Math.random().toString(36).slice(2, 18);
  }
  const env = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    NODE_ENV: 'test',
    BULK_PREVIEW_SECRET: process.env.BULK_PREVIEW_SECRET,
  };
  const child = spawn('npx', ['vitest', 'run', ...testArgs], {
    stdio: 'inherit',
    env,
    cwd: process.cwd(),
  });

  const cleanup = async (code) => {
    log('shutting down postgres...');
    try {
      await pg.stop();
    } catch (e) {
      log('stop error:', e.message);
    }
    try {
      fs.rmSync(databaseDir, { recursive: true, force: true });
    } catch {}
    process.exit(code);
  };

  child.on('exit', (code) => {
    cleanup(code === null ? 1 : code);
  });
  process.on('SIGINT', () => cleanup(130));
  process.on('SIGTERM', () => cleanup(143));
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
