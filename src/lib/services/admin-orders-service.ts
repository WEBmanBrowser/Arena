import { db } from "@/db";
import { auditLogs, orderItems, orders, orderStatusHistory, payments, users, ORDER_TRANSITIONS, ORDER_STATUSES } from "@/db/schema";
import { and, asc, desc, eq, gte, ilike, lte, or, sql } from "drizzle-orm";
import { createAuditLog } from "@/lib/audit";
import { transitionOrderStatus } from "@/lib/orders";

export const ADMIN_ORDER_PAGE_SIZE_DEFAULT = 25;
export const ADMIN_ORDER_PAGE_SIZE_MAX = 100;

export interface AdminOrderListParams {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: string;
  paymentStatus?: string;
  deliveryType?: string;
  dateFrom?: string;
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

function buildOrderConditions(params: AdminOrderListParams) {
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
  if (params.dateFrom) conditions.push(gte(orders.createdAt, new Date(params.dateFrom)));
  if (params.dateTo) conditions.push(lte(orders.createdAt, new Date(params.dateTo)));
  return conditions.length ? and(...conditions) : undefined;
}

export async function listAdminOrders(params: AdminOrderListParams) {
  const page = normalizePage(params.page);
  const pageSize = normalizePageSize(params.pageSize);
  const offset = (page - 1) * pageSize;
  const where = buildOrderConditions(params);

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

export async function getAdminOrderDetail(orderId: number) {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) throw new Error("ORDER_NOT_FOUND");

  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId)).orderBy(asc(orderItems.id));
  const paymentRows = await db.select().from(payments).where(eq(payments.orderId, orderId)).orderBy(desc(payments.createdAt));
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

  let customer = null;
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
    statusHistory: history,
  };
}

export async function updateAdminOrderStatus(orderId: number, status: string, actorId: number, comment?: string) {
  if (!ORDER_STATUSES.includes(status as typeof ORDER_STATUSES[number])) throw new Error("INVALID_STATUS");
  if (status === "expired") throw new Error("EXPIRED_IS_SYSTEM_ONLY");
  const result = await transitionOrderStatus(orderId, status, actorId, comment);
  if (!result.success) throw new Error(result.error || "STATUS_TRANSITION_FAILED");
  return getAdminOrderDetail(orderId);
}

export async function updateOrderTracking(orderId: number, trackingNumber: string | null, actorId: number) {
  const normalized = trackingNumber?.trim() || null;
  if (normalized && normalized.length > 255) throw new Error("TRACKING_TOO_LONG");

  const [order] = await db.select({ id: orders.id, trackingNumber: orders.trackingNumber }).from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) throw new Error("ORDER_NOT_FOUND");
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
