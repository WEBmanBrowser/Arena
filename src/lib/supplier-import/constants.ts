/**
 * C.3.1 — Single source of truth for the supplier import tuning knobs.
 *
 * Everything that more than one module needs (route, service, recovery rules,
 * tests) is declared here exactly once, so a threshold can never disagree
 * between the code that writes a heartbeat and the code that decides whether it
 * is stale.
 */

/**
 * How long a claimed `applying` import may go without a heartbeat before
 * another request may reclaim it.
 *
 * Staleness is ALWAYS decided server-side from `supplier_imports.heartbeat_at`
 * — never from `started_at` (a long first batch says nothing about a dead
 * worker) and never in the browser.
 */
export const IMPORT_HEARTBEAT_TTL_MS = 5 * 60 * 1000;

/** Rows applied per committed transaction. ~500 keeps locks short. */
export const SUPPLIER_IMPORT_BATCH_SIZE = 500;

/** Hard row ceiling, inherited from the CSV parser limit (20 000 lines — stock ALSO has ~15 255). */
export const SUPPLIER_IMPORT_MAX_ROWS = 20000;

/**
 * How many lines the preview payload returns to the browser. The full snapshot
 * is persisted in `supplier_import_rows`; apply reads the persisted snapshot,
 * so truncating the response never truncates the work.
 */
export const SUPPLIER_IMPORT_PREVIEW_LIMIT = 200;

/**
 * Lifetime of the signed apply token. Longer than the 15 min of the bulk price
 * token on purpose: the snapshot it confirms is persisted server-side and
 * immutable, and an operator must be able to resume a partial import hours
 * later without re-uploading the file.
 */
export const SUPPLIER_IMPORT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/** How many disappeared products are listed in a report (the count is total). */
export const SUPPLIER_IMPORT_MISSING_LIMIT = 500;

/** Chunk size for key lookups, so a 10 000-line file never builds one huge IN(). */
export const SUPPLIER_IMPORT_KEY_CHUNK = 500;

/**
 * C.3.4.2 — Window after which a `running` supplier_source_run may be claimed
 * over (worker crash mid-run). Same 5-minute budget as the import heartbeat: a
 * fetch is capped at 3×10 s + parse of ≤5 MB, so a live run never goes silent
 * for this long; a dead one never strands the source forever. Staleness is
 * decided in Postgres (`started_at`), never in the Worker's memory.
 */
export const SOURCE_RUN_STALE_MS = 5 * 60 * 1000;

/**
 * Prefix of an internal MDTech SKU minted for a product a supplier list introduces.
 *
 * products.sku is MDTech's own global reference; product_suppliers.supplier_sku is
 * the supplier's reference for the same article. A supplier's code therefore never
 * becomes products.sku — doing so let one supplier's file collide with (or silently
 * retarget) another supplier's product.
 */
export const MDTECH_SKU_PREFIX = "MD-";

/** PostgreSQL sequence behind MDTECH_SKU_PREFIX; nextval() is the concurrency guard. */
export const MDTECH_SKU_SEQUENCE = "product_internal_sku_seq";

/** Digits of the zero-padded number: MD-000001 … (longer values are simply wider). */
export const MDTECH_SKU_DIGITS = 6;

/**
 * How many sequence values one row may burn when a value is already taken by
 * hand-written data. Each attempt takes a FRESH nextval, so a collision costs a
 * retry — never a rolled back batch of 500 rows.
 */
export const MDTECH_SKU_ALLOC_ATTEMPTS = 20;

// ─── Snapshot column ceilings ─────────────────────────────
// supplier_import_rows mirrors these types, and a supplier file must NEVER be
// able to fail the whole preview because one line holds a value that the
// snapshot column cannot store. normalize.ts rejects such values per row (the
// row becomes an error, the preview continues) instead of letting the INSERT
// throw. These are the single source of truth for the tests that lock the
// exact limits: values at the ceiling are accepted, one past it are not.

/** Upper bound of a PostgreSQL `integer` (int4): stock and lead time columns. */
export const SNAPSHOT_INT4_MAX = 2147483647;

/**
 * Upper bound of a PostgreSQL `numeric(10,2)` (8 integer + 2 fraction digits):
 * the snapshot cost column.
 */
export const SNAPSHOT_COST_MAX = "99999999.99";
