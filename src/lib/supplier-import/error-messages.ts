/**
 * C.3.1 — Shared, safe supplier-import messages (API + UI).
 *
 * One table for every code an API response can carry, so the route that builds
 * a response and the panel that renders it can never drift apart. Rules:
 *
 *  - a message the SERVER sends explicitly (`serverMessage`) always wins — it is
 *    the only place a dynamic, still-safe value (file size, row count…) can
 *    appear;
 *  - storage failures (a PostgreSQL/Drizzle error the request did not expect)
 *    are classified into the safe IMPORT_* categories below; the technical
 *    error stays in the server log (console.error) and NEVER reaches the
 *    browser — no SQL, no query, no params, no stack trace, no constraint or
 *    relation names, no secrets;
 *  - IMPORT_SCHEMA_MISSING tells the operator, in plain words, that migration
 *    0010 (C.3.1) has not been applied in the environment that answered.
 */
import { SUPPLIER_IMPORT_MAX_ROWS } from "./constants";

export const SUPPLIER_IMPORT_MESSAGES: Record<string, string> = {
  // ── request / auth ──
  INVALID_BODY: "Corpo do pedido inválido.",
  INVALID_SUPPLIER_ID: "Fornecedor inválido.",
  SUPPLIER_ID_REQUIRED: "Fornecedor obrigatório.",
  IMPORT_ID_REQUIRED: "Identificador da importação obrigatório.",
  UNAUTHORIZED: "Sem permissões (requer gestor).",
  SUPPLIER_NOT_FOUND: "Fornecedor não encontrado.",
  SUPPLIER_INACTIVE: "O fornecedor está inativo — reative-o antes de importar a lista.",

  // ── CSV file level ──
  CSV_EMPTY: "CSV vazio.",
  CSV_NO_DATA: "CSV sem linhas de dados.",
  CSV_TOO_MANY_ROWS: `Ficheiro com demasiadas linhas (máx. ${SUPPLIER_IMPORT_MAX_ROWS}).`,
  CSV_FILE_TOO_LARGE: "Ficheiro demasiado grande (máx. 5 MB).",
  CSV_NO_COLUMNS_MAPPED: "Nenhuma coluna reconhecida — mapeie as colunas.",
  CSV_MISSING_KEY_COLUMN: "Ficheiro sem coluna de SKU do fornecedor, EAN ou SKU interno.",
  CSV_PARSE_ERROR: "Erro ao processar o CSV — verifique o formato do ficheiro.",

  // ── token / state machine ──
  PREVIEW_TOKEN_REQUIRED: "Confirme o preview antes de aplicar.",
  PREVIEW_TOKEN_INVALID: "Token do preview inválido.",
  PREVIEW_TOKEN_MISMATCH: "O token não corresponde a este ficheiro.",
  PREVIEW_EXPIRED: "O preview expirou — gere um novo.",
  IMPORT_NOT_FOUND: "Importação não encontrada.",
  IMPORT_IN_PROGRESS: "Já existe uma aplicação desta importação em curso.",
  IMPORT_FAILED: "Importação marcada como falhada: é preciso um novo preview.",

  // ── generic failures (full technical detail stays in the server log) ──
  SUPPLIER_IMPORT_PREVIEW_FAILED: "Falha ao processar o ficheiro — nenhuma alteração foi gravada.",
  SUPPLIER_IMPORT_APPLY_FAILED: "Falha ao aplicar — nenhum registo foi gravado a mais; pode retomar.",
  APPLY_BATCH_FAILED: "Falha ao aplicar um lote — os lotes já concluídos ficaram gravados; pode retomar.",
  APPLY_STALLED: "O apply não progrediu; importação interrompida.",

  // ── storage failures, classified into safe categories ──
  IMPORT_VALUE_TOO_LONG: "Valor demasiado longo para ser gravado — a linha foi recusada e o preview continua.",
  IMPORT_VALUE_OUT_OF_RANGE: "Valor fora do intervalo suportado — a linha foi recusada e o preview continua.",
  IMPORT_VALUE_REJECTED: "Valor recusado pela base de dados — a linha não foi gravada.",
  IMPORT_DUPLICATE_ROW: "Linha duplicada — não foi gravada uma segunda vez.",
  IMPORT_MISSING_VALUE: "Falta um valor obrigatório — a linha não foi gravada.",
  IMPORT_SCHEMA_MISSING:
    "As tabelas de importação ainda não existem neste ambiente — a migration 0010 (C.3.1) não está aplicada.",
};

/** Human label for each supplier field, used by the duplicate-mapping message. */
const FIELD_LABELS: Record<string, string> = {
  supplierSku: "SKU do fornecedor",
  internalSku: "SKU interno",
  ean: "EAN",
  name: "nome",
  costPrice: "custo",
  stock: "stock",
  leadTimeDays: "prazo de entrega",
};

/** "DUPLICATE_MAPPING:costPrice" / "DUPLICATE_MAPPING_costPrice" → PT text. */
function duplicateMappingMessage(code: string): string {
  const tail = code.includes(":") ? code.slice(code.indexOf(":") + 1) : code.slice(code.indexOf("_") + 1);
  const label = FIELD_LABELS[tail];
  return label
    ? `Duas colunas mapeadas para o ${label}.`
    : "Duas colunas mapeadas para o mesmo campo.";
}

/**
 * The message an operator should see for `code`.
 *
 * Priority:
 *  1. an explicit safe `serverMessage` (the server is the only source of
 *     dynamic but safe numbers such as sizes or counts);
 *  2. the shared table above;
 *  3. `fallback` when the caller needs a generic sentence for unknown codes
 *     (e.g. a legacy CSV parser error);
 *  4. the code itself — machine-readable, never raw internals;
 *  5. a last-resort generic sentence.
 */
export function supplierImportErrorMessage(
  code: string | undefined,
  serverMessage?: unknown,
  fallback?: string
): string {
  const explicit = typeof serverMessage === "string" && serverMessage.trim() ? serverMessage.trim() : "";
  if (explicit) return explicit;
  if (code) {
    if (code.startsWith("DUPLICATE_MAPPING:")) return duplicateMappingMessage(code);
    const known = SUPPLIER_IMPORT_MESSAGES[code];
    if (known) return known;
    if (fallback !== undefined) return fallback;
    return code;
  }
  return fallback ?? "Ocorreu um erro.";
}

// ─── Storage failure classification ───────────────────────

export const IMPORT_STORAGE_FAILURE_CODES = [
  "IMPORT_VALUE_TOO_LONG",
  "IMPORT_VALUE_OUT_OF_RANGE",
  "IMPORT_VALUE_REJECTED",
  "IMPORT_DUPLICATE_ROW",
  "IMPORT_MISSING_VALUE",
  "IMPORT_SCHEMA_MISSING",
] as const;
export type ImportStorageFailureCode = (typeof IMPORT_STORAGE_FAILURE_CODES)[number];

export interface ImportStorageFailure {
  code: ImportStorageFailureCode;
  message: string;
}

/**
 * Classify an unexpected database error into a safe, human category.
 *
 * This is the ONLY place a raw PostgreSQL/Drizzle error is examined. It runs
 * server-side (the caller logs the full technical error first); everything
 * returned here is from the table above — never the error's message, SQL,
 * query, params, stack, constraint or relation names.
 *
 * Returns null when the error does not look like a storage failure, so callers
 * keep their own generic handling.
 */
export function classifyImportStorageFailure(error: unknown): ImportStorageFailure | null {
  // Drizzle/pg may wrap the PostgreSQL error (the real code/message/table sit on
  // a `.cause` or nested driver error), so walk the whole cause chain.
  const codes: string[] = [];
  const fragments: string[] = [];
  let current: unknown = error;
  const seen = new Set<object>();
  while (current !== null && current !== undefined && typeof current === "object") {
    if (seen.has(current)) break;
    seen.add(current);
    const raw = current as { code?: unknown; message?: unknown; constraint?: unknown; table?: unknown; cause?: unknown };
    if (typeof raw.code === "string") codes.push(raw.code);
    if (typeof raw.message === "string") fragments.push(raw.message);
    if (typeof raw.table === "string") fragments.push(raw.table);
    if (typeof raw.constraint === "string") fragments.push(raw.constraint);
    const cause = raw.cause;
    if (cause === current) break;
    current = cause;
  }

  const haystack = fragments.join(" ").toLowerCase();
  const hasPg = (code: string) => codes.includes(code);

  const safe = (code: ImportStorageFailureCode): ImportStorageFailure => ({
    code,
    message: SUPPLIER_IMPORT_MESSAGES[code],
  });

  // 42P01 / "relation … does not exist": the migration that creates the C.3.1
  // tables (0010) has not been applied in the answering environment.
  if (hasPg("42P01") || /relation .* does not exist|undefined_table/.test(haystack)) {
    return safe("IMPORT_SCHEMA_MISSING");
  }
  // 22001 string_data_right_truncation.
  if (hasPg("22001") || /value too long|string_data_right_truncation/.test(haystack)) {
    return safe("IMPORT_VALUE_TOO_LONG");
  }
  // 22003 numeric_value_out_of_range.
  if (hasPg("22003") || /out of range|numeric field overflow/.test(haystack)) {
    return safe("IMPORT_VALUE_OUT_OF_RANGE");
  }
  // 23505 unique_violation.
  if (hasPg("23505") || /duplicate key value/.test(haystack)) {
    return safe("IMPORT_DUPLICATE_ROW");
  }
  // 23502 not_null_violation.
  if (hasPg("23502") || /null value in column/.test(haystack)) {
    return safe("IMPORT_MISSING_VALUE");
  }
  // 23514 check_violation, 23503 foreign_key_violation, 23504, 22P02 (invalid
  // text representation)… any other value the database refuses.
  if (hasPg("23514") || hasPg("23503") || hasPg("22P02") || /violates check|violates foreign key/.test(haystack)) {
    return safe("IMPORT_VALUE_REJECTED");
  }
  return null;
}
