import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser, isManager } from "@/lib/auth";
import { ManualInvoicingError, recordManualInvoice } from "@/lib/manual-invoicing";
import { z } from "zod";

const schema = z.object({
  officialReference: z.string().min(2).max(100),
  issuedAt: z.string().optional(),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sessão requerida" }, { status: 401 });
  if (!isManager(user.role)) return NextResponse.json({ error: "Operação requer nível manager ou admin" }, { status: 403 });

  const { id } = await params;
  const orderId = Number.parseInt(id, 10);
  if (!Number.isInteger(orderId) || orderId < 1) return NextResponse.json({ error: "ID inválido" }, { status: 400 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "VALIDATION_ERROR" }, { status: 400 });
  const issuedAt = parsed.data.issuedAt ? new Date(parsed.data.issuedAt) : new Date();
  if (Number.isNaN(issuedAt.getTime())) return NextResponse.json({ error: "INVALID_ISSUED_AT" }, { status: 400 });

  try {
    const document = await recordManualInvoice({
      orderId,
      actorUserId: user.id,
      officialReference: parsed.data.officialReference,
      issuedAt,
    });
    return NextResponse.json({ document }, { status: 201 });
  } catch (e) {
    if (e instanceof ManualInvoicingError) {
      const status = e.code === "ORDER_NOT_FOUND" ? 404 : e.code === "DUPLICATE_INVOICE" ? 409 : 400;
      return NextResponse.json({ error: e.message, code: e.code }, { status });
    }
    console.error("manual invoice record failed:", e);
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
