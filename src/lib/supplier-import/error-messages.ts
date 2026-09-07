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

  // ── supplier file format (C.3.3) ──
  FILE_TYPE_NOT_SUPPORTED:
    "Tipo de ficheiro não suportado: apenas CSV/TXT e XLSX são aceites (sem .xls, .xlsm, .ods ou outros).",

  // ── source abstraction (C.3.4.1) ──
  SOURCE_PAYLOAD_INVALID:
    "Fonte de importação inválida — é obrigatório exatamente um conteúdo (texto CSV ou bytes XLSX) com um nome identificador.",
  SOURCE_URL_MALFORMED: "URL da fonte ilegível.",
  SOURCE_URL_TOO_LONG: "URL da fonte demasiado longa.",
  SOURCE_URL_SCHEME: "Apenas URLs HTTPS são permitidas por defeito.",
  SOURCE_URL_CREDENTIALS: "Credenciais na URL da fonte são proibidas.",
  SOURCE_URL_QUERY_NOT_ALLOWED: "A URL da fonte não pode conter parâmetros de query; use autenticação por basic/bearer/header.",
  SOURCE_URL_FRAGMENT_NOT_ALLOWED: "A URL da fonte não pode conter fragmento (#).",
  SOURCE_URL_HOST: "URL da fonte sem host válido.",
  SOURCE_URL_LOCAL_HOST: "Hostname local ou de metadados bloqueado.",
  SOURCE_URL_PRIVATE_IP: "Endereço IP privado/especial bloqueado.",
  SOURCE_URL_NUMERIC_HOST: "Host numérico não é permitido.",

  // ── remote fetch (C.3.4.2) ──
  // Nenhuma destas mensagens pode conter URL com query, headers, corpo,
  // stack ou segredos — a tabela é a única fonte do texto visto pelo operador.
  SOURCE_URL_INVALID: "A fonte remota não tem uma URL HTTPS configurada.",
  SOURCE_AUTH_SECRET_MISSING:
    "O segredo da fonte não está disponível no runtime — verifique a referência do secret (o valor nunca é guardado na aplicação).",
  SOURCE_AUTH_CONFIG_INVALID: "Configuração de autenticação da fonte inválida (faltam dados não-secretos obrigatórios).",
  SOURCE_HEADERS_CONFIG_INVALID: "Os headers não-secretos da fonte são inválidos ou reservados.",
  SOURCE_FETCH_TIMEOUT: "A fonte remota não respondeu dentro do limite de 10 segundos por tentativa.",
  SOURCE_FETCH_FAILED: "Falha ao obter a fonte remota — tente novamente mais tarde.",
  SOURCE_HTTP_401: "A fonte remota recusou as credenciais (HTTP 401).",
  SOURCE_HTTP_403: "A fonte remota negou acesso (HTTP 403).",
  SOURCE_HTTP_404: "O ficheiro da fonte remota não existe (HTTP 404).",
  SOURCE_HTTP_429: "A fonte remota impôs limite de pedidos (HTTP 429) — tente novamente mais tarde.",
  SOURCE_HTTP_5XX: "A fonte remota está indisponível (erro 5xx do servidor).",
  SOURCE_TOO_LARGE: "A fonte remota excede o limite de 5 MB — nada foi importado.",
  SOURCE_REDIRECT_BLOCKED:
    "O redirecionamento da fonte remota foi bloqueado (mudou de host ou excedeu o máximo de redirecionamentos).",
  SOURCE_ALREADY_RUNNING: "Já existe uma sincronização desta fonte em curso.",
  SOURCE_NO_CHANGE: "Nenhuma alteração desde a última sincronização.",
  SOURCE_PARSE_FAILED: "O conteúdo obtido não é uma lista de fornecedor válida — nada foi importado.",
  SOURCE_NOT_FOUND: "Fonte de fornecedor não encontrada.",
  SOURCE_DISABLED: "A fonte está desativada — ative-a para sincronizar.",
  SOURCE_TYPE_UNSUPPORTED: "Esta fonte não é uma fonte remota HTTPS — nada a sincronizar.",
  SOURCE_RUN_FAILED: "Falha ao sincronizar a fonte — nenhuma alteração foi gravada no catálogo.",
  SOURCE_NAME_EXISTS: "Já existe uma fonte com este nome para este fornecedor.",

  // ── XLSX file level (C.3.3 etapa 2) ──
  // Nenhuma destas mensagens revela detalhes técnicos (mensagem da
  // biblioteca, estrutura do ZIP, stack): o erro bruto fica no log do
  // servidor, o operador recebe apenas a categoria segura.
  XLSX_INVALID: "Ficheiro Excel (.xlsx) inválido — verifique se é um .xlsx legível e não protegido por palavra-passe.",
  XLSX_CORRUPT: "Ficheiro Excel (.xlsx) corrompido — tente gerar o ficheiro novamente.",
  XLSX_TOO_LARGE: "Ficheiro Excel (.xlsx) demasiado grande (máx. 5 MB).",
  XLSX_TOO_MANY_ROWS: `Ficheiro Excel (.xlsx) com demasiadas linhas (máx. ${SUPPLIER_IMPORT_MAX_ROWS}).`,
  XLSX_NO_USABLE_SHEET: "Ficheiro Excel (.xlsx) sem folhas com dados utilizáveis.",
  XLSX_NO_DATA: "Ficheiro Excel (.xlsx) sem linhas de dados.",

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
