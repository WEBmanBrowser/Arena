/**
 * C.3.4.1 — Abstração de FONTE de listas de fornecedor.
 *
 * Contrato aprovado:
 *
 *   SOURCE  (upload / futuramente URL / API)
 *     ↓
 *   SourcePayload
 *     ↓
 *   FORMATO  (parseSupplierFile → SupplierFileParse)
 *     ↓
 *   NormalizedSupplierRow[]
 *     ↓
 *   MOTOR  (matching → pricing → preview → apply)
 *
 * A fonte NUNCA conhece o parser, o mapping ou o motor: produz apenas um
 * SourcePayload (bytes/texto + metadados de transporte). Quem transforma o
 * payload em SupplierFileParse é o dispatcher de formatos (./file.ts), que
 * NÃO é alterado nesta fase — SupplierFileParse continua a ser o contrato de
 * saída dos parsers (nunca substituído por NormalizedSupplierRow[] isolado).
 *
 * Nesta fase (C.3.4.1):
 *  - o upload CSV/XLSX é convertido para SourcePayload por `uploadSource()`,
 *    usado pela rota E pelos testes de serviço (compatibilidade garantida);
 *  - o serviço (previewSupplierImport) passa a receber apenas `source`.
 *
 * C.3.4.2 acrescenta a este módulo o fetch remoto HTTPS (`fetchSource`),
 * reutilizando as guardas de URL/SSRF PURAS abaixo (sem DNS, sem rede, sem I/O
 * na validação) — o único I/O vive no `fetchSource`, que produz um
 * SourcePayload idêntico ao do upload e nada mais.
 */
import { classifySupplierFileName, type SupplierFileFormat } from "./file";
import { byteLengthUtf8, sha256Hex, sha256HexBytes } from "./normalize";
import { CSV_MAX_SIZE } from "@/lib/csv";

// ─── Tipos ────────────────────────────────────────────────

/** Formas de obtenção suportadas. `api` é aditivo futuro (adapter). */
export const SOURCE_KINDS = ["upload", "url"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/**
 * O que a fonte produz. Contrato único entre SOURCE e FORMATO.
 *
 * Regras:
 *  - EXATAMENTE um de `text` (CSV, caminho atual) ou `bytes` (XLSX; futuro XML)
 *    está presente — `assertSourcePayload()` garante a exclusividade;
 *  - `format` é a decisão da camada de cima (rota por extensão; futura
 *    configuração da fonte); "auto" manda detetar pelos bytes/texto;
 *  - `label` é o nome legível (nome do ficheiro no upload; URL no futuro) e é
 *    o que vai para supplier_imports.file_name / source_label;
 *  - `url`/`etag`/`lastModified` são metadados do transporte remoto (C.3.4.2);
 *    no upload ficam vazios. NUNCA transportam credenciais.
 */
export interface SourcePayload {
  kind: SourceKind;
  /** Nome legível da fonte (ficheiro/URL). Snapshot imutável no histórico. */
  label: string;
  /** Formato decidido a montante; "auto" → deteção por bytes/texto. */
  format: SupplierFileFormat | "auto";
  /** CSV: texto exato (a hash/tamanho são calculados em UTF-8). */
  text?: string;
  /** XLSX (futuro XML): bytes exatos do ficheiro. */
  bytes?: Uint8Array;
  /** Metadados de transporte (opcionais, sem segredos). */
  contentType?: string;
  url?: string;
  etag?: string;
  lastModified?: string;
}

/** Erro de fonte com código estável para a API/UI (mesmo padrão do C.3.1). */
export class SupplierSourceError extends Error {
  constructor(readonly code: string, readonly httpStatus = 400) {
    super(code);
    this.name = "SupplierSourceError";
  }
}

// ─── Builder do upload (rota + testes usam EXATAMENTE este caminho) ────────

/**
 * Upload CSV/XLSX → SourcePayload, com a MESMA classificação da rota C.3.3:
 * extensão decide, os bytes confirmam no parser (nunca se confia na extensão).
 *
 * Compatibilidade:
 *  - .xlsx com `xlsxBytes` → payload binário (bytes exatos);
 *  - qualquer outro nome (CSV/TXT) → payload texto;
 *  - .xls/.xlsm/.ods… → SupplierSourceError("FILE_TYPE_NOT_SUPPORTED").
 */
export function uploadSource(input: {
  fileName: string;
  csvText?: string;
  xlsxBytes?: Uint8Array;
}): SourcePayload {
  const fileName = typeof input.fileName === "string" ? input.fileName.trim() : "";
  const xlsxBytes = input.xlsxBytes && input.xlsxBytes.byteLength > 0 ? input.xlsxBytes : undefined;
  const kind = classifySupplierFileName(fileName);

  if (kind === "unsupported") {
    throw new SupplierSourceError("FILE_TYPE_NOT_SUPPORTED");
  }
  // Bytes ganham: é o mesmo critério do serviço C.3.3 (presença de bytes).
  if (kind === "xlsx" || xlsxBytes) {
    if (!xlsxBytes) throw new SupplierSourceError("XLSX_INVALID");
    return { kind: "upload", label: fileName || "supplier-list.xlsx", format: "xlsx", bytes: xlsxBytes };
  }
  if (kind === "also_pricelist") {
    return { kind: "upload", label: fileName || "pricelist-1.txt", format: "also_pricelist", text: input.csvText ?? "" };
  }
  if (kind === "also_stock") {
    return { kind: "upload", label: fileName || "stock.txt", format: "also_stock", text: input.csvText ?? "" };
  }
  // ALSO auto-detection when fileName is generic .txt but content is TSV ALSO stock (header-driven)
  const txt = input.csvText ?? "";
  if (txt.includes("\t")) {
    const stripped = txt.replace(/^\uFEFF/, "").trim();
    const firstLine = stripped.split(/\r?\n/)[0] ?? "";
    const firstCells = firstLine.split("\t").map((s) => s.trim().toLowerCase());
    const normFirst = firstCells.join("|");
    // stock.txt header contains productid + availablequantity + availabilitydate
    if (firstCells.includes("productid") && firstCells.includes("availablequantity")) {
      return { kind: "upload", label: fileName || "stock.txt", format: "also_stock", text: txt };
    }
    // pricelist-1.txt has no header but contains tabs and many columns; fallback to pricelist if generic txt with tabs and not stock
    // We keep csv for generic txt unless explicitly pricelist filename; do not auto-detect pricelist to avoid breaking CSV with tabs
  }
  return { kind: "upload", label: fileName || "supplier-list.csv", format: "csv", text: input.csvText ?? "" };
}

/** Valida o contrato do payload: exatamente um de `text`/`bytes` + label. */
export function assertSourcePayload(payload: SourcePayload): void {
  if (!payload || typeof payload !== "object") {
    throw new SupplierSourceError("SOURCE_PAYLOAD_INVALID");
  }
  const hasText = typeof payload.text === "string";
  const hasBytes = ArrayBuffer.isView(payload.bytes) && (payload.bytes as Uint8Array).byteLength > 0;
  if (hasText === hasBytes) {
    throw new SupplierSourceError("SOURCE_PAYLOAD_INVALID");
  }
  if (typeof payload.label !== "string" || payload.label.trim().length === 0) {
    throw new SupplierSourceError("SOURCE_PAYLOAD_INVALID");
  }
}

// ─── Helpers de conteúdo (hash/tamanho/format) ────────────

/**
 * Formato efetivo do payload: o `format` explícito vence; "auto" deteta pelos
 * bytes (assinatura ZIP/OOXML PK\x03\x04 → xlsx) ou assume CSV (texto).
 * O sniffing XML será adicionado na C.3.4.3 sem tocar no motor.
 */
export function sourceFormat(payload: SourcePayload): SupplierFileFormat {
  if (payload.format !== "auto") return payload.format;
  const bytes = payload.bytes;
  if (
    bytes &&
    bytes.byteLength >= 4 &&
    bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
  ) {
    return "xlsx";
  }
  const text = payload.text ?? "";
  if (text.includes("\t")) {
    const stripped = text.replace(/^\uFEFF/, "").trim();
    const firstLine = stripped.split(/\r?\n/)[0] ?? "";
    const cells = firstLine.split("\t").map((s) => s.trim().toLowerCase());
    if (cells.includes("productid") && cells.includes("availablequantity")) {
      return "also_stock";
    }
  }
  return "csv";
}

/** Comprimento em bytes do conteúdo (UTF-8 para texto; bytes reais para binário). */
export function sourceByteLength(payload: SourcePayload): number {
  return payload.bytes ? payload.bytes.byteLength : byteLengthUtf8(payload.text ?? "");
}

/** SHA-256 (hex) dos bytes/UTF-8 exatos que produziram o snapshot. */
export function sourceSha256Hex(payload: SourcePayload): string {
  return payload.bytes ? sha256HexBytes(payload.bytes) : sha256Hex(payload.text ?? "");
}

// ─── Guardas de URL/SSRF (PURAS — sem DNS, sem fetch) ─────

export const SOURCE_URL_MAX_LENGTH = 2048;

export const SOURCE_URL_GUARD_CODES = [
  "SOURCE_URL_MALFORMED",
  "SOURCE_URL_TOO_LONG",
  "SOURCE_URL_SCHEME",
  "SOURCE_URL_CREDENTIALS",
  "SOURCE_URL_QUERY_NOT_ALLOWED",
  "SOURCE_URL_FRAGMENT_NOT_ALLOWED",
  "SOURCE_URL_HOST",
  "SOURCE_URL_LOCAL_HOST",
  "SOURCE_URL_PRIVATE_IP",
  "SOURCE_URL_NUMERIC_HOST",
] as const;
export type SourceUrlGuardCode = (typeof SOURCE_URL_GUARD_CODES)[number];

export interface SourceUrlGuardOptions {
  /**
   * Por defeito APENAS HTTPS. `allowHttp` é opt-in explícito (futuro), sujeito
   * a auditoria — nunca um comportamento implícito do schema.
   */
  allowHttp?: boolean;
}

export type SourceUrlGuardResult =
  | { ok: true; url: URL; hostname: string }
  | { ok: false; code: SourceUrlGuardCode; message: string };

// ─── IPv4 ─────────────────────────────────────────────────

/** Bloqueados por serem privados/especiais/reservados (SSRF + metadados). */
const BLOCKED_IPV4_RANGES: Array<[number, number]> = [
  [0x00000000, 0x00ffffff], // 0.0.0.0/8
  [0x0a000000, 0x0affffff], // 10.0.0.0/8
  [0x64400000, 0x647fffff], // 100.64.0.0/10 (CGNAT, inclui 100.100.100.200)
  [0x7f000000, 0x7fffffff], // 127.0.0.0/8 (loopback)
  [0xa9fe0000, 0xa9feffff], // 169.254.0.0/16 (link-local / metadata AWS)
  [0xac100000, 0xac1fffff], // 172.16.0.0/12
  [0xc0000000, 0xc00000ff], // 192.0.0.0/24
  [0xc0000200, 0xc00002ff], // 192.0.2.0/24 (TEST-NET-1)
  [0xc0a80000, 0xc0a8ffff], // 192.168.0.0/16
  [0xc6120000, 0xc613ffff], // 198.18.0.0/15
  [0xc6336400, 0xc63364ff], // 198.51.100.0/24 (TEST-NET-2)
  [0xcb007100, 0xcb0071ff], // 203.0.113.0/24 (TEST-NET-3)
  [0xe0000000, 0xefffffff], // 224.0.0.0/4 (multicast)
  [0xf0000000, 0xffffffff], // 240.0.0.0/4 (reservado + broadcast)
];

function ipv4ToInt(parts: number[]): number | null {
  if (parts.length !== 4) return null;
  for (const p of parts) {
    if (!Number.isInteger(p) || p < 0 || p > 255) return null;
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/** True quando um dotted-quad é privado/especial/reservado (inclui metadados). */
export function isBlockedIpv4(ip: string): boolean {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const n = ipv4ToInt([+m[1], +m[2], +m[3], +m[4]]);
  if (n === null) return false;
  return BLOCKED_IPV4_RANGES.some(([first, last]) => n >= first && n <= last);
}

// ─── IPv6 ─────────────────────────────────────────────────

/** IPv6 → 8 grupos de 16 bits (sem BigInt: compatível com target ES<2020). */
function parseIpv6Groups(host: string): number[] | null {
  let h = host.toLowerCase();
  let v4Tail: number | null = null;

  // Formas com IPv4 embebido: ::ffff:1.2.3.4 / ::1.2.3.4
  const v4m = h.match(/^(.*):(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4m) {
    const n = ipv4ToInt([+v4m[2], +v4m[3], +v4m[4], +v4m[5]]);
    if (n === null) return null;
    v4Tail = n;
    h = v4m[1];
  }

  const [leftRaw = "", rightRaw = ""] = h.split("::");
  const left = leftRaw ? leftRaw.split(":").filter(Boolean) : [];
  const right = rightRaw ? rightRaw.split(":").filter(Boolean) : [];
  const tailGroups = v4Tail === null ? 0 : 2;
  const missing = 8 - left.length - right.length - tailGroups;
  if (h.includes("::") ? missing < 1 : missing !== 0) return null;

  const parts = [...left, ...Array<string>(Math.max(missing, 0)).fill("0"), ...right];
  if (v4Tail !== null) {
    parts.push(((v4Tail >>> 16) & 0xffff).toString(16), (v4Tail & 0xffff).toString(16));
  }
  if (parts.length !== 8) return null;

  const groups: number[] = [];
  for (const p of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(p)) return null;
    groups.push(parseInt(p, 16));
  }
  return groups;
}

/** True quando um literal IPv6 (sem brackets) é bloqueado. `false` para não-IPv6. */
export function isBlockedIpv6(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!h.includes(":")) return false;
  const groups = parseIpv6Groups(h);
  // Literal IPv6 ilegível → fail closed (nunca deixar passar um endereço que
  // não conseguimos classificar).
  if (groups === null) return true;

  const isAllZero = groups.every((g) => g === 0);
  const isLoopback = groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1;
  if (isAllZero || isLoopback) return true; // :: e ::1
  if ((groups[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 (link-local)
  if ((groups[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 (ULA)
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return true; // 2001:db8::/32

  // IPv4-embebido (::ffff:a.b.c.d e ::a.b.c.d) → aplicar as regras IPv4.
  const firstFiveZero = groups.slice(0, 5).every((g) => g === 0);
  const v4compat = firstFiveZero && groups[5] === 0;
  const v4mapped = firstFiveZero && groups[5] === 0xffff;
  if (v4compat || v4mapped) {
    // >>> 0: sem isto, endereços ≥ 128.0.0.0 (ex.: 192.168.x) tornam-se
    // negativos no shift de 32 bits e escapavam às gamas bloqueadas.
    const v4 = (((groups[6] << 16) | groups[7]) >>> 0);
    return BLOCKED_IPV4_RANGES.some(([first, last]) => v4 >= first && v4 <= last);
  }
  return false;
}

/** True quando o hostname é literal de IP e bloqueado (privado/especial/metadados). */
export function isBlockedIpLiteral(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h.includes(":")) return isBlockedIpv6(h);
  return isBlockedIpv4(h);
}

// ─── Hostnames por convenção ──────────────────────────────

const BLOCKED_HOSTNAME_SUFFIXES = [
  ".local", ".internal", ".home.arpa", ".localdomain",
  ".test", ".invalid", ".example", ".onion", ".localhost",
];

const BLOCKED_METADATA_HOSTNAMES = [
  "metadata",
  "metadata.google.internal",
  "metadata.aws.internal",
  "instance-data",
  "instance-data.ec2.internal",
];

/** True para hostnames locais/metadados por CONVENÇÃO (não confiável sozinho: é
 *  camada 1; a camada 2 é a allowlist exata de hostname da C.3.4.2). */
export function isLocalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (!h) return true;
  if (h === "localhost" || h === "localhost.localdomain") return true;
  if (BLOCKED_HOSTNAME_SUFFIXES.some((s) => h.endsWith(s))) return true;
  if (BLOCKED_METADATA_HOSTNAMES.includes(h)) return true;
  return false;
}

/** Hosts puramente numéricos (ex.: "2130706433") — o URL parser normaliza a
 *  maioria, mas a regra permanece como defesa em profundidade. */
export function looksLikeNumericHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (/^\d+$/.test(h)) return true;
  if (/^0x[0-9a-f]+$/i.test(h)) return true;
  return false;
}

const fail = (code: SourceUrlGuardCode, message: string): SourceUrlGuardResult => ({ ok: false, code, message });

/**
 * Guarda PURA de URL de fonte de fornecedor (sem DNS, sem rede).
 *
 * Verifica: formato (HTTPS por defeito), userinfo (credenciais na URL
 * proibidas), query string e fragmento PROIBIDOS (política fail-closed
 * C.3.4.2: tokens em `?...` acabariam em `supplier_sources.url`,
 * `source_label` e `file_name`; autenticação vive exclusivamente em
 * basic/bearer/header + `secret_reference` — NUNCA se "sanitiza" removendo a
 * query, rejeita-se a configuração), literal de IP privado/especial/metadados
 * (IPv4+IPv6+IPv4-mapped), hostnames locais/metadados por convenção, hosts
 * numéricos e comprimento.
 *
 * NÃO resolve DNS (limitação conhecida do Workers: não há pinning — a
 * C.3.4.2 adiciona allowlist exata de hostname + revalidação em cada redirect
 * + opcionalmente egress Gateway).
 */
export function guardSupplierSourceUrl(
  rawUrl: string,
  options: SourceUrlGuardOptions = {}
): SourceUrlGuardResult {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    return fail("SOURCE_URL_MALFORMED", "URL vazia");
  }
  if (rawUrl.length > SOURCE_URL_MAX_LENGTH) {
    return fail("SOURCE_URL_TOO_LONG", `URL acima de ${SOURCE_URL_MAX_LENGTH} caracteres`);
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return fail("SOURCE_URL_MALFORMED", "URL ilegível");
  }

  const protocol = url.protocol.toLowerCase();
  if (protocol !== "https:" && !(options.allowHttp && protocol === "http:")) {
    return fail("SOURCE_URL_SCHEME", "apenas HTTPS é permitido por defeito");
  }
  if (url.username || url.password) {
    return fail("SOURCE_URL_CREDENTIALS", "credenciais na URL são proibidas");
  }
  // Política fail-closed (C.3.4.2): query strings podem carregar tokens que
  // acabariam persistidos (`supplier_sources.url`, `source_label`,
  // `file_name`). NÃO se remove a query para continuar — a query pode ser
  // parte da autenticação/semântica do recurso; rejeita-se a configuração.
  // `url.search` é "" tanto para "sem ?" como para "?" vazio (o parser
  // WHATWG normaliza o vazio fora do href, logo nada viaja na rede).
  if (url.search) {
    return fail("SOURCE_URL_QUERY_NOT_ALLOWED", "parâmetros de query na URL da fonte são proibidos; use basic/bearer/header");
  }
  if (url.hash) {
    return fail("SOURCE_URL_FRAGMENT_NOT_ALLOWED", "fragmento (#) na URL da fonte é proibido");
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname) return fail("SOURCE_URL_HOST", "host ausente");
  if (looksLikeNumericHost(hostname)) return fail("SOURCE_URL_NUMERIC_HOST", "host numérico não é permitido");
  if (isBlockedIpLiteral(hostname)) return fail("SOURCE_URL_PRIVATE_IP", "endereço IP privado/especial bloqueado");
  if (isLocalHostname(hostname)) return fail("SOURCE_URL_LOCAL_HOST", "hostname local/metadados bloqueado");

  return { ok: true, url, hostname };
}

// ═══════════════════════════════════════════════════════════
// C.3.4.2 — FETCH REMOTO HTTPS
// ═══════════════════════════════════════════════════════════
//
// `fetchSource` é a ÚNICA forma de obter conteúdo remoto. Não conhece o
// parser, o mapping nem o motor: devolve o MESMO SourcePayload do upload,
// produzido pelas mesmas regras (formato decidido por "explícito vence; auto
// deteta PK\x03\x04 → xlsx, senão csv — Content-Type é apenas informativo).
//
// Regras fixas desta fase:
//  - APENAS HTTPS (o `allowHttp` das guardas puras NÃO é usado aqui);
//  - `redirect: "manual"` sempre — o redirect NUNCA é seguido automaticamente;
//    cada `Location` é revalidado com TODAS as regras e tem de manter o
//    hostname original (cross-host é SOURCE_REDIRECT_BLOCKED; máximo 3);
//  - corpo lido em STREAMING com teto de 5 MB (mesmo teto dos parsers,
//    `CSV_MAX_SIZE`); `Content-Length` acima do teto aborta ANTES de ler;
//  - timeout de 10 s por tentativa via AbortController/AbortSignal
//    (compatível com Cloudflare Workers); máximo de 3 tentativas NO TOTAL,
//    apenas para timeout/rede, 429, 502, 503, 504 (com Retry-After ≤ 10 s);
//  - segredos NUNCA vêm da BD nem da UI: `secret_reference` é o NOME da
//    variável de ambiente; o valor é resolvido só em runtime e nunca é
//    devolvido, persistido nem escrito em erro/log.

/** Timeout por tentativa (ms). */
export const SOURCE_FETCH_TIMEOUT_MS = 10_000;
/** Tentativas TOTAL por fetch (não por redirect). */
export const SOURCE_FETCH_MAX_ATTEMPTS = 3;
/** Redirects máximos seguidos manualmente. */
export const SOURCE_MAX_REDIRECTS = 3;
/** Teto de bytes ACEITES: o mesmo 5 MB dos parsers (CSV_MAX_SIZE = XLSX_MAX_SIZE_BYTES). */
export const SOURCE_MAX_CONTENT_BYTES = CSV_MAX_SIZE;
/** Retry-After só é "razoável" até 10 s; acima disso não se espera — falha já. */
export const SOURCE_MAX_RETRY_AFTER_MS = 10_000;

/** Status HTTP que justificam nova tentativa (e apenas estes + timeout/rede). */
const RETRYABLE_HTTP_STATUSES = new Set([429, 502, 503, 504]);

/** Códigos de erro estáveis do fetch remoto (nunca texto bruto do erro). */
export const SOURCE_FETCH_ERROR_CODES = [
  "SOURCE_URL_INVALID",
  "SOURCE_AUTH_SECRET_MISSING",
  "SOURCE_AUTH_CONFIG_INVALID",
  "SOURCE_HEADERS_CONFIG_INVALID",
  "SOURCE_FETCH_TIMEOUT",
  "SOURCE_FETCH_FAILED",
  "SOURCE_HTTP_401",
  "SOURCE_HTTP_403",
  "SOURCE_HTTP_404",
  "SOURCE_HTTP_429",
  "SOURCE_HTTP_5XX",
  "SOURCE_TOO_LARGE",
  "SOURCE_REDIRECT_BLOCKED",
] as const;
export type SourceFetchErrorCode = (typeof SOURCE_FETCH_ERROR_CODES)[number];

/** Erro de fetch remoto: código estável + status HTTP do REMOTO (para `last_http_status`). */
export class SourceFetchError extends SupplierSourceError {
  /** `httpStatus` (base) é o status da NOSSA API; `remoteStatus` o do fornecedor. */
  constructor(code: string, httpStatus: number, readonly remoteStatus: number | null = null) {
    super(code, httpStatus);
    this.name = "SourceFetchError";
  }
}

export const SOURCE_AUTH_TYPES = ["none", "basic", "bearer", "header"] as const;
export type SourceAuthType = (typeof SOURCE_AUTH_TYPES)[number];

/**
 * Chave reservada em `headers_config` para auth=header: contém só o NOME do
 * header para onde o segredo vai (o valor nunca é configurado aqui).
 */
export const SOURCE_SECRET_HEADER_KEY = "headerName";

/** O que o fetch precisa de saber da source (projeção de supplier_sources — sem segredos). */
export interface RemoteSourceConfig {
  url: string;
  format: "auto" | "csv" | "xlsx";
  authType: SourceAuthType;
  /** Não-secreto (Basic Auth user). */
  username?: string | null;
  /** NOME da variável de ambiente com o segredo; nunca o valor. */
  secretReference?: string | null;
  /** Headers não-secretos; `headerName` é reservado (auth=header). */
  headersConfig?: Record<string, unknown> | null;
  /** Validadores da última resposta boa (condicional GET). */
  lastEtag?: string | null;
  lastModified?: string | null;
}

/** Injeção de dependências — o padrão do cliente Eupago: testes não precisam de rede. */
export interface FetchSourceOptions {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  maxAttempts?: number;
  maxRedirects?: number;
  maxBytes?: number;
  /** Sobrescrevível nos testes para não dormir de verdade no Retry-After. */
  sleepImpl?: (ms: number) => Promise<void>;
}

export type FetchSourceResult =
  | { kind: "not_modified"; httpStatus: 304 }
  | {
      kind: "content";
      httpStatus: number;
      payload: SourcePayload;
      etag: string | null;
      lastModified: string | null;
    };

// ─── Segredo + cabeçalhos ─────────────────────────────────

/** Nome de env legal para `secret_reference` (fail closed: nada fora disto é lido). */
const SECRET_ENV_NAME_RE = /^[A-Z][A-Z0-9_]{0,254}$/;

/**
 * Resolve o segredo EXCLUSIVAMENTE em runtime a partir do NOME guardado na BD
 * (`process.env[secretReference]`). Se não existir → SOURCE_AUTH_SECRET_MISSING.
 * O valor devolvido NUNCA é copiado para erros, logs, BD ou respostas.
 */
export function resolveSourceSecret(
  secretReference: string | null | undefined,
  env: Record<string, string | undefined> = process.env
): string {
  if (typeof secretReference !== "string" || !SECRET_ENV_NAME_RE.test(secretReference)) {
    throw new SourceFetchError("SOURCE_AUTH_SECRET_MISSING", 500);
  }
  const value = env[secretReference];
  if (typeof value !== "string" || value.length === 0 || /[\r\n\0]/.test(value)) {
    // /[\r\n\0]/: um valor com CRLF permitiria header injection; é sempre um
    // erro de configuração — nunca se envia, nunca se revela o motivo técnico.
    throw new SourceFetchError("SOURCE_AUTH_SECRET_MISSING", 500);
  }
  return value;
}

/** Header name = token HTTP (RFC 7230). */
const HEADER_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Headers que a config não-secreta NUNCA pode definir — são do transporte ou
 * da autenticação (que só existe via secret_reference). Defenso em profundidade
 * contra um segredo/Authorization escrito em headers_config.
 */
export const FORBIDDEN_SOURCE_HEADERS = [
  "authorization", "proxy-authorization", "cookie", "set-cookie", "host",
  "content-length", "content-type", "connection", "keep-alive", "te",
  "trailer", "transfer-encoding", "upgrade", "expect", "date",
] as const;

function base64Utf8(input: string): string {
  // btoa + TextEncoder existem no Node (≥16) e no workerd (nodejs_compat);
  // sem dependências novas e sem Buffer no caminho de auth.
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * Constrói os headers do pedido. Seguros por construção:
 *  - segredos só entram via resolveSourceSecret (nunca da BD/URL/config);
 *  - headers_config não-secreto é validado (token, sem CRLF, sem nomes
 *    reservados) e `headerName` reservado não é enviado como header literal;
 *  - `Accept-Encoding: identity` — os bytes contados no streaming são os
 *    bytes que o parser vê (sem gzip a falsear Content-Length/tamanho);
 *  - validadores condicionais só existem se a fonte os guardou.
 */
export function buildSourceRequestHeaders(
  cfg: RemoteSourceConfig,
  env: Record<string, string | undefined> = process.env
): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "text/csv, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, */*",
    "accept-encoding": "identity",
    "cache-control": "no-cache",
    "user-agent": "MDTech-SupplierSource/1.0",
  };

  const configEntries: Array<[string, unknown]> =
    cfg.headersConfig && typeof cfg.headersConfig === "object" && !Array.isArray(cfg.headersConfig)
      ? Object.entries(cfg.headersConfig as Record<string, unknown>)
      : [];

  for (const [rawName, rawValue] of configEntries) {
    if (rawName === SOURCE_SECRET_HEADER_KEY) continue; // reservado: é config, não header
    const name = String(rawName);
    const value = typeof rawValue === "string" ? rawValue : "";
    if (
      !HEADER_TOKEN_RE.test(name) ||
      FORBIDDEN_SOURCE_HEADERS.includes(name.toLowerCase() as (typeof FORBIDDEN_SOURCE_HEADERS)[number]) ||
      typeof rawValue !== "string" ||
      /[\r\n\0]/.test(value) ||
      value.length > 2048
    ) {
      throw new SourceFetchError("SOURCE_HEADERS_CONFIG_INVALID", 400);
    }
    headers[name] = value;
  }

  if (cfg.authType !== "none") {
    const secret = resolveSourceSecret(cfg.secretReference, env);
    if (cfg.authType === "basic") {
      const username = typeof cfg.username === "string" ? cfg.username.trim() : "";
      if (!username || /[\r\n\0]/.test(username)) {
        throw new SourceFetchError("SOURCE_AUTH_CONFIG_INVALID", 500);
      }
      headers.authorization = `Basic ${base64Utf8(`${username}:${secret}`)}`;
    } else if (cfg.authType === "bearer") {
      headers.authorization = `Bearer ${secret}`;
    } else {
      // auth=header: o NOME vem de headers_config (não-secreto); o VALOR só do secret.
      const headerName = (cfg.headersConfig as Record<string, unknown> | null | undefined)?.[SOURCE_SECRET_HEADER_KEY];
      if (
        typeof headerName !== "string" ||
        !HEADER_TOKEN_RE.test(headerName) ||
        FORBIDDEN_SOURCE_HEADERS.includes(headerName.toLowerCase() as (typeof FORBIDDEN_SOURCE_HEADERS)[number])
      ) {
        throw new SourceFetchError("SOURCE_AUTH_CONFIG_INVALID", 500);
      }
      headers[headerName] = secret;
    }
  }

  if (cfg.lastEtag && String(cfg.lastEtag).trim()) headers["if-none-match"] = String(cfg.lastEtag).trim();
  if (cfg.lastModified && String(cfg.lastModified).trim()) headers["if-modified-since"] = String(cfg.lastModified).trim();
  return headers;
}

// ─── Leitura em streaming com teto ────────────────────────

interface BodySource {
  status: number;
  headers: { get(name: string): string | null };
  body: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(reason?: unknown): Promise<void> } } | null;
}

/**
 * Lê `response.body` em streaming até `maxBytes`. Interrompe ASSIM que o
 * limite é ultrapassado (mesmo sem Content-Length) e cancela o leitor.
 * NUNCA `response.arrayBuffer()` sem limite.
 */
export async function readBodyCapped(source: BodySource, maxBytes: number): Promise<Uint8Array> {
  // Guardas: o shape mínimo tem de existir; um body não-iterável é erro, não crash.
  const reader = source.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await Promise.resolve(reader.cancel()).catch(() => undefined);
        throw new SourceFetchError("SOURCE_TOO_LARGE", 413);
      }
      chunks.push(value);
    }
  } finally {
    // nada a libertar no contrato mínimo; mantém o try/finally explícito p/ mocks.
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function parseContentLength(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value.trim());
  if (!Number.isSafeInteger(n) || n < 0) return null;
  return n;
}

function parseRetryAfterMs(value: string | null): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d{1,9}$/.test(trimmed)) return Math.min(Number(trimmed) * 1000, 24 * 3600_000);
  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) return Math.max(0, Math.min(date - Date.now(), 24 * 3600_000));
  return null;
}

/** Assinatura ZIP/OOXML (mesmo critério do parser XLSX): PK\x03\x04 → xlsx. */
function looksLikeXlsx(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function httpFailureError(status: number): SourceFetchError {
  const code: SourceFetchErrorCode =
    status === 401 ? "SOURCE_HTTP_401"
      : status === 403 ? "SOURCE_HTTP_403"
        : status === 404 ? "SOURCE_HTTP_404"
          : status === 429 ? "SOURCE_HTTP_429"
            : status >= 500 && status <= 599 ? "SOURCE_HTTP_5XX"
              : "SOURCE_FETCH_FAILED";
  // A nossa API responde 502 (o remoto não produziu representação); o status
  // do fornecedor segue no `remoteStatus` para `last_http_status`.
  return new SourceFetchError(code, status === 429 ? 429 : 502, status);
}

// ─── fetchSource ──────────────────────────────────────────

/**
 * Obtém o conteúdo remoto de uma fonte de fornecedor e devolve o SourcePayload
 * (ou `not_modified` num 304 condicionado). Não parseia, não grava nada.
 */
export async function fetchSource(cfg: RemoteSourceConfig, opts: FetchSourceOptions = {}): Promise<FetchSourceResult> {
  const timeoutMs = Math.max(1, opts.timeoutMs ?? SOURCE_FETCH_TIMEOUT_MS);
  const maxAttempts = Math.max(1, Math.min(opts.maxAttempts ?? SOURCE_FETCH_MAX_ATTEMPTS, 10));
  const maxRedirects = Math.max(0, Math.min(opts.maxRedirects ?? SOURCE_MAX_REDIRECTS, 10));
  const maxBytes = Math.max(1, Math.min(opts.maxBytes ?? SOURCE_MAX_CONTENT_BYTES, SOURCE_MAX_CONTENT_BYTES));
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const env = opts.env ?? process.env;
  const sleep = opts.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  if (typeof fetchImpl !== "function") throw new SourceFetchError("SOURCE_FETCH_FAILED", 500);

  // 1) URL validada ANTES de qualquer fetch. HTTPS apenas — allowHttp não existe aqui.
  if (typeof cfg.url !== "string" || !cfg.url.trim()) throw new SourceFetchError("SOURCE_URL_INVALID", 400);
  const initial = guardSupplierSourceUrl(cfg.url.trim());
  if (!initial.ok) throw new SourceFetchError(initial.code, 400);
  const originHostname = initial.hostname;

  // 2) Headers (auth/condicional/config) — constuídos UMA vez; um segredo
  //    ausente falha aqui, antes de qualquer rede.
  const headers = buildSourceRequestHeaders(cfg, env);

  let current = initial.url;
  let redirectsFollowed = 0;
  let attempt = 0;

  for (;;) {
    attempt += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(current.href, {
        method: "GET",
        redirect: "manual", // NUNCA seguir automaticamente
        headers: { ...headers },
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      if (attempt < maxAttempts) continue; // retry: timeout/rede
      const timedOut = controller.signal.aborted || (e instanceof Error && /abort/i.test(e.name));
      throw new SourceFetchError(timedOut ? "SOURCE_FETCH_TIMEOUT" : "SOURCE_FETCH_FAILED", 502);
    }

    try {
      const status = response.status;

      // 3) 304 ANTES do ramo 3xx — "Not Modified" é um 3xx SEM redirect a
      //    seguir: nenhuma alteração, sem body, sem payload, sem preview.
      if (status === 304) {
        clearTimeout(timer);
        return { kind: "not_modified", httpStatus: 304 };
      }

      // 4) Redirect manual revalidado — NÃO consome tentativa, mas consome o
      //    orçamento de redirects e re-aplica TODAS as regras ao Location.
      if (status >= 300 && status < 400) {
        clearTimeout(timer);
        await Promise.resolve(response.body?.cancel()).catch(() => undefined);
        const location = response.headers.get("location");
        if (!location) throw new SourceFetchError("SOURCE_REDIRECT_BLOCKED", 502, status);
        let nextUrl: URL;
        try {
          nextUrl = new URL(location, current);
        } catch {
          throw new SourceFetchError("SOURCE_URL_MALFORMED", 400, status);
        }
        const guarded = guardSupplierSourceUrl(nextUrl.href);
        if (!guarded.ok) throw new SourceFetchError(guarded.code, 400, status);
        if (guarded.hostname !== originHostname) {
          // HOST POLICY: sem wildcards, sem cross-host silencioso.
          throw new SourceFetchError("SOURCE_REDIRECT_BLOCKED", 502, status);
        }
        if (redirectsFollowed >= maxRedirects) {
          throw new SourceFetchError("SOURCE_REDIRECT_BLOCKED", 502, status);
        }
        redirectsFollowed += 1;
        current = guarded.url;
        attempt -= 1; // o redirect não gasta tentativas de retry
        continue;
      }

      // 5) 200 — streaming limitado. Qualquer outro 2xx é falha explícita
      //    (não se tenta adivinhar representações não-documentadas).
      if (status === 200) {
        const declared = parseContentLength(response.headers.get("content-length"));
        if (declared !== null && declared > maxBytes) {
          await Promise.resolve(response.body?.cancel()).catch(() => undefined);
          throw new SourceFetchError("SOURCE_TOO_LARGE", 413, status);
        }
        let bytes: Uint8Array;
        try {
          bytes = await readBodyCapped(response as unknown as BodySource, maxBytes);
        } finally {
          clearTimeout(timer); // o timeout abarca fetch + leitura do corpo
        }
        const etag = response.headers.get("etag");
        const lastModified = response.headers.get("last-modified");
        // Content-Type é apenas informativo; o formato efetivo é decidido por
        // explícito-vence / sniffing dos BYTES (nunca pelo header).
        const format: SupplierFileFormat = cfg.format === "auto" ? (looksLikeXlsx(bytes) ? "xlsx" : "csv") : cfg.format;
        const transport = {
          contentType: response.headers.get("content-type") ?? undefined,
          url: current.href,
          etag: etag ?? undefined,
          lastModified: lastModified ?? undefined,
        };
        const payload: SourcePayload =
          format === "xlsx"
            ? { kind: "url", label: cfg.url.trim(), format: "xlsx", bytes, ...transport }
            : { kind: "url", label: cfg.url.trim(), format: "csv", text: new TextDecoder("utf-8").decode(bytes), ...transport };
        assertSourcePayload(payload);
        return { kind: "content", httpStatus: 200, payload, etag, lastModified };
      }

      // 6) Erros HTTP. Retry APENAS em 429/502/503/504 (e timeout/rede acima).
      const retryable = RETRYABLE_HTTP_STATUSES.has(status);
      if (retryable && attempt < maxAttempts) {
        clearTimeout(timer);
        if (status === 429) {
          const waitMs = parseRetryAfterMs(response.headers.get("retry-after"));
          if (waitMs !== null && waitMs > SOURCE_MAX_RETRY_AFTER_MS) {
            // "razoável" é um limite, não uma sugestão: espera longa → falha já.
            throw new SourceFetchError("SOURCE_HTTP_429", 429, status);
          }
          if (waitMs !== null && waitMs > 0) await sleep(Math.min(waitMs, SOURCE_MAX_RETRY_AFTER_MS));
        }
        continue;
      }
      throw httpFailureError(status);
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof SupplierSourceError) throw e;
      if (attempt < maxAttempts) continue; // timeout/rede durante a leitura do corpo
      throw new SourceFetchError(controller.signal.aborted ? "SOURCE_FETCH_TIMEOUT" : "SOURCE_FETCH_FAILED", 502);
    }
  }
}
