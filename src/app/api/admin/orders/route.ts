import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser, isStaff } from "@/lib/auth";
import { getAdminOrderDetail, listAdminOrders, updateAdminOrderStatus, updateOrderTracking } from "@/lib/services/admin-orders-service";
import { z } from "zod";

const querySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  search: z.string().optional(),
  status: z.string().optional(),
  paymentStatus: z.string().optional(),
  deliveryType: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  sort: z.string().optional(),
});

const updateSchema = z.object({
  id: z.number().int().min(1),
  status: z.string().optional(),
  comment: z.string().optional(),
  trackingNumber: z.string().nullable().optional(),
});

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user || !isStaff(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams.entries()));
  if (!parsed.success) return NextResponse.json({ error: "VALIDATION_ERROR" }, { status: 400 });
  const result = await listAdminOrders(parsed.data);
  return NextResponse.json(result);
}

export async function PUT(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user || !isStaff(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

  const parsed = updateSchema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: "VALIDATION_ERROR" }, { status: 400 });
  const body = parsed.data;

  try {
    let detail;
    if (body.status) detail = await updateAdminOrderStatus(body.id, body.status, user.id, body.comment);
    if (body.trackingNumber !== undefined) detail = (await updateOrderTracking(body.id, body.trackingNumber, user.id)).order;
    if (!detail) detail = await getAdminOrderDetail(body.id);
    return NextResponse.json(detail);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Erro";
    if (msg === "ORDER_NOT_FOUND") return NextResponse.json({ error: "Encomenda não encontrada" }, { status: 404 });
    if (msg === "INVALID_STATUS" || msg === "EXPIRED_IS_SYSTEM_ONLY" || msg === "TRACKING_TOO_LONG") return NextResponse.json({ error: msg }, { status: 400 });
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
