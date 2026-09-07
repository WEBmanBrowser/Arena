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
 * Nesta fase:
 *  - o upload CSV/XLSX é convertido para SourcePayload por `uploadSource()`,
 *    usado pela rota E pelos testes de serviço (compatibilidade garantida);
 *  - o serviço (previewSupplierImport) passa a receber apenas `source`;
 *  - NÃO existe fetch remoto: as guardas de URL/SSRF abaixo são PURAS
 *    (sem DNS, sem rede, sem I/O) — prontas para a C.3.4.2.
 */
import { classifySupplierFileName, type SupplierFileFormat } from "./file";
import { byteLengthUtf8, sha256Hex, sha256HexBytes } from "./normalize";

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
 * proibidas), literal de IP privado/especial/metadados (IPv4+IPv6+IPv4-mapped),
 * hostnames locais/metadados por convenção, hosts numéricos e comprimento.
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

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname) return fail("SOURCE_URL_HOST", "host ausente");
  if (looksLikeNumericHost(hostname)) return fail("SOURCE_URL_NUMERIC_HOST", "host numérico não é permitido");
  if (isBlockedIpLiteral(hostname)) return fail("SOURCE_URL_PRIVATE_IP", "endereço IP privado/especial bloqueado");
  if (isLocalHostname(hostname)) return fail("SOURCE_URL_LOCAL_HOST", "hostname local/metadados bloqueado");

  return { ok: true, url, hostname };
}
