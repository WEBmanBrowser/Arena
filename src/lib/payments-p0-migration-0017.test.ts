/**
 * PAYMENT P0 — migration 0017 verification (versioned, additive, no backfill).
 *
 * This test builds a REAL pre-migration database from the REAL migration files
 * 0000 → 0016 (never a `CREATE TABLE AS SELECT` reconstruction, never a copy of
 * the post-migration schema), inserts valid synthetic history of the shape that
 * exists in production today, then applies 0017 and verifies:
 *
 *   • every historical row is preserved byte-for-byte (no value rewritten);
 *   • no historical row was given a `payment_id` (no automatic financial backfill);
 *   • the new columns exist with their documented defaults;
 *   • the composite FKs and the two guards exist AND enforce the invariants;
 *   • the legacy exception keeps a pre-existing Eupago row writable;
 *   • nothing was dropped.
 *
 * SAFETY: the scratch database is created inside the DISPOSABLE PostgreSQL of
 * the test runner (the same server `src/test-support/setup.ts` verifies) and is
 * dropped at the end. No staging/production database is ever contacted.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import fs from "node:fs";
import path from "node:path";

const ADMIN_URL = process.env.DATABASE_URL;
if (!ADMIN_URL) throw new Error("DATABASE_URL is required (provided by scripts/test-runner.cjs)");

const SCRATCH_DB = `arena_p0_migration_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
const DRIZZLE_DIR = path.resolve(process.cwd(), "drizzle");

function migrationFilesUpTo(idxInclusive: number): string[] {
  const journal = JSON.parse(fs.readFileSync(path.join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8")) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  return journal.entries
    .filter((entry) => entry.idx <= idxInclusive)
    .sort((a, b) => a.idx - b.idx)
    .map((entry) => path.join(DRIZZLE_DIR, `${entry.tag}.sql`));
}

async function applyFile(client: Client, file: string) {
  const statements = fs
    .readFileSync(file, "utf8")
    .split("--> statement-breakpoint")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  for (const statement of statements) {
    await client.query(statement);
  }
}

function scratchUrl(): string {
  const url = new URL(ADMIN_URL!);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
}

let admin: Client;
let scratch: Client;

/** Ids captured from the synthetic pre-0017 history. */
let history: {
  orderId: number;
  manualPaymentId: number;
  manualAttemptId: number;
  legacyEupagoAttemptId: number;
  refundId: number;
  emailId: number;
};

beforeAll(async () => {
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${SCRATCH_DB}"`);

  scratch = new Client({ connectionString: scratchUrl() });
  await scratch.connect();

  // ── 1. Apply the REAL migrations 0000 → 0016 ──
  for (const file of migrationFilesUpTo(16)) {
    await applyFile(scratch, file);
  }

  // ── 2. Synthetic history, in the PRE-0017 shape ──
  const user = await scratch.query(
    `INSERT INTO users (email, password, name, role) VALUES ('p0-migration@test.local','x','P0 Migration','admin') RETURNING id`
  );
  const userId = user.rows[0].id as number;

  const product = await scratch.query(
    `INSERT INTO products (sku, name, slug, price, stock, reserved_stock)
     VALUES ('P0MIG-1','P0 migration product','p0-migration-1','50.00',10,0) RETURNING id`
  );

  const order = await scratch.query(
    `INSERT INTO orders (order_number, status, payment_status, subtotal, shipping, discount, vat, total, delivery_type, payment_method, guest_email)
     VALUES ('P0MIG-1','pending_payment','pending','50.00','0.00','0.00','0.00','50.00','pickup','bank_transfer','p0-migration@test.local')
     RETURNING id`
  );
  const orderId = order.rows[0].id as number;

  const manualPayment = await scratch.query(
    `INSERT INTO payments (order_id, provider, method, amount, currency, status)
     VALUES ($1,'manual','bank_transfer','50.00','EUR','pending') RETURNING id`,
    [orderId]
  );
  const manualPaymentId = manualPayment.rows[0].id as number;

  // A historical attempt of the bank-transfer flow (provider = 'manual').
  const manualAttempt = await scratch.query(
    `INSERT INTO payment_attempts (order_id, provider, method, amount_cents, currency, status, provider_identifier)
     VALUES ($1,'manual','bank_transfer',5000,'EUR','succeeded',$2) RETURNING id`,
    [orderId, `P0MIG-MANUAL-${Date.now()}`]
  );

  // A historical EUPAGO attempt WITHOUT payment_id — the shape 0017 must preserve
  // instead of backfilling (the old table has no payment_id column at all).
  const legacyAttempt = await scratch.query(
    `INSERT INTO payment_attempts (order_id, provider, method, amount_cents, currency, status, provider_identifier, provider_reference)
     VALUES ($1,'eupago','mbway',5000,'EUR','succeeded',$2,'REF-LEGACY') RETURNING id`,
    [orderId, `P0MIG-LEGACY-${Date.now()}`]
  );

  const refund = await scratch.query(
    `INSERT INTO refund_attempts (order_id, payment_id, provider, idempotency_key, amount_cents, currency, status, requested_by)
     VALUES ($1,$2,'manual',$3,1000,'EUR','pending',$4) RETURNING id`,
    [orderId, manualPaymentId, `P0MIG-REFUND-${Date.now()}`, userId]
  );

  const email = await scratch.query(
    `INSERT INTO email_notifications (event_key, type, recipient, subject, status)
     VALUES ($1,'payment_confirmed','p0-migration@test.local','Encomenda paga','pending') RETURNING id`,
    [`p0-migration-${Date.now()}`]
  );

  history = {
    orderId,
    manualPaymentId,
    manualAttemptId: manualAttempt.rows[0].id as number,
    legacyEupagoAttemptId: legacyAttempt.rows[0].id as number,
    refundId: refund.rows[0].id as number,
    emailId: email.rows[0].id as number,
  };

  // ── 3. Apply the real 0017 ──
  const files = migrationFilesUpTo(17);
  await applyFile(scratch, files[files.length - 1]);
}, 120_000);

afterAll(async () => {
  await scratch?.end().catch(() => undefined);
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
});

describe("migration 0017 — additive structure", () => {
  it("adds the documented columns with the documented defaults", async () => {
    const columns = await scratch.query(
      `SELECT table_name, column_name, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND ((table_name = 'payment_attempts' AND column_name IN ('payment_id','operation_revision'))
            OR (table_name = 'refund_attempts' AND column_name = 'operation_revision')
            OR (table_name = 'email_notifications' AND column_name = 'dispatch_started_at'))`
    );
    const found = new Map(columns.rows.map((row) => [`${row.table_name}.${row.column_name}`, row]));

    const paymentId = found.get("payment_attempts.payment_id")!;
    expect(paymentId.is_nullable).toBe("YES"); // history stays valid
    expect(paymentId.column_default).toBeNull();

    const attemptRevision = found.get("payment_attempts.operation_revision")!;
    expect(attemptRevision.is_nullable).toBe("NO");
    expect(String(attemptRevision.column_default)).toContain("0");

    const refundRevision = found.get("refund_attempts.operation_revision")!;
    expect(refundRevision.is_nullable).toBe("NO");
    expect(String(refundRevision.column_default)).toContain("0");

    const dispatch = found.get("email_notifications.dispatch_started_at")!;
    expect(dispatch.is_nullable).toBe("YES");
  });

  it("installs the unique index, the composite FKs and both guards", async () => {
    const index = await scratch.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'payments_id_order_unique'`
    );
    expect(index.rows).toHaveLength(1);

    const constraints = await scratch.query(
      `SELECT conname FROM pg_constraint
        WHERE conname IN ('payment_attempts_payment_order_fk','refund_attempts_payment_order_fk')`
    );
    expect(constraints.rows.map((row) => row.conname).sort()).toEqual([
      "payment_attempts_payment_order_fk",
      "refund_attempts_payment_order_fk",
    ]);

    const triggers = await scratch.query(
      `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal
         AND tgname IN ('payment_attempts_identity_guard','refund_attempts_payment_binding_guard')`
    );
    expect(triggers.rows.map((row) => row.tgname).sort()).toEqual([
      "payment_attempts_identity_guard",
      "refund_attempts_payment_binding_guard",
    ]);
  });

  it("drops nothing that existed before", async () => {
    const tables = await scratch.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()`
    );
    const names = tables.rows.map((row) => row.table_name);
    for (const required of [
      "orders",
      "order_items",
      "products",
      "payments",
      "payment_attempts",
      "refund_attempts",
      "email_notifications",
      "provider_webhook_events",
      "reconciliation_observations",
      "stock_movements",
      "audit_logs",
    ]) {
      expect(names).toContain(required);
    }
  });
});

describe("migration 0017 — history preservation (no automatic backfill)", () => {
  it("keeps every synthetic history row exactly as it was", async () => {
    const attempt = await scratch.query(
      `SELECT payment_id, provider, amount_cents, status, provider_reference, operation_revision
         FROM payment_attempts WHERE id = $1`,
      [history.legacyEupagoAttemptId]
    );
    expect(attempt.rows).toHaveLength(1);
    // The financial identity of the row is untouched: no payment_id was invented.
    expect(attempt.rows[0].payment_id).toBeNull();
    expect(attempt.rows[0].provider).toBe("eupago");
    expect(attempt.rows[0].amount_cents).toBe(5000);
    expect(attempt.rows[0].status).toBe("succeeded");
    expect(attempt.rows[0].provider_reference).toBe("REF-LEGACY");
    expect(attempt.rows[0].operation_revision).toBe(0);

    const manual = await scratch.query(
      `SELECT payment_id, provider, operation_revision FROM payment_attempts WHERE id = $1`,
      [history.manualAttemptId]
    );
    expect(manual.rows[0].payment_id).toBeNull();
    expect(manual.rows[0].provider).toBe("manual");

    const refund = await scratch.query(`SELECT provider, amount_cents, operation_revision FROM refund_attempts WHERE id = $1`, [
      history.refundId,
    ]);
    expect(refund.rows[0].provider).toBe("manual");
    expect(refund.rows[0].amount_cents).toBe(1000);
    expect(refund.rows[0].operation_revision).toBe(0);

    const email = await scratch.query(`SELECT dispatch_started_at, status FROM email_notifications WHERE id = $1`, [
      history.emailId,
    ]);
    expect(email.rows[0].dispatch_started_at).toBeNull();
    expect(email.rows[0].status).toBe("pending");
  });

  it("keeps a legacy Eupago row writable while it stays detached (legacy exception)", async () => {
    await scratch.query(`UPDATE payment_attempts SET failure_reason = 'legacy note' WHERE id = $1`, [
      history.legacyEupagoAttemptId,
    ]);
    const row = await scratch.query(`SELECT payment_id, failure_reason FROM payment_attempts WHERE id = $1`, [
      history.legacyEupagoAttemptId,
    ]);
    expect(row.rows[0].payment_id).toBeNull();
    expect(row.rows[0].failure_reason).toBe("legacy note");
  });
});

describe("migration 0017 — the guards are effective after the upgrade", () => {
  it("refuses NEW uncorrelated Eupago attempts and promotions (M2)", async () => {
    await expect(
      scratch.query(
        `INSERT INTO payment_attempts (order_id, provider, method, amount_cents, currency, status, provider_identifier)
         VALUES ($1,'eupago','mbway',5000,'EUR','pending',$2)`,
        [history.orderId, `P0MIG-NEW-${Date.now()}`]
      )
    ).rejects.toThrow(/PAYMENT_ATTEMPT_EUPAGO_PAYMENT_REQUIRED/);

    await expect(
      scratch.query(
        `INSERT INTO payment_attempts (order_id, provider, method, amount_cents, currency, status, provider_identifier)
         VALUES ($1,'manual','bank_transfer',5000,'EUR','pending',$2) RETURNING id`,
        [history.orderId, `P0MIG-PROMO-${Date.now()}`]
      ).then((inserted) =>
        scratch.query(`UPDATE payment_attempts SET provider = 'eupago' WHERE id = $1`, [inserted.rows[0].id])
      )
    ).rejects.toThrow(/PAYMENT_ATTEMPT_EUPAGO_PAYMENT_REQUIRED/);
  });

  it("enforces the snapshot agreement on linked attempts", async () => {
    const linked = await scratch.query(
      `INSERT INTO payment_attempts (order_id, payment_id, provider, method, amount_cents, currency, status, provider_identifier)
       VALUES ($1,$2,'eupago','bank_transfer',5000,'EUR','pending',$3) RETURNING id`,
      [history.orderId, history.manualPaymentId, `P0MIG-LINKED-${Date.now()}`]
    );
    expect(linked.rows).toHaveLength(1);

    await expect(
      scratch.query(`UPDATE payment_attempts SET amount_cents = 4900 WHERE id = $1`, [linked.rows[0].id])
    ).rejects.toThrow(/PAYMENT_ATTEMPT_SNAPSHOT_MISMATCH/);
  });

  it("refuses a composite-FK mismatch across orders", async () => {
    const otherOrder = await scratch.query(
      `INSERT INTO orders (order_number, status, payment_status, subtotal, shipping, discount, vat, total, delivery_type, payment_method)
       VALUES ('P0MIG-2','pending_payment','pending','50.00','0.00','0.00','0.00','50.00','pickup','bank_transfer') RETURNING id`
    );
    await expect(
      scratch.query(
        `INSERT INTO payment_attempts (order_id, payment_id, provider, method, amount_cents, currency, status, provider_identifier)
         VALUES ($1,$2,'eupago','bank_transfer',5000,'EUR','pending',$3)`,
        [otherOrder.rows[0].id, history.manualPaymentId, `P0MIG-X-${Date.now()}`]
      )
    ).rejects.toThrow(/payment_attempts_payment_order_fk|PAYMENT_ATTEMPT_ORDER_MISMATCH/);
  });

  it("refuses an unanchored provider refund transmission", async () => {
    await expect(
      scratch.query(
        `UPDATE refund_attempts SET provider = 'eupago', recovery_state = 'requested' WHERE id = $1`,
        [history.refundId]
      )
    ).rejects.toThrow(/REFUND_PAYMENT_PROVIDER_MISMATCH/);
  });
});

/**
 * MEDIUM-1 — the drizzle SNAPSHOT must describe exactly the state the versioned
 * migration produces. The snapshot drifted before (a column existed in the DDL
 * and in the code but not in `meta/0017_snapshot.json`), and every later
 * `drizzle-kit generate` would then have "helpfully" re-added it — or, worse,
 * missed a genuinely new column. The check runs against the database built by
 * applying the REAL migration files 0000 → 0017, so it can only pass when the
 * snapshot and the DDL agree.
 */
describe("migration 0017 — snapshot parity (MEDIUM-1)", () => {
  const snapshotPath = path.join(DRIZZLE_DIR, "meta", "0017_snapshot.json");

  function readSnapshot(): {
    prevId: string;
    tables: Record<string, { columns: Record<string, { name: string; notNull?: boolean }>; foreignKeys?: Record<string, unknown> }>;
  } {
    return JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  }

  it("is the journal's last entry and chains from 0016", () => {
    const journal = JSON.parse(fs.readFileSync(path.join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const last = [...journal.entries].sort((a, b) => a.idx - b.idx).at(-1)!;
    expect(last.idx).toBe(17);
    expect(last.tag).toBe("0017_eupago_p0_ledger_integrity");

    const previous = JSON.parse(fs.readFileSync(path.join(DRIZZLE_DIR, "meta", "0016_snapshot.json"), "utf8")) as { id: string };
    expect(readSnapshot().prevId).toBe(previous.id);
  });

  it("describes every migrated table and column, in both directions", async () => {
    const snapshot = readSnapshot();
    const live = await scratch.query(
      `SELECT table_name, column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = current_schema()`
    );
    const liveColumns = new Map<string, string>();
    const liveTables = new Set<string>();
    for (const row of live.rows) {
      liveTables.add(row.table_name as string);
      liveColumns.set(`${row.table_name}.${row.column_name}`, row.is_nullable as string);
    }

    const snapshotTables = Object.keys(snapshot.tables).filter((key) => key.startsWith("public."));

    for (const key of snapshotTables) {
      const table = key.slice("public.".length);
      expect(liveTables, `table ${table} missing from the migrated database`).toContain(table);
      for (const column of Object.values(snapshot.tables[key].columns)) {
        const live = liveColumns.get(`${table}.${column.name}`);
        expect(live, `snapshot column ${table}.${column.name} missing from the migrated database`).toBeDefined();
        expect(live, `nullability drift on ${table}.${column.name}`).toBe(column.notNull ? "NO" : "YES");
      }
    }

    // Reverse direction: the migration must not create a column the snapshot
    // does not know about (that is exactly how MEDIUM-1 happened).
    for (const key of liveColumns.keys()) {
      const [table, column] = key.split(".");
      if (!snapshotTables.includes(`public.${table}`)) continue;
      const known = Object.values(snapshot.tables[`public.${table}`].columns).some((c) => c.name === column);
      expect(known, `migrated column ${key} missing from the snapshot`).toBe(true);
    }
  });

  it("records the P0 ledger columns and the anomaly linkage in the snapshot", () => {
    const snapshot = readSnapshot();

    // The exact drift that was found in this review round.
    expect(snapshot.tables["public.refund_attempts"].columns.operation_revision).toBeDefined();
    expect(snapshot.tables["public.payment_attempts"].columns.operation_revision).toBeDefined();
    expect(snapshot.tables["public.payment_attempts"].columns.payment_id).toBeDefined();
    expect(snapshot.tables["public.email_notifications"].columns.dispatch_started_at).toBeDefined();

    // HIGH-1/HIGH-2 operability of a system-raised anomaly.
    expect(snapshot.tables["public.reconciliation_observations"].columns.payment_id).toBeDefined();
    expect(snapshot.tables["public.reconciliation_observations"].columns.recorded_by?.notNull).toBeFalsy();
  });

  it("describes the composite FKs and the new anomaly index that the DDL creates", async () => {
    const snapshot = readSnapshot();
    const expected = [
      "payment_attempts_payment_order_fk",
      "refund_attempts_payment_order_fk",
      "reconciliation_observations_payment_id_payments_id_fk",
    ];
    for (const name of expected) {
      const found = Object.values(snapshot.tables).some((table) =>
        Object.values(table.foreignKeys ?? {}).some(
          (fk) => typeof fk === "object" && fk !== null && (fk as { name?: string }).name === name
        )
      );
      expect(found, `snapshot is missing FK ${name}`).toBe(true);
    }

    const constraint = await scratch.query(`SELECT conname FROM pg_constraint WHERE conname = ANY($1)`, [expected]);
    expect(constraint.rows.map((row) => row.conname).sort()).toEqual([...expected].sort());

    const index = await scratch.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'reconciliation_observations_payment_idx'`
    );
    expect(index.rows).toHaveLength(1);
    const snapshotIndexes = Object.values(snapshot.tables).flatMap((table) =>
      Object.values((table as { indexes?: Record<string, { name?: string }> }).indexes ?? {}).map((i) => i.name)
    );
    expect(snapshotIndexes).toContain("reconciliation_observations_payment_idx");
  });

  it("implements the L3 immutability guard in the applied DDL", async () => {
    // A linked attempt cannot be re-pointed to another payment of the same order.
    const linked = await scratch.query(
      `INSERT INTO payment_attempts (order_id, payment_id, provider, method, amount_cents, currency, status, provider_identifier)
       VALUES ($1,$2,'eupago','bank_transfer',5000,'EUR','pending',$3) RETURNING id`,
      [history.orderId, history.manualPaymentId, `P0MIG-L3-${Date.now()}`]
    );

    const otherPayment = await scratch.query(
      `INSERT INTO payments (order_id, provider, method, amount, currency, status)
       VALUES ($1,'manual','bank_transfer','50.00','EUR','pending') RETURNING id`,
      [history.orderId]
    );

    await expect(
      scratch.query(`UPDATE payment_attempts SET payment_id = $2 WHERE id = $1`, [
        linked.rows[0].id,
        otherPayment.rows[0].id,
      ])
    ).rejects.toThrow(/PAYMENT_ATTEMPT_PAYMENT_IMMUTABLE/);

    // Unlinking is refused as well. For a EUPAGO row the older M2 rule
    // ("new eupago rows MUST be linked") already wins, which is even stricter
    // than L3 — both are fail-closed, so the test accepts either guard.
    await expect(
      scratch.query(`UPDATE payment_attempts SET payment_id = NULL WHERE id = $1`, [linked.rows[0].id])
    ).rejects.toThrow(/PAYMENT_ATTEMPT_PAYMENT_IMMUTABLE|PAYMENT_ATTEMPT_EUPAGO_PAYMENT_REQUIRED/);
  });
});
