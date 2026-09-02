/**
 * B.2.1 / B.4.2 — Admin Order Management service.
 *
 * List/detail/tracking/status/queue operations for the admin orders UI.
 * Status changes REUSE the central Phase A state machine (transitionOrderStatus)
 * — there is NO second state machine and NO direct SQL writes to orders.status here.
 */

import { db } from "@/db";
import {
  invoiceDocuments,
  orderItems,
  orders,
  orderStatusHistory,
  paymentAttempts,
  payments,
  products,
  providerWebhookEvents,
  reconciliationObservations,
  refundAttempts,
  users,
  ORDER_TRANSITIONS,
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  DELIVERY_TYPES,
} from "@/db/schema";
import { and, asc, desc, eq, gte, ilike, inArray, lte, notInArray, or, sql, type SQL } from "drizzle-orm";
import { createAuditLog } from "@/lib/audit";
import { transitionOrderStatus } from "@/lib/orders";
import { isMetadataEligibleForRecovery } from "@/lib/services/eupago-refund-recovery-service";
import type { OrderRefundState } from "@/lib/refunds";
import { getOrderRefundState } from "@/lib/refunds";

export const ADMIN_ORDER_PAGE_SIZE_DEFAULT = 25;
export const ADMIN_ORDER_PAGE_SIZE_MAX = 100;
export const ADMIN_MAX_BULK_ORDERS = 50;

/** Operational queue allowlist (B.4.2). */
export const ADMIN_ORDER_QUEUES = [
  "awaiting_payment",
  "paid_needs_processing",
  "preparing",
  "ready_to_ship",
  "ready_for_pickup",
  "shipped",
  "refund_attention",
  "missing_invoice",
  "exceptions",
] as const;
export type AdminOrderQueue = (typeof ADMIN_ORDER_QUEUES)[number];

/** Operational webhook anomaly filter allowlist (B.4.2). */
export const ADMIN_WEBHOOK_FILTERS = ["all", "failed", "ignored_payment", "ignored_refund"] as const;
export type AdminWebhookFilter = (typeof ADMIN_WEBHOOK_FILTERS)[number];

/** Sorting whitelist (anything else → newest). */
export const ADMIN_ORDER_SORTS = ["newest", "oldest", "total_desc", "total_asc"] as const;
export type AdminOrderSort = (typeof ADMIN_ORDER_SORTS)[number];

/** Strict ISO date (YYYY-MM-DD) — the only accepted format for date filters. */
export const ADMIN_ORDER_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/** Validation error → HTTP 400 (route maps this class, never 500). */
export class AdminOrderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminOrderValidationError";
  }
}

// ─── Public result types (used by admin UI and tests) ────

export type AdminOrderListRow = {
  id: number;
  orderNumber: string;
  createdAt: Date;
  customerName: string;
  customerEmail: string;
  total: string;
  status: string;
  paymentStatus: string;
  paymentMethod: string | null;
  deliveryType: string;
  trackingNumber: string | null;
};

export type AdminOrderListPagination = { page: number; pageSize: number; total: number; totalPages: number };

export type AdminOrderQueueCounts = {
  awaiting_payment: number;
  paid_needs_processing: number;
  preparing: number;
  ready_to_ship: number;
  ready_for_pickup: number;
  shipped: number;
  refund_attention: number;
  missing_invoice: number;
  exceptions: number;
};

export type AdminWebhookAnomalyRow = {
  id: number;
  provider: string;
  providerEventId: string | null;
  eventType: string | null;
  kind: "payment" | "refund" | "other";
  status: string;
  attempts: number;
  lastError: string | null;
  receivedAt: Date;
  processedAt: Date | null;
  failedAt: Date | null;
  createdAt: Date;
  /**
   * Server-derived "metadata-eligible for a recovery attempt" boolean.
   * When `true`, the admin UI MAY surface a "Recuperar" action; the
   * actual recovery still has to be performed by the B.3.5.2 service,
   * which is the only authority that can claim the event and correlate
   * it with a refund attempt under a single transaction. This boolean
   * is NOT a guarantee of financial success — it only means the row
   * carries the persisted trusted metadata shape required to attempt
   * recovery. The raw metadata is never exposed to the browser.
   */
  recoverable: boolean;
};

export interface AdminWebhookAnomalyParams {
  filter?: AdminWebhookFilter;
  limit?: number;
}

export type AdminOrderListResult = {
  orders: AdminOrderListRow[];
  pagination: AdminOrderListPagination;
  queueCounts?: AdminOrderQueueCounts;
  webhookAnomalies?: {
    anomalies: AdminWebhookAnomalyRow[];
    total: number;
  };
};

export type AdminOrderRow = typeof orders.$inferSelect;

export type AdminOrderItemRow = typeof orderItems.$inferSelect & {
  ean?: string | null;
  warehouseStock?: number | null;
  storeStock?: number | null;
};

export type AdminOrderPaymentRow = typeof payments.$inferSelect;

export type AdminOrderPaymentAttemptRow = {
  id: number;
  provider: string;
  method: string;
  amountCents: number;
  currency: string;
  status: string;
  providerReference: string | null;
  providerTransactionId: string | null;
  recoveryState: string | null;
  operatorActionCode: string | null;
  failureReason: string | null;
  expiresAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
};

export type AdminOrderInvoiceDocumentRow = typeof invoiceDocuments.$inferSelect;

export type AdminOrderCustomerRow = {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  nif: string | null;
  company: string | null;
};

export type AdminOrderStatusHistoryRow = {
  id: number;
  fromStatus: string | null;
  toStatus: string;
  comment: string | null;
  createdAt: Date;
  changedBy: number | null;
  changedByName: string | null;
  changedByEmail: string | null;
};

export type AdminOrderTimelineEntry = {
  id: string;
  type: "order_created" | "status_change" | "payment" | "payment_attempt" | "refund" | "invoice";
  timestamp: Date;
  title: string;
  description: string | null;
  actor: string | null;
  safeMetadata?: Record<string, unknown>;
};

export type AdminOrderDetail = {
  order: AdminOrderRow & { allowedTransitions: string[] };
  items: AdminOrderItemRow[];
  customer: AdminOrderCustomerRow | null;
  payments: AdminOrderPaymentRow[];
  paymentAttempts: AdminOrderPaymentAttemptRow[];
  invoiceDocuments: AdminOrderInvoiceDocumentRow[];
  statusHistory: AdminOrderStatusHistoryRow[];
  timeline: AdminOrderTimelineEntry[];
  /** B.3.5 — derived financial refund state (never mutates order state). */
  refundState: OrderRefundState;
};

// ─── Params ──────────────────────────────────────────────

export interface AdminOrderListParams {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: string;
  paymentStatus?: string;
  deliveryType?: string;
  queue?: string;
  webhookFilter?: string;
  /** ISO date YYYY-MM-DD (start of day, inclusive) */
  dateFrom?: string;
  /** ISO date YYYY-MM-DD (whole final day included, up to 23:59:59.999) */
  dateTo?: string;
  sort?: string;
}

function normalizePage(value?: number) {
  return Math.max(1, Number.isFinite(value || 0) ? value || 1 : 1);
}

function normalizePageSize(value?: number) {
  const raw = Number.isFinite(value || 0) ? value || ADMIN_ORDER_PAGE_SIZE_DEFAULT : ADMIN_ORDER_PAGE_SIZE_DEFAULT;
  return Math.min(ADMIN_ORDER_PAGE_SIZE_MAX, Math.max(1, raw));
}

/** Parse one YYYY-MM-DD string into a UTC-midnight Date; reject format and calendar-invalid dates. */
function parseDateParam(value: string, field: "dateFrom" | "dateTo"): Date {
  if (!ADMIN_ORDER_DATE_REGEX.test(value)) {
    throw new AdminOrderValidationError(`INVALID_${field.toUpperCase()}_FORMAT`);
  }
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  // Calendar check — rejects 2026-02-30, 2026-13-01, day 00, etc.
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    throw new AdminOrderValidationError(`INVALID_${field.toUpperCase()}_DATE`);
  }
  return date;
}

/**
 * Resolve the date range. Full-day semantics live HERE (server-side, single place):
 *  - dateFrom → 00:00:00.000 of that day
 *  - dateTo   → 23:59:59.999 of that day (entire final day included)
 *  - dateFrom > dateTo → validation error
 */
export function resolveAdminOrderDateRange(dateFrom?: string, dateTo?: string): { from?: Date; to?: Date } {
  const from = dateFrom ? parseDateParam(dateFrom, "dateFrom") : undefined;
  const to = dateTo ? parseDateParam(dateTo, "dateTo") : undefined;
  if (from && to && from.getTime() > to.getTime()) {
    throw new AdminOrderValidationError("DATE_FROM_AFTER_DATE_TO");
  }
  return { from, to: to ? new Date(to.getTime() + 86_399_999) : undefined };
}

function validateEnumFilters(params: AdminOrderListParams) {
  if (params.queue && !ADMIN_ORDER_QUEUES.includes(params.queue as AdminOrderQueue)) {
    throw new AdminOrderValidationError("INVALID_QUEUE");
  }
  if (params.webhookFilter && !ADMIN_WEBHOOK_FILTERS.includes(params.webhookFilter as AdminWebhookFilter)) {
    throw new AdminOrderValidationError("INVALID_WEBHOOK_FILTER");
  }
  if (params.status && !ORDER_STATUSES.includes(params.status as typeof ORDER_STATUSES[number])) {
    throw new AdminOrderValidationError("INVALID_STATUS");
  }
  if (params.paymentStatus && !PAYMENT_STATUSES.includes(params.paymentStatus as typeof PAYMENT_STATUSES[number])) {
    throw new AdminOrderValidationError("INVALID_PAYMENT_STATUS");
  }
  if (params.deliveryType && !DELIVERY_TYPES.includes(params.deliveryType as typeof DELIVERY_TYPES[number])) {
    throw new AdminOrderValidationError("INVALID_DELIVERY_TYPE");
  }
  if (params.sort && !ADMIN_ORDER_SORTS.includes(params.sort as AdminOrderSort)) {
    throw new AdminOrderValidationError("INVALID_SORT");
  }
}

function buildQueueCondition(queue: AdminOrderQueue) {
  switch (queue) {
    case "awaiting_payment":
      return eq(orders.status, "pending_payment");
    case "paid_needs_processing":
      return eq(orders.status, "paid");
    case "preparing":
      return eq(orders.status, "processing");
    case "ready_to_ship":
      return and(eq(orders.status, "processing"), eq(orders.deliveryType, "shipping"));
    case "ready_for_pickup":
      return and(eq(orders.status, "ready_for_pickup"), eq(orders.deliveryType, "pickup"));
    case "shipped":
      return eq(orders.status, "shipped");
    case "refund_attention":
      return sql`EXISTS (
        SELECT 1 FROM ${refundAttempts}
        WHERE ${refundAttempts.orderId} = ${orders.id}
          AND ${refundAttempts.status} IN ('pending', 'processing', 'failed')
      )`;
    case "missing_invoice":
      return and(
        eq(orders.paymentStatus, "paid"),
        notInArray(orders.status, ["cancelled", "refunded"]),
        sql`NOT EXISTS (
          SELECT 1 FROM ${invoiceDocuments}
          WHERE ${invoiceDocuments.orderId} = ${orders.id}
            AND ${invoiceDocuments.documentType} = 'invoice'
            AND ${invoiceDocuments.status} = 'issued'
        )`
      );
    case "exceptions":
      return sql`(
        EXISTS (
          SELECT 1 FROM ${paymentAttempts}
          WHERE ${paymentAttempts.orderId} = ${orders.id}
            AND ${paymentAttempts.recoveryState} = 'reconciliation_required'
        ) OR EXISTS (
          SELECT 1 FROM ${reconciliationObservations}
          WHERE ${reconciliationObservations.orderId} = ${orders.id}
            AND ${reconciliationObservations.status} = 'open'
        ) OR EXISTS (
          SELECT 1 FROM ${invoiceDocuments}
          WHERE ${invoiceDocuments.orderId} = ${orders.id}
            AND ${invoiceDocuments.status} = 'failed'
        )
      )`;
    default:
      return undefined;
  }
}

function buildOrderConditions(params: AdminOrderListParams, range: { from?: Date; to?: Date }) {
  const conditions = [];
  if (params.queue) {
    const qCond = buildQueueCondition(params.queue as AdminOrderQueue);
    if (qCond) conditions.push(qCond);
  }
  if (params.search?.trim()) {
    const q = `%${params.search.trim()}%`;
    conditions.push(or(
      ilike(orders.orderNumber, q),
      ilike(orders.guestEmail, q),
      ilike(orders.guestName, q),
      ilike(users.email, q),
      ilike(users.name, q),
    ));
  }
  if (params.status) conditions.push(eq(orders.status, params.status));
  if (params.paymentStatus) conditions.push(eq(orders.paymentStatus, params.paymentStatus));
  if (params.deliveryType) conditions.push(eq(orders.deliveryType, params.deliveryType));
  if (range.from) conditions.push(gte(orders.createdAt, range.from));
  if (range.to) conditions.push(lte(orders.createdAt, range.to));
  return conditions.length ? and(...conditions) : undefined;
}

// ─── QUEUE COUNTS (PostgreSQL-side aggregation) ───────────

export async function getAdminOrderQueueCounts(): Promise<AdminOrderQueueCounts> {
  const [row] = await db.select({
    awaiting_payment: sql<number>`count(*) FILTER (WHERE ${orders.status} = 'pending_payment')::int`,
    paid_needs_processing: sql<number>`count(*) FILTER (WHERE ${orders.status} = 'paid')::int`,
    preparing: sql<number>`count(*) FILTER (WHERE ${orders.status} = 'processing')::int`,
    ready_to_ship: sql<number>`count(*) FILTER (WHERE ${orders.status} = 'processing' AND ${orders.deliveryType} = 'shipping')::int`,
    ready_for_pickup: sql<number>`count(*) FILTER (WHERE ${orders.status} = 'ready_for_pickup' AND ${orders.deliveryType} = 'pickup')::int`,
    shipped: sql<number>`count(*) FILTER (WHERE ${orders.status} = 'shipped')::int`,
    refund_attention: sql<number>`count(*) FILTER (WHERE EXISTS (
      SELECT 1 FROM ${refundAttempts}
      WHERE ${refundAttempts.orderId} = ${orders.id}
        AND ${refundAttempts.status} IN ('pending', 'processing', 'failed')
    ))::int`,
    missing_invoice: sql<number>`count(*) FILTER (WHERE ${orders.paymentStatus} = 'paid' AND ${orders.status} NOT IN ('cancelled', 'refunded') AND NOT EXISTS (
      SELECT 1 FROM ${invoiceDocuments}
      WHERE ${invoiceDocuments.orderId} = ${orders.id}
        AND ${invoiceDocuments.documentType} = 'invoice'
        AND ${invoiceDocuments.status} = 'issued'
    ))::int`,
    exceptions: sql<number>`count(*) FILTER (WHERE (
      EXISTS (
        SELECT 1 FROM ${paymentAttempts}
        WHERE ${paymentAttempts.orderId} = ${orders.id}
          AND ${paymentAttempts.recoveryState} = 'reconciliation_required'
      ) OR EXISTS (
        SELECT 1 FROM ${reconciliationObservations}
        WHERE ${reconciliationObservations.orderId} = ${orders.id}
          AND ${reconciliationObservations.status} = 'open'
      ) OR EXISTS (
        SELECT 1 FROM ${invoiceDocuments}
        WHERE ${invoiceDocuments.orderId} = ${orders.id}
          AND ${invoiceDocuments.status} = 'failed'
      )
    ))::int`,
  }).from(orders);

  return {
    awaiting_payment: Number(row?.awaiting_payment || 0),
    paid_needs_processing: Number(row?.paid_needs_processing || 0),
    preparing: Number(row?.preparing || 0),
    ready_to_ship: Number(row?.ready_to_ship || 0),
    ready_for_pickup: Number(row?.ready_for_pickup || 0),
    shipped: Number(row?.shipped || 0),
    refund_attention: Number(row?.refund_attention || 0),
    missing_invoice: Number(row?.missing_invoice || 0),
    exceptions: Number(row?.exceptions || 0),
  };
}

// ─── READ-ONLY WEBHOOK ANOMALIES (Fix 1 / B.4.2) ──────────

export async function listAdminWebhookAnomalies(
  params: AdminWebhookAnomalyParams = {}
): Promise<{ anomalies: AdminWebhookAnomalyRow[]; total: number }> {
  const limit = Math.min(100, Math.max(1, params.limit || 50));
  const filter = params.filter || "all";

  const conditions: SQL[] = [
    inArray(providerWebhookEvents.status, ["failed", "ignored"]),
  ];

  if (filter === "failed") {
    conditions.push(eq(providerWebhookEvents.status, "failed"));
  } else if (filter === "ignored_payment") {
    conditions.push(
      eq(providerWebhookEvents.status, "ignored"),
      sql`(${providerWebhookEvents.metadata}->>'kind' = 'payment' OR ${providerWebhookEvents.eventType} LIKE 'payment%')`
    );
  } else if (filter === "ignored_refund") {
    conditions.push(
      eq(providerWebhookEvents.status, "ignored"),
      sql`(${providerWebhookEvents.metadata}->>'kind' = 'refund' OR ${providerWebhookEvents.eventType} LIKE 'refund%' OR ${providerWebhookEvents.lastError} = 'REFUND_ATTEMPT_NOT_FOUND')`
    );
  }

  const whereClause = and(...conditions);

  const [countRow, rows] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(providerWebhookEvents)
      .where(whereClause!)
      .then(([r]) => r),
    db
      .select({
        id: providerWebhookEvents.id,
        provider: providerWebhookEvents.provider,
        providerEventId: providerWebhookEvents.providerEventId,
        eventType: providerWebhookEvents.eventType,
        metadata: providerWebhookEvents.metadata,
        status: providerWebhookEvents.status,
        attempts: providerWebhookEvents.attempts,
        lastError: providerWebhookEvents.lastError,
        receivedAt: providerWebhookEvents.receivedAt,
        processedAt: providerWebhookEvents.processedAt,
        failedAt: providerWebhookEvents.failedAt,
        createdAt: providerWebhookEvents.createdAt,
      })
      .from(providerWebhookEvents)
      .where(whereClause!)
      .orderBy(desc(providerWebhookEvents.receivedAt))
      .limit(limit),
  ]);

  const anomalies: AdminWebhookAnomalyRow[] = (rows || []).map((r) => {
    const metaKind = (r.metadata as { kind?: string } | null)?.kind;
    const eventType = r.eventType ?? null;
    const kind: "payment" | "refund" | "other" =
      metaKind === "refund" || eventType?.startsWith("refund") || r.lastError === "REFUND_ATTEMPT_NOT_FOUND"
        ? "refund"
        : metaKind === "payment" || eventType?.startsWith("payment")
          ? "payment"
          : "other";

    // Server-side metadata-eligibility check. The shared predicate is the
    // single source of truth for B.3.5.2 metadata eligibility, so the UI
    // can never enable the recovery button for an event the recovery
    // service would refuse. The raw metadata is intentionally NOT exposed
    // to the browser — only this boolean is.
    const recoverable = isMetadataEligibleForRecovery({
      provider: r.provider,
      status: r.status,
      lastError: r.lastError,
      providerEventId: r.providerEventId,
      metadata: r.metadata,
    });

    return {
      id: r.id,
      provider: r.provider,
      providerEventId: r.providerEventId,
      eventType: r.eventType,
      kind,
      status: r.status,
      attempts: r.attempts,
      lastError: r.lastError,
      receivedAt: r.receivedAt,
      processedAt: r.processedAt,
      failedAt: r.failedAt,
      createdAt: r.createdAt,
      recoverable,
    };
  });

  return {
    anomalies,
    total: Number(countRow?.count || 0),
  };
}

// ─── LIST ────────────────────────────────────────────────

export async function listAdminOrders(params: AdminOrderListParams = {}): Promise<AdminOrderListResult> {
  // Server-side validation first (routes also validate via Zod — defense in depth)
  validateEnumFilters(params);
  const range = resolveAdminOrderDateRange(params.dateFrom, params.dateTo);

  const page = normalizePage(params.page);
  const pageSize = normalizePageSize(params.pageSize);
  const offset = (page - 1) * pageSize;
  const where = buildOrderConditions(params, range);

  let orderBy = desc(orders.createdAt);
  if (params.sort === "oldest") orderBy = asc(orders.createdAt);
  if (params.sort === "total_desc") orderBy = desc(orders.total);
  if (params.sort === "total_asc") orderBy = asc(orders.total);

  const shouldFetchWebhookAnomalies = params.queue === "exceptions" || Boolean(params.webhookFilter);

  const [countRow, queueCounts, rows, webhookAnomalies] = await Promise.all([
    db.select({ count: sql<number>`count(DISTINCT ${orders.id})` })
      .from(orders)
      .leftJoin(users, eq(orders.userId, users.id))
      .where(where)
      .then(([r]) => r),
    getAdminOrderQueueCounts(),
    db.select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      createdAt: orders.createdAt,
      customerName: sql<string>`COALESCE(${users.name}, ${orders.guestName}, 'Cliente')`,
      customerEmail: sql<string>`COALESCE(${users.email}, ${orders.guestEmail}, '')`,
      total: orders.total,
      status: orders.status,
      paymentStatus: orders.paymentStatus,
      paymentMethod: orders.paymentMethod,
      deliveryType: orders.deliveryType,
      trackingNumber: orders.trackingNumber,
    }).from(orders)
      .leftJoin(users, eq(orders.userId, users.id))
      .where(where)
      .orderBy(orderBy)
      .limit(pageSize)
      .offset(offset),
    shouldFetchWebhookAnomalies
      ? listAdminWebhookAnomalies({
          filter: (params.webhookFilter as AdminWebhookFilter) || "all",
          limit: 50,
        })
      : Promise.resolve(undefined),
  ]);

  const total = Number(countRow?.count || 0);
  return {
    orders: rows,
    pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    queueCounts,
    webhookAnomalies,
  };
}

// ─── DETAIL ──────────────────────────────────────────────

export async function getAdminOrderDetail(orderId: number): Promise<AdminOrderDetail> {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) throw new Error("ORDER_NOT_FOUND");

  // Items keep their HISTORICAL snapshots (productName/SKU/prices at purchase time).
  // Joined with current products table only for non-financial picking aids (EAN, warehouse/store stock).
  const itemRows = await db.select({
    id: orderItems.id,
    orderId: orderItems.orderId,
    productId: orderItems.productId,
    productName: orderItems.productName,
    productSku: orderItems.productSku,
    quantity: orderItems.quantity,
    unitPriceGross: orderItems.unitPriceGross,
    unitPriceNet: orderItems.unitPriceNet,
    vatRate: orderItems.vatRate,
    vatAmount: orderItems.vatAmount,
    discountAmount: orderItems.discountAmount,
    lineTotalGross: orderItems.lineTotalGross,
    ean: products.ean,
    warehouseStock: products.warehouseStock,
    storeStock: products.storeStock,
  }).from(orderItems)
    .leftJoin(products, eq(orderItems.productId, products.id))
    .where(eq(orderItems.orderId, orderId))
    .orderBy(asc(orderItems.id));

  const paymentRows = await db.select().from(payments).where(eq(payments.orderId, orderId)).orderBy(desc(payments.createdAt));
  const attemptRows = await db.select({
    id: paymentAttempts.id,
    provider: paymentAttempts.provider,
    method: paymentAttempts.method,
    amountCents: paymentAttempts.amountCents,
    currency: paymentAttempts.currency,
    status: paymentAttempts.status,
    providerReference: paymentAttempts.providerReference,
    providerTransactionId: paymentAttempts.providerTransactionId,
    recoveryState: paymentAttempts.recoveryState,
    operatorActionCode: paymentAttempts.operatorActionCode,
    failureReason: paymentAttempts.failureReason,
    expiresAt: paymentAttempts.expiresAt,
    completedAt: paymentAttempts.completedAt,
    createdAt: paymentAttempts.createdAt,
  }).from(paymentAttempts).where(eq(paymentAttempts.orderId, orderId)).orderBy(desc(paymentAttempts.createdAt));

  const invoiceRows = await db.select().from(invoiceDocuments).where(eq(invoiceDocuments.orderId, orderId)).orderBy(desc(invoiceDocuments.createdAt));
  const history = await db.select({
    id: orderStatusHistory.id,
    fromStatus: orderStatusHistory.fromStatus,
    toStatus: orderStatusHistory.toStatus,
    comment: orderStatusHistory.comment,
    createdAt: orderStatusHistory.createdAt,
    changedBy: orderStatusHistory.changedBy,
    changedByName: users.name,
    changedByEmail: users.email,
  }).from(orderStatusHistory)
    .leftJoin(users, eq(orderStatusHistory.changedBy, users.id))
    .where(eq(orderStatusHistory.orderId, orderId))
    .orderBy(desc(orderStatusHistory.createdAt));

  let customer: AdminOrderCustomerRow | null = null;
  if (order.userId) {
    const [u] = await db.select({ id: users.id, name: users.name, email: users.email, phone: users.phone, nif: users.nif, company: users.company })
      .from(users).where(eq(users.id, order.userId)).limit(1);
    customer = u || null;
  }

  const refundState = await getOrderRefundState(orderId);

  // Synthesize deterministic unified operational timeline
  const timeline: AdminOrderTimelineEntry[] = [
    {
      id: `order-created-${order.id}`,
      type: "order_created",
      timestamp: order.createdAt,
      title: `Encomenda criada #${order.orderNumber}`,
      description: `Total: ${order.total}€ · ${order.deliveryType === "pickup" ? "Levantamento em loja" : "Envio"}`,
      actor: customer ? customer.name : (order.guestName || "Cliente Convidado"),
    },
  ];

  for (const h of history) {
    timeline.push({
      id: `status-history-${h.id}`,
      type: "status_change",
      timestamp: h.createdAt,
      title: `Estado: ${h.fromStatus || "—"} → ${h.toStatus}`,
      description: h.comment || null,
      actor: h.changedByName || (h.changedBy ? `Utilizador #${h.changedBy}` : "Sistema"),
    });
  }

  for (const p of paymentRows) {
    timeline.push({
      id: `payment-${p.id}`,
      type: "payment",
      timestamp: p.paidAt || p.createdAt,
      title: p.status === "paid" ? `Pagamento confirmado (${p.amount} ${p.currency})` : `Registo de pagamento (${p.status})`,
      description: `Método: ${p.method || p.provider}`,
      actor: null,
    });
  }

  for (const pa of attemptRows) {
    timeline.push({
      id: `payment-attempt-${pa.id}`,
      type: "payment_attempt",
      timestamp: pa.completedAt || pa.createdAt,
      title: `Tentativa de pagamento ${pa.provider} (${pa.method}): ${pa.status}`,
      description: pa.failureReason ? `Motivo: ${pa.failureReason}` : (pa.providerReference ? `Ref: ${pa.providerReference}` : null),
      actor: null,
    });
  }

  for (const r of refundState.refunds) {
    timeline.push({
      id: `refund-${r.id}`,
      type: "refund",
      timestamp: r.completedAt || r.createdAt,
      title: `Reembolso #${r.id} (${(r.amountCents / 100).toFixed(2)} ${r.currency}): ${r.status}`,
      description: r.reason || (r.providerRefundId ? `Ref externa: ${r.providerRefundId}` : null),
      actor: null,
    });
  }

  for (const inv of invoiceRows) {
    timeline.push({
      id: `invoice-${inv.id}`,
      type: "invoice",
      timestamp: inv.issuedAt || inv.createdAt,
      title: `Documento fiscal (${inv.documentType}): ${inv.documentNumber || inv.providerDocumentId || "Pendente"}`,
      description: `Estado: ${inv.status} · ${inv.amountCents != null ? `${(inv.amountCents / 100).toFixed(2)} ${inv.currency}` : ""}`,
      actor: null,
    });
  }

  const TYPE_TIE_BREAKER: Record<string, number> = {
    order_created: 1,
    payment: 2,
    payment_attempt: 3,
    invoice: 4,
    status_change: 5,
    refund: 6,
  };

  timeline.sort((a, b) => {
    const diff = b.timestamp.getTime() - a.timestamp.getTime();
    if (diff !== 0) return diff;
    const typeDiff = (TYPE_TIE_BREAKER[b.type] ?? 99) - (TYPE_TIE_BREAKER[a.type] ?? 99);
    if (typeDiff !== 0) return typeDiff;
    return b.id.localeCompare(a.id);
  });

  return {
    order: { ...order, allowedTransitions: ORDER_TRANSITIONS[order.status] || [] },
    items: itemRows,
    customer,
    payments: paymentRows,
    paymentAttempts: attemptRows,
    invoiceDocuments: invoiceRows,
    statusHistory: history,
    timeline,
    refundState,
  };
}

// ─── STATUS (reuses the central Phase A state machine) ───

export async function updateAdminOrderStatus(orderId: number, status: string, actorId: number, comment?: string): Promise<AdminOrderDetail> {
  if (!ORDER_STATUSES.includes(status as typeof ORDER_STATUSES[number])) throw new AdminOrderValidationError("INVALID_STATUS");
  if (status === "expired") throw new AdminOrderValidationError("EXPIRED_IS_SYSTEM_ONLY");
  const result = await transitionOrderStatus(orderId, status, actorId, comment);
  if (!result.success) throw new Error(result.error || "STATUS_TRANSITION_FAILED");
  return getAdminOrderDetail(orderId);
}

// ─── SAFE BULK TRANSITIONS (B.4.2) ────────────────────────

export async function bulkTransitionAdminOrders(
  action: "start_processing" | "mark_ready_for_pickup",
  orderIds: number[],
  actorId: number
): Promise<{
  action: string;
  total: number;
  succeeded: number[];
  failed: Array<{ id: number; reason: string }>;
}> {
  if (!Array.isArray(orderIds) || orderIds.length === 0) {
    throw new AdminOrderValidationError("NO_ORDERS_SELECTED");
  }
  if (orderIds.length > ADMIN_MAX_BULK_ORDERS) {
    throw new AdminOrderValidationError(`BATCH_SIZE_EXCEEDED (max ${ADMIN_MAX_BULK_ORDERS})`);
  }

  // Deduplicate and validate positive integers
  const uniqueIds = Array.from(new Set(orderIds));
  for (const id of uniqueIds) {
    if (!Number.isInteger(id) || id < 1) {
      throw new AdminOrderValidationError("INVALID_ORDER_ID");
    }
  }

  const targetStatus = action === "start_processing" ? "processing" : "ready_for_pickup";
  const succeeded: number[] = [];
  const failed: Array<{ id: number; reason: string }> = [];

  for (const orderId of uniqueIds) {
    try {
      const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
      if (!order) {
        failed.push({ id: orderId, reason: "Encomenda não encontrada" });
        continue;
      }

      if (action === "mark_ready_for_pickup" && order.deliveryType !== "pickup") {
        failed.push({ id: orderId, reason: "Apenas aplicável a encomendas de levantamento em loja" });
        continue;
      }

      const comment = action === "start_processing" ? "Preparação iniciada em lote" : "Marcada pronta para levantamento em lote";
      const result = await transitionOrderStatus(orderId, targetStatus, actorId, comment);
      if (result.success) {
        succeeded.push(orderId);
      } else {
        failed.push({ id: orderId, reason: result.error || "Transição de estado inválida" });
      }
    } catch (e) {
      failed.push({ id: orderId, reason: e instanceof Error ? e.message : "Erro desconhecido" });
    }
  }

  await createAuditLog({
    userId: actorId,
    action: `bulk.order_${action}`,
    entity: "orders",
    details: {
      action,
      targetStatus,
      total: uniqueIds.length,
      succeededCount: succeeded.length,
      failedCount: failed.length,
      succeededIds: succeeded,
    },
  });

  return {
    action,
    total: uniqueIds.length,
    succeeded,
    failed,
  };
}

// ─── TRACKING ────────────────────────────────────────────

export async function updateOrderTracking(orderId: number, trackingNumber: string | null, actorId: number): Promise<{ changed: boolean; order: AdminOrderDetail }> {
  const normalized = trackingNumber?.trim() || null; // empty/whitespace string → null (clear)
  if (normalized && normalized.length > 255) throw new AdminOrderValidationError("TRACKING_TOO_LONG");

  const [order] = await db.select({ id: orders.id, trackingNumber: orders.trackingNumber }).from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) throw new Error("ORDER_NOT_FOUND");
  // No-op when the value did not change — no update, no audit entry.
  if ((order.trackingNumber || null) === normalized) return { changed: false, order: await getAdminOrderDetail(orderId) };

  await db.update(orders).set({ trackingNumber: normalized, updatedAt: new Date() }).where(eq(orders.id, orderId));
  await createAuditLog({
    userId: actorId,
    action: "order.tracking_updated",
    entity: "order",
    entityId: orderId,
    details: { oldTrackingNumber: order.trackingNumber, newTrackingNumber: normalized },
  });
  return { changed: true, order: await getAdminOrderDetail(orderId) };
}
