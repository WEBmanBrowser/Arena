import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser, isStaff, isManager } from "@/lib/auth";
import { csrfGuard } from "@/lib/csrf";
import {
  getAdminOrderDetail,
  listAdminOrders,
  updateAdminOrderStatus,
  updateOrderTracking,
  AdminOrderValidationError,
  ADMIN_ORDER_QUEUES,
  ADMIN_ORDER_SORTS,
  ADMIN_ORDER_DATE_REGEX,
} from "@/lib/services/admin-orders-service";
import { ORDER_STATUSES, PAYMENT_STATUSES, DELIVERY_TYPES } from "@/db/schema";
import { z } from "zod";

// RBAC: statuses that require manager/admin level (B.2.1)
const CRITICAL_STATUSES = ["cancelled", "refunded"] as const;

const querySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  search: z.string().optional(),
  queue: z.enum(ADMIN_ORDER_QUEUES).optional(),
  status: z.enum(ORDER_STATUSES).optional(),
  paymentStatus: z.enum(PAYMENT_STATUSES).optional(),
  deliveryType: z.enum(DELIVERY_TYPES).optional(),
  dateFrom: z.string().regex(ADMIN_ORDER_DATE_REGEX, "INVALID_DATEFROM_FORMAT").optional(),
  dateTo: z.string().regex(ADMIN_ORDER_DATE_REGEX, "INVALID_DATETO_FORMAT").optional(),
  sort: z.enum(ADMIN_ORDER_SORTS).optional(),
});

const updateSchema = z.object({
  id: z.number().int().min(1),
  status: z.enum(ORDER_STATUSES).optional(),
  comment: z.string().optional(),
  trackingNumber: z.string().nullable().optional(),
});

/** Drop empty-string query params so optional filters can be omitted cleanly. */
function compactQuery(req: NextRequest): Record<string, string> {
  const out: Record<string, string> = {};
  req.nextUrl.searchParams.forEach((value, key) => {
    if (value !== "") out[key] = value;
  });
  return out;
}

export async function GET(req: NextRequest) {
  // RBAC — 401 (no session) vs 403 (authenticated, insufficient role)
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sessão requerida" }, { status: 401 });
  if (!isStaff(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

  const parsed = querySchema.safeParse(compactQuery(req));
  if (!parsed.success) return NextResponse.json({ error: "VALIDATION_ERROR", issues: parsed.error.issues.map(i => i.path.join(".")) }, { status: 400 });

  try {
    const result = await listAdminOrders(parsed.data);
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof AdminOrderValidationError) return NextResponse.json({ error: e.message }, { status: 400 });
    console.error("admin orders list failed:", e);
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sessão requerida" }, { status: 401 });
  if (!isStaff(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

  const parsed = updateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "VALIDATION_ERROR" }, { status: 400 });
  const body = parsed.data;

  // Critical operations (cancelled/refunded) require manager/admin
  if (body.status && (CRITICAL_STATUSES as readonly string[]).includes(body.status) && !isManager(user.role)) {
    return NextResponse.json({ error: "Operação requer nível manager ou admin" }, { status: 403 });
  }

  try {
    let detail;
    if (body.status) detail = await updateAdminOrderStatus(body.id, body.status, user.id, body.comment);
    if (body.trackingNumber !== undefined) detail = (await updateOrderTracking(body.id, body.trackingNumber, user.id)).order;
    if (!detail) detail = await getAdminOrderDetail(body.id);
    return NextResponse.json(detail);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Erro";
    if (msg === "ORDER_NOT_FOUND") return NextResponse.json({ error: "Encomenda não encontrada" }, { status: 404 });
    if (e instanceof AdminOrderValidationError || msg === "EXPIRED_IS_SYSTEM_ONLY" || msg === "INVALID_STATUS" || msg === "TRACKING_TOO_LONG") {
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    // State machine transition errors (central Phase A logic) are client errors
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
