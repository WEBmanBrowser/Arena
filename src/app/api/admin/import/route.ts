/**
 * Legacy catalogue importer (CSV → products).
 *
 * C.3.1 — this route no longer writes products.price. Not on create, not on
 * update, in either price mode:
 *
 *   - price_mode = 'manual' → the price belongs to a human; a file must never
 *     overwrite it (cost and stock may still come from the file);
 *   - price_mode = 'auto'   → the price belongs to the C.1/C.2 engine, which
 *     derives it from the cost of the PREFERRED supplier.
 *
 * So the `Preço` column is parsed and validated as before (a malformed file
 * must still be reported) but it is never written. Where the file supplies a
 * cost for the preferred supplier, the price moves through syncProductCost →
 * recalculateProductPrice, i.e. the same single implementation the product UI
 * uses — no duplicated formula, and the preview below predicts exactly what
 * that will produce.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { products, brands, categories, stockMovements, suppliers, productSuppliers, shippingClasses } from "@/db/schema";
import { eq, sql, and, inArray } from "drizzle-orm";
import { getCurrentUser, isManager } from "@/lib/auth";
import { slugify } from "@/lib/utils";
import { createAuditLog } from "@/lib/audit";
import { isValidGTIN } from "@/lib/validation";
import { parseCSV, autoMapHeaders, applyMapping, CSV_MAX_SIZE } from "@/lib/csv";
import { ensureDefaultShippingConfiguration } from "@/lib/shipping-rates";
import { syncProductCost } from "@/lib/services/product-supplier-service";
import { computeAutomaticPrice, loadPricingContext } from "@/lib/services/pricing-engine-service";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

interface ImportError { row: number; field: string; value: string; code: string; message: string; }
interface ImportResult {
  row: number; sku: string; name: string;
  action: "create" | "update" | "skip";
  errors: ImportError[];
  changes?: Record<string, { from: unknown; to: unknown }>;
  /** C.3.1: what happens to the price, and why the CSV price is not written. */
  priceNote?: string;
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user || !isManager(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

  const body = await req.json() as Record<string, unknown>;
  const csvData = body.data as string;
  const mode = (body.mode as string) || "preview";
  const importMode = (body.importMode as string) || "create_update";
  const headerMapping = (body.mapping as Record<string, string>) || {};
  const createMissingEntities = !!body.createMissingEntities;

  if (!csvData) return NextResponse.json({ error: "CSV vazio" }, { status: 400 });
  if (csvData.length > CSV_MAX_SIZE) return NextResponse.json({ error: "CSV_FILE_TOO_LARGE", message: "Ficheiro excede 5 MB" }, { status: 400 });

  // Parse CSV with real parser
  let parsed;
  try {
    parsed = parseCSV(csvData);
  } catch (e: unknown) {
    const code = e instanceof Error ? e.message : "CSV_PARSE_ERROR";
    return NextResponse.json({ error: code, message: "Erro ao processar CSV" }, { status: 400 });
  }

  // Build mapping: user-provided or auto-detected
  const mapping = Object.keys(headerMapping).length > 0 ? headerMapping : autoMapHeaders(parsed.headers);
  if (!Object.values(mapping).includes("sku")) {
    return NextResponse.json({ error: "CSV_MISSING_SKU", message: "Coluna SKU não mapeada" }, { status: 400 });
  }

  // Load reference data
  await ensureDefaultShippingConfiguration();
  const allProducts = await db.select().from(products);
  const skuMap: Record<string, typeof allProducts[0]> = {};
  allProducts.forEach(p => { if (p.sku) skuMap[p.sku] = p; });
  const allBrands = await db.select().from(brands);
  const brandNameMap: Record<string, number> = {};
  allBrands.forEach(b => { brandNameMap[b.name.toLowerCase()] = b.id; });
  const allCats = await db.select().from(categories);
  const catNameMap: Record<string, number> = {};
  allCats.forEach(c => { catNameMap[c.name.toLowerCase()] = c.id; });
  const allSuppliers = await db.select().from(suppliers);
  const allShippingClasses = await db.select().from(shippingClasses);
  const supplierNameMap: Record<string, number> = {};
  allSuppliers.forEach(s => { supplierNameMap[s.name.toLowerCase()] = s.id; });
  const shippingClassKeyMap: Record<string, { id: number; isActive: boolean }> = {};
  allShippingClasses.forEach(c => { shippingClassKeyMap[c.key.toLowerCase()] = { id: c.id, isActive: c.isActive }; shippingClassKeyMap[c.displayName.toLowerCase()] = { id: c.id, isActive: c.isActive }; });
  const defaultShippingClassId = shippingClassKeyMap.small?.id ?? null;

  // C.3.1: because a file can only move prices through the engine, the preview
  // needs the engine's own inputs — the preferred supplier link of every
  // product this file touches.
  const pricing = await loadPricingContext();
  const matchedProductIds = [...new Set(
    parsed.rows
      .map((r) => skuMap[applyMapping(r, mapping).sku || ""]?.id)
      .filter((v): v is number => typeof v === "number")
  )];
  const preferredLink = new Map<number, { supplierId: number; costPrice: string | null }>();
  if (matchedProductIds.length > 0) {
    const links = await db
      .select({ productId: productSuppliers.productId, supplierId: productSuppliers.supplierId, costPrice: productSuppliers.costPrice })
      .from(productSuppliers)
      .where(and(inArray(productSuppliers.productId, matchedProductIds), eq(productSuppliers.isPreferred, true)));
    for (const link of links) preferredLink.set(link.productId, { supplierId: link.supplierId, costPrice: link.costPrice });
  }

  const costFromRow = (mapped: Record<string, string>): string | null =>
    mapped.costPrice ? (Number.isFinite(parseFloat(mapped.costPrice.replace(",", "."))) ? parseFloat(mapped.costPrice.replace(",", ".")).toFixed(2) : null) : null;

  /** What the engine will produce for a product after this row is applied. */
  const predictEnginePrice = (
    product: (typeof allProducts)[0],
    effectiveCost: string | null,
    supplierId: number | null
  ): string | null => {
    const computation = computeAutomaticPrice(
      { ...product, costPrice: effectiveCost },
      supplierId,
      pricing.rules,
      pricing.categoryTree,
      pricing.policy
    );
    return computation.priced && computation.changed ? computation.newPrice ?? null : null;
  };

  const results: ImportResult[] = [];
  let newCount = 0, updateCount = 0, skipCount = 0, errCount = 0;

  for (let i = 0; i < parsed.rows.length; i++) {
    const mapped = applyMapping(parsed.rows[i], mapping);
    const sku = mapped.sku || "";
    const name = mapped.name || "";
    const errors: ImportError[] = [];
    const rowNum = i + 2; // +2 because header=1, 0-indexed

    if (!sku) { errors.push({ row: rowNum, field: "sku", value: "", code: "REQUIRED", message: "SKU vazio" }); }
    if (!name && !skuMap[sku]) { errors.push({ row: rowNum, field: "name", value: "", code: "REQUIRED", message: "Nome obrigatório para produto novo" }); }

    // EAN validation
    if (mapped.ean && !isValidGTIN(mapped.ean)) {
      errors.push({ row: rowNum, field: "ean", value: mapped.ean, code: "INVALID_GTIN", message: "EAN/GTIN com checksum inválido" });
    }

    // Price validation
    const price = mapped.price ? parseFloat(mapped.price.replace(",", ".")) : null;
    if (mapped.price && (isNaN(price!) || price! < 0)) {
      errors.push({ row: rowNum, field: "price", value: mapped.price, code: "INVALID_PRICE", message: "Preço inválido" });
    }

    // Stock validation
    const stockVal = mapped.stock ? parseInt(mapped.stock) : null;
    if (mapped.stock && (isNaN(stockVal!) || stockVal! < 0)) {
      errors.push({ row: rowNum, field: "stock", value: mapped.stock, code: "INVALID_STOCK", message: "Stock inválido" });
    }

    // Brand check
    let brandId: number | null = null;
    if (mapped.brand) {
      brandId = brandNameMap[mapped.brand.toLowerCase()] ?? null;
      if (!brandId && !createMissingEntities) {
        errors.push({ row: rowNum, field: "brand", value: mapped.brand, code: "BRAND_NOT_FOUND", message: `Marca desconhecida: ${mapped.brand}` });
      }
    }

    // Category check
    let categoryId: number | null = null;
    if (mapped.category) {
      categoryId = catNameMap[mapped.category.toLowerCase()] ?? null;
      if (!categoryId && !createMissingEntities) {
        errors.push({ row: rowNum, field: "category", value: mapped.category, code: "CATEGORY_NOT_FOUND", message: `Categoria desconhecida: ${mapped.category}` });
      }
    }

    // Shipping class check (optional; missing means default small for new physical products)
    let shippingClassId: number | null = null;
    if (mapped.shippingClass) {
      const cls = shippingClassKeyMap[mapped.shippingClass.toLowerCase()];
      if (!cls || !cls.isActive) {
        errors.push({ row: rowNum, field: "shippingClass", value: mapped.shippingClass, code: "SHIPPING_CLASS_NOT_FOUND", message: `Classe de envio inválida/inativa: ${mapped.shippingClass}` });
      } else {
        shippingClassId = cls.id;
      }
    }

    // Supplier check
    let supplierId: number | null = null;
    if (mapped.supplier) {
      supplierId = supplierNameMap[mapped.supplier.toLowerCase()] ?? null;
      if (!supplierId && !createMissingEntities) {
        errors.push({ row: rowNum, field: "supplier", value: mapped.supplier, code: "SUPPLIER_NOT_FOUND", message: `Fornecedor desconhecido: ${mapped.supplier}` });
      }
    }

    // Stock below reserved check
    const existing = skuMap[sku];
    if (existing && stockVal !== null && stockVal < existing.reservedStock) {
      errors.push({ row: rowNum, field: "stock", value: String(stockVal), code: "STOCK_BELOW_RESERVED", message: `Stock ${stockVal} inferior a reservas (${existing.reservedStock})` });
    }

    // Determine action
    let action: "create" | "update" | "skip" = existing ? "update" : "create";
    if (existing && importMode === "create_only") action = "skip";
    if (!existing && importMode === "update_only") action = "skip";

    if (errors.length > 0) { errCount++; action = "skip"; }

    // Track changes for preview
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    let priceNote: string | undefined;
    if (existing && action === "update") {
      // C.3.1: the CSV `Preço` column is never written. The only way this
      // import can move a price is by changing the cost of the product's
      // PREFERRED supplier, which the C.1/C.2 engine turns into a price.
      const rowCost = costFromRow(mapped);
      const link = preferredLink.get(existing.id);
      const preferredIsThisRow = !!supplierId && link?.supplierId === supplierId;
      if (existing.priceMode === "manual") {
        if (mapped.price) priceNote = "Preço manual — a coluna de preço é ignorada e products.price não é alterada";
      } else if (rowCost !== null && preferredIsThisRow && rowCost !== (link?.costPrice ?? null)) {
        const predicted = predictEnginePrice(existing, rowCost, supplierId);
        if (predicted !== null) changes.price = { from: existing.price, to: predicted };
        priceNote = "Preço recalculado pelo motor de preços a partir do custo do fornecedor preferido";
      } else if (mapped.price) {
        priceNote = "Coluna de preço ignorada — products.price é calculado pelo motor de preços";
      }
      if (stockVal !== null && stockVal !== existing.stock) changes.stock = { from: existing.stock, to: stockVal };
      if (shippingClassId !== null && shippingClassId !== existing.shippingClassId) changes.shippingClassId = { from: existing.shippingClassId, to: shippingClassId };
    }
    if (!existing && action === "create") {
      // A new product's price is also the engine's output: cost of the (new)
      // preferred supplier + the rule that applies to its category/brand.
      const rowCost = costFromRow(mapped);
      const computation = rowCost !== null && supplierId
        ? computeAutomaticPrice(
            { id: 0, price: "0.00", costPrice: rowCost, vatRate: mapped.vatRate || "23.00", categoryId, brandId, priceMode: "auto" },
            supplierId, pricing.rules, pricing.categoryTree, pricing.policy
          )
        : null;
      const predicted = computation?.priced ? computation.newPrice ?? null : null;
      if (predicted !== null) changes.price = { from: "0.00", to: predicted };
      priceNote = predicted !== null
        ? "Preço inicial definido pelo motor de preços a partir do custo do fornecedor"
        : "Sem custo de fornecedor preferido → o preço fica 0,00 € até existir custo e regra";
    }

    results.push({ row: rowNum, sku, name: name || existing?.name || "", action, errors, changes: Object.keys(changes).length ? changes : undefined, priceNote });
    if (action === "create") newCount++;
    else if (action === "update" && Object.keys(changes).length > 0) updateCount++;
    else if (action === "skip" && errors.length === 0) skipCount++;
  }

  // Preview — no writes
  if (mode === "preview") {
    return NextResponse.json({ results, summary: { total: results.length, created: newCount, updated: updateCount, skipped: skipCount, errors: errCount }, headers: parsed.headers, mapping, delimiter: parsed.delimiter });
  }

  // Execute — transactional
  if (errCount > 0) {
    return NextResponse.json({ error: "CSV contém erros. Corrija e tente novamente.", results, summary: { errors: errCount } }, { status: 400 });
  }

  try {
    let execCreated = 0, execUpdated = 0;
    await db.transaction(async (tx) => {
      for (const r of results) {
        if (r.action === "skip") continue;
        const mapped = applyMapping(parsed.rows[r.row - 2], mapping);
        // No `price` here on purpose: C.3.1 removed the direct write of
        // products.price from this importer. See the header comment.
        const stockVal = mapped.stock ? parseInt(mapped.stock) : null;
        const mappedClass = mapped.shippingClass ? shippingClassKeyMap[mapped.shippingClass.toLowerCase()] : null;
        const resolvedShippingClassId = mappedClass?.id ?? defaultShippingClassId;

        // Resolve brand/category/supplier (create if needed)
        let bid = mapped.brand ? brandNameMap[mapped.brand.toLowerCase()] : null;
        if (mapped.brand && !bid && createMissingEntities) {
          const [newBrand] = await tx.insert(brands).values({ name: mapped.brand, slug: slugify(mapped.brand) + "-" + Date.now().toString(36) }).returning();
          bid = newBrand.id;
          brandNameMap[mapped.brand.toLowerCase()] = bid;
        }
        let cid = mapped.category ? catNameMap[mapped.category.toLowerCase()] : null;
        if (mapped.category && !cid && createMissingEntities) {
          const [newCat] = await tx.insert(categories).values({ name: mapped.category, slug: slugify(mapped.category) + "-" + Date.now().toString(36) }).returning();
          cid = newCat.id;
          catNameMap[mapped.category.toLowerCase()] = cid;
        }
        let sid = mapped.supplier ? supplierNameMap[mapped.supplier.toLowerCase()] : null;
        if (mapped.supplier && !sid && createMissingEntities) {
          const [newSup] = await tx.insert(suppliers).values({ name: mapped.supplier }).returning();
          sid = newSup.id;
          supplierNameMap[mapped.supplier.toLowerCase()] = sid;
        }

        const existing = skuMap[r.sku];

        if (r.action === "create") {
          const slug = slugify(mapped.name || r.sku) + "-" + Date.now().toString(36);
          const [newProd] = await tx.insert(products).values({
            name: mapped.name || r.sku, slug, sku: r.sku,
            ean: mapped.ean || null, brandId: bid, categoryId: cid,
            // C.3.1: the file's price column is never written. A new product
            // starts at zero and is priced by the engine below, from the cost
            // of the supplier this same row links as preferred.
            price: "0.00", priceMode: "auto", vatRate: mapped.vatRate || "23.00",
            stock: stockVal ?? 0, minStock: mapped.minStock ? parseInt(mapped.minStock) : 0,
            shippingClassId: resolvedShippingClassId,
            isActive: true,
          }).returning();

          if (sid) {
            await tx.insert(productSuppliers).values({
              productId: newProd.id, supplierId: sid,
              supplierSku: mapped.supplierSku || null,
              costPrice: mapped.costPrice ? parseFloat(mapped.costPrice.replace(",", ".")).toFixed(2) : null,
              leadTimeDays: mapped.leadTimeDays ? parseInt(mapped.leadTimeDays) : null,
              isPreferred: true,
            }).onConflictDoNothing();
            // cost + price in one step, through the single shared path (C.1).
            await syncProductCost(tx as unknown as NodePgDatabase, newProd.id);
          }
          execCreated++;
        } else if (r.action === "update" && existing) {
          const updateData: Record<string, unknown> = { updatedAt: new Date() };
          if (mapped.name) { updateData.name = mapped.name; updateData.slug = slugify(mapped.name); }
          // C.3.1: `updateData.price = …` used to live here. products.price is
          // never written by an import: for price_mode='auto' the engine derives
          // it from the preferred supplier's cost (below), and for
          // price_mode='manual' nothing but a human may change it.
          if (bid) updateData.brandId = bid;
          if (cid) updateData.categoryId = cid;
          if (mapped.ean) updateData.ean = mapped.ean;
          if (mapped.vatRate) updateData.vatRate = mapped.vatRate;
          if (mapped.minStock) updateData.minStock = parseInt(mapped.minStock);
          if (mapped.shippingClass && resolvedShippingClassId) updateData.shippingClassId = resolvedShippingClassId;

          if (stockVal !== null && stockVal !== existing.stock) {
            updateData.stock = stockVal;
            // Real stock movement with correct reserved values
            await tx.insert(stockMovements).values({
              productId: existing.id, type: "import", quantity: stockVal - existing.stock,
              stockBefore: existing.stock, stockAfter: stockVal,
              reservedBefore: existing.reservedStock, reservedAfter: existing.reservedStock,
              reason: "Importação CSV", referenceType: "import", userId: user.id,
            });
          }

          await tx.update(products).set(updateData).where(eq(products.id, existing.id));

          // Supplier link
          if (sid) {
            const [existingPS] = await tx.select().from(productSuppliers)
              .where(and(eq(productSuppliers.productId, existing.id), eq(productSuppliers.supplierId, sid))).limit(1);
            if (existingPS) {
              const newCost = mapped.costPrice ? parseFloat(mapped.costPrice.replace(",", ".")).toFixed(2) : existingPS.costPrice;
              const lastCost = newCost !== existingPS.costPrice ? existingPS.costPrice : existingPS.lastCostPrice;
              await tx.update(productSuppliers).set({
                supplierSku: mapped.supplierSku || existingPS.supplierSku,
                costPrice: newCost, lastCostPrice: lastCost,
                leadTimeDays: mapped.leadTimeDays ? parseInt(mapped.leadTimeDays) : existingPS.leadTimeDays,
                updatedAt: new Date(),
              }).where(eq(productSuppliers.id, existingPS.id));
            } else {
              await tx.insert(productSuppliers).values({
                productId: existing.id, supplierId: sid,
                supplierSku: mapped.supplierSku || null,
                costPrice: mapped.costPrice ? parseFloat(mapped.costPrice.replace(",", ".")).toFixed(2) : null,
                leadTimeDays: mapped.leadTimeDays ? parseInt(mapped.leadTimeDays) : null,
                // A link created by an import is never silently made preferred.
                isPreferred: false,
              });
            }

            // Only the PREFERRED supplier's cost is authoritative for
            // products.costPrice, and only that cost may move the price — via
            // the engine, which also refuses products in manual mode.
            if (mapped.costPrice) {
              const [preferredThisSupplier] = await tx.select({ id: productSuppliers.id }).from(productSuppliers)
                .where(and(
                  eq(productSuppliers.productId, existing.id),
                  eq(productSuppliers.supplierId, sid),
                  eq(productSuppliers.isPreferred, true),
                )).limit(1);
              if (preferredThisSupplier) {
                await syncProductCost(tx as unknown as NodePgDatabase, existing.id);
              }
            }
          }
          execUpdated++;
        }
      }
    });

    await createAuditLog({ userId: user.id, action: "catalog.imported", entity: "products", details: { created: execCreated, updated: execUpdated } });
    return NextResponse.json({ results, summary: { total: results.length, created: execCreated, updated: execUpdated, skipped: skipCount, errors: 0 } });
  } catch (e) {
    console.error("Import error:", e);
    return NextResponse.json({ error: "Erro na importação — rollback completo", details: e instanceof Error ? e.message : "" }, { status: 500 });
  }
}
