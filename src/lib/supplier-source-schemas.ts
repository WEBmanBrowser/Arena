/**
 * C.3.4.2 — Zod schemas para a administração de FONTES de fornecedor.
 *
 * Padrão do repo (b22-schemas / pricing-rules-schemas): a BD (migration 0012)
 * já impõe CHECKs; estas schemas existem para a API responder 400 com motivo
 * seguro em vez de deixar escapar um 500 do driver. Regras de segurança que
 * VIVEM aqui (e são re-verificadas no fetch, em depth):
 *
 *  - URL: passa GUARDA PURA `guardSupplierSourceUrl` — HTTPS, sem userinfo,
 *    sem query string, sem fragmento, sem IP literal, sem localhost/metadados.
 *    É o mesmo validador usado pelo `fetchSource` (uma só fonte de verdade
 *    para a política de URL — create, edit, fetch inicial e cada redirect);
 *  - `enabled` NÃO existe no create: uma fonte nova nasce SEMPRE desativada
 *    (default da BD). Ativar é um ato explícito e separado (PATCH);
 *  - o valor de um segredo NUNCA é aceite por API: só `secret_reference`
 *    (nome de variável de ambiente, maiúsculas + dígitos + underscore);
 *  - `headers_config` é só config NÃO-secreta: nomes de header válidos, sem
 *    nomes reservados de transporte/autenticação (Authorization, Cookie…), sem
 *    CRLF; para auth=header a chave reservada `headerName` é obrigatória.
 */
import { z } from "zod";
import {
  FORBIDDEN_SOURCE_HEADERS,
  SOURCE_AUTH_TYPES,
  SOURCE_SECRET_HEADER_KEY,
  guardSupplierSourceUrl,
} from "@/lib/supplier-import/source";

/** Nome de env: exatamente o que `resolveSourceSecret` aceitará ler. */
export const SECRET_REFERENCE_RE = /^[A-Z][A-Z0-9_]{0,254}$/;
/** Header name = token HTTP (RFC 7230) — espelha o verificador do fetch. */
export const HEADER_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

const headersConfigSchema = z
  .record(z.string(), z.string())
  .superRefine((config, ctx) => {
    for (const [name, value] of Object.entries(config)) {
      if (name === SOURCE_SECRET_HEADER_KEY) {
        // A chave reservada transporta APENAS o nome do header do segredo.
        if (!HEADER_TOKEN_RE.test(value) || (FORBIDDEN_SOURCE_HEADERS as readonly string[]).includes(value.toLowerCase())) {
          ctx.addIssue({
            code: "custom",
            path: [SOURCE_SECRET_HEADER_KEY],
            message: "Nome de header do secret inválido ou reservado",
          });
        }
        continue;
      }
      if (!HEADER_TOKEN_RE.test(name) || (FORBIDDEN_SOURCE_HEADERS as readonly string[]).includes(name.toLowerCase())) {
        ctx.addIssue({ code: "custom", path: [name], message: "Nome de header inválido ou reservado" });
      }
      if (/[\r\n\0]/.test(value) || value.length > 2048) {
        ctx.addIssue({ code: "custom", path: [name], message: "Valor de header inválido" });
      }
    }
    if (Object.keys(config).length > 32) {
      ctx.addIssue({ code: "custom", message: "Demasiados headers configurados (máx. 32)" });
    }
  });

/** Campos partilhados por create/update (update aplica .partial() em cima). */
const sourceFields = {
  supplierId: z.coerce.number().int().positive(),
  name: z.string().trim().min(1).max(100),
  /**
   * Apenas HTTPS, SEM query string nem fragmento (fail-closed C.3.4.2 —
   * tokens nunca em URLs persistidas); as guardas puras são a política.
   */
  url: z
    .string()
    .trim()
    .min(1)
    .max(1000)
    .superRefine((url, ctx) => {
      const guard = guardSupplierSourceUrl(url);
      if (!guard.ok) {
        ctx.addIssue({ code: "custom", message: guard.message });
      }
    }),
  format: z.enum(["auto", "csv", "xlsx"]).default("auto"),
  authType: z.enum(SOURCE_AUTH_TYPES).default("none"),
  /** Não-secreto: só o username do Basic Auth. A password NUNCA é aceite aqui. */
  username: z.string().trim().min(1).max(255).nullish(),
  /** APENAS a referência (nome de env). O valor vive no runtime, nunca na BD. */
  secretReference: z.string().regex(SECRET_REFERENCE_RE, "Use um nome de variável de ambiente (ex.: SUPPLIER_SRC_12_TOKEN)").nullish(),
  headersConfig: headersConfigSchema.nullish(),
  /** NULL = perfil normal do fornecedor (C.3.2) — o default da UI. */
  profileId: z.coerce.number().int().positive().nullish(),
};

function requireAuth(config: {
  authType: string;
  username?: string | null;
  secretReference?: string | null;
  headersConfig?: Record<string, string> | null;
}, ctx: z.RefinementCtx): void {
  const needsSecret = config.authType !== "none";
  if (needsSecret && !config.secretReference) {
    ctx.addIssue({ code: "custom", path: ["secretReference"], message: "Autenticação exige secret_reference (nome do secret no runtime)" });
  }
  if (config.authType === "basic" && !config.username) {
    ctx.addIssue({ code: "custom", path: ["username"], message: "Basic Auth exige o username (não-secreto)" });
  }
  if (config.authType === "header" && !config.headersConfig?.[SOURCE_SECRET_HEADER_KEY]) {
    ctx.addIssue({
      code: "custom",
      path: ["headersConfig"],
      message: `auth=header exige headers_config.${SOURCE_SECRET_HEADER_KEY} (o NOME do header; o valor vem do secret)`,
    });
  }
  if (config.authType === "none") {
    // "Nenhuma" autenticação não tem segredo nem username: valores recebidos
    // são normalizados abaixo (na rota) em vez de persistir config morta.
    if (config.secretReference || config.username) {
      ctx.addIssue({ code: "custom", path: ["authType"], message: "authType=none não aceita username nem secret_reference" });
    }
  }
}

export const supplierSourceCreateSchema = z.object(sourceFields).superRefine(requireAuth);

/**
 * Update: só os campos enviados mudam (PATCH-semântica); `supplierId` é
 * IMUTÁVEL e não entra. A rota valida em DUAS fases:
 *  1. o patch contra esta schema (forma de cada campo, url quando enviada);
 *  2. o ESTADO FINAL ({ ...row, ...patch, supplierId: row.supplierId }) contra
 *     `supplierSourceCreateSchema` — assim as validações cruzadas de auth são
 *     verificadas sobre a combinação real (ex.: trocar authType para "bearer"
 *     numa linha sem secret_reference falha aqui, não em runtime).
 */
export const supplierSourceUpdateSchema = z.object(sourceFields).omit({ supplierId: true }).partial();

export const supplierSourceEnabledSchema = z.object({ enabled: z.boolean() });

export type SupplierSourceCreateInput = z.infer<typeof supplierSourceCreateSchema>;
export type SupplierSourceUpdateInput = z.infer<typeof supplierSourceUpdateSchema>;
