import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser, isManager } from "@/lib/auth";
import { csrfGuard } from "@/lib/csrf";
import { RefundError, recordManualCreditNote } from "@/lib/refunds";
import { z } from "zod";

const creditNoteSchema = z.object({
  originalDocumentId: z.number().int().positive(),
  officialReference: z.string().min(2).max(100),
  amountCents: z.number().int().positive(),
  issuedAt: z.string().optional(),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const csrf = csrfGuard(req);
  if (csrf) return csrf;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sessão requerida" }, { status: 401 });
  if (!isManager(user.role)) return NextResponse.json({ error: "Operação requer nível manager ou admin" }, { status: 403 });

  const { id } = await params;
  const orderId = Number.parseInt(id, 10);
  if (!Number.isInteger(orderId) || orderId < 1) return NextResponse.json({ error: "ID inválido" }, { status: 400 });

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const parsed = creditNoteSchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: "VALIDATION_ERROR", details: parsed.error.issues.map(i => i.message).join("; ") }, { status: 400 });

  const issuedAt = parsed.data.issuedAt ? new Date(parsed.data.issuedAt) : new Date();
  if (Number.isNaN(issuedAt.getTime())) return NextResponse.json({ error: "INVALID_ISSUED_AT" }, { status: 400 });

  try {
    const document = await recordManualCreditNote({
      orderId,
      originalDocumentId: parsed.data.originalDocumentId,
      officialReference: parsed.data.officialReference,
      issuedAt,
      amountCents: parsed.data.amountCents,
      actorId: user.id,
    });
    return NextResponse.json({ document }, { status: 201 });
  } catch (e) {
    if (e instanceof RefundError) {
      const status =
        e.code === "ORDER_NOT_FOUND"
          ? 404
          : e.code === "DUPLICATE_DOCUMENT" || e.code === "CREDIT_NOTE_EXCEEDS_INVOICE"
          ? 409
          : 400;
      return NextResponse.json({ error: e.message, code: e.code }, { status });
    }
    console.error("credit note record failed:", e);
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
