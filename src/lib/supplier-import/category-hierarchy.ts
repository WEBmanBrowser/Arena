/**
 * C.3.4.5 — Hierarquia de categorias ALSO (CategoryText1 → 2 → 3 → Produto).
 *
 * IDENTIDADE
 *  A identidade de um nó é o CAMINHO ESTRUTURAL normalizado até esse nível
 *  (`canonicalPath`, length-prefixed e versionado). O `slug` é uma função PURA
 *  desse caminho — nunca do estado da base de dados, da ordem dos imports, do
 *  relógio ou de aleatoriedade:
 *
 *      slug = `<readable>-<hash32>`
 *      hash32   = SHA-256(UTF-8(canonicalPath)) hex, truncado a 32 chars (128 bits)
 *      readable = slugify(nomes da cadeia), cortado a 120 chars
 *
 *  - O hash come sobre `canonicalPath` (Unicode NFC, case-fold, whitespace
 *    normalizado, níveis length-prefixed) — NUNCA sobre o `slugify` — por isso
 *    caminhos distintos que o slugify colapse ("Café" vs "Cafe", "A / B" num
 *    nível vs níveis "A","B") produzem slugs distintos.
 *  - Colisão de 128 bits é criptograficamente desprezável; o sufixo
 *    determinístico `"\n#gen:k"` (k=1..8, também com 128 bits) existe apenas
 *    para o caso de o slug calculado estar ocupado por uma linha NÃO
 *    correspondente (categoria humana/estranha). A sondagem nunca define
 *    identidade: cada k é função pura do caminho.
 *
 * ADOÇÃO PÓS-ON CONFLICT
 *  `INSERT … ON CONFLICT (slug) DO NOTHING` + re-select: o nó só é adoptado se
 *  `name` E `parentId` corresponderem. Nunca se adopta uma categoria errada;
 *  esgotar a sondagem falha fechado (a linha não é aplicada).
 *
 * CONCORRÊNCIA
 *  A unique global de `categories.slug` é o árbitro: dois workers com o mesmo
 *  caminho calculam o mesmo slug, um insere, o outro re-selecciona e adopta.
 *  Não é necessária `UNIQUE(parent_id, name)`.
 *
 * Web Crypto apenas (crypto.subtle) — Cloudflare Workers / OpenNext compatible.
 * SERVER-ONLY: toca a base de dados; nunca importado por código cliente.
 */

import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { categories } from "@/db/schema";
import { slugify } from "@/lib/utils";

/** Teto da coluna `categories.slug` (varchar(255)) — nunca alcançado: 120+1+32=153. */
const SLUG_MAX_LENGTH = 255;
/** Comprimento máximo da parte legível do slug. */
const READABLE_MAX_LENGTH = 120;
/** Hex chars do hash (32 hex = 128 bits). */
const HASH_HEX_LENGTH = 32;
/** Tentativas determinísticas quando o slug calculado está ocupado por outrem. */
const MAX_GENERATIONS = 8;
/** Fallback quando o slugify da cadeia não produz nada de legível (ex.: "///"). */
const READABLE_FALLBACK = "cat";

/** Níveis que o apply fornece (CategoryText1..3; qualquer outro comprimento é suportado). */
export type CategoryLevels = Array<string | null | undefined>;

/**
 * Normalização POR NÍVEL que alimenta o caminho canónico: NFC (ficheiros podem
 * chegar em NFD), remoção de format characters (ZWSP/ZWJ/FEFF/BOM…), runs de
 * controlo/espaços colapsados num único espaço, trim e case-fold.
 */
function normLevel(raw: string): string {
  return raw
    .normalize("NFC")
    .replace(/\p{Cf}/gu, "")
    .replace(/[\p{C}\p{Zs}]+/gu, " ")
    .trim()
    .toLowerCase();
}

/**
 * Caminho canónico — codificação length-prefixed, injectiva por construção:
 * nenhum conteúdo pode confundir a fronteira entre níveis
 * (`["a","b c"] → "v1|1:a|3:b c"` ≠ `["a b","c"] → "v1|3:a b|1:c"`).
 */
export function canonicalCategoryPath(levels: string[]): string {
  return `v1|${levels.map(normLevel).map((n) => `${n.length}:${n}`).join("|")}`;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input))
  );
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/**
 * Slug determinístico do prefixo de cadeia dado. `generation = 0` é o slug
 * normal; `generation ≥ 1` deriva de `canonicalPath + "\n#gen:k"` e serve
 * apenas para desviar de um slug ocupado por linha não correspondente.
 * Exportado para testes (plantar conflitos determinísticos).
 */
export async function alsoCategorySlug(levels: string[], generation = 0): Promise<string> {
  const canonical = canonicalCategoryPath(levels);
  const source = generation === 0 ? canonical : `${canonical}\n#gen:${generation}`;
  const hash = (await sha256Hex(source)).slice(0, HASH_HEX_LENGTH);
  const readable =
    slugify(levels.join(" ")).slice(0, READABLE_MAX_LENGTH).replace(/-+$/, "") ||
    READABLE_FALLBACK;
  const slug = `${readable}-${hash}`;
  if (slug.length > SLUG_MAX_LENGTH) {
    // Inalcançável com READABLE_MAX_LENGTH=120 + hash 32; guard explícito.
    throw new Error(`CATEGORY_SLUG_TOO_LONG: ${slug.length}`);
  }
  return slug;
}

export type EnsureCategoryResult =
  | { ok: true; categoryId: number | null; created: number }
  | { ok: false; reason: "CATEGORY_SLUG_EXHAUSTED" };

/**
 * Garante (idempotente) a cadeia de categorias para os níveis não-vazios e
 * devolve o id do nó mais específico. Níveis vazios/brancos são IGNORADOS
 * (`["A", null, "C"] → A → C`); cadeia vazia → `{ categoryId: null }` (sem
 * criação — é o comportamento das linhas sem informação estrutural, incl.
 * previews anteriores a supplier_category_text1..3).
 *
 * Corre dentro da transação do batch do apply: qualquer falha reverte o batch.
 */
export async function ensureCategoryHierarchy(
  tx: NodePgDatabase,
  levels: CategoryLevels
): Promise<EnsureCategoryResult> {
  const chain = (levels ?? [])
    .map((level) => (typeof level === "string" ? level.trim() : ""))
    .filter((level) => level.length > 0);
  if (chain.length === 0) return { ok: true, categoryId: null, created: 0 };

  let parentId: number | null = null;
  let created = 0;

  for (let depth = 1; depth <= chain.length; depth += 1) {
    const prefix = chain.slice(0, depth);
    const name = prefix[prefix.length - 1];
    let node: { id: number } | null = null;

    for (let generation = 0; generation <= MAX_GENERATIONS; generation += 1) {
      const slug = await alsoCategorySlug(prefix, generation);

      const inserted = await tx
        .insert(categories)
        .values({ name, slug, parentId })
        .onConflictDoNothing({ target: categories.slug })
        .returning({ id: categories.id });

      const [row] = await tx
        .select({ id: categories.id, name: categories.name, parentId: categories.parentId })
        .from(categories)
        .where(eq(categories.slug, slug))
        .limit(1);

      if (!row) continue; // corrida extrema (apagada entre insert e select) — próximo k

      const parentMatches = (row.parentId ?? null) === (parentId ?? null);
      if (row.name !== name || !parentMatches) continue; // ocupado por outrem — próximo k

      if (inserted.length > 0) created += 1;
      node = { id: row.id };
      break;
    }

    if (node === null) return { ok: false, reason: "CATEGORY_SLUG_EXHAUSTED" };
    parentId = node.id;
  }

  return { ok: true, categoryId: parentId, created };
}
