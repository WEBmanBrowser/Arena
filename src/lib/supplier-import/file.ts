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

/** Formatos de ficheiro de fornecedor suportados — apenas CSV nesta etapa. */
export const SUPPLIER_FILE_FORMATS = ["csv"] as const;
export type SupplierFileFormat = (typeof SUPPLIER_FILE_FORMATS)[number];

/**
 * Texto do ficheiro do fornecedor → contrato normalizado, seja qual for o
 * formato. O preview deve chamar SEMPRE esta função (nunca um parser concreto),
 * para que um segundo formato nasça já ligado ao mesmo pipeline.
 */
export function parseSupplierFile(
  text: string,
  overrides?: Record<string, string>,
  format: SupplierFileFormat = "csv"
): SupplierFileParse {
  switch (format) {
    case "csv":
      // Ramo CSV — delega no parser original C.3.1 (regras intocadas).
      return parseSupplierCsv(text, overrides);
    default: {
      // Inalcançável com o tipo fechado; guarda o valor fora da união em runtime.
      throw new Error(`FILE_FORMAT_NOT_SUPPORTED: ${String(format)}`);
    }
  }
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
