import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { orders, orderItems, products, orderStatusHistory, stockMovements, coupons, payments } from "@/db/schema";
import { eq, desc, sql, and } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import { generateOrderNumber } from "@/lib/utils";
import { toCents, toEuros, calcVatFromGross, lineTotal as calcLineTotal, allocateDiscount, unitPriceNet as calcUnitPriceNet, getReservationMinutes } from "@/lib/money";
import { sendEmail, orderCreatedEmail } from "@/lib/email";
import { calculateShippingForCart, ShippingRateError } from "@/lib/shipping-rates";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { items, billingAddress, shippingAddress, paymentMethod, shippingMethod,
            deliveryType, couponCode, nif, companyName, guestEmail, guestName, guestPhone, notes } = body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: "Carrinho vazio" }, { status: 400 });
    }

    const user = await getCurrentUser();

    const result = await db.transaction(async (tx) => {
      // ── 1. Validate products ────────────────────────────────
      let subtotalCents = 0;
      const orderLines: Array<{
        product: typeof products.$inferSelect;
        quantity: number;
        unitGrossCents: number;
        unitNetCents: number;
        lineTotalCents: number;
        vatRate: number;
        vatCents: number;
      }> = [];

      for (const item of items) {
        const productId = parseInt(item.productId);
        const quantity = parseInt(item.quantity);
        if (!productId || !quantity || quantity < 1 || quantity > 100) {
          throw new Error("VALIDATION:Dados do produto inválidos");
        }
        const [product] = await tx.select().from(products)
          .where(and(eq(products.id, productId), eq(products.isActive, true))).limit(1);
        if (!product) throw new Error(`VALIDATION:Produto não encontrado: ${productId}`);
        const available = product.stock - product.reservedStock;
        if (!product.isService && available < quantity) {
          throw new Error(`VALIDATION:Stock insuficiente para ${product.name}. Disponível: ${available}`);
        }

        const unitGrossCents = toCents(product.price);
        const vatRate = parseFloat(product.vatRate);
        const unitNetCents = calcUnitPriceNet(unitGrossCents, vatRate);
        const lineTotalCents = calcLineTotal(unitGrossCents, quantity);
        const { vatCents } = calcVatFromGross(lineTotalCents, vatRate);

        subtotalCents += lineTotalCents;
        orderLines.push({ product, quantity, unitGrossCents, unitNetCents, lineTotalCents, vatRate, vatCents });
      }

      // ── 2. Validate coupon — FAIL-CLOSED ────────────────────
      let discountCents = 0;
      let validatedCouponCode: string | null = null;
      let couponId: number | null = null;

      if (couponCode) {
        // Atomic coupon consumption: UPDATE ... WHERE conditions
        const [coupon] = await tx.select().from(coupons)
          .where(eq(coupons.code, couponCode.toUpperCase())).limit(1);

        if (!coupon || !coupon.isActive) {
          throw new Error("VALIDATION:COUPON_NO_LONGER_VALID — Cupão inválido ou inativo");
        }
        const now = new Date();
        if (coupon.expiresAt && new Date(coupon.expiresAt) <= now) throw new Error("VALIDATION:COUPON_NO_LONGER_VALID — Cupão expirado");
        if (coupon.startsAt && new Date(coupon.startsAt) > now) throw new Error("VALIDATION:COUPON_NO_LONGER_VALID — Cupão ainda não válido");
        if (coupon.minPurchase && subtotalCents < toCents(coupon.minPurchase)) throw new Error(`VALIDATION:COUPON_NO_LONGER_VALID — Compra mínima: ${coupon.minPurchase}€`);

        // Atomic max_uses check via UPDATE WHERE
        const [updated] = await tx.update(coupons).set({
          usedCount: sql`${coupons.usedCount} + 1`,
        }).where(and(
          eq(coupons.id, coupon.id),
          eq(coupons.isActive, true),
          sql`(${coupons.maxUses} IS NULL OR ${coupons.usedCount} < ${coupons.maxUses})`
        )).returning();

        if (!updated) throw new Error("VALIDATION:COUPON_NO_LONGER_VALID — Cupão esgotado (concorrência)");

        discountCents = coupon.type === "percentage"
          ? Math.round(subtotalCents * parseFloat(coupon.value) / 100)
          : Math.min(toCents(coupon.value), subtotalCents);
        validatedCouponCode = coupon.code;
        couponId = coupon.id;
      }

      // ── 3. Allocate discount per line ───────────────────────
      const lineDiscounts = allocateDiscount(orderLines.map(l => ({ lineTotalCents: l.lineTotalCents })), discountCents);

      // ── 4. Calculate totals ─────────────────────────────────
      const afterDiscountCents = subtotalCents - discountCents;
      const delivery = deliveryType === "pickup" ? "pickup" : "shipping";
      const shippingQuote = await calculateShippingForCart({
        items: orderLines.map((line) => ({ productId: line.product.id, quantity: line.quantity })),
        deliveryType: delivery,
        merchandiseAfterDiscountCents: afterDiscountCents,
      }, tx as typeof db);
      const shippingCents = shippingQuote.shippingCents;
      const totalCents = afterDiscountCents + shippingCents;

      // Calculate total VAT from per-line after-discount values
      let totalVatCents = 0;
      for (let i = 0; i < orderLines.length; i++) {
        const effectiveGross = orderLines[i].lineTotalCents - lineDiscounts[i];
        const { vatCents } = calcVatFromGross(effectiveGross, orderLines[i].vatRate);
        totalVatCents += vatCents;
      }

      const orderNumber = generateOrderNumber();
      const reservationMs = getReservationMinutes() * 60 * 1000;

      // ── 5. Create order ─────────────────────────────────────
      const [order] = await tx.insert(orders).values({
        orderNumber,
        userId: user?.id ?? null,
        guestEmail: !user ? (guestEmail || null) : null,
        guestName: !user ? (guestName || null) : null,
        guestPhone: !user ? (guestPhone || null) : null,
        status: "pending_payment",
        subtotal: toEuros(subtotalCents),
        shipping: toEuros(shippingCents),
        discount: toEuros(discountCents),
        vat: toEuros(totalVatCents),
        total: toEuros(totalCents),
        paymentMethod: paymentMethod || "bank_transfer",
        paymentStatus: "pending",
        shippingMethod: delivery === "pickup" ? "store_pickup" : (shippingQuote.winningClass?.key || shippingMethod || null),
        deliveryType: delivery,
        couponCode: validatedCouponCode,
        nif: nif || null,
        companyName: companyName || null,
        billingAddress: billingAddress || null,
        shippingAddress: shippingAddress || null,
        notes: notes || null,
        reservationExpiresAt: new Date(Date.now() + reservationMs),
      }).returning();

      // ── 6. Create order items with full financial snapshot ──
      for (let i = 0; i < orderLines.length; i++) {
        const line = orderLines[i];
        const lineDisc = lineDiscounts[i];
        const effectiveGross = line.lineTotalCents - lineDisc;
        const { netCents, vatCents } = calcVatFromGross(effectiveGross, line.vatRate);

        await tx.insert(orderItems).values({
          orderId: order.id,
          productId: line.product.id,
          productName: line.product.name,
          productSku: line.product.sku,
          quantity: line.quantity,
          unitPriceGross: toEuros(line.unitGrossCents),
          unitPriceNet: toEuros(line.unitNetCents),
          vatRate: line.vatRate.toFixed(2),
          vatAmount: toEuros(vatCents),
          discountAmount: toEuros(lineDisc),
          lineTotalGross: toEuros(effectiveGross),
        });

        // Reserve stock
        if (!line.product.isService) {
          const [updated] = await tx.update(products).set({
            reservedStock: sql`${products.reservedStock} + ${line.quantity}`,
            updatedAt: new Date(),
          }).where(and(
            eq(products.id, line.product.id),
            sql`${products.stock} - ${products.reservedStock} >= ${line.quantity}`
          )).returning();
          if (!updated) throw new Error(`VALIDATION:Stock insuficiente para ${line.product.name} (concorrência)`);

          await tx.insert(stockMovements).values({
            productId: line.product.id, type: "reservation_created", quantity: line.quantity,
            stockBefore: line.product.stock, stockAfter: line.product.stock,
            reservedBefore: line.product.reservedStock, reservedAfter: line.product.reservedStock + line.quantity,
            reason: `Reserva #${orderNumber}`, referenceType: "order", referenceId: order.id, userId: user?.id ?? null,
          });
        }
      }

      // ── 7. Create payment record ────────────────────────────
      await tx.insert(payments).values({
        orderId: order.id, provider: "manual", method: paymentMethod || "bank_transfer",
        amount: toEuros(totalCents), currency: "EUR", status: "pending",
      });

      // ── 8. Record initial status ────────────────────────────
      await tx.insert(orderStatusHistory).values({
        orderId: order.id, fromStatus: null, toStatus: "pending_payment",
        changedBy: user?.id ?? null, comment: "Encomenda criada",
      });

      return order;
    });

    // Post-commit email
    const recipientEmail = result.guestEmail || (user ? user.email : null);
    if (recipientEmail) {
      const tmpl = orderCreatedEmail(result.orderNumber, result.total);
      const eventKey = `order_created:${result.id}`;
      await sendEmail({ type: "order_created", to: recipientEmail, ...tmpl, referenceType: "order", referenceId: result.id, eventKey });
    }

    return NextResponse.json({
      order: { id: result.id, orderNumber: result.orderNumber, total: result.total, status: result.status, paymentStatus: result.paymentStatus, paymentMethod: result.paymentMethod },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Erro ao criar encomenda";
    if (e instanceof ShippingRateError) return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
    if (msg.startsWith("VALIDATION:")) return NextResponse.json({ error: msg.replace("VALIDATION:", "") }, { status: 400 });
    console.error("Order creation error:", e);
    return NextResponse.json({ error: "Erro ao criar encomenda" }, { status: 500 });
  }
}

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
    const userOrders = await db.select().from(orders).where(eq(orders.userId, user.id)).orderBy(desc(orders.createdAt));
    return NextResponse.json({ orders: userOrders });
  } catch {
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
