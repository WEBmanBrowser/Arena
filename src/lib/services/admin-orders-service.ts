/**
 * B.2.1 — Admin Order Management service.
 *
 * List/detail/tracking/status operations for the admin orders UI.
 * Status changes REUSE the central Phase A state machine (transitionOrderStatus)
 * — there is no second state machine here.
 */

import { db } from "@/db";
import { invoiceDocuments, orderItems, orders, orderStatusHistory, payments, users, ORDER_TRANSITIONS, ORDER_STATUSES, PAYMENT_STATUSES, DELIVERY_TYPES } from "@/db/schema";
import { and, asc, desc, eq, gte, ilike, lte, or, sql } from "drizzle-orm";
import { createAuditLog } from "@/lib/audit";
import { transitionOrderStatus } from "@/lib/orders";
import type { OrderRefundState } from "@/lib/refunds";
import { getOrderRefundState } from "@/lib/refunds";

export const ADMIN_ORDER_PAGE_SIZE_DEFAULT = 25;
export const ADMIN_ORDER_PAGE_SIZE_MAX = 100;

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

export type AdminOrderListResult = { orders: AdminOrderListRow[]; pagination: AdminOrderListPagination };

export type AdminOrderRow = typeof orders.$inferSelect;

export type AdminOrderItemRow = typeof orderItems.$inferSelect;

export type AdminOrderPaymentRow = typeof payments.$inferSelect;

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

export type AdminOrderDetail = {
  order: AdminOrderRow & { allowedTransitions: string[] };
  items: AdminOrderItemRow[];
  customer: AdminOrderCustomerRow | null;
  payments: AdminOrderPaymentRow[];
  invoiceDocuments: AdminOrderInvoiceDocumentRow[];
  statusHistory: AdminOrderStatusHistoryRow[];
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

function buildOrderConditions(params: AdminOrderListParams, range: { from?: Date; to?: Date }) {
  const conditions = [];
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

// ─── LIST ────────────────────────────────────────────────

export async function listAdminOrders(params: AdminOrderListParams): Promise<AdminOrderListResult> {
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

  const [countRow] = await db.select({ count: sql<number>`count(DISTINCT ${orders.id})` })
    .from(orders)
    .leftJoin(users, eq(orders.userId, users.id))
    .where(where);

  const rows = await db.select({
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
    .offset(offset);

  const total = Number(countRow?.count || 0);
  return {
    orders: rows,
    pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
  };
}

// ─── DETAIL ──────────────────────────────────────────────

export async function getAdminOrderDetail(orderId: number): Promise<AdminOrderDetail> {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) throw new Error("ORDER_NOT_FOUND");

  // Items keep their HISTORICAL snapshots (productName/SKU/prices at purchase time)
  // — never re-joined with current product data.
  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId)).orderBy(asc(orderItems.id));
  const paymentRows = await db.select().from(payments).where(eq(payments.orderId, orderId)).orderBy(desc(payments.createdAt));
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

  return {
    order: { ...order, allowedTransitions: ORDER_TRANSITIONS[order.status] || [] },
    items,
    customer,
    payments: paymentRows,
    invoiceDocuments: invoiceRows,
    statusHistory: history,
    refundState: await getOrderRefundState(orderId),
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
