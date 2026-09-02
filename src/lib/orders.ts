/**
 * Central order lifecycle functions.
 * All critical operations are transactional and idempotent.
 * No GREATEST() — inconsistencies cause hard failures.
 */

import { db } from "@/db";
import { orders, orderItems, products, orderStatusHistory, stockMovements, payments, coupons, ORDER_TRANSITIONS } from "@/db/schema";
import { eq, sql, and, lte } from "drizzle-orm";
import { createAuditLog } from "@/lib/audit";
import { sendEmail, orderPaidEmail, orderCancelledEmail, orderExpiredEmail, getOrderCustomerEmail } from "@/lib/email";

// ─── CONFIRM PAYMENT ──────────────────────────────────────

export async function confirmOrderPayment(orderId: number, actorId: number | null): Promise<{ success: boolean; changed: boolean; error?: string }> {
  try {
    let changed = false;
    const ctx = { orderNumber: "", userId: null as number | null, guestEmail: null as string | null };

    await db.transaction(async (tx) => {
      const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1);
      if (!order) throw new Error("VALIDATION:Encomenda não encontrada");
      if (order.status === "paid") return; // idempotent
      if (order.status !== "pending_payment") throw new Error(`VALIDATION:Não é possível confirmar pagamento no estado ${order.status}`);

      // Atomic status transition — prevents concurrent double-confirm
      const [statusUpdated] = await tx.update(orders).set({ status: "paid", paymentStatus: "paid", updatedAt: new Date() })
        .where(and(eq(orders.id, orderId), eq(orders.status, "pending_payment"))).returning();
      if (!statusUpdated) return; // Another process already confirmed

      ctx.orderNumber = order.orderNumber; ctx.userId = order.userId; ctx.guestEmail = order.guestEmail;
      changed = true;

      await tx.update(payments).set({ status: "paid", paidAt: new Date(), updatedAt: new Date() })
        .where(and(eq(payments.orderId, orderId), eq(payments.status, "pending")));

      const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId));
      for (const item of items) {
        if (!item.productId) continue;
        const [prod] = await tx.select().from(products).where(eq(products.id, item.productId)).limit(1);
        if (!prod || prod.isService) continue;

        const [updated] = await tx.update(products).set({
          stock: sql`${products.stock} - ${item.quantity}`,
          reservedStock: sql`${products.reservedStock} - ${item.quantity}`,
          soldCount: sql`${products.soldCount} + ${item.quantity}`,
          updatedAt: new Date(),
        }).where(and(eq(products.id, item.productId), sql`${products.stock} >= ${item.quantity}`, sql`${products.reservedStock} >= ${item.quantity}`)).returning();

        if (!updated) throw new Error("VALIDATION:INVENTORY_INCONSISTENCY — stock ou reserva insuficiente para confirmação");

        await tx.insert(stockMovements).values({
          productId: item.productId, type: "sale", quantity: -item.quantity,
          stockBefore: prod.stock, stockAfter: prod.stock - item.quantity,
          reservedBefore: prod.reservedStock, reservedAfter: prod.reservedStock - item.quantity,
          reason: `Pagamento confirmado #${order.orderNumber}`, referenceType: "order", referenceId: orderId, userId: actorId,
        });
      }

      await tx.insert(orderStatusHistory).values({ orderId, fromStatus: "pending_payment", toStatus: "paid", changedBy: actorId, comment: "Pagamento confirmado" });
    });

    // Post-commit — only if changed
    if (changed) {
      await createAuditLog({ userId: actorId, action: "order.payment_confirmed", entity: "order", entityId: orderId });
      const recipient = await getOrderCustomerEmail(ctx);
      if (recipient) await sendEmail({ type: "payment_confirmed", to: recipient, ...orderPaidEmail(ctx.orderNumber), referenceType: "order", referenceId: orderId, eventKey: `payment_confirmed:${orderId}` });
    }

    return { success: true, changed };
  } catch (e) {
    return { success: false, changed: false, error: (e instanceof Error ? e.message : "Erro").replace("VALIDATION:", "") };
  }
}

// ─── CANCEL ORDER ─────────────────────────────────────────

export async function cancelOrder(orderId: number, actorId: number | null, reason?: string): Promise<{ success: boolean; changed: boolean; error?: string }> {
  try {
    let changed = false;
    const ctx = { orderNumber: "", userId: null as number | null, guestEmail: null as string | null };

    await db.transaction(async (tx) => {
      const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1);
      if (!order) throw new Error("VALIDATION:Encomenda não encontrada");
      if (order.status === "cancelled") return; // idempotent
      const allowed = ORDER_TRANSITIONS[order.status] || [];
      if (!allowed.includes("cancelled")) throw new Error(`VALIDATION:Não é possível cancelar no estado ${order.status}`);

      const [statusUpdated] = await tx.update(orders).set({ status: "cancelled", paymentStatus: order.status === "pending_payment" ? "cancelled" : order.paymentStatus, updatedAt: new Date() })
        .where(and(eq(orders.id, orderId), eq(orders.status, order.status))).returning();
      if (!statusUpdated) return;

      ctx.orderNumber = order.orderNumber; ctx.userId = order.userId; ctx.guestEmail = order.guestEmail;
      changed = true;

      if (order.status === "pending_payment") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await releaseOrderReservations(tx as any, orderId, order.orderNumber, actorId);
        if (order.couponCode) {
          await tx.update(coupons).set({ usedCount: sql`${coupons.usedCount} - 1` })
            .where(and(eq(coupons.code, order.couponCode), sql`${coupons.usedCount} > 0`));
        }
      }

      await tx.update(payments).set({ status: "cancelled", updatedAt: new Date() }).where(and(eq(payments.orderId, orderId), eq(payments.status, "pending")));
      await tx.insert(orderStatusHistory).values({ orderId, fromStatus: order.status, toStatus: "cancelled", changedBy: actorId, comment: reason || "Encomenda cancelada" });
    });

    if (changed) {
      await createAuditLog({ userId: actorId, action: "order.cancelled", entity: "order", entityId: orderId, details: { reason } });
      const recipient = await getOrderCustomerEmail(ctx);
      if (recipient) await sendEmail({ type: "order_cancelled", to: recipient, ...orderCancelledEmail(ctx.orderNumber, reason), referenceType: "order", referenceId: orderId, eventKey: `order_cancelled:${orderId}` });
    }

    return { success: true, changed };
  } catch (e) {
    return { success: false, changed: false, error: (e instanceof Error ? e.message : "Erro").replace("VALIDATION:", "") };
  }
}

// ─── RELEASE EXPIRED RESERVATIONS ─────────────────────────

export async function releaseExpiredReservations(): Promise<{ expired: number }> {
  const now = new Date();
  const expiredOrders = await db.select().from(orders)
    .where(and(eq(orders.status, "pending_payment"), lte(orders.reservationExpiresAt, now)));

  let count = 0;
  for (const order of expiredOrders) {
    try {
      let changed = false;
      await db.transaction(async (tx) => {
        const [current] = await tx.update(orders).set({ status: "expired", paymentStatus: "expired", updatedAt: new Date() })
          .where(and(eq(orders.id, order.id), eq(orders.status, "pending_payment"))).returning();
        if (!current) return; // already processed
        changed = true;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await releaseOrderReservations(tx as any, order.id, order.orderNumber, null);
        if (current.couponCode) {
          await tx.update(coupons).set({ usedCount: sql`${coupons.usedCount} - 1` })
            .where(and(eq(coupons.code, current.couponCode), sql`${coupons.usedCount} > 0`));
        }
        await tx.update(payments).set({ status: "expired", updatedAt: new Date() }).where(and(eq(payments.orderId, order.id), eq(payments.status, "pending")));
        await tx.insert(orderStatusHistory).values({ orderId: order.id, fromStatus: "pending_payment", toStatus: "expired", changedBy: null, comment: "Reserva expirada" });
      });

      if (changed) {
        await createAuditLog({ userId: null, action: "order.expired", entity: "order", entityId: order.id });
        const recipient = await getOrderCustomerEmail(order);
        if (recipient) await sendEmail({ type: "order_expired", to: recipient, ...orderExpiredEmail(order.orderNumber), referenceType: "order", referenceId: order.id, eventKey: `order_expired:${order.id}` });
        count++;
      }
    } catch (e) {
      console.error(`Failed to expire order ${order.id}:`, e);
    }
  }
  return { expired: count };
}

// ─── SHARED ───────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function releaseOrderReservations(tx: any, orderId: number, orderNumber: string, actorId: number | null) {
  const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId));
  for (const item of items) {
    if (!item.productId) continue;
    const [prod] = await tx.select().from(products).where(eq(products.id, item.productId)).limit(1);
    if (!prod || prod.isService) continue;
    const [updated] = await tx.update(products).set({ reservedStock: sql`${products.reservedStock} - ${item.quantity}`, updatedAt: new Date() })
      .where(and(eq(products.id, item.productId), sql`${products.reservedStock} >= ${item.quantity}`)).returning();
    if (!updated) throw new Error("VALIDATION:INVENTORY_INCONSISTENCY — reserva insuficiente para libertação");
    await tx.insert(stockMovements).values({
      productId: item.productId, type: "reservation_released", quantity: item.quantity,
      stockBefore: prod.stock, stockAfter: prod.stock,
      reservedBefore: prod.reservedStock, reservedAfter: prod.reservedStock - item.quantity,
      reason: `Libertação #${orderNumber}`, referenceType: "order", referenceId: orderId, userId: actorId,
    });
  }
}

// ─── GENERIC STATUS TRANSITION ────────────────────────────

export async function transitionOrderStatus(orderId: number, newStatus: string, actorId: number | null, comment?: string): Promise<{ success: boolean; error?: string }> {
  if (newStatus === "paid") return confirmOrderPayment(orderId, actorId);
  if (newStatus === "cancelled") return cancelOrder(orderId, actorId, comment);
  if (newStatus === "expired") return { success: false, error: "Use releaseExpiredReservations()" };

  try {
    await db.transaction(async (tx) => {
      const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1);
      if (!order) throw new Error("VALIDATION:Encomenda não encontrada");
      if (order.status === newStatus) return;
      const allowed = ORDER_TRANSITIONS[order.status] || [];
      if (!allowed.includes(newStatus)) throw new Error(`VALIDATION:Transição inválida: ${order.status} → ${newStatus}. Permitidas: ${allowed.join(", ")}`);

      // Delivery-type backend invariant:
      // deliveryType = shipping MUST NOT transition to ready_for_pickup
      // deliveryType = pickup MUST NOT transition to shipped
      if (newStatus === "ready_for_pickup" && order.deliveryType !== "pickup") {
        throw new Error(`VALIDATION:Transição inválida para tipo de entrega ${order.deliveryType}: apenas encomendas de levantamento em loja podem ficar prontas para levantamento`);
      }
      if (newStatus === "shipped" && order.deliveryType !== "shipping") {
        throw new Error(`VALIDATION:Transição inválida para tipo de entrega ${order.deliveryType}: apenas encomendas com envio ao domicílio podem ser expedidas`);
      }

      await tx.update(orders).set({ status: newStatus, updatedAt: new Date() }).where(eq(orders.id, orderId));
      await tx.insert(orderStatusHistory).values({ orderId, fromStatus: order.status, toStatus: newStatus, changedBy: actorId, comment: comment || null });
    });
    await createAuditLog({ userId: actorId, action: "order.status_changed", entity: "order", entityId: orderId, details: { newStatus } });
    return { success: true };
  } catch (e) {
    return { success: false, error: (e instanceof Error ? e.message : "Erro").replace("VALIDATION:", "") };
  }
}
