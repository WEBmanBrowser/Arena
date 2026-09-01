import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { products, coupons } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { toCents, toEuros, calcVatFromGross, lineTotal } from "@/lib/money";
import { calculateShippingForCart, ShippingRateError } from "@/lib/shipping-rates";

/**
 * POST /api/cart/quote
 * Server-side cart recalculation. The frontend must use these values for display.
 * Accepts: { items: [{productId, quantity}], couponCode?, deliveryType? }
 * Returns: validated products with current prices, totals, stock status
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { items, couponCode, deliveryType } = body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: "Carrinho vazio" }, { status: 400 });
    }

    const quoteLines: Array<{
      productId: number;
      name: string;
      slug: string;
      sku: string | null;
      quantity: number;
      unitPriceGross: string;
      vatRate: string;
      unitPriceNet: string;
      vatAmount: string;
      lineTotal: string;
      inStock: boolean;
      availableStock: number;
      isService: boolean;
      priceChanged: boolean;
    }> = [];

    let subtotalCents = 0;
    let totalVatCents = 0;

    for (const item of items) {
      const productId = parseInt(item.productId);
      const quantity = Math.max(1, Math.min(100, parseInt(item.quantity) || 1));

      if (!productId) {
        return NextResponse.json({ error: "ID de produto inválido", code: "INVALID_PRODUCT_ID" }, { status: 400 });
      }

      const [product] = await db.select().from(products)
        .where(eq(products.id, productId))
        .limit(1);

      if (!product) {
        return NextResponse.json({ error: `Produto não encontrado: ${productId}`, code: "PRODUCT_NOT_FOUND", productId }, { status: 400 });
      }
      if (!product.isActive) {
        return NextResponse.json({ error: `Produto indisponível: ${product.name}`, code: "PRODUCT_UNAVAILABLE", productId }, { status: 400 });
      }

      const available = product.stock - product.reservedStock;
      const inStock = product.isService || available >= quantity;
      const unitPriceCents = toCents(product.price);
      const vatRate = parseFloat(product.vatRate);
      const lineTotalCents = lineTotal(unitPriceCents, quantity);
      const { netCents, vatCents } = calcVatFromGross(lineTotalCents, vatRate);

      subtotalCents += lineTotalCents;
      totalVatCents += vatCents;

      // Check if price changed from what frontend may have stored
      const frontendPrice = item.price ? toCents(item.price) : null;
      const priceChanged = frontendPrice !== null && frontendPrice !== unitPriceCents;

      quoteLines.push({
        productId: product.id,
        name: product.name,
        slug: product.slug,
        sku: product.sku,
        quantity,
        unitPriceGross: toEuros(unitPriceCents),
        vatRate: vatRate.toFixed(2),
        unitPriceNet: toEuros(netCents / quantity || 0),
        vatAmount: toEuros(vatCents),
        lineTotal: toEuros(lineTotalCents),
        inStock,
        availableStock: product.isService ? 999 : available,
        isService: product.isService,
        priceChanged,
      });
    }

    // Coupon
    let discountCents = 0;
    let couponInfo: { code: string; type: string; value: string } | null = null;
    let couponError: string | null = null;

    if (couponCode) {
      const [coupon] = await db.select().from(coupons)
        .where(eq(coupons.code, couponCode.toUpperCase()))
        .limit(1);

      if (!coupon || !coupon.isActive) {
        couponError = "Cupão inválido ou inativo";
      } else {
        const now = new Date();
        if (coupon.expiresAt && new Date(coupon.expiresAt) <= now) {
          couponError = "Cupão expirado";
        } else if (coupon.startsAt && new Date(coupon.startsAt) > now) {
          couponError = "Cupão ainda não é válido";
        } else if (coupon.maxUses && coupon.usedCount >= coupon.maxUses) {
          couponError = "Cupão esgotado";
        } else if (coupon.minPurchase && subtotalCents < toCents(coupon.minPurchase)) {
          couponError = `Compra mínima: ${coupon.minPurchase}€`;
        } else {
          if (coupon.type === "percentage") {
            discountCents = Math.round(subtotalCents * parseFloat(coupon.value) / 100);
          } else {
            discountCents = Math.min(toCents(coupon.value), subtotalCents);
          }
          couponInfo = { code: coupon.code, type: coupon.type, value: coupon.value };
        }
      }
    }

    const afterDiscountCents = subtotalCents - discountCents;
    const shippingQuote = await calculateShippingForCart({
      items: quoteLines.map((line) => ({ productId: line.productId, quantity: line.quantity })),
      deliveryType: deliveryType === "pickup" ? "pickup" : "shipping",
      merchandiseAfterDiscountCents: afterDiscountCents,
    });
    const shippingCents = shippingQuote.shippingCents;
    const totalCents = afterDiscountCents + shippingCents;

    // Recalculate VAT on discounted merchandise, then add VAT embedded in gross shipping.
    const discountRatio = subtotalCents > 0 ? afterDiscountCents / subtotalCents : 1;
    const merchandiseVatCents = Math.round(totalVatCents * discountRatio);
    const { vatCents: shippingVatCents } = calcVatFromGross(shippingCents, 23);
    const adjustedVatCents = merchandiseVatCents + shippingVatCents;

    const allInStock = quoteLines.every(l => l.inStock);
    const anyPriceChanged = quoteLines.some(l => l.priceChanged);

    return NextResponse.json({
      lines: quoteLines,
      subtotal: toEuros(subtotalCents),
      discount: toEuros(discountCents),
      shipping: toEuros(shippingCents),
      vat: toEuros(adjustedVatCents),
      total: toEuros(totalCents),
      coupon: couponInfo,
      couponError,
      allInStock,
      anyPriceChanged,
      freeShippingThreshold: shippingQuote.freeShippingThresholdEuros,
      shippingClass: shippingQuote.winningClass ? { key: shippingQuote.winningClass.key, displayName: shippingQuote.winningClass.displayName } : null,
      freeShippingApplied: shippingQuote.freeShippingApplied,
    });
  } catch (e) {
    if (e instanceof ShippingRateError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
    }
    console.error("Cart quote error:", e);
    return NextResponse.json({ error: "Erro ao calcular carrinho" }, { status: 500 });
  }
}
