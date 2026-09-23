import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { products, coupons, loyaltyVouchers } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import { getAvailableLoyaltyPointsTx } from "@/lib/services/loyalty-point-reservation-service";
import { toCents, toEuros, calcVatFromGross, lineTotal } from "@/lib/money";
import { calculateShippingForCart, ShippingRateError } from "@/lib/shipping-rates";
import { getSupplierAvailabilityByProductIds } from "@/lib/supplier-stock";

/**
 * POST /api/cart/quote
 * Server-side cart recalculation. The frontend must use these values for display.
 * Accepts: { items: [{productId, quantity}], couponCode?, deliveryType? }
 * Returns: validated products with current prices, totals, stock status
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { items, couponCode, deliveryType, loyaltyVoucherCode, loyaltyPoints } = body;

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
      localAvailableStock: number;
      supplierAvailableStock: number;
      stockSource: "service" | "local" | "supplier" | "none";
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

      const localAvailable = Math.max(0, product.stock - product.reservedStock);
      const supplierAvailability = await getSupplierAvailabilityByProductIds(db, [product.id]);
      const supplierAvailable = supplierAvailability.get(product.id) ?? 0;
      const available = localAvailable + supplierAvailable;
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
        localAvailableStock: product.isService ? 999 : localAvailable,
        supplierAvailableStock: product.isService ? 0 : supplierAvailable,
        stockSource: product.isService ? "service" : localAvailable > 0 ? "local" : supplierAvailable > 0 ? "supplier" : "none",
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

    let loyaltyDiscountCents = 0;
    let loyaltyInfo: { type: "voucher" | "points"; points: number; code?: string } | null = null;
    let loyaltyError: string | null = null;
    const user = await getCurrentUser();
    const requestedPoints = Number(loyaltyPoints || 0);
    const afterCouponCents = subtotalCents - discountCents;
    if (loyaltyVoucherCode || requestedPoints) {
      if (!user) loyaltyError = "Inicie sessão para utilizar pontos ou vales";
      else if (loyaltyVoucherCode && requestedPoints) loyaltyError = "Escolha um vale ou pontos, não ambos";
      else if (loyaltyVoucherCode) {
        const code = String(loyaltyVoucherCode).trim().toUpperCase();
        const [voucher] = await db.select().from(loyaltyVouchers).where(and(eq(loyaltyVouchers.code, code), eq(loyaltyVouchers.userId, user.id))).limit(1);
        if (!voucher || voucher.status !== "active") loyaltyError = "Vale inválido, indisponível ou já utilizado";
        else if (voucher.valueCents > afterCouponCents) loyaltyError = "O valor do vale é superior ao valor dos produtos após cupão";
        else { loyaltyDiscountCents = voucher.valueCents; loyaltyInfo = { type: "voucher", points: voucher.points, code: voucher.code }; }
      } else if (!Number.isInteger(requestedPoints) || requestedPoints < 100 || requestedPoints % 100 !== 0) loyaltyError = "Os pontos devem ser um múltiplo inteiro de 100";
      else if (requestedPoints > afterCouponCents) loyaltyError = "Os pontos selecionados excedem o valor dos produtos após cupão";
      else {
        const available = await getAvailableLoyaltyPointsTx(db, user.id);
        if (available < requestedPoints) loyaltyError = "Saldo de pontos insuficiente";
        else { loyaltyDiscountCents = requestedPoints; loyaltyInfo = { type: "points", points: requestedPoints }; }
      }
    }
    const totalDiscountCents = discountCents + loyaltyDiscountCents;
    const afterDiscountCents = subtotalCents - totalDiscountCents;
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
      discount: toEuros(totalDiscountCents),
      couponDiscount: toEuros(discountCents),
      loyaltyDiscount: toEuros(loyaltyDiscountCents),
      shipping: toEuros(shippingCents),
      vat: toEuros(adjustedVatCents),
      total: toEuros(totalCents),
      coupon: couponInfo,
      couponError,
      loyalty: loyaltyInfo,
      loyaltyError,
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
