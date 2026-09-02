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
const net = require('net');
const { spawnSync, spawn } = require('child_process');
const EmbeddedPostgres = require('embedded-postgres').default;

function log(...args) {
  console.error('[test-runner]', ...args);
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const tester = net
      .createServer()
      .once('error', () => resolve(false))
      .once('listening', () => tester.close(() => resolve(true)))
      .listen(port, '127.0.0.1');
  });
}

async function pickPort(preferred) {
  // Try the preferred port first, then scan forward to find the first
  // free one. Previous implementation always returned 54320 and would
  // EADDRINUSE on parallel CI runs.
  const base = Number.isFinite(preferred) ? preferred : 54320;
  if (await isPortFree(base)) return base;
  for (let i = 1; i < 50; i += 1) {
    const candidate = base + i;
    if (await isPortFree(candidate)) return candidate;
  }
  throw new Error(`No free TCP port found near ${base}`);
}

async function main() {
  const port = await pickPort(Number(process.env.PG_PORT));
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

  // Always remove the data dir on exit, even on early failure.
  const cleanupDataDir = () => {
    try {
      fs.rmSync(databaseDir, { recursive: true, force: true });
    } catch {}
  };

  let pgStarted = false;
  try {
    await pg.initialise();
    await pg.start();
    pgStarted = true;
    await pg.createDatabase('app_db');
  } catch (e) {
    log('failed to start embedded postgres:', e.message);
    if (pgStarted) await pg.stop().catch(() => {});
    cleanupDataDir();
    process.exit(1);
  }

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
    cleanupDataDir();
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

  let cleaningUp = false;
  const cleanup = async (code, signal) => {
    if (cleaningUp) {
      // Re-entrant calls (e.g. SIGINT then child exit) are ignored.
      return;
    }
    cleaningUp = true;
    log('shutting down postgres (signal=' + (signal || 'none') + ')...');
    // Forward the signal to the child first so it releases its
    // connections to PG before we attempt to stop PG.
    if (signal && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill(signal);
      } catch {}
      // Give the child a moment to release connections.
      await new Promise((r) => setTimeout(r, 250));
    }
    try {
      await pg.stop();
    } catch (e) {
      log('stop error:', e.message);
    }
    cleanupDataDir();
    // Conventional exit code: 128 + signal number for signal exits.
    if (signal === 'SIGINT') process.exit(130);
    if (signal === 'SIGTERM') process.exit(143);
    process.exit(code);
  };

  child.on('exit', (code, signal) => {
    if (signal) {
      cleanup(1, signal);
    } else {
      cleanup(code === null ? 1 : code, null);
    }
  });
  process.on('SIGINT', () => cleanup(130, 'SIGINT'));
  process.on('SIGTERM', () => cleanup(143, 'SIGTERM'));
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
