/**
 * C.3.4.3.1 — Deteção ALSO no upload manual: preview COMPLETO (BD) do cenário de staging
 *
 * O mesmo ficheiro de staging (TSV sem header, 10 linhas) passa pelo caminho
 * exato do upload manual — uploadSource() + previewSupplierImport() — com um
 * NOME GENÉRICO (sem "pricelist"): antes do fix isto caía no parser genérico e
 * o preview ficava inutilizável; agora entra no parser ALSO existente
 * (parseAlsoPricelist, reutilizado — não há segundo parser) e o preview mostra
 * supplierSku, nome, custo e stock corretos, com o preço de venda calculado
 * pelo motor MDTech (C.1/C.2) — nunca pelo ficheiro.
 *
 * preview_only: nada é aplicado; a BD do catálogo fica intacta.
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { db } from "@/db";
import {
  products,
  productSuppliers,
  suppliers,
  supplierImportRows,
  supplierImports,
  stockMovements,
  users,
  pricingRules,
} from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { previewSupplierImport } from "@/lib/services/supplier-import-service";
import { uploadSource } from "@/lib/supplier-import/source";

const TAG = "C343DET";
const MANAGER = { id: 9746, email: "c343-detect@test.local", name: "C343 Detect", role: "manager" as const };

let supplierId = 0;

// O ficheiro de staging (mesma forma que o teste puro): TSV sem header, 10 linhas,
// colunas posicional ALSO (ProductID, EAN, 3x CategoryText, Description,
// AvailableQuantity, NetPrice, MPN, Brand) e EANs com checksum válido.
const STAGING_ROWS: string[][] = [
  ["1203387", "4017858000003", "Networking", "Routers", "Gaming Routers", "HP 3y PickupRtrn 324", "120", "189.99", "J2P32A", "HP"],
  ["1204001", "4008321741189", "PCs", "Desktops", "All-in-One", "HP All-in-One 27 27-aa0005", "45", "349.00", "51A22EA", "HP"],
  ["1204555", "4895903520108", "Audio", "Headsets", "Gaming", "HyperX Cloud II Wired Headset", "8", "129.95", "HMBS260", "HyperX"],
  ["1205000", "4711234567899", "Storage", "SSDs", "M.2 NVMe", "Samsung 980 Pro 2TB", "-1", "179.90", "MZ-V8P2T0B", "Samsung"],
  ["1205123", "4043677000122", "Monitors", "27 inch", "QHD", "LG UltraGear 27GP850", "33", "289.00", "27GP850-B", "LG"],
  ["1206001", "4260101234568", "Keyboards", "Mechanical", "RGB", "Logitech G Pro X TKL", "17", "199.99", "910-006024", "Logitech"],
  ["1206100", "4017858999994", "Networking", "Switches", "Gigabit", "HP 8-Port Gigabit Ethernet Switch", "55", "59.90", "J6V89A", "HP"],
  ["1207000", "4710654891713", "Laptops", "15 inch", "Core i5", "Lenovo IdeaPad 3 15", "12", "429.00", "82M200QSPB", "Lenovo"],
  ["1208000", "4017858111112", "Accessories", "Mouse", "Gaming", "Razer DeathAdder V2", "200", "69.99", "RZ03-03210100", "Razer"],
  ["1209000", "4895903111221", "Chargers", "USB-C", "65W", "Anker 65W GaN Charger", "75", "45.00", "A2665", "Anker"],
];
const STAGING_FILE = STAGING_ROWS.map((r) => r.join("\t")).join("\r\n") + "\r\n";

async function cleanupTag() {
  const taggedProducts = await db.select({ id: products.id }).from(products).where(sql`sku LIKE ${`${TAG}%`}`);
  const ids = taggedProducts.map((p) => p.id);
  if (ids.length) {
    const idList = sql.join(ids.map((id) => sql`${id}`), sql`, `);
    await db.execute(sql`DELETE FROM stock_movements WHERE product_id IN (${idList})`);
    await db.execute(sql`DELETE FROM product_suppliers WHERE product_id IN (${idList})`);
    await db.execute(sql`DELETE FROM supplier_import_rows WHERE product_id IN (${idList})`);
    await db.delete(products).where(sql`id IN (${idList})`);
  }
  await db.execute(sql`DELETE FROM supplier_import_rows WHERE import_id IN (SELECT id FROM supplier_imports WHERE user_id = ${MANAGER.id})`);
  await db.execute(sql`DELETE FROM supplier_imports WHERE user_id = ${MANAGER.id}`);
  await db.execute(sql`DELETE FROM pricing_rules WHERE notes LIKE ${`${RULE_NOTES}%`}`);
}

const RULE_NOTES = `engine rule for ${TAG}`;

/**
 * Regra do motor MDTech (C.1) para este fornecedor: markup 20% sobre custo +
 * IVA 23% do produto → o preço de venda do preview vem do motor, nunca do
 * ficheiro. Semeada no beforeEach (DEPOIS do cleanup) para cada teste nascer
 * com a regra intacta.
 */
async function seedEngineRule() {
  await db.insert(pricingRules).values({
    scope: "supplier", supplierId, method: "markup_on_cost", ratePercent: "20",
    roundingPolicy: "auto", notes: RULE_NOTES, isActive: true,
  });
}

beforeAll(async () => {
  await db.insert(users).values({ id: MANAGER.id, email: MANAGER.email, password: "x", name: MANAGER.name, role: MANAGER.role }).onConflictDoNothing();
  const [s] = await db.insert(suppliers).values({ name: `${TAG} Supplier` }).returning();
  supplierId = s.id;
});
afterAll(async () => {
  await db.execute(sql`DELETE FROM audit_logs WHERE user_id = ${MANAGER.id}`);
  await cleanupTag();
  await db.execute(sql`DELETE FROM audit_logs WHERE user_id = ${MANAGER.id}`);
  await db.execute(sql`DELETE FROM suppliers WHERE name LIKE ${`${TAG}%`}`);
  await db.execute(sql`DELETE FROM users WHERE id = ${MANAGER.id}`);
});
beforeEach(async () => {
  await cleanupTag();
  await seedEngineRule();
});

describe("C.3.4.3.1 — staging end-to-end: upload manual com nome genérico", () => {
  it("10 linhas → 0 erros, 10 novos; preview com supplierSku/nome/custo/stock corretos (motor MDTech calcula o preço)", async () => {
    const preview = await previewSupplierImport({
      supplierId,
      source: uploadSource({ fileName: "also-export.txt", csvText: STAGING_FILE }),
      userId: MANAGER.id,
    });

    // O formato efetivo é o ALSO pricelist (nada de fallback C.3.2, nada de CSV genérico)
    expect(preview.fileName).toBe("also-export.txt");
    expect(preview.delimiter).toBe("\t");
    expect(preview.mapping["ProductID"]).toBe("supplierSku");
    expect(preview.mapping["NetPrice"]).toBe("costPrice");

    // Resumo do staging corrigido: 10 linhas, 0 erros, 0 atualizar, 10 novos
    const s = preview.summary as Record<string, unknown>;
    expect(s.total).toBe(10);
    expect(s.errors).toBe(0);
    expect(s.ready).toBe(0);
    expect(s.newProducts).toBe(10);
    expect(s.conflicts).toBe(0);
    expect(s.actionable).toBe(10);

    // Linha 1: supplierSku, nome, custo e stock corretos no preview
    const first = preview.lines[0];
    expect(first.supplierSku).toBe("1203387");
    expect(first.name).toBe("HP 3y PickupRtrn 324");
    expect(first.costPrice).toBe("189.99");
    expect(first.stock).toBe(120);
    expect(first.status).toBe("new_product");
    // Preço de venda calculado pelo motor MDTech (20% markup + IVA 23% + arredondamento comercial)
    expect(first.computedPrice).toBe("280.90");
    expect(first.issues.filter((i) => i.severity === "error")).toHaveLength(0);
    // Metadados ALSO preservados até ao preview
    expect(first.alsoManufacturerPartNumber).toBe("J2P32A");
    expect(first.alsoManufacturerName).toBe("HP");
    expect(first.alsoCategoryPath).toBe("Networking / Routers / Gaming Routers");

    // Linha 4: sentinela -1 → stock nulo (warning), custo íntegro, linha utilizável
    const fourth = preview.lines[3];
    expect(fourth.supplierSku).toBe("1205000");
    expect(fourth.stock).toBeNull();
    expect(fourth.costPrice).toBe("179.90");
    expect(fourth.status).toBe("new_product");
    expect(fourth.issues.some((i) => i.code === "AVAILABLE_NEXT_QUANTITY_UNKNOWN")).toBe(true);
    expect(fourth.computedPrice).toBe("265.90");

    // Metadados persistidos no snapshot (supplier_import_rows)
    const [snap] = await db.select().from(supplierImportRows)
      .where(eq(supplierImportRows.importId, preview.importId)).limit(1);
    expect(snap.manufacturerPartNumber).toBe("J2P32A");
    expect(snap.manufacturerName).toBe("HP");
    expect(snap.supplierCategoryPath).toBe("Networking / Routers / Gaming Routers");

    // preview_only: a importação fica em "preview" — nada é aplicado
    const [imp] = await db.select({ status: supplierImports.status }).from(supplierImports).where(eq(supplierImports.id, preview.importId));
    expect(imp.status).toBe("preview");
  });

  it("produto correspondente (via supplierSku): custo + preço do motor no preview; catálogo intacto (nunca auto-apply)", async () => {
    const sku = `${TAG}-MATCH`;
    const [product] = await db.insert(products).values({
      name: "HP 3y PickupRtrn 324", slug: `${sku.toLowerCase()}-det`, sku,
      price: "12.30", costPrice: "10.00", vatRate: "23.00", priceMode: "auto", stock: 3,
    }).returning();
    await db.insert(productSuppliers).values({
      productId: product.id, supplierId, supplierSku: "1203387", costPrice: "10.00", isPreferred: true,
    });

    const preview = await previewSupplierImport({
      supplierId,
      source: uploadSource({ fileName: "download.txt", csvText: STAGING_FILE }),
      userId: MANAGER.id,
    });

    const first = preview.lines[0];
    expect(first.status).toBe("ready");
    expect(first.matchType).toBe("supplier_sku");
    expect(first.productId).toBe(product.id);
    expect(first.costPrice).toBe("189.99");
    expect(first.costBefore).toBe("10.00");
    expect(first.stock).toBe(120);
    expect(first.stockBefore).toBe(3);
    expect(first.computedPrice).toBe("280.90");
    expect(first.priceMessage).toBeNull();

    // As 9 restantes linhas continuam novas (só a linha 1 casa no catálogo)
    const rest = preview.lines.slice(1);
    expect(rest.every((l) => l.status === "new_product")).toBe(true);

    // preview_only — a BD de catálogo NÃO muda:
    const [p] = await db.select().from(products).where(eq(products.id, product.id));
    expect(p.price).toBe("12.30");
    expect(p.costPrice).toBe("10.00");
    expect(p.stock).toBe(3);
    const [link] = await db.select().from(productSuppliers)
      .where(eq(productSuppliers.productId, product.id));
    expect(link.costPrice).toBe("10.00");
    const movements = await db.select({ id: stockMovements.id }).from(stockMovements).where(eq(stockMovements.productId, product.id));
    expect(movements).toHaveLength(0);
  });
});
