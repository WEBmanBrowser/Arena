/**
 * C.3.4.5 — Hierarquia de categorias ALSO (CategoryText1..3 estruturados).
 *
 * Cobre o algoritmo aprovado:
 *  - Cadeia completa 3 níveis via preview→apply de produto NOVO (única fonte:
 *    os 3 campos estruturados; o path de display nunca é splittado).
 *  - Níveis vazios ignorados (A,NULL,C → A→C); 3×NULL = nenhuma categoria,
 *    produto novo com categoryId NULL (linhas legadas incluídas).
 *  - Reutilização pelo pai certo; mesmo nome em pais diferentes é OK;
 *    idempotente; concorrência arbitrada pela UNIQUE global de slug.
 *  - Identidade = caminho canónico length-prefixed com hash 128 bits:
 *    "A / B" num nível ≠ dois níveis; "Café" ≠ "Cafe"; NFD/zero-width
 *    normalizam no canónico mas o nome raw nunca é adoptado por outrem.
 *  - Slug legível cortado a 120; ocupação humana do slug k=0 desvia para
 *    #gen:1 determinístico; esgotar as gerações falha FECHADO (linha erro,
 *    produto não criado, nunca ligação errada).
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { db } from "@/db";
import { products, productSuppliers, suppliers, supplierImports, supplierImportRows, users, categories } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { previewSupplierImport, applySupplierImport } from "@/lib/services/supplier-import-service";
import { uploadSource } from "@/lib/supplier-import/source";
import { ensureCategoryHierarchy, alsoCategorySlug, canonicalCategoryPath } from "@/lib/supplier-import/category-hierarchy";

const TAG = "C345HIER";
const MANAGER = { id: 9745, email: "c345-hier@test.local", name: "C345 Hier", role: "manager" as const };

let supplierId = 0;

function pricelistTxt(rows: Array<Record<string, string>>): string {
  const cols = (r: Record<string, string>) => [
    r.ProductID ?? "PID",
    r.EuropeanArticleNumber ?? "5901234123457",
    r.CategoryText1 ?? "",
    r.CategoryText2 ?? "",
    r.CategoryText3 ?? "",
    r.Description ?? "Produto",
    r.AvailableQuantity ?? "5",
    r.NetPrice ?? "10,00",
    r.ManufacturerPartNumber ?? "MPN",
    r.ManufacturerName ?? "BrandX",
  ].join("\t");
  return rows.map(cols).join("\n");
}

async function alsoPreview(rows: Array<Record<string, string>>) {
  return previewSupplierImport({
    supplierId,
    source: uploadSource({ fileName: "pricelist-1.txt", csvText: pricelistTxt(rows) }),
    userId: MANAGER.id,
  });
}

async function categoryCount(): Promise<number> {
  const [r] = await db.select({ c: sql<string>`count(*)` }).from(categories);
  return Number(r.c);
}

async function nodeByName(name: string) {
  const [n] = await db.select().from(categories).where(eq(categories.name, name)).limit(1);
  return n ?? null;
}

async function taggedProductIds(): Promise<number[]> {
  // Os produtos criados pelo serviço recebem SKU interno minted (nunca o TAG);
  // apanhamo-los pelo nome/slug derivado das Description do ficheiro.
  const tagged = await db.select({ id: products.id }).from(products).where(sql`name LIKE ${`%C345%`} OR slug LIKE ${`%c345%`}`);
  return tagged.map((p) => p.id);
}

async function cleanupTag() {
  await db.execute(sql`DELETE FROM supplier_import_rows WHERE import_id IN (SELECT id FROM supplier_imports WHERE user_id = ${MANAGER.id})`);
  await db.execute(sql`DELETE FROM supplier_imports WHERE user_id = ${MANAGER.id}`);
  const ids = await taggedProductIds();
  if (ids.length) {
    const idList = sql.join(ids.map((id) => sql`${id}`), sql`,`);
    await db.execute(sql`DELETE FROM stock_movements WHERE product_id IN (${idList})`);
    await db.execute(sql`DELETE FROM product_suppliers WHERE product_id IN (${idList})`);
    await db.delete(products).where(sql`id IN (${idList})`);
  }
  // Categorias criadas pelas suítes C.3.4.5: todos os nomes/slugs de teste
  // contêm "345" (impostores incluídos). Produtos já removidos em cima.
  await db.execute(sql`DELETE FROM categories WHERE name LIKE ${`%345%`} OR slug LIKE ${`%345%`}`);
}

beforeAll(async () => {
  await db.insert(users).values({ id: MANAGER.id, email: MANAGER.email, password: "x", name: MANAGER.name, role: MANAGER.role }).onConflictDoNothing();
  const [a] = await db.insert(suppliers).values({ name: `${TAG} Supplier` }).returning();
  supplierId = a.id;
});

afterAll(async () => {
  await cleanupTag();
  await db.execute(sql`DELETE FROM audit_logs WHERE user_id = ${MANAGER.id}`);
  await db.execute(sql`DELETE FROM suppliers WHERE name LIKE ${`${TAG}%`}`);
  await db.execute(sql`DELETE FROM users WHERE id = ${MANAGER.id}`);
});

beforeEach(async () => {
  await cleanupTag();
});

describe("C.3.4.5 — cadeia completa via preview→apply (produto novo)", () => {
  it("cria Raiz→Meio→Folha, liga o produto à folha e é idempotente à 2ª passagem", async () => {
    const before = await categoryCount();
    const preview = await alsoPreview([
      { ProductID: "PID-NEW-1", Description: "Prod C345 A", CategoryText1: "Raiz345", CategoryText2: "Meio345", CategoryText3: "Folha345", NetPrice: "12,00" },
    ]);
    expect(preview.lines[0].status).toBe("new_product");
    expect(preview.lines[0].alsoCategoryText1).toBe("Raiz345");
    expect(preview.lines[0].alsoCategoryText2).toBe("Meio345");
    expect(preview.lines[0].alsoCategoryText3).toBe("Folha345");
    expect(preview.lines[0].alsoCategoryPath).toBe("Raiz345 / Meio345 / Folha345"); // display intacto

    await applySupplierImport({ importId: preview.importId, previewToken: preview.previewToken, userId: MANAGER.id });

    const root = await nodeByName("Raiz345");
    const mid = await nodeByName("Meio345");
    const leaf = await nodeByName("Folha345");
    expect(root && mid && leaf).toBeTruthy();
    expect(mid!.parentId).toBe(root!.id);
    expect(leaf!.parentId).toBe(mid!.id);

    const [prod] = await db.select().from(products).where(sql`name = 'Prod C345 A'`).limit(1);
    expect(prod).toBeTruthy();
    expect(prod.categoryId).toBe(leaf!.id);

    expect(await categoryCount()).toBe(before + 3);

    // Segunda passagem (novo import, mesma cadeia): reutiliza, created=0.
    const preview2 = await alsoPreview([
      { ProductID: "PID-NEW-2", EuropeanArticleNumber: "4006381333931", Description: "Prod C345 B", CategoryText1: "Raiz345", CategoryText2: "Meio345", CategoryText3: "Folha345" },
    ]);
    const ensured2 = await ensureCategoryHierarchy(db, ["Raiz345", "Meio345", "Folha345"]);
    expect(ensured2).toMatchObject({ ok: true, categoryId: leaf!.id, created: 0 });
    await applySupplierImport({ importId: preview2.importId, previewToken: preview2.previewToken, userId: MANAGER.id });
    const [prod2] = await db.select().from(products).where(sql`name = 'Prod C345 B'`).limit(1);
    expect(prod2).toBeTruthy();
    expect(prod2.categoryId).toBe(leaf!.id);
    expect(await categoryCount()).toBe(before + 3);
  });
});

describe("C.3.4.5 — níveis vazios são ignorados", () => {
  it("A,NULL,C → A→C (ligação ao não-vazio mais específico)", async () => {
    const res = await ensureCategoryHierarchy(db, ["RaizE345", null, "FolhaE345"]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const root = await nodeByName("RaizE345");
    const leaf = await nodeByName("FolhaE345");
    expect(root && leaf).toBeTruthy();
    expect(res.created).toBe(2);
    expect(res.categoryId).toBe(leaf!.id);
    expect(leaf!.parentId).toBe(root!.id);
    expect(await nodeByName("NULL")).toBeNull();
  });

  it("só o último nível; só o primeiro nível; cadeia vazia", async () => {
    const onlyLast = await ensureCategoryHierarchy(db, [null, null, "Unica345"]);
    expect(onlyLast).toMatchObject({ ok: true, created: 1 });
    const onlyFirst = await ensureCategoryHierarchy(db, ["So345", null, null]);
    expect(onlyFirst).toMatchObject({ ok: true, created: 1, categoryId: (await nodeByName("So345"))!.id });

    const before = await categoryCount();
    const empty = await ensureCategoryHierarchy(db, [null, null, null]);
    expect(empty).toMatchObject({ ok: true, categoryId: null, created: 0 });
    expect(await categoryCount()).toBe(before);
  });
});

describe("C.3.4.5 — 3×NULL: nenhuma categoria, produto novo com categoryId NULL", () => {
  it("preview→apply de linha sem CategoryText (e linha legada a NULL) não cria categorias", async () => {
    const before = await categoryCount();
    const preview = await alsoPreview([
      { ProductID: "PID-NEW-3", Description: "Prod C345 SemCat", CategoryText1: "", CategoryText2: "", CategoryText3: "" },
    ]);
    expect(preview.lines[0].status).toBe("new_product");
    expect(preview.lines[0].alsoCategoryText1).toBeNull();
    expect(preview.lines[0].alsoCategoryText2).toBeNull();
    expect(preview.lines[0].alsoCategoryText3).toBeNull();

    // Simula linha legada (pré-colunas): as 3 estruturadas a NULL na DB.
    await db.execute(sql`UPDATE supplier_import_rows SET supplier_category_text1 = NULL, supplier_category_text2 = NULL, supplier_category_text3 = NULL WHERE import_id = ${preview.importId}`);

    await applySupplierImport({ importId: preview.importId, previewToken: preview.previewToken, userId: MANAGER.id });

    const [prod] = await db.select().from(products).where(sql`name = 'Prod C345 SemCat'`).limit(1);
    expect(prod).toBeTruthy();
    expect(prod.categoryId).toBeNull();
    expect(await categoryCount()).toBe(before);
  });
});

describe("C.3.4.5 — reutilização pelo pai certo", () => {
  it("mesmo nome em pais diferentes → nós distintos, sem adoção errada", async () => {
    const a = await ensureCategoryHierarchy(db, ["PaiA345", "Comum345"]);
    const b = await ensureCategoryHierarchy(db, ["PaiB345", "Comum345"]);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.categoryId).not.toBe(b.categoryId);

    const comumA = await nodeByName("Comum345");
    // dois nós com o mesmo name: distingui-los pelo pai
    const comuns = await db.select().from(categories).where(eq(categories.name, "Comum345"));
    expect(comuns.length).toBe(2);
    const paiA = await nodeByName("PaiA345");
    const paiB = await nodeByName("PaiB345");
    const byParent = new Map(comuns.map((c) => [c.parentId, c.id]));
    expect(byParent.get(paiA!.id)).toBe(a.categoryId);
    expect(byParent.get(paiB!.id)).toBe(b.categoryId);
    void comumA;
  });
});

describe("C.3.4.5 — identidade pelo caminho estrutural, nunca pelo slugify", () => {
  it('"X / Y345" num nível ≠ ["X345","Y345"] em dois níveis', async () => {
    expect(canonicalCategoryPath(["a", "b c"])).toBe("v1|1:a|3:b c");
    expect(canonicalCategoryPath(["a b", "c"])).not.toBe(canonicalCategoryPath(["a", "b c"]));

    const one = await ensureCategoryHierarchy(db, ["X / Y345"]);
    const two = await ensureCategoryHierarchy(db, ["X345", "Y345"]);
    expect(one.ok && two.ok).toBe(true);
    if (!one.ok || !two.ok) return;
    const single = await nodeByName("X / Y345");
    expect(single).toBeTruthy(); // UM nó, nome intacto — nunca splittado
    expect(await nodeByName("X345")).toBeTruthy();
    const yNodes = await db.select().from(categories).where(eq(categories.name, "Y345"));
    expect(yNodes.length).toBe(1);
    expect(one.categoryId).not.toBe(two.categoryId);
  });

  it('"Café345" ≠ "Cafe345" (hash sobre o canónico, não sobre o slugify)', async () => {
    const s1 = await alsoCategorySlug(["Café345"]);
    const s2 = await alsoCategorySlug(["Cafe345"]);
    expect(s1).not.toBe(s2); // slugify colapsaria ambos para "cafe345"

    const a = await ensureCategoryHierarchy(db, ["Café345"]);
    const b = await ensureCategoryHierarchy(db, ["Cafe345"]);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.categoryId).not.toBe(b.categoryId);
  });

  it("NFD e zero-width normalizam no canónico; o nome raw nunca é adoptado por outrem", async () => {
    expect(canonicalCategoryPath(["Café345"])).toBe(canonicalCategoryPath(["Café345".normalize("NFD")]));
    expect(canonicalCategoryPath(["A345"])).toBe(canonicalCategoryPath(["\u200BA345"])); // ZWSP é Cf → removido
    expect(canonicalCategoryPath(["A345"])).toBe(canonicalCategoryPath(["\uFEFFA345"])); // BOM idem
    expect(await alsoCategorySlug(["Café345".normalize("NFD")])).toBe(await alsoCategorySlug(["Café345"]));

    const nfc = await ensureCategoryHierarchy(db, ["Café345"]);
    expect(nfc.ok).toBe(true);
    if (!nfc.ok) return;
    const nfcNode = await nodeByName("Café345");

    // Replay NFD: canónico/slug k=0 idênticos, mas nome raw difere → a regra
    // "adoptar só com name+parentId iguais" manda desviar para #gen:1 (nunca
    // adoptar um nó cujo nome difere).
    const nfd = await ensureCategoryHierarchy(db, ["Café345".normalize("NFD")]);
    expect(nfd.ok).toBe(true);
    if (!nfd.ok) return;
    expect(nfd.categoryId).not.toBe(nfcNode!.id);
    expect(nfd.created).toBe(1);
    const nfdNode = await db.select().from(categories).where(eq(categories.id, nfd.categoryId!)).limit(1);
    expect(nfdNode[0].slug).toBe(await alsoCategorySlug(["Café345".normalize("NFD")], 1));
  });
});

describe("C.3.4.5 — slug legível", () => {
  it("cap 120 no slugify da cadeia; fallback 'cat'; comprimento total 153 ≤ 255", async () => {
    const long = await alsoCategorySlug(["a".repeat(119) + "-" + "b".repeat(50)]);
    expect(long.startsWith("a".repeat(119) + "-")).toBe(true); // "-" final aparado
    expect(long.length).toBe(119 + 1 + 32);

    const capped = await alsoCategorySlug(["n".repeat(300)]);
    expect(capped.startsWith("n".repeat(120) + "-")).toBe(true);
    expect(capped.length).toBe(120 + 1 + 32);

    const fallback = await alsoCategorySlug(["///"]);
    expect(fallback.startsWith("cat-")).toBe(true);
  });
});

describe("C.3.4.5 — slug k=0 ocupado por categoria humana", () => {
  it("desvia para #gen:1 determinístico, liga ao nó certo e o replay é idempotente", async () => {
    const chain = ["RaizOcc345"];
    const occupiedSlug = await alsoCategorySlug(chain, 0);
    const [impostor] = await db.insert(categories).values({ name: "IMPOSTOR345", slug: occupiedSlug, parentId: null }).returning();

    const first = await ensureCategoryHierarchy(db, chain);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.created).toBe(1);
    expect(first.categoryId).not.toBe(impostor.id);
    const node = await db.select().from(categories).where(eq(categories.id, first.categoryId!)).limit(1);
    expect(node[0].name).toBe("RaizOcc345");
    expect(node[0].slug).toBe(await alsoCategorySlug(chain, 1));
    expect(node[0].parentId).toBeNull();

    const replay = await ensureCategoryHierarchy(db, chain);
    expect(replay).toMatchObject({ ok: true, categoryId: first.categoryId, created: 0 });
  });
});

describe("C.3.4.5 — exaustão de gerações falha fechado", () => {
  it("ensure devolve CATEGORY_SLUG_EXHAUSTED quando k=0..8 estão ocupados", async () => {
    const chain = ["RaizEx345"];
    for (let gen = 0; gen <= 8; gen += 1) {
      await db.insert(categories).values({
        name: `IMPOSTOR-${gen}-345`,
        slug: await alsoCategorySlug(chain, gen),
        parentId: null,
      }).onConflictDoNothing();
    }
    const res = await ensureCategoryHierarchy(db, chain);
    expect(res).toMatchObject({ ok: false, reason: "CATEGORY_SLUG_EXHAUSTED" });
  });

  it("no serviço: linha marca erro, produto não nasce, ninguém liga ao impostor", async () => {
    const chain = ["RaizExS345", "FolhaExS345"];
    // Ocupa TODAS as gerações do 1º nível da cadeia (o ensure falha logo aí).
    for (let gen = 0; gen <= 8; gen += 1) {
      await db.insert(categories).values({
        name: `IMPOSTORS-${gen}-345`,
        slug: await alsoCategorySlug([chain[0]], gen),
        parentId: null,
      }).onConflictDoNothing();
    }

    const before = await categoryCount();
    const preview = await alsoPreview([
      { ProductID: "PID-NEW-4", Description: "Prod C345 Ex", CategoryText1: chain[0], CategoryText2: chain[1], CategoryText3: "" },
    ]);
    await applySupplierImport({ importId: preview.importId, previewToken: preview.previewToken, userId: MANAGER.id });

    const [row] = await db.select().from(supplierImportRows).where(eq(supplierImportRows.importId, preview.importId)).limit(1);
    expect(row.status).toBe("error");
    expect(row.message).toContain("hierarquia de categorias");

    const created = await db.select().from(products).where(sql`name = 'Prod C345 Ex'`).limit(1);
    expect(created.length).toBe(0);

    // Nenhuma categoria nova além dos impostores; impostores continuam sem filhos.
    expect(await categoryCount()).toBe(before);
    const impostors = await db.select().from(categories).where(sql`name LIKE ${"IMPOSTORS-%-345"}`);
    expect(impostors.length).toBe(9);
    const [folha] = await db.select().from(categories).where(eq(categories.name, "FolhaExS345")).limit(1);
    expect(folha).toBeUndefined();
  });
});

describe("C.3.4.5 — concorrência", () => {
  it("dois ensures paralelos da mesma cadeia → um só conjunto de nós", async () => {
    const before = await categoryCount();
    const chain = ["Para345", "MeioP345", "FolhaP345"];
    const [r1, r2] = await Promise.all([
      ensureCategoryHierarchy(db, chain),
      ensureCategoryHierarchy(db, chain),
    ]);
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.categoryId).toBe(r2.categoryId);
    expect(await categoryCount()).toBe(before + 3);
  });
});
