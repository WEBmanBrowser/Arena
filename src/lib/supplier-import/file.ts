/**
 * C.3.3 (etapa 1) — dispatcher de formatos de ficheiro de fornecedor.
 *
 * Ponto ÚNICO de entrada do parsing:
 *
 *   parseSupplierFile → SupplierFileParse → NormalizedSupplierRow[]
 *
 * Tudo a jusante (matching, preview persistido, token HMAC, apply em lotes,
 * histórico, perfis) consome o contrato normalizado e NÃO conhece o formato de
 * origem. Nesta etapa existe APENAS o ramo CSV, que delega no parser C.3.1
 * original (parseSupplierCsv em ./normalize.ts) — sem reescrever uma linha das
 * regras de parsing (aliases, deteção de delimiter, BOM, limites, números).
 * Um formato futuro (ex.: XLSX) acrescenta um case aqui e produz o MESMO
 * SupplierFileParse; nada a jusante muda.
 *
 * Aqui vive também a resolução mapping/perfil do preview (semântica C.3.2,
 * movida verbatim do serviço): é lógica pura sobre o ficheiro já parseado,
 * agnóstica ao formato — o serviço deixa de conhecer o parser concreto.
 */
import { parseSupplierCsv, type SupplierFileParse } from "./normalize";
import { parseSupplierXlsx } from "./xlsx";
import { parseAlsoPricelist, parseAlsoStock } from "./also";

/**
 * Formatos de ficheiro de fornecedor suportados.
 * C.3.3 (etapa 1): apenas "csv". C.3.3 (etapa 2): + "xlsx".
 * C.3.4.3.1: + "also_pricelist" (pricelist-1.txt TSV sem header) + "also_stock" (stock.txt TSV com header).
 */
export const SUPPLIER_FILE_FORMATS = ["csv", "xlsx", "also_pricelist", "also_stock"] as const;
export type SupplierFileFormat = (typeof SUPPLIER_FILE_FORMATS)[number];

/**
 * Texto (CSV) ou bytes (XLSX) do ficheiro do fornecedor → contrato
 * normalizado, seja qual for o formato. O preview deve chamar SEMPRE esta
 * função (nunca um parser concreto), para que um segundo formato nasça já
 * ligado ao mesmo pipeline.
 *
 * `xlsxBytes` só é usado no ramo "xlsx" (e é obrigatório nesse ramo); no ramo
 * "csv" é ignorado — o caminho CSV é EXATAMENTE o parser original C.3.1.
 */
export function parseSupplierFile(
  text: string,
  overrides?: Record<string, string>,
  format: SupplierFileFormat = "csv",
  xlsxBytes?: Uint8Array
): SupplierFileParse {
  switch (format) {
    case "csv":
      // Ramo CSV — delega no parser original C.3.1 (regras intocadas).
      return parseSupplierCsv(text, overrides);
    case "xlsx":
      // Ramo XLSX (C.3.3 etapa 2) — bytes originais do ficheiro; o mesmo
      // contrato SupplierFileParse sai daqui (delimiter = null).
      if (!xlsxBytes || xlsxBytes.byteLength === 0) {
        throw new Error("FILE_FORMAT_NOT_SUPPORTED: xlsx requer bytes");
      }
      return parseSupplierXlsx(xlsxBytes, overrides);
    case "also_pricelist":
      return parseAlsoPricelist(text, overrides);
    case "also_stock":
      return parseAlsoStock(text, overrides);
    default: {
      // Inalcançável com o tipo fechado; guarda o valor fora da união em runtime.
      throw new Error(`FILE_FORMAT_NOT_SUPPORTED: ${String(format)}`);
    }
  }
}

// ─── Classificação do nome do ficheiro (rota da API) ──────

/**
 * Formatos de spreadsheet que NÃO são suportados nesta app e que devem ser
 * recusados COM CLAREZA (FILE_TYPE_NOT_SUPPORTED) em vez de chegarem ao
 * parser CSV como texto binário legível apenas como erro genérico.
 * (.xls/.xlsm/.xltm/.xlsb/.xltx/.xlt e ODF — ver escopo C.3.3 etapa 2:
 * apenas .xlsx, sem exceções.)
 */
export const UNSUPPORTED_SPREADSHEET_EXTENSIONS = [
  "xls", "xlsm", "xltm", "xlsb", "xltx", "xlt", "ods", "fods", "ott",
] as const;

/**
 * O formato é decidido pela extensão do nome enviado pelo browser e CONFIRMADO
 * pela assinatura dos bytes no parser (ZIP/OOXML) — nunca só pela extensão.
 *
 *  - "xlsx"  → ramo binário (base64 → bytes → parseSupplierXlsx);
 *  - "csv"   → ramo texto atual (mesmo para .txt, como sempre foi);
 *  - "unsupported" → spreadsheet binário conhecido mas fora do escopo.
 */
export function classifySupplierFileName(fileName: string): "xlsx" | "csv" | "also_pricelist" | "also_stock" | "unsupported" {
  const ext = (fileName.match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();
  if (ext === "xlsx") return "xlsx";
  if ((UNSUPPORTED_SPREADSHEET_EXTENSIONS as readonly string[]).includes(ext)) return "unsupported";
  const lower = fileName.toLowerCase();
  // ALSO explicit by filename (pricelist-1.txt, stock.txt) — .txt TSV
  if (lower.endsWith(".txt")) {
    if (lower.includes("stock")) return "also_stock";
    if (lower.includes("pricelist")) return "also_pricelist";
  }
  return "csv";
}

/** O que a resolução precisa de saber sobre o perfil guardado (C.3.2). */
export interface SupplierProfileRef {
  id: number;
  mapping: Record<string, string>;
}

/** Estado de resolução do mapping para o preview (C.3.2, inalterado). */
export type ProfileResolution =
  | { type: "profile_valid"; mapping: Record<string, string>; profileId?: number }
  | { type: "profile_invalid"; reason: string; mapping: Record<string, string>; profileId?: number }
  | { type: "no_profile"; mapping: Record<string, string>; profileId?: number };

/** Verifica se o mapping do perfil ainda é compatível com os headers do ficheiro. */
export function isProfileCompatibleWithHeaders(
  profileMapping: Record<string, string>,
  fileHeaders: string[]
): boolean {
  const normalizedHeaders = fileHeaders.map((h) => h.toLowerCase().trim());
  for (const [header, field] of Object.entries(profileMapping)) {
    const headerLower = header.toLowerCase().trim();
    if (!normalizedHeaders.includes(headerLower)) {
      return false;
    }
  }
  return true;
}

export interface ResolveSupplierFileMappingOptions {
  /** Parse do ficheiro com o mapping manual (ou auto-deteção), já calculado. */
  initial: SupplierFileParse;
  /**
   * Re-parse do MESMO ficheiro com outro mapping — usado para APLICAR o perfil
   * guardado. É uma função, não texto: o resolvedor nunca conhece o formato.
   */
  reparse: (mapping: Record<string, string>) => SupplierFileParse;
  /** Mapping manual não vazio ({} conta como ausente — decidido a montante). */
  manualMapping?: Record<string, string>;
  /** Perfil guardado do fornecedor (0 ou 1), já validado como mapping legível. */
  profile: SupplierProfileRef | null;
}

/**
 * Resolução mapping/perfil do preview — semântica C.3.2 validada, movida
 * verbatim de previewSupplierImport (C.3.3 etapa 1):
 *
 *  - mapping manual NÃO vazio tem prioridade e é usado no parse;
 *  - mapping manual VAZIO é tratado como ausente (a montante);
 *  - sem mapping manual, um perfil compatível é APLICADO ao parse (re-parse);
 *  - um perfil incompatível faz fallback seguro para o parse inicial;
 *  - o `parsed` devolvido é sempre o parse do mapping REALMENTE usado — é ele
 *    que alimenta supplier_imports.mapping e as linhas do snapshot.
 *
 * O "Guardar perfil" (saveProfile) NÃO vive aqui: é uma decisão do serviço,
 * com escrita e releitura na base de dados (save → reload → só depois
 * profile_valid).
 */
export function resolveSupplierFileMapping(
  options: ResolveSupplierFileMappingOptions
): { parsed: SupplierFileParse; resolution: ProfileResolution } {
  const { initial, reparse, manualMapping, profile } = options;
  let parsed = initial;
  let resolution: ProfileResolution;

  if (profile && !manualMapping) {
    // Sem mapeamento manual, um perfil válido guardado tem prioridade: o
    // ficheiro é relido com o mapping do perfil e o snapshot
    // (supplier_imports.mapping) continua a ser o mapping realmente usado.
    if (isProfileCompatibleWithHeaders(profile.mapping, initial.headers)) {
      parsed = reparse(profile.mapping);
      resolution = { type: "profile_valid", mapping: profile.mapping, profileId: profile.id };
    } else {
      resolution = {
        type: "profile_invalid",
        reason: "O formato desta lista parece ter mudado. Confirme o mapeamento antes de continuar.",
        mapping: profile.mapping,
        profileId: profile.id,
      };
      // parsed fica o parse inicial (autoMapHeaders) — fallback seguro.
    }
  } else if (profile && manualMapping) {
    // Mapeamento manual NÃO VAZIO mantém o comportamento manual atual: o
    // ficheiro é lido com o mapeamento do operador (initial); o perfil apenas
    // informa a resolução.
    resolution = isProfileCompatibleWithHeaders(profile.mapping, initial.headers)
      ? { type: "profile_valid", mapping: profile.mapping, profileId: profile.id }
      : {
          type: "profile_invalid",
          reason: "O formato desta lista parece ter mudado. Confirme o mapeamento antes de continuar.",
          mapping: profile.mapping,
          profileId: profile.id,
        };
  } else {
    resolution = { type: "no_profile", mapping: initial.mapping };
  }

  return { parsed, resolution };
}
