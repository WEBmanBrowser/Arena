import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { orders, orderItems, products, productSuppliers, orderItemStockAllocations, orderStatusHistory, stockMovements, coupons, payments } from "@/db/schema";
import { eq, desc, sql, and } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import { generateOrderNumber } from "@/lib/utils";
import { toCents, toEuros, calcVatFromGross, lineTotal as calcLineTotal, allocateDiscount, unitPriceNet as calcUnitPriceNet, getReservationMinutes } from "@/lib/money";
import { sendEmail, orderCreatedEmail } from "@/lib/email";
import { calculateShippingForCart, ShippingRateError } from "@/lib/shipping-rates";
import { checkRateLimit, clientIp, rateLimitResponse } from "@/lib/rate-limit";
import { lockProductsAscending, lockActiveProductSuppliersAscending } from "@/lib/stock-locks";
import { checkoutOrderSchema } from "@/lib/checkout-order-schema";
import { createEupagoPayment } from "@/lib/services/eupago-payment-service";

/**
 * B.5.4 — POST /api/orders abuse protection (existing Postgres rate-limit
 * infrastructure, no new tables and no new forwarded-header trust model).
 *
 * Layered buckets:
 *  - every caller (guest or authenticated): 5 attempts / 60s / IP
 *  - authenticated callers additionally:   10 attempts / 60min / user.id
 *
 * The layering is intentional: an authenticated user can hit the 5/min IP
 * protection before reaching the 10/hour user protection. The IP bucket is
 * burst protection; the user bucket is sustained-abuse protection.
 *
 * The `clientIp()` "unknown" fallback (no cf-connecting-ip and no
 * x-forwarded-for) makes all such callers share a single bucket. Behind
 * Cloudflare/OpenNext cf-connecting-ip is always present, so in production
 * this only affects direct-to-origin traffic, which fails closed into a more
 * restrictive shared bucket. clientIp is deliberately NOT redesigned here.
 */
const ORDERS_IP_LIMIT = { limit: 5, windowSeconds: 60 } as const;
const ORDERS_USER_LIMIT = { limit: 10, windowSeconds: 60 * 60 } as const;

export async function POST(req: NextRequest) {
  try {
    // ── 0. Rate limit — BEFORE any order transaction, stock reservation,
    //       coupon mutation, payment/provider creation or email. ─────────
    const ipLimit = await checkRateLimit(`orders:create:ip:${clientIp(req)}`, ORDERS_IP_LIMIT);
    if (!ipLimit.allowed) return rateLimitResponse(ipLimit.retryAfterSeconds);

    const rateLimitedUser = await getCurrentUser();
    if (rateLimitedUser) {
      const userLimit = await checkRateLimit(`orders:create:user:${rateLimitedUser.id}`, ORDERS_USER_LIMIT);
      if (!userLimit.allowed) return rateLimitResponse(userLimit.retryAfterSeconds);
    }

    const body = await req.json();
    const parsedBody = checkoutOrderSchema.safeParse(body);
    if (!parsedBody.success) {
      return NextResponse.json({
        error: "Dados da encomenda invalidos",
        issues: parsedBody.error.issues,
      }, { status: 400 });
    }

    const { items, billingAddress, shippingAddress, paymentMethod, shippingMethod,
            deliveryType, couponCode, nif, companyName, guestEmail, guestName, guestPhone, notes } = parsedBody.data;

    const user = rateLimitedUser;

    // Resolve payment identity server-side. Authenticated customer data always
    // wins over guest fields supplied by the browser.
    const paymentCustomerEmail = user?.email ?? guestEmail ?? null;
    const paymentCustomerName = user?.name ?? guestName ?? null;
    const rawPaymentCustomerPhone = user?.phone ?? guestPhone ?? null;
    const paymentCustomerPhoneDigits = rawPaymentCustomerPhone
      ? rawPaymentCustomerPhone.replace(/\D/g, "")
      : null;
    const paymentCustomerPhone =
      paymentCustomerPhoneDigits?.startsWith("351") && paymentCustomerPhoneDigits.length === 12
        ? paymentCustomerPhoneDigits.slice(3)
        : paymentCustomerPhoneDigits;

    // Provider-specific identity requirements must fail before the order
    // transaction so no order, stock reservation or coupon mutation is created.
    if (paymentMethod === "mbway" && (!paymentCustomerPhone || !/^\d{6,15}$/.test(paymentCustomerPhone))) {
      return NextResponse.json(
        { error: "Telefone valido obrigatorio para pagamento MB WAY" },
        { status: 400 },
      );
    }

    const siteUrl =
      paymentMethod === "card"
        ? (process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || "https://loja.mdtech.pt").replace(/\/+$/, "")
        : null;

    if (paymentMethod === "card" && !paymentCustomerEmail) {
      return NextResponse.json(
        { error: "Email obrigatorio para pagamento por cartao" },
        { status: 400 },
      );
    }

    const result = await db.transaction(async (tx) => {
      // ── 1. Validate products + stock under deterministic locks ──
      // Lock local product rows first, then supplier-stock rows. Every stock
      // writer follows this same order to avoid deadlocks and overselling.
      const requestedProductIds = items.map((item) => item.productId);
      const lockedProducts = await lockProductsAscending(tx, requestedProductIds);
      const lockedSuppliers = await lockActiveProductSuppliersAscending(tx, requestedProductIds);

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
        const { productId, quantity } = item;
        const product = lockedProducts.get(productId);
        if (!product || !product.isActive) throw new Error(`VALIDATION:Produto não encontrado: ${productId}`);
        const localAvailable = Math.max(0, product.stock - product.reservedStock);
        const supplierAvailable = (lockedSuppliers.get(productId) ?? []).reduce(
          (sum, row) => sum + Math.max(0, (row.supplierStock ?? 0) - row.supplierReservedStock),
          0
        );
        const available = localAvailable + supplierAvailable;
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

      // Calculate total VAT from per-line after-discount values plus VAT embedded in gross shipping.
      let totalVatCents = 0;
      for (let i = 0; i < orderLines.length; i++) {
        const effectiveGross = orderLines[i].lineTotalCents - lineDiscounts[i];
        const { vatCents } = calcVatFromGross(effectiveGross, orderLines[i].vatRate);
        totalVatCents += vatCents;
      }
      const { vatCents: shippingVatCents } = calcVatFromGross(shippingCents, 23);
      totalVatCents += shippingVatCents;

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
        paymentMethod,
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
      //
      // Product and supplier rows were already locked during validation above.

      for (let i = 0; i < orderLines.length; i++) {
        const line = orderLines[i];
        const lineDisc = lineDiscounts[i];
        const effectiveGross = line.lineTotalCents - lineDisc;
        const { netCents, vatCents } = calcVatFromGross(effectiveGross, line.vatRate);

        const [orderItem] = await tx.insert(orderItems).values({
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
        }).returning({ id: orderItems.id });

        if (!line.product.isService) {
          const lockedProduct = lockedProducts.get(line.product.id)!;
          const localAvailable = Math.max(0, lockedProduct.stock - lockedProduct.reservedStock);
          const localQuantity = Math.min(line.quantity, localAvailable);
          let remaining = line.quantity - localQuantity;

          if (localQuantity > 0) {
            const [updated] = await tx.update(products).set({
              reservedStock: sql`${products.reservedStock} + ${localQuantity}`,
              updatedAt: new Date(),
            }).where(and(
              eq(products.id, line.product.id),
              sql`${products.stock} - ${products.reservedStock} >= ${localQuantity}`
            )).returning();
            if (!updated) throw new Error(`VALIDATION:Stock local insuficiente para ${line.product.name} (concorrência)`);

            await tx.insert(orderItemStockAllocations).values({
              orderItemId: orderItem.id,
              allocationType: "local",
              productSupplierId: null,
              quantity: localQuantity,
              status: "reserved",
            });

            await tx.insert(stockMovements).values({
              productId: line.product.id, type: "reservation_created", quantity: localQuantity,
              stockBefore: lockedProduct.stock, stockAfter: lockedProduct.stock,
              reservedBefore: lockedProduct.reservedStock, reservedAfter: lockedProduct.reservedStock + localQuantity,
              reason: `Reserva #${orderNumber}`, referenceType: "order", referenceId: order.id, userId: user?.id ?? null,
            });
          }

          for (const supplierRow of lockedSuppliers.get(line.product.id) ?? []) {
            if (remaining <= 0) break;
            const supplierAvailable = Math.max(0, (supplierRow.supplierStock ?? 0) - supplierRow.supplierReservedStock);
            const supplierQuantity = Math.min(remaining, supplierAvailable);
            if (supplierQuantity <= 0) continue;

            const [updated] = await tx.update(productSuppliers).set({
              supplierReservedStock: sql`${productSuppliers.supplierReservedStock} + ${supplierQuantity}`,
              updatedAt: new Date(),
            }).where(and(
              eq(productSuppliers.id, supplierRow.id),
              sql`coalesce(${productSuppliers.supplierStock}, 0) - ${productSuppliers.supplierReservedStock} >= ${supplierQuantity}`
            )).returning({ id: productSuppliers.id });
            if (!updated) throw new Error(`VALIDATION:Stock de fornecedor insuficiente para ${line.product.name} (concorrência)`);

            await tx.insert(orderItemStockAllocations).values({
              orderItemId: orderItem.id,
              allocationType: "supplier",
              productSupplierId: supplierRow.id,
              quantity: supplierQuantity,
              status: "reserved",
            });
            remaining -= supplierQuantity;
          }

          if (remaining > 0) throw new Error(`VALIDATION:Stock insuficiente para ${line.product.name} (concorrência)`);
        }
      }

      // ── 7. Create payment record ────────────────────────────
      if (paymentMethod === "bank_transfer") {
        await tx.insert(payments).values({
          orderId: order.id, provider: "manual", method: "bank_transfer",
          amount: toEuros(totalCents), currency: "EUR", status: "pending",
        });
      }

      // ── 8. Record initial status ────────────────────────────
      await tx.insert(orderStatusHistory).values({
        orderId: order.id, fromStatus: null, toStatus: "pending_payment",
        changedBy: user?.id ?? null, comment: "Encomenda criada",
      });

      return { order, totalCents };
    });

    // Provider payment creation happens only after the order/stock transaction
    // has committed. A provider failure must never make the API claim that the
    // already-created order itself failed.
    let paymentResult: Awaited<ReturnType<typeof createEupagoPayment>> | null = null;
    let paymentProvisioningError = false;

    if (paymentMethod !== "bank_transfer") {
      try {
        paymentResult = await createEupagoPayment({
          orderId: result.order.id,
          method: paymentMethod,
          amountCents: result.totalCents,
          actorId: user?.id ?? null,
          customerName: paymentCustomerName,
          customerEmail: paymentCustomerEmail,
          ...(paymentMethod === "mbway"
            ? {
                customerPhone: paymentCustomerPhone!,
                countryCode: "351",
              }
            : {}),
          ...(paymentMethod === "card"
            ? {
                successUrl: `${siteUrl}/checkout/sucesso?order=${encodeURIComponent(result.order.orderNumber)}`,
                failUrl: `${siteUrl}/checkout/falha?order=${encodeURIComponent(result.order.orderNumber)}`,
                backUrl: `${siteUrl}/checkout/falha?order=${encodeURIComponent(result.order.orderNumber)}`,
              }
            : {}),
        });
      } catch (error) {
        paymentProvisioningError = true;
        console.error("Post-commit Eupago provisioning error:", {
          orderId: result.order.id,
          paymentMethod,
          error,
        });
      }
    }

    // Post-commit email is best-effort. A notification failure must never turn
    // an already-created order into an apparent order-creation failure.
    const recipientEmail = result.order.guestEmail || (user ? user.email : null);
    if (recipientEmail) {
      try {
        const tmpl = orderCreatedEmail(result.order.orderNumber, result.order.total);
        const eventKey = `order_created:${result.order.id}`;
        await sendEmail({
          type: "order_created",
          to: recipientEmail,
          ...tmpl,
          referenceType: "order",
          referenceId: result.order.id,
          eventKey,
        });
      } catch (error) {
        console.error("Post-commit order email error:", {
          orderId: result.order.id,
          error,
        });
      }
    }

    const payment =
      paymentMethod === "bank_transfer"
        ? {
            method: "bank_transfer" as const,
            outcome: "pending" as const,
          }
        : paymentProvisioningError
          ? {
              method: paymentMethod,
              outcome: "provisioning_error" as const,
            }
          : paymentResult?.outcome === "created"
            ? {
                method: paymentMethod,
                outcome: "created" as const,
                ...(paymentMethod === "multibanco"
                  ? {
                      entity: paymentResult.attempt.providerEntity,
                      reference: paymentResult.attempt.providerReference,
                      expiresAt: paymentResult.attempt.expiresAt?.toISOString() ?? null,
                    }
                  : {}),
                ...(paymentMethod === "card"
                  ? { redirectUrl: paymentResult.redirectUrl ?? null }
                  : {}),
              }
            : paymentResult?.outcome === "rejected"
              ? {
                  method: paymentMethod,
                  outcome: "rejected" as const,
                  code: paymentResult.code,
                }
              : paymentResult?.outcome === "reconciliation_required"
                ? {
                    method: paymentMethod,
                    outcome: "reconciliation_required" as const,
                    code: paymentResult.code,
                  }
                : {
                    method: paymentMethod,
                    outcome: "provisioning_error" as const,
                  };

    return NextResponse.json({
      order: {
        id: result.order.id,
        orderNumber: result.order.orderNumber,
        total: result.order.total,
        status: result.order.status,
        paymentStatus: result.order.paymentStatus,
        paymentMethod: result.order.paymentMethod,
      },
      payment,
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
