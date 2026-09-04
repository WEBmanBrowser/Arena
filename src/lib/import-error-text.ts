/**
 * Human-readable text from unknown error payloads, shared by the legacy
 * importer page and the C.3.1 supplier panel.
 *
 * Both admin screens used to render errors by coercing the payload directly —
 * `errors.join(", ")` on an array of objects, template interpolation of a
 * whole object — which produced the dreaded "[object Object]" instead of the
 * actual code/field/message. These formatters are the single replacement:
 *
 *  - structured errors keep code, field, message and line when present;
 *  - an `Error` keeps its message and never its stack;
 *  - stack / query / params are never rendered, wherever they sit;
 *  - unknown objects fall back to a short, safe representation that is never
 *    the string "[object Object]";
 *  - overly long text is capped;
 *  - repeated messages collapse in a list.
 */

const IGNORED_KEYS = new Set(["stack", "query", "params"]);
const MAX_PART_LENGTH = 200;
const MAX_JOINED_LENGTH = 800;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

/**
 * JSON of an unknown record with the internal-only keys removed. Returns null
 * when nothing renderable is left or the object cannot be serialized.
 */
function conciseJson(value: Record<string, unknown>): string | null {
  const cleaned: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (IGNORED_KEYS.has(key)) continue;
    if (v === undefined || v === null || typeof v === "function" || typeof v === "symbol") continue;
    cleaned[key] = v;
  }
  if (Object.keys(cleaned).length === 0) return null;
  try {
    const text = JSON.stringify(cleaned);
    return text && text !== "{}" ? text : null;
  } catch {
    return null;
  }
}

/**
 * One error → one line of text. Accepts the shapes both importers produce:
 * strings, numbers, `Error`, arrays, and objects
 * ({code, field, message, row|line}, plus anything the server added).
 */
export function formatImportError(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return truncate(value, MAX_PART_LENGTH);
  if (typeof value === "number") return truncate(String(value), MAX_PART_LENGTH);
  if (typeof value === "bigint" || typeof value === "boolean") return truncate(value.toString(), MAX_PART_LENGTH);
  if (value instanceof Error) {
    // message only — never the stack (and any query/params hung off the error).
    const message = value.message && value.message.trim() ? value.message.trim() : value.name;
    return truncate(message, MAX_PART_LENGTH);
  }
  if (Array.isArray(value)) return formatImportErrors(value);
  if (!isRecord(value)) return "Erro desconhecido";

  const code = typeof value.code === "string" && value.code.trim() ? value.code.trim() : undefined;
  const message = typeof value.message === "string" && value.message.trim() ? value.message.trim() : undefined;
  const field = typeof value.field === "string" && value.field.trim() ? value.field.trim() : undefined;
  const row = typeof value.row === "number" ? value.row : typeof value.line === "number" ? value.line : undefined;

  const parts: string[] = [];
  if (row !== undefined) parts.push(`linha ${row}`);
  if (field) parts.push(`campo ${field}`);
  if (code) parts.push(code);
  // A code whose message is the code itself (Error.name === message) is a
  // duplicate — say it once.
  if (message && message !== code) parts.push(message);
  if (parts.length > 0) return truncate(parts.join(" · "), MAX_JOINED_LENGTH);

  const fallback = conciseJson(value);
  return fallback ? truncate(fallback, MAX_JOINED_LENGTH) : "Erro desconhecido";
}

/**
 * A list of errors (or a single error) → one deduplicated text block.
 * `value` may be the API's `results[].errors` array, an object wrapping an
 * `errors` array, an issue list, or a single error of any supported shape.
 */
export function formatImportErrors(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (
    typeof value === "string" || typeof value === "number" ||
    typeof value === "bigint" || typeof value === "boolean" || value instanceof Error
  ) {
    return formatImportError(value);
  }
  const items = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.errors)
      ? value.errors
      : [value];

  // Repeated messages collapse: entries that differ only by their "linha N"
  // prefix are merged, keeping every line number ("linhas 2, 4 · …"). Entries
  // without a line number are deduplicated by their full text.
  const merged: { lines: number[]; rest: string }[] = [];
  const byRest = new Map<string, number>();
  for (const item of items) {
    const full = formatImportError(item).trim();
    if (!full) continue;
    const prefix = full.match(/^linha (\d+)((?:, \d+)*) · /);
    let line: number | null = null;
    let rest = full;
    if (prefix) {
      line = Number(prefix[1]);
      rest = full.slice(prefix[0].length);
    }
    if (!rest) continue;
    const key = rest.toLowerCase();
    const existing = byRest.get(key);
    if (existing !== undefined) {
      if (line !== null && !merged[existing].lines.includes(line)) merged[existing].lines.push(line);
      continue;
    }
    byRest.set(key, merged.length);
    merged.push({ lines: line !== null ? [line] : [], rest });
  }

  const out = merged.map((entry) => {
    if (entry.lines.length === 0) return entry.rest;
    const lines = [...entry.lines].sort((a, b) => a - b);
    const label = lines.length > 1 ? `linhas ${lines.join(", ")}` : `linha ${lines[0]}`;
    return `${label} · ${entry.rest}`;
  });
  return truncate(out.join("; "), MAX_JOINED_LENGTH);
}

/**
 * One change/leaf value → safe display text, for the legacy importer's
 * "Alterações" column. A change pair {from, to} renders as "from → to";
 * anything else is a scalar or a short JSON — never "[object Object]".
 */
export function formatImportValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return truncate(value, MAX_PART_LENGTH);
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return truncate(value.toString(), MAX_PART_LENGTH);
  }
  if (value instanceof Error) return truncate(value.message || value.name, MAX_PART_LENGTH);
  if (value instanceof Date) return truncate(value.toISOString(), MAX_PART_LENGTH);
  if (Array.isArray(value)) return value.length === 0 ? "—" : value.map(formatImportValue).join(", ");
  if (isRecord(value)) {
    if ("from" in value || "to" in value) {
      return [formatImportValue(value.from), formatImportValue(value.to)].join(" → ");
    }
    const fallback = conciseJson(value);
    return fallback ? truncate(fallback, MAX_PART_LENGTH) : "—";
  }
  return "—";
}
