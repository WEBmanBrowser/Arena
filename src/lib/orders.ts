/**
 * Central order lifecycle functions.
 * All critical operations are transactional and idempotent.
 * No GREATEST() — inconsistencies cause hard failures.
 */

import { db } from "@/db";
import { orders, orderItems, products, productSuppliers, orderItemStockAllocations, orderStatusHistory, stockMovements, payments, coupons, paymentAttempts, ORDER_TRANSITIONS } from "@/db/schema";
import { eq, sql, and, lte, asc, desc, inArray } from "drizzle-orm";
import { createAuditLog, createAuditLogTx } from "@/lib/audit";
import { sendEmail, orderPaidEmail, orderCancelledEmail, orderExpiredEmail, getOrderCustomerEmail } from "@/lib/email";
import { runPostPaymentEffects } from "@/lib/services/post-payment-coordinator";
import { enqueueEmail, dispatchEmailNotification } from "@/lib/email-outbox";
import { lockProductsAscending, lockActiveProductSuppliersAscending, type DbOrTx } from "@/lib/stock-locks";
import { consumeLoyaltyVoucherForOrderTx, releaseLoyaltyVoucherReservationForOrderTx } from "@/lib/services/loyalty-voucher-service";
import { consumeLoyaltyPointsForOrderTx, releaseLoyaltyPointsForOrderTx } from "@/lib/services/loyalty-point-reservation-service";

// ─── CONFIRM PAYMENT ──────────────────────────────────────
//
// PAYMENT P0 (items 9/21/22) — CANONICAL TRANSACTIONAL CONFIRMATION.
//
//  • EXACTLY ONE payment row is settled: the canonical one. The legacy
//    behaviour (`UPDATE payments … WHERE order_id = ? AND status = 'pending'`)
//    marked EVERY pending payment of the order as paid, which silently rewrote
//    unrelated financial rows (e.g. a manual payment plus a provider payment).
//  • The audit entry and the notification row are written INSIDE the
//    transaction: they either commit with the money movement or not at all.
//  • Stock is converted under deterministic, ascending product-id locks with
//    before/after values read under those locks (M1).
//  • NO external HTTP happens here — the notification is enqueued in-tx and
//    dispatched by the caller after the commit succeeded.

export interface CanonicalPayment {
  readonly id: number;
  readonly provider: string;
  readonly method: string;
  readonly amount: string;
  readonly currency: string;
  readonly status: string;
}

/**
 * Resolve THE payment row this confirmation settles.
 *
 * Deterministic order:
 *   1. an explicitly supplied paymentId (provider settlement always supplies it);
 *   2. the payment referenced by the newest attempt still awaiting payment;
 *   3. the single pending payment of the order;
 *   4. the single payment of the order.
 * Returns null when no payment row exists at all (legacy orders).
 */
export async function resolveCanonicalPayment(
  tx: DbOrTx,
  orderId: number,
  explicitPaymentId?: number | null
): Promise<CanonicalPayment | null> {
  if (explicitPaymentId != null) {
    const [row] = await tx
      .select()
      .from(payments)
      .where(and(eq(payments.id, explicitPaymentId), eq(payments.orderId, orderId)))
      .limit(1);
    if (!row) throw new Error("VALIDATION:Pagamento canónico não encontrado para esta encomenda");
    return row;
  }

  const [fromAttempt] = await tx
    .select({ id: payments.id })
    .from(paymentAttempts)
    .innerJoin(payments, eq(payments.id, paymentAttempts.paymentId))
    .where(
      and(
        eq(paymentAttempts.orderId, orderId),
        eq(paymentAttempts.status, "pending"),
        eq(payments.status, "pending")
      )
    )
    .orderBy(desc(paymentAttempts.id))
    .limit(1);
  if (fromAttempt) {
    const [row] = await tx.select().from(payments).where(eq(payments.id, fromAttempt.id)).limit(1);
    if (row) return row;
  }

  const pending = await tx
    .select()
    .from(payments)
    .where(and(eq(payments.orderId, orderId), eq(payments.status, "pending")))
    .orderBy(asc(payments.id));
  if (pending.length === 1) return pending[0];

  if (pending.length === 0) {
    const all = await tx.select().from(payments).where(eq(payments.orderId, orderId)).orderBy(asc(payments.id));
    return all.length === 1 ? all[0] : null;
  }

  // Several pending payments and no provider context: the oldest pending row is
  // the canonical one. The OTHERS are deliberately left untouched (never
  // silently marked paid).
  return pending[0];
}

/**
 * PAYMENT P0 (HIGH-1 / HIGH-2) — why a settlement could NOT be applied coherently.
 *
 * Returned ONLY to callers that ask for fail-closed provider settlement
 * (`settlementMustBeCoherent`). The caller is then responsible for recording the
 * durable financial anomaly (and the fund movement id) instead of reporting a
 * silent success.
 */
export type ConfirmPaymentIncoherenceCode =
  /** No canonical `payments` row exists for the order/attempt. */
  | "PAYMENT_NOT_FOUND"
  /** The canonical payment is ALREADY paid — a second movement needs intervention. */
  | "PAYMENT_ALREADY_SETTLED"
  /** The canonical payment was cancelled internally (money arrived too late). */
  | "PAYMENT_CANCELLED"
  /** The canonical payment is in any other non-pending, non-settleable state. */
  | "PAYMENT_NOT_SETTLED"
  /** The ORDER was settled by a DIFFERENT payment/movement (double charge). */
  | "ORDER_ALREADY_SETTLED_BY_OTHER_MOVEMENT"
  /** The order state cannot absorb a settlement (expired, cancelled, refunded…). */
  | "ORDER_NOT_SETTLEABLE";

export interface ConfirmPaymentIncoherence {
  readonly code: ConfirmPaymentIncoherenceCode;
  readonly detail: string;
  readonly paymentId: number | null;
}

export interface ConfirmOrderPaymentTxResult {
  readonly changed: boolean;
  readonly orderNumber: string;
  readonly paymentId: number | null;
  /** Notification row enqueued in-tx; dispatch it AFTER the commit. */
  readonly notificationId: number | null;
  /**
   * Always present: non-null means the requested settlement was REFUSED because
   * it could not be made coherent. In that case NOTHING was written by this
   * function — no order transition, no stock movement, no audit, no outbox row.
   */
  readonly incoherence: ConfirmPaymentIncoherence | null;
}

/**
 * The canonical confirmation, composed on the CALLER'S transaction.
 *
 * Used by `confirmOrderPayment()` (manual/admin flow) and, as one atomic unit,
 * by the Eupago settlement pipeline.
 */
export async function confirmOrderPaymentInTx(
  tx: DbOrTx,
  input: {
    orderId: number;
    actorId: number | null;
    paymentId?: number | null;
    source: "manual" | "provider_webhook" | "admin" | "recovery";
    /**
     * HIGH-1/HIGH-2 — when true the confirmation is FAIL-CLOSED: the canonical
     * payment must be settleable and coherent with the order, otherwise the call
     * refuses (returning `incoherence`) instead of writing a partial settlement.
     * Provider settlements pass true; the manual/admin flow keeps its historical
     * behaviour.
     */
    settlementMustBeCoherent?: boolean;
  }
): Promise<ConfirmOrderPaymentTxResult> {
  const { orderId, actorId } = input;
  const requireCoherent = input.settlementMustBeCoherent === true;

  // Deterministic lock order (M1): order → payment → products(asc).
  const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1).for("update");
  if (!order) throw new Error("VALIDATION:Encomenda não encontrada");

  const refuse = (
    code: ConfirmPaymentIncoherenceCode,
    detail: string,
    paymentId: number | null
  ): ConfirmOrderPaymentTxResult => ({
    changed: false,
    orderNumber: order.orderNumber,
    paymentId,
    notificationId: null,
    incoherence: { code, detail, paymentId },
  });

  // ─── HIGH-1/HIGH-2 COHERENCE GATE ───────────────────────
  // Everything below reads the AUTHORITATIVE rows under lock and decides BEFORE
  // any write, so a refusal leaves no partial settlement behind (no order
  // transition, no stock movement, no email). The movement evidence itself is
  // preserved by the caller (attempt row + durable financial anomaly).
  let canonical: CanonicalPayment | null = null;
  if (requireCoherent) {
    canonical = await resolveCanonicalPayment(tx, orderId, input.paymentId ?? null);
    if (canonical) {
      // Lock + re-read: the fresh row is the one the invariant is evaluated on.
      const [locked] = await tx
        .select()
        .from(payments)
        .where(eq(payments.id, canonical.id))
        .limit(1)
        .for("update");
      if (locked) canonical = locked;
    }

    if (order.status !== "pending_payment") {
      // A movement that reaches this point has JUST been claimed for THIS
      // delivery, so an order that is already settled was settled by a DIFFERENT
      // movement: the same-movement redelivery is recognised earlier (duplicate
      // claim / duplicate attempt CAS) and never reaches here. Refusing is
      // therefore unconditional and there is no "coherent repeat" shortcut to
      // take — money has no place to land and needs an operator.
      const settledRows = await tx
        .select({ id: payments.id })
        .from(payments)
        .where(and(eq(payments.orderId, orderId), eq(payments.status, "paid")));
      return order.status === "paid"
        ? refuse(
            "ORDER_ALREADY_SETTLED_BY_OTHER_MOVEMENT",
            `order already settled by payment ${settledRows.map((r) => r.id).join(",") || "(unknown)"}`,
            canonical?.id ?? null
          )
        : refuse("ORDER_NOT_SETTLEABLE", `order status ${order.status}`, canonical?.id ?? null);
    }

    if (!canonical) {
      return refuse("PAYMENT_NOT_FOUND", "no canonical payment row for this order", null);
    }
    if (canonical.status === "paid") {
      return refuse("PAYMENT_ALREADY_SETTLED", "canonical payment is already paid", canonical.id);
    }
    if (canonical.status === "cancelled") {
      return refuse("PAYMENT_CANCELLED", "canonical payment was cancelled", canonical.id);
    }
    if (canonical.status !== "pending") {
      return refuse("PAYMENT_NOT_SETTLED", `canonical payment status ${canonical.status}`, canonical.id);
    }
  } else if (order.status === "paid") {
    return { changed: false, orderNumber: order.orderNumber, paymentId: input.paymentId ?? null, notificationId: null, incoherence: null };
  } else if (order.status !== "pending_payment") {
    throw new Error(`VALIDATION:Não é possível confirmar pagamento no estado ${order.status}`);
  }

  if (!canonical) {
    canonical = await resolveCanonicalPayment(tx, orderId, input.paymentId ?? null);
    if (canonical) {
      // Lock the canonical payment row explicitly so the settlement and any
      // refund path serialize on it.
      await tx.select({ id: payments.id }).from(payments).where(eq(payments.id, canonical.id)).limit(1).for("update");
    }
  }

  const [statusUpdated] = await tx
    .update(orders)
    .set({ status: "paid", paymentStatus: "paid", updatedAt: new Date() })
    .where(and(eq(orders.id, orderId), eq(orders.status, "pending_payment")))
    .returning();
  if (!statusUpdated) {
    // Another process already confirmed. In coherent mode THIS movement did not
    // settle anything, so it must not be reported as a success.
    if (requireCoherent) {
      return refuse(
        "ORDER_ALREADY_SETTLED_BY_OTHER_MOVEMENT",
        "order state changed concurrently — settlement not applied",
        canonical?.id ?? null
      );
    }
    // Not an error, and no second effect.
    return { changed: false, orderNumber: order.orderNumber, paymentId: canonical?.id ?? null, notificationId: null, incoherence: null };
  }

  if (canonical) {
    // EXACTLY ONE payment row — the canonical one. Nothing else is touched.
    const paidRows = await tx
      .update(payments)
      .set({ status: "paid", paidAt: new Date(), updatedAt: new Date() })
      .where(and(eq(payments.id, canonical.id), eq(payments.status, "pending")))
      .returning({ id: payments.id });
    if (requireCoherent && paidRows.length === 0) {
      // The canonical payment was verified `pending` under lock, so this is an
      // internal invariant breach, not a provider situation: roll back instead of
      // committing an order marked paid with no settled payment.
      throw new Error("INCONSISTENT_CANONICAL_PAYMENT: pagamento canónico deixou de estar pendente sob lock");
    }
  }

  const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId));
  const stockItems = items.filter((item) => item.productId);
  const locked = await lockProductsAscending(tx, stockItems.map((item) => item.productId!));
  await lockActiveProductSuppliersAscending(tx, stockItems.map((item) => item.productId!));
  const allocations = stockItems.length > 0
    ? await tx.select().from(orderItemStockAllocations).where(inArray(orderItemStockAllocations.orderItemId, stockItems.map((item) => item.id)))
    : [];

  for (const item of stockItems) {
    const prod = locked.get(item.productId!);
    if (!prod || prod.isService) continue;

    const itemAllocations = allocations.filter((allocation) => allocation.orderItemId === item.id && allocation.status === "reserved");
    // Legacy orders created before allocation tracking are treated exactly as before.
    const localQuantity = itemAllocations.length === 0
      ? item.quantity
      : itemAllocations.filter((allocation) => allocation.allocationType === "local").reduce((sum, allocation) => sum + allocation.quantity, 0);

    if (localQuantity > 0) {
      const [updated] = await tx
        .update(products)
        .set({
          stock: sql`${products.stock} - ${localQuantity}`,
          reservedStock: sql`${products.reservedStock} - ${localQuantity}`,
          updatedAt: new Date(),
        })
        .where(and(
          eq(products.id, item.productId!),
          sql`${products.stock} >= ${localQuantity}`,
          sql`${products.reservedStock} >= ${localQuantity}`
        ))
        .returning();
      if (!updated) throw new Error("VALIDATION:INVENTORY_INCONSISTENCY — stock ou reserva local insuficiente para confirmação");

      await tx.insert(stockMovements).values({
        productId: item.productId!, type: "sale", quantity: -localQuantity,
        stockBefore: prod.stock, stockAfter: prod.stock - localQuantity,
        reservedBefore: prod.reservedStock, reservedAfter: prod.reservedStock - localQuantity,
        reason: `Pagamento confirmado #${order.orderNumber}`,
        referenceType: "order", referenceId: orderId, userId: actorId,
      });
    }

    // soldCount represents units sold, independently of whether they came from
    // local physical stock or an external supplier.
    await tx.update(products).set({
      soldCount: sql`${products.soldCount} + ${item.quantity}`,
      updatedAt: new Date(),
    }).where(eq(products.id, item.productId!));
  }

  if (allocations.length > 0) {
    await tx.update(orderItemStockAllocations).set({ status: "committed", updatedAt: new Date() })
      .where(and(
        inArray(orderItemStockAllocations.orderItemId, stockItems.map((item) => item.id)),
        eq(orderItemStockAllocations.status, "reserved")
      ));
  }

  await tx.insert(orderStatusHistory).values({
    orderId,
    fromStatus: "pending_payment",
    toStatus: "paid",
    changedBy: actorId,
    comment: "Pagamento confirmado",
  });

  // S33.1 — consume a reserved loyalty voucher atomically with payment
  // confirmation. Both manual/admin and provider webhook settlements converge
  // through this transaction, so the voucher can never remain reserved after a
  // successfully committed payment.
  await consumeLoyaltyVoucherForOrderTx(tx, orderId);
  await consumeLoyaltyPointsForOrderTx(tx, orderId, actorId);

  // MANDATORY financial audit inside the transaction (item 21).
  await createAuditLogTx(tx, {
    userId: actorId,
    action: "order.payment_confirmed",
    entity: "order",
    entityId: orderId,
    details: {
      paymentId: canonical?.id ?? null,
      paymentProvider: canonical?.provider ?? null,
      amount: canonical?.amount ?? null,
      currency: canonical?.currency ?? null,
      source: input.source,
    },
  });

  // Notification row inside the transaction (deduplicated by event_key).
  const recipient = await getOrderCustomerEmail(order);
  let notificationId: number | null = null;
  if (recipient) {
    const queued = await enqueueEmail(tx, {
      type: "payment_confirmed",
      recipient,
      subject: orderPaidEmail(order.orderNumber).subject,
      referenceType: "order",
      referenceId: orderId,
      eventKey: `payment_confirmed:${orderId}`,
    });
    notificationId = queued.created ? queued.id : null;
  }

  return { changed: true, orderNumber: order.orderNumber, paymentId: canonical?.id ?? null, notificationId, incoherence: null };
}

/**
 * Public confirmation entry point (admin/manual and any non-webhook caller).
 *
 * POST-COMMIT ONLY: the outbound email is dispatched after the transaction
 * commits — never inside it.
 */
export async function confirmOrderPayment(
  orderId: number,
  actorId: number | null,
  options: { paymentId?: number | null; source?: "manual" | "admin" | "recovery" } = {}
): Promise<{ success: boolean; changed: boolean; error?: string }> {
  try {
    const result = await db.transaction(async (tx) =>
      confirmOrderPaymentInTx(tx, {
        orderId,
        actorId,
        paymentId: options.paymentId ?? null,
        source: options.source ?? "manual",
      })
    );

    // Post-commit — only if something actually changed.
    if (result.changed && result.notificationId != null) {
      await dispatchEmailNotification(result.notificationId);
    }

    if (result.changed) {
      await runPostPaymentEffects({ orderId, actorId, source: options.source ?? "manual" });
    }

    return { success: true, changed: result.changed };
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
        await releaseOrderReservations(tx as any, orderId, order.orderNumber, actorId);
        if (order.couponCode) {
          await tx.update(coupons).set({ usedCount: sql`${coupons.usedCount} - 1` })
            .where(and(eq(coupons.code, order.couponCode), sql`${coupons.usedCount} > 0`));
        }
        await releaseLoyaltyVoucherReservationForOrderTx(tx, orderId);
        await releaseLoyaltyPointsForOrderTx(tx, orderId);
      }
      else {
        // Paid/processing/ready-for-pickup cancellations do not restock local
        // physical inventory (existing behaviour), but must release any
        // supplier quantity that was still held for this order.
        await releaseCommittedSupplierReservations(tx as any, orderId, "released");
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

        await releaseOrderReservations(tx as any, order.id, order.orderNumber, null);
        if (current.couponCode) {
          await tx.update(coupons).set({ usedCount: sql`${coupons.usedCount} - 1` })
            .where(and(eq(coupons.code, current.couponCode), sql`${coupons.usedCount} > 0`));
        }
        await releaseLoyaltyVoucherReservationForOrderTx(tx, order.id);
        await releaseLoyaltyPointsForOrderTx(tx, order.id);
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

async function releaseOrderReservations(tx: any, orderId: number, orderNumber: string, actorId: number | null) {
  const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId));
  const stockItems = items.filter((item: { productId: number | null }) => item.productId);
  const locked = await lockProductsAscending(tx, stockItems.map((item: { productId: number | null }) => item.productId!));
  await lockActiveProductSuppliersAscending(tx, stockItems.map((item: { productId: number | null }) => item.productId!));
  const allocations = stockItems.length > 0
    ? await tx.select().from(orderItemStockAllocations).where(inArray(orderItemStockAllocations.orderItemId, stockItems.map((item: { id: number }) => item.id)))
    : [];

  for (const item of stockItems) {
    const prod = locked.get(item.productId);
    if (!prod || prod.isService) continue;
    const itemAllocations = allocations.filter((allocation: typeof orderItemStockAllocations.$inferSelect) => allocation.orderItemId === item.id && allocation.status === "reserved");
    const localQuantity = itemAllocations.length === 0
      ? item.quantity
      : itemAllocations.filter((allocation: typeof orderItemStockAllocations.$inferSelect) => allocation.allocationType === "local").reduce((sum: number, allocation: typeof orderItemStockAllocations.$inferSelect) => sum + allocation.quantity, 0);

    if (localQuantity > 0) {
      const [updated] = await tx.update(products).set({ reservedStock: sql`${products.reservedStock} - ${localQuantity}`, updatedAt: new Date() })
        .where(and(eq(products.id, item.productId), sql`${products.reservedStock} >= ${localQuantity}`)).returning();
      if (!updated) throw new Error("VALIDATION:INVENTORY_INCONSISTENCY — reserva local insuficiente para libertação");
      await tx.insert(stockMovements).values({
        productId: item.productId, type: "reservation_released", quantity: localQuantity,
        stockBefore: prod.stock, stockAfter: prod.stock,
        reservedBefore: prod.reservedStock, reservedAfter: prod.reservedStock - localQuantity,
        reason: `Libertação #${orderNumber}`, referenceType: "order", referenceId: orderId, userId: actorId,
      });
    }
  }

  for (const allocation of allocations.filter((row: typeof orderItemStockAllocations.$inferSelect) => row.allocationType === "supplier" && row.status === "reserved")) {
    if (allocation.productSupplierId == null) throw new Error("VALIDATION:INVENTORY_INCONSISTENCY — alocação de fornecedor sem fornecedor");
    const [updated] = await tx.update(productSuppliers).set({
      supplierReservedStock: sql`${productSuppliers.supplierReservedStock} - ${allocation.quantity}`,
      updatedAt: new Date(),
    }).where(and(
      eq(productSuppliers.id, allocation.productSupplierId),
      sql`${productSuppliers.supplierReservedStock} >= ${allocation.quantity}`
    )).returning({ id: productSuppliers.id });
    if (!updated) throw new Error("VALIDATION:INVENTORY_INCONSISTENCY — reserva de fornecedor insuficiente para libertação");
  }

  if (allocations.length > 0) {
    await tx.update(orderItemStockAllocations).set({ status: "released", updatedAt: new Date() })
      .where(and(
        inArray(orderItemStockAllocations.orderItemId, stockItems.map((item: { id: number }) => item.id)),
        eq(orderItemStockAllocations.status, "reserved")
      ));
  }
}

async function releaseCommittedSupplierReservations(tx: any, orderId: number, finalStatus: "released" | "fulfilled") {
  const items = await tx.select({ id: orderItems.id, productId: orderItems.productId }).from(orderItems).where(eq(orderItems.orderId, orderId));
  const itemIds = items.map((item: { id: number }) => item.id);
  if (itemIds.length === 0) return;

  await lockProductsAscending(tx, items.flatMap((item: { productId: number | null }) => item.productId ? [item.productId] : []));
  await lockActiveProductSuppliersAscending(tx, items.flatMap((item: { productId: number | null }) => item.productId ? [item.productId] : []));
  const allocations = await tx.select().from(orderItemStockAllocations).where(and(
    inArray(orderItemStockAllocations.orderItemId, itemIds),
    eq(orderItemStockAllocations.allocationType, "supplier"),
    eq(orderItemStockAllocations.status, "committed")
  ));

  for (const allocation of allocations) {
    if (allocation.productSupplierId == null) throw new Error("VALIDATION:INVENTORY_INCONSISTENCY — alocação de fornecedor sem fornecedor");
    const [updated] = await tx.update(productSuppliers).set({
      supplierReservedStock: sql`${productSuppliers.supplierReservedStock} - ${allocation.quantity}`,
      updatedAt: new Date(),
    }).where(and(
      eq(productSuppliers.id, allocation.productSupplierId),
      sql`${productSuppliers.supplierReservedStock} >= ${allocation.quantity}`
    )).returning({ id: productSuppliers.id });
    if (!updated) throw new Error("VALIDATION:INVENTORY_INCONSISTENCY — reserva de fornecedor insuficiente");
  }

  if (allocations.length > 0) {
    await tx.update(orderItemStockAllocations).set({ status: finalStatus, updatedAt: new Date() })
      .where(inArray(orderItemStockAllocations.id, allocations.map((allocation: { id: number }) => allocation.id)));
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

      if (newStatus === "delivered") {
        await releaseCommittedSupplierReservations(tx as any, orderId, "fulfilled");
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
