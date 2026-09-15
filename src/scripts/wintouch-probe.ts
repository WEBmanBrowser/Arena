/**
 * C.4 — Wintouch Cloud connectivity probe (READ-ONLY diagnostics).
 *
 *   WINTOUCH_API_BASE_URL=https://<tenant>/api WINTOUCH_API_KEY=<key> npx tsx src/scripts/wintouch-probe.ts
 *
 * Both variables may instead live in .env (loaded automatically, never
 * printed). No other configuration exists.
 *
 * CLI-only. No HTTP endpoint, no .env writing, no schema change, no writes
 * of any kind against the Wintouch API (GET requests exclusively).
 *
 * Exit codes:
 *   0 — every check returned 2xx with a parseable body.
 *   1 — usage error or missing/invalid configuration (nothing was requested).
 *   2 — the probe ran but at least one check failed (see the JSON for which).
 *
 * Output policy: stdout is pure JSON (pipeable into jq and tickets); a
 * one-line human summary goes to stderr. The API key is NEVER printed —
 * see the redaction guarantees in ../lib/providers/wintouch/probe.ts.
 */
import "dotenv/config";
import { toCustomerSafeError } from "../lib/providers/errors";
import { probeWintouch } from "../lib/providers/wintouch/probe";

const USAGE = `Usage: WINTOUCH_API_BASE_URL=<url> WINTOUCH_API_KEY=<key> npx tsx src/scripts/wintouch-probe.ts
   or: fill both variables in .env, then  npx tsx src/scripts/wintouch-probe.ts

Runs read-only GET checks (Document_Types, payment_methods, entities,
product_documents) and prints a secret-free JSON diagnostic to stdout.`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  if (argv.length > 0) {
    console.error(`Unexpected argument: ${argv[0]}\n${USAGE}`);
    return 1;
  }

  try {
    const result = await probeWintouch();
    console.log(JSON.stringify(result, null, 2));
    console.error(result.ok ? "wintouch probe: OK" : "wintouch probe: FAILURES (see stdout JSON)");
    return result.ok ? 0 : 2;
  } catch (e) {
    console.log(JSON.stringify({ ok: false, ...toCustomerSafeError(e) }));
    console.error("wintouch probe: ERROR (see stdout JSON)");
    return 1;
  }
}

main().then(
  (code) => {
    process.exit(code);
  },
  (e: unknown) => {
    console.log(JSON.stringify({ ok: false, ...toCustomerSafeError(e) }));
    console.error("wintouch probe: UNEXPECTED ERROR (see stdout JSON)");
    process.exit(1);
  }
);
