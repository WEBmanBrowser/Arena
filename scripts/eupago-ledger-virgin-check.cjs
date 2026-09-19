#!/usr/bin/env node
/**
 * PAYMENT P0 (B1) — READ-ONLY "is the Eupago ledger virgin?" diagnostic.
 *
 * Run this BEFORE installing migration 0017 and BEFORE deploying the new
 * payment code. It answers ONE question with evidence: does this database
 * contain any Eupago financial history or in-flight Eupago operation?
 *
 *   VIRGIN      → 0017 may be installed, then the new code may be deployed
 *                 (Eupago stays without traffic during the cut).
 *   NOT_VIRGIN  → STOP. Do not install 0017. A separate
 *                 compatibility/backfill/cutover plan is required.
 *
 * SAFETY
 *   • The script performs SELECT/COUNT statements ONLY — it is structurally
 *     incapable of writing (every statement goes through `readOnly()`).
 *   • It refuses non-loopback hosts unless `--allow-remote` is passed
 *     explicitly, so it cannot be pointed at production by accident.
 *   • It does NOT install anything, does NOT connect to Eupago, and does NOT
 *     touch secrets.
 *
 * USAGE
 *   DATABASE_URL=postgresql://… node scripts/eupago-ledger-virgin-check.cjs
 *   node scripts/eupago-ledger-virgin-check.cjs --url postgresql://… [--json]
 *
 * EXIT CODES
 *   0 = VIRGIN (safe to proceed), 2 = NOT_VIRGIN (STOP), 3 = error/refused.
 */

const { Client } = require("pg");

function parseArgs(argv) {
  const args = { url: process.env.DATABASE_URL || null, json: false, allowRemote: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--url") args.url = argv[++i];
    else if (arg === "--json") args.json = true;
    else if (arg === "--allow-remote") args.allowRemote = true;
    else if (arg === "--help") {
      console.log("usage: node scripts/eupago-ledger-virgin-check.cjs [--url <postgres url>] [--json] [--allow-remote]");
      process.exit(0);
    }
  }
  return args;
}

/** Structural read-only enforcement: no statement may leave these verbs. */
function readOnly(sqlText) {
  const normalized = sqlText.trim().toLowerCase();
  if (!/^(select|with|show)\b/.test(normalized)) {
    throw new Error(`REFUSED_NON_READ_ONLY_STATEMENT: ${normalized.slice(0, 40)}`);
  }
  if (/\b(insert|update|delete|alter|drop|truncate|create|grant|revoke|copy)\b/.test(normalized)) {
    throw new Error("REFUSED_NON_READ_ONLY_STATEMENT: write verb detected");
  }
  return sqlText;
}

function isLoopback(url) {
  try {
    const host = new URL(url).hostname;
    return host === "127.0.0.1" || host === "::1" || host === "localhost";
  } catch {
    return false;
  }
}

const CHECKS = [
  {
    key: "payment_attempts_eupago",
    label: "payment_attempts rows with provider = 'eupago'",
    sql: `select count(*)::int as count from payment_attempts where provider = 'eupago'`,
  },
  {
    key: "refund_attempts_eupago",
    label: "refund_attempts rows with provider = 'eupago'",
    sql: `select count(*)::int as count from refund_attempts where provider = 'eupago'`,
  },
  {
    key: "provider_webhook_events_eupago",
    label: "provider_webhook_events rows with provider = 'eupago'",
    sql: `select count(*)::int as count from provider_webhook_events where provider = 'eupago'`,
  },
  {
    key: "payments_eupago_context",
    label: "payments rows with a Eupago provider or Eupago environment metadata",
    sql: `select count(*)::int as count from payments
          where provider = 'eupago' or (metadata ->> 'eupagoEnvironment') is not null`,
  },
  {
    key: "in_flight_provider_operations",
    label: "attempts/refunds in an in-flight provider state (any provider)",
    sql: `select (
            (select count(*)::int from payment_attempts where recovery_state in ('requested','reconciliation_required'))
          + (select count(*)::int from refund_attempts where recovery_state in ('requested','reconciliation_required'))
          ) as count`,
  },
];

async function tableExists(client, table) {
  const result = await client.query(
    readOnly(`select 1 as present from information_schema.tables
              where table_schema = current_schema() and table_name = $1 limit 1`),
    [table]
  );
  return result.rows.length > 0;
}

async function columnExists(client, table, column) {
  const result = await client.query(
    readOnly(`select 1 as present from information_schema.columns
              where table_schema = current_schema() and table_name = $1 and column_name = $2 limit 1`),
    [table, column]
  );
  return result.rows.length > 0;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.url) {
    console.error("DATABASE_URL (or --url) is required");
    process.exit(3);
  }
  if (!isLoopback(args.url) && !args.allowRemote) {
    console.error("REFUSED_REMOTE_TARGET: pass --allow-remote to run against a non-loopback database");
    process.exit(3);
  }

  const client = new Client({ connectionString: args.url, application_name: "eupago-ledger-virgin-check" });
  const report = {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    host: (() => {
      try {
        return new URL(args.url).host;
      } catch {
        return "unknown";
      }
    })(),
    migration0017Installed: null,
    checks: {},
    verdict: null,
    reasons: [],
  };

  try {
    await client.connect();

    report.migration0017Installed = await columnExists(client, "payment_attempts", "operation_revision");

    for (const check of CHECKS) {
      if (!(await tableExists(client, check.sql.match(/from\s+([a-z_]+)/)[1]))) {
        report.checks[check.key] = { label: check.label, count: null, skipped: "table missing" };
        continue;
      }
      const result = await client.query(readOnly(check.sql));
      report.checks[check.key] = { label: check.label, count: result.rows[0].count };
    }

    for (const [key, value] of Object.entries(report.checks)) {
      if (value.count && value.count > 0) report.reasons.push(`${key}=${value.count}`);
    }

    if (report.migration0017Installed) {
      report.reasons.push("migration 0017 already installed");
    }

    report.verdict = report.reasons.length === 0 ? "VIRGIN" : "NOT_VIRGIN";
  } catch (error) {
    console.error(`diagnostic failed: ${error.message}`);
    await client.end().catch(() => undefined);
    process.exit(3);
  }

  await client.end();

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log("Eupago ledger virgin check (READ-ONLY)\n");
    console.log(`0017 installed: ${report.migration0017Installed}`);
    for (const [key, value] of Object.entries(report.checks)) {
      console.log(`  ${key}: ${value.count === null ? `skipped (${value.skipped})` : value.count}`);
    }
    console.log(`\nVERDICT: ${report.verdict}`);
    if (report.verdict === "NOT_VIRGIN") {
      console.log("STOP — do not install 0017. A separate compatibility/backfill/cutover plan is required.");
    } else {
      console.log("Safe to install migration 0017 (versioned migration, never db:push), then deploy the new code.");
    }
  }

  process.exit(report.verdict === "VIRGIN" ? 0 : 2);
}

main().catch((error) => {
  console.error(error);
  process.exit(3);
});
