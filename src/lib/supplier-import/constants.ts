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

/** Hard row ceiling, inherited from the CSV parser limit (10 000 lines). */
export const SUPPLIER_IMPORT_MAX_ROWS = 10000;

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
