/**
 * B.2.2 — Admin Customer Management service.
 *
 * List, detail, statistics, notes, disable/reactivate operations.
 *
 * FINANCIAL RULE (net revenue) — single source of truth:
 *   Revenue order statuses = paid, processing, ready_for_pickup, shipped,
 *                            delivered, return_requested
 *   Excluded               = pending_payment, cancelled, expired, refunded,
 *                            returned
 *
 * Rationale (per existing state machine ORDER_TRANSITIONS):
 *   - pending_payment / cancelled / expired / refunded never represent
 *     effective revenue (money never arrived or was returned).
 *   - returned is excluded because the state machine forces
 *     returned → refunded, so the money is on its way back to the customer.
 *   - return_requested is INCLUDED because the request can still be rejected
 *     (return_requested → delivered) and no money has left — the sale is
 *     not yet reversed.
 *
 *   averageOrderValue uses the SAME universe: AOV = totalSpent / revenueOrders
 *   (AOV = 0 when there are no revenue orders).
 *
 *   Monetary values are INTEGER CENTS in the service API.
 */
import { db } from "@/db";
import { addresses, customerNotes, orders, orderItems, users, wishlists, rmaRequests, RMA_STATUSES } from "@/db/schema";
import { and, asc, desc, eq, gte, ilike, inArray, lte, or, sql, type SQLWrapper, type SQL } from "drizzle-orm";
import { createAuditLog } from "@/lib/audit";

export const ADMIN_CUSTOMER_PAGE_SIZE_DEFAULT = 25;
export const ADMIN_CUSTOMER_PAGE_SIZE_MAX = 100;

export const ADMIN_CUSTOMER_SORTS = [
  "newest", "oldest", "name_asc", "name_desc",
  "orders_desc", "spend_desc", "last_order_desc",
] as const;
export type AdminCustomerSort = (typeof ADMIN_CUSTOMER_SORTS)[number];

export type CustomerStatusFilter = "all" | "active" | "disabled" | "with_orders" | "without_orders";
export const CUSTOMER_STATUS_FILTERS: readonly CustomerStatusFilter[] = ["all", "active", "disabled", "with_orders", "without_orders"];

export const CUSTOMER_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/** Statuses that represent effective revenue (see file header). */
export const REVENUE_STATUSES = [
  "paid", "processing", "ready_for_pickup",
  "shipped", "delivered", "return_requested",
] as const;

export class CustomerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomerValidationError";
  }
}

// ─── Types ────────────────────────────────────────────────
export interface AdminCustomerListParams {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: CustomerStatusFilter;
  registeredFrom?: string;
  registeredTo?: string;
  lastOrderFrom?: string;
  lastOrderTo?: string;
  sort?: string;
}

export type AdminCustomerListRow = {
  id: number;
  email: string;
  name: string;
  phone: string | null;
  nif: string | null;
  company: string | null;
  isActive: boolean;
  createdAt: Date;
  orderCount: number;
  totalSpentCents: number;
  lastOrderDate: Date | null;
};

export type AdminCustomerListPagination = { page: number; pageSize: number; total: number; totalPages: number };
export type AdminCustomerListResult = { customers: AdminCustomerListRow[]; pagination: AdminCustomerListPagination };

export type CustomerStatistics = {
  totalOrders: number;
  totalSpentCents: number;
  averageOrderValueCents: number;
  lastOrderDate: Date | null;
};

export type AdminCustomerAddressRow = typeof addresses.$inferSelect;
export type AdminCustomerOrderRow = {
  id: number; orderNumber: string; createdAt: Date; total: string;
  status: string; paymentStatus: string; deliveryType: string;
};
export type AdminCustomerNoteRow = {
  id: number; userId: number; authorUserId: number;
  authorName: string | null; authorEmail: string | null;
  note: string; createdAt: Date; updatedAt: Date | null;
};

export type AdminCustomerDetail = {
  customer: {
    id: number; email: string; name: string; phone: string | null;
    nif: string | null; company: string | null; isActive: boolean;
    role: string; createdAt: Date; updatedAt: Date;
  };
  statistics: CustomerStatistics;
  addresses: AdminCustomerAddressRow[];
  ordersPaginated: { orders: AdminCustomerOrderRow[]; pagination: AdminCustomerListPagination };
  notes: AdminCustomerNoteRow[];
  rmaSummary: { total: number; open: number; resolved: number };
  wishlistCount: number;
};

// ─── Helpers ─────────────────────────────────────────────
function normalizePage(value?: number) {
  const v = Number(value);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 1;
}
function normalizePageSize(value?: number) {
  const v = Number(value);
  const raw = Number.isFinite(v) && v >= 1 ? Math.floor(v) : ADMIN_CUSTOMER_PAGE_SIZE_DEFAULT;
  return Math.min(ADMIN_CUSTOMER_PAGE_SIZE_MAX, raw);
}

function validateSort(sort?: string): AdminCustomerSort {
  if (!sort) return "newest";
  if (!ADMIN_CUSTOMER_SORTS.includes(sort as AdminCustomerSort)) {
    throw new CustomerValidationError("INVALID_SORT");
  }
  return sort as AdminCustomerSort;
}

function validateStatusFilter(status?: string): CustomerStatusFilter {
  if (!status) return "all";
  if (!CUSTOMER_STATUS_FILTERS.includes(status as CustomerStatusFilter)) {
    throw new CustomerValidationError("INVALID_STATUS_FILTER");
  }
  return status as CustomerStatusFilter;
}

function parseDateParam(value: string, field: string): Date {
  if (!CUSTOMER_DATE_REGEX.test(value)) {
    throw new CustomerValidationError(`INVALID_${field.toUpperCase()}_FORMAT`);
  }
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    throw new CustomerValidationError(`INVALID_${field.toUpperCase()}_DATE`);
  }
  return date;
}

// ─── Statistics (single customer, computed in DB) ─────────
export async function getCustomerStatistics(userId: number): Promise<CustomerStatistics> {
  const revenueFilter = inArray(orders.status, REVENUE_STATUSES as unknown as string[]);
  const [stats] = await db.select({
    totalOrders: sql<number>`count(*)::int`,
    revenueOrderCount: sql<number>`count(*) FILTER (WHERE ${revenueFilter})::int`,
    totalSpentCents: sql<string>`COALESCE(SUM(${orders.total}) FILTER (WHERE ${revenueFilter}), 0)`,
    lastOrderDateRaw: sql<string | null>`MAX(${orders.createdAt}::text) FILTER (WHERE ${revenueFilter})`,
  }).from(orders).where(eq(orders.userId, userId));

  const totalOrders = Number(stats?.totalOrders ?? 0);
  const revenueOrderCount = Number(stats?.revenueOrderCount ?? 0);
  const totalSpentCents = Math.round(parseFloat(stats?.totalSpentCents ?? "0") * 100);
  const lastOrderDate = stats?.lastOrderDateRaw ? new Date(stats.lastOrderDateRaw.replace(" ", "T") + "Z") : null;
  const averageOrderValueCents = revenueOrderCount > 0 ? Math.round(totalSpentCents / revenueOrderCount) : 0;

  return { totalOrders, totalSpentCents, averageOrderValueCents, lastOrderDate };
}

// ─── LIST ────────────────────────────────────────────────
export async function listAdminCustomers(params: AdminCustomerListParams): Promise<AdminCustomerListResult> {
  const statusFilter = validateStatusFilter(params.status);
  const sort = validateSort(params.sort);
  const page = normalizePage(params.page);
  const pageSize = normalizePageSize(params.pageSize);
  const offset = (page - 1) * pageSize;

  const regFrom = params.registeredFrom ? parseDateParam(params.registeredFrom, "registeredFrom") : undefined;
  const regToRaw = params.registeredTo ? parseDateParam(params.registeredTo, "registeredTo") : undefined;
  const regTo = regToRaw ? new Date(regToRaw.getTime() + 86_399_999) : undefined;
  const lodFrom = params.lastOrderFrom ? parseDateParam(params.lastOrderFrom, "lastOrderFrom") : undefined;
  const lodToRaw = params.lastOrderTo ? parseDateParam(params.lastOrderTo, "lastOrderTo") : undefined;
  const lodTo = lodToRaw ? new Date(lodToRaw.getTime() + 86_399_999) : undefined;

  // ── Base user-level WHERE ──
  const userConds: SQLWrapper[] = [eq(users.role, "customer")];
  if (params.search?.trim()) {
    const q = `%${params.search.trim()}%`;
    userConds.push(or(
      ilike(users.name, q),
      ilike(users.email, q),
      ilike(users.phone, q),
      ilike(users.nif, q),
      ilike(users.company, q),
    )!);
  }
  if (statusFilter === "active") userConds.push(eq(users.isActive, true));
  if (statusFilter === "disabled") userConds.push(eq(users.isActive, false));
  if (regFrom) userConds.push(gte(users.createdAt, regFrom));
  if (regTo) userConds.push(lte(users.createdAt, regTo));
  const userWhere = and(...userConds);

  // ── Order-aggregate subquery (single GROUP BY — no N+1) ──
  const revenueFilter = inArray(orders.status, REVENUE_STATUSES as unknown as string[]);
  const orderAgg = db.$with("order_agg").as(
    db.select({
      userId: orders.userId,
      orderCount: sql<number>`count(*)::int`.as("order_count"),
      revenueOrderCount: sql<number>`count(*) FILTER (WHERE ${revenueFilter})::int`.as("revenue_order_count"),
      totalSpentRaw: sql<string>`COALESCE(SUM(${orders.total}) FILTER (WHERE ${revenueFilter}), 0)`.as("total_spent_raw"),
      lastOrderDate: sql<string | null>`MAX(${orders.createdAt}::text)`.as("last_order_date"),
    }).from(orders).groupBy(orders.userId),
  );

  // HAVING-style filters that depend on the aggregate
  const aggConds: SQL[] = [];
  if (statusFilter === "with_orders") aggConds.push(sql`COALESCE(${orderAgg.orderCount}, 0) > 0`);
  if (statusFilter === "without_orders") aggConds.push(sql`COALESCE(${orderAgg.orderCount}, 0) = 0`);
  if (lodFrom) aggConds.push(sql`${orderAgg.lastOrderDate} >= ${lodFrom}`);
  if (lodTo) aggConds.push(sql`${orderAgg.lastOrderDate} <= ${lodTo}`);
  const fullWhere = aggConds.length ? and(userWhere, ...aggConds) : userWhere;

  // Total count (distinct users after all filters)
  const [countRow] = await db.with(orderAgg).select({ count: sql<number>`count(*)::int` })
    .from(users).leftJoin(orderAgg, eq(orderAgg.userId, users.id)).where(fullWhere);
  const total = Number(countRow?.count ?? 0);

  // Sorting (whitelist mapped to SQL — never arbitrary input)
  let orderBy: SQL;
  switch (sort) {
    case "oldest": orderBy = sql`${users.createdAt} ASC, ${users.id} ASC`; break;
    case "name_asc": orderBy = sql`${users.name} ASC, ${users.id} ASC`; break;
    case "name_desc": orderBy = sql`${users.name} DESC, ${users.id} ASC`; break;
    case "orders_desc": orderBy = sql`COALESCE(${orderAgg.orderCount}, 0) DESC, ${users.createdAt} DESC, ${users.id} ASC`; break;
    case "spend_desc": orderBy = sql`COALESCE(${orderAgg.totalSpentRaw}, 0)::numeric DESC, ${users.createdAt} DESC, ${users.id} ASC`; break;
    case "last_order_desc": orderBy = sql`${orderAgg.lastOrderDate} DESC NULLS LAST, ${users.createdAt} DESC, ${users.id} ASC`; break;
    case "newest":
    default: orderBy = sql`${users.createdAt} DESC, ${users.id} ASC`;
  }

  const rows = await db.with(orderAgg).select({
    id: users.id,
    email: users.email,
    name: users.name,
    phone: users.phone,
    nif: users.nif,
    company: users.company,
    isActive: users.isActive,
    createdAt: users.createdAt,
    orderCount: sql<number>`COALESCE(${orderAgg.orderCount}, 0)::int`,
    totalSpentRaw: sql<string>`COALESCE(${orderAgg.totalSpentRaw}, 0)`,
    lastOrderDate: sql<Date | null>`${orderAgg.lastOrderDate}`,
  }).from(users)
    .leftJoin(orderAgg, eq(orderAgg.userId, users.id))
    .where(fullWhere)
    .orderBy(orderBy)
    .limit(pageSize)
    .offset(offset);

  const customers: AdminCustomerListRow[] = rows.map(r => ({
    id: r.id,
    email: r.email,
    name: r.name,
    phone: r.phone,
    nif: r.nif,
    company: r.company,
    isActive: r.isActive,
    createdAt: r.createdAt,
    orderCount: Number(r.orderCount ?? 0),
    totalSpentCents: Math.round(parseFloat(String(r.totalSpentRaw ?? "0")) * 100),
    lastOrderDate: r.lastOrderDate ? new Date(String(r.lastOrderDate).replace(" ", "T") + "Z") : null,
  }));

  return {
    customers,
    pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
  };
}

// ─── DETAIL ──────────────────────────────────────────────
export async function getAdminCustomerDetail(customerId: number, ordersPage = 1, ordersPageSize = 25): Promise<AdminCustomerDetail> {
  const [customer] = await db.select().from(users).where(eq(users.id, customerId)).limit(1);
  if (!customer || customer.role !== "customer") {
    throw new Error("CUSTOMER_NOT_FOUND");
  }

  const stats = await getCustomerStatistics(customerId);

  const rmaOpenStatuses = RMA_STATUSES.filter(s => s !== "completed" && s !== "cancelled") as unknown as string[];
  const [rmaAgg] = await db.select({
    total: sql<number>`count(*)::int`,
    open: sql<number>`count(*) FILTER (WHERE ${inArray(rmaRequests.status, rmaOpenStatuses)})::int`,
    resolved: sql<number>`count(*) FILTER (WHERE ${inArray(rmaRequests.status, ["completed", "cancelled"])})::int`,
  }).from(rmaRequests).where(eq(rmaRequests.userId, customerId));

  const [wl] = await db.select({ count: sql<number>`count(*)::int` }).from(wishlists).where(eq(wishlists.userId, customerId));

  const addrRows = await db.select().from(addresses).where(eq(addresses.userId, customerId))
    .orderBy(desc(addresses.isDefaultBilling), desc(addresses.isDefaultShipping), asc(addresses.createdAt));

  // Paginated orders (detail tab)
  const p = normalizePage(ordersPage);
  const ps = Math.min(100, Math.max(1, ordersPageSize));
  const [oc] = await db.select({ count: sql<number>`count(*)::int` }).from(orders).where(eq(orders.userId, customerId));
  const orderTotal = Number(oc?.count ?? 0);
  const orderRows = await db.select({
    id: orders.id,
    orderNumber: orders.orderNumber,
    createdAt: orders.createdAt,
    total: orders.total,
    status: orders.status,
    paymentStatus: orders.paymentStatus,
    deliveryType: orders.deliveryType,
  }).from(orders).where(eq(orders.userId, customerId))
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(ps).offset((p - 1) * ps);

  const noteRows = await db.select({
    id: customerNotes.id,
    userId: customerNotes.userId,
    authorUserId: customerNotes.authorUserId,
    authorName: users.name,
    authorEmail: users.email,
    note: customerNotes.note,
    createdAt: customerNotes.createdAt,
    updatedAt: customerNotes.updatedAt,
  }).from(customerNotes)
    .leftJoin(users, eq(customerNotes.authorUserId, users.id))
    .where(eq(customerNotes.userId, customerId))
    .orderBy(desc(customerNotes.createdAt), desc(customerNotes.id));

  return {
    customer: {
      id: customer.id, email: customer.email, name: customer.name,
      phone: customer.phone, nif: customer.nif, company: customer.company,
      isActive: customer.isActive, role: customer.role,
      createdAt: customer.createdAt, updatedAt: customer.updatedAt,
    },
    statistics: {
      totalOrders: stats.totalOrders,
      totalSpentCents: stats.totalSpentCents,
      averageOrderValueCents: stats.averageOrderValueCents,
      lastOrderDate: stats.lastOrderDate,
    },
    addresses: addrRows,
    ordersPaginated: {
      orders: orderRows,
      pagination: { page: p, pageSize: ps, total: orderTotal, totalPages: Math.max(1, Math.ceil(orderTotal / ps)) },
    },
    notes: noteRows,
    rmaSummary: {
      total: Number(rmaAgg?.total ?? 0),
      open: Number(rmaAgg?.open ?? 0),
      resolved: Number(rmaAgg?.resolved ?? 0),
    },
    wishlistCount: Number(wl?.count ?? 0),
  };
}

// ─── NOTES CRUD (manager/admin only) ─────────────────────
export async function createCustomerNote(customerId: number, note: string, authorId: number): Promise<{ id: number }> {
  if (!note.trim()) throw new CustomerValidationError("NOTE_EMPTY");
  if (note.trim().length > 5000) throw new CustomerValidationError("NOTE_TOO_LONG");

  const [customer] = await db.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, customerId)).limit(1);
  if (!customer || customer.role !== "customer") throw new Error("CUSTOMER_NOT_FOUND");

  const [inserted] = await db.insert(customerNotes).values({
    userId: customerId, note: note.trim(), authorUserId: authorId,
  }).returning({ id: customerNotes.id });

  await createAuditLog({
    userId: authorId,
    action: "customer.note_created",
    entity: "customer_note",
    entityId: inserted.id,
    details: { customerId },
  });
  return { id: inserted.id };
}

export async function updateCustomerNote(noteId: number, note: string, actorId: number): Promise<void> {
  if (!note.trim()) throw new CustomerValidationError("NOTE_EMPTY");
  if (note.trim().length > 5000) throw new CustomerValidationError("NOTE_TOO_LONG");

  const [existing] = await db.select().from(customerNotes).where(eq(customerNotes.id, noteId)).limit(1);
  if (!existing) throw new Error("NOTE_NOT_FOUND");

  await db.update(customerNotes).set({ note: note.trim(), updatedAt: new Date() }).where(eq(customerNotes.id, noteId));
  await createAuditLog({
    userId: actorId,
    action: "customer.note_updated",
    entity: "customer_note",
    entityId: noteId,
    details: { customerId: existing.userId },
  });
}

export async function deleteCustomerNote(noteId: number, actorId: number): Promise<void> {
  const [existing] = await db.select().from(customerNotes).where(eq(customerNotes.id, noteId)).limit(1);
  if (!existing) throw new Error("NOTE_NOT_FOUND");

  await db.delete(customerNotes).where(eq(customerNotes.id, noteId));
  await createAuditLog({
    userId: actorId,
    action: "customer.note_deleted",
    entity: "customer_note",
    entityId: noteId,
    details: { customerId: existing.userId },
  });
}

// ─── ACCOUNT STATUS (disable / reactivate) ────────────────
export async function disableCustomer(customerId: number, actorId: number, reason?: string): Promise<{ changed: boolean }> {
  let changed = false;
  await db.transaction(async (tx) => {
    const [existing] = await tx.select({ id: users.id, role: users.role, isActive: users.isActive })
      .from(users).where(eq(users.id, customerId)).limit(1);
    if (!existing || existing.role !== "customer") throw new Error("CUSTOMER_NOT_FOUND");
    if (!existing.isActive) return; // idempotent
    // Disable only flips isActive — never touches orders/items/snapshots/RMA.
    await tx.update(users).set({ isActive: false, updatedAt: new Date() }).where(eq(users.id, customerId));
    changed = true;
  });

  if (changed) {
    await createAuditLog({
      userId: actorId,
      action: "customer.disabled",
      entity: "customer",
      entityId: customerId,
      details: reason ? { reason } : undefined,
    });
  }
  return { changed };
}

export async function reactivateCustomer(customerId: number, actorId: number): Promise<{ changed: boolean }> {
  let changed = false;
  await db.transaction(async (tx) => {
    const [existing] = await tx.select({ id: users.id, role: users.role, isActive: users.isActive })
      .from(users).where(eq(users.id, customerId)).limit(1);
    if (!existing || existing.role !== "customer") throw new Error("CUSTOMER_NOT_FOUND");
    if (existing.isActive) return; // idempotent
    // Reactivate ONLY flips isActive — password untouched.
    await tx.update(users).set({ isActive: true, updatedAt: new Date() }).where(eq(users.id, customerId));
    changed = true;
  });

  if (changed) {
    await createAuditLog({
      userId: actorId,
      action: "customer.reactivated",
      entity: "customer",
      entityId: customerId,
    });
  }
  return { changed };
}

// ─── ACCOUNT (customer self-service) ─────────────────────
export type AccountProfileData = {
  id: number; email: string; name: string; phone: string | null;
  nif: string | null; company: string | null; isActive: boolean; createdAt: Date;
};

export async function getAccountProfile(userId: number): Promise<AccountProfileData> {
  const [user] = await db.select({
    id: users.id, email: users.email, name: users.name,
    phone: users.phone, nif: users.nif, company: users.company,
    isActive: users.isActive, createdAt: users.createdAt,
  }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new Error("USER_NOT_FOUND");
  return user;
}

export async function updateAccountProfile(
  userId: number,
  data: { name?: string; phone?: string | null; nif?: string | null; company?: string | null },
): Promise<AccountProfileData> {
  const [existing] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!existing) throw new Error("USER_NOT_FOUND");

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (data.name !== undefined) {
    const n = data.name.trim();
    if (!n) throw new CustomerValidationError("NAME_EMPTY");
    updates.name = n;
  }
  if (data.phone !== undefined) updates.phone = data.phone?.trim() || null;
  if (data.nif !== undefined) updates.nif = data.nif?.trim() || null;
  if (data.company !== undefined) updates.company = data.company?.trim() || null;

  await db.update(users).set(updates).where(eq(users.id, userId));
  return getAccountProfile(userId);
}

export async function getAccountAddresses(userId: number) {
  return db.select().from(addresses).where(eq(addresses.userId, userId))
    .orderBy(desc(addresses.isDefaultBilling), desc(addresses.isDefaultShipping), asc(addresses.createdAt));
}

export async function getAccountAddressById(addressId: number, userId: number) {
  const [addr] = await db.select().from(addresses).where(eq(addresses.id, addressId)).limit(1);
  if (!addr || addr.userId !== userId) return null; // 404 — no cross-customer enumeration
  return addr;
}

export interface AddressInput {
  label?: string | null;
  name: string;
  address1: string;
  address2?: string | null;
  city: string;
  postalCode: string;
  country?: string;
  phone?: string | null;
  setDefaultBilling?: boolean;
  setDefaultShipping?: boolean;
}

export async function createAccountAddress(userId: number, data: AddressInput) {
  return db.transaction(async (tx) => {
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(addresses).where(eq(addresses.userId, userId));
    const first = Number(n) === 0;

    const setBilling = data.setDefaultBilling === true || first;
    const setShipping = data.setDefaultShipping === true || first;

    // Transactionally clear previous defaults (DB + service guarantee)
    if (setBilling) {
      await tx.update(addresses).set({ isDefaultBilling: false })
        .where(and(eq(addresses.userId, userId), eq(addresses.isDefaultBilling, true)));
    }
    if (setShipping) {
      await tx.update(addresses).set({ isDefaultShipping: false })
        .where(and(eq(addresses.userId, userId), eq(addresses.isDefaultShipping, true)));
    }

    const [created] = await tx.insert(addresses).values({
      userId,
      label: data.label?.trim() || null,
      name: data.name.trim(),
      address1: data.address1.trim(),
      address2: data.address2?.trim() || null,
      city: data.city.trim(),
      postalCode: data.postalCode.trim(),
      country: data.country?.trim() || "Portugal",
      phone: data.phone?.trim() || null,
      isDefaultBilling: setBilling,
      isDefaultShipping: setShipping,
    }).returning();
    return created;
  });
}

export async function updateAccountAddress(addressId: number, userId: number, data: Partial<AddressInput>) {
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(addresses).where(eq(addresses.id, addressId)).limit(1);
    if (!existing || existing.userId !== userId) throw new Error("ADDRESS_NOT_FOUND");

    if (data.setDefaultBilling === true && !existing.isDefaultBilling) {
      await tx.update(addresses).set({ isDefaultBilling: false })
        .where(and(eq(addresses.userId, userId), eq(addresses.isDefaultBilling, true)));
      await tx.update(addresses).set({ isDefaultBilling: true }).where(eq(addresses.id, addressId));
    }
    if (data.setDefaultShipping === true && !existing.isDefaultShipping) {
      await tx.update(addresses).set({ isDefaultShipping: false })
        .where(and(eq(addresses.userId, userId), eq(addresses.isDefaultShipping, true)));
      await tx.update(addresses).set({ isDefaultShipping: true }).where(eq(addresses.id, addressId));
    }

    const updates: Record<string, unknown> = {};
    if (data.label !== undefined) updates.label = data.label?.trim() || null;
    if (data.name !== undefined) {
      const n = data.name.trim();
      if (!n) throw new CustomerValidationError("NAME_EMPTY");
      updates.name = n;
    }
    if (data.address1 !== undefined) {
      const a = data.address1.trim();
      if (!a) throw new CustomerValidationError("ADDRESS1_EMPTY");
      updates.address1 = a;
    }
    if (data.address2 !== undefined) updates.address2 = data.address2?.trim() || null;
    if (data.city !== undefined) {
      const c = data.city.trim();
      if (!c) throw new CustomerValidationError("CITY_EMPTY");
      updates.city = c;
    }
    if (data.postalCode !== undefined) {
      const pc = data.postalCode.trim();
      if (!pc) throw new CustomerValidationError("POSTAL_CODE_EMPTY");
      updates.postalCode = pc;
    }
    if (data.country !== undefined) updates.country = data.country.trim() || "Portugal";
    if (data.phone !== undefined) updates.phone = data.phone?.trim() || null;

    if (Object.keys(updates).length) {
      await tx.update(addresses).set(updates).where(eq(addresses.id, addressId));
    }
    const [row] = await tx.select().from(addresses).where(eq(addresses.id, addressId)).limit(1);
    return row;
  });
}

export async function deleteAccountAddress(addressId: number, userId: number): Promise<void> {
  await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(addresses).where(eq(addresses.id, addressId)).limit(1);
    if (!existing || existing.userId !== userId) throw new Error("ADDRESS_NOT_FOUND");
    // Deleting an account address NEVER touches historical order snapshots
    // (snapshots live in orders.billingAddress / orders.shippingAddress as JSONB).
    await tx.delete(addresses).where(eq(addresses.id, addressId));
  });
}

export type AccountOrderListRow = {
  id: number; orderNumber: string; createdAt: Date; total: string;
  status: string; paymentStatus: string; deliveryType: string;
  trackingNumber: string | null;
};

export async function getAccountOrders(userId: number, page = 1, pageSize = 25) {
  const p = normalizePage(page);
  const ps = Math.min(100, Math.max(1, pageSize));
  const [countRow] = await db.select({ count: sql<number>`count(*)::int` }).from(orders).where(eq(orders.userId, userId));
  const total = Number(countRow?.count ?? 0);
  const rows = await db.select({
    id: orders.id, orderNumber: orders.orderNumber, createdAt: orders.createdAt,
    total: orders.total, status: orders.status, paymentStatus: orders.paymentStatus,
    deliveryType: orders.deliveryType, trackingNumber: orders.trackingNumber,
  }).from(orders).where(eq(orders.userId, userId))
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(ps).offset((p - 1) * ps);
  return { orders: rows, pagination: { page: p, pageSize: ps, total, totalPages: Math.max(1, Math.ceil(total / ps)) } };
}

export async function getAccountOrderDetail(orderId: number, userId: number) {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order || order.userId !== userId) return null; // IDOR-safe: 404

  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId)).orderBy(asc(orderItems.id));
  return { order, items };
}
