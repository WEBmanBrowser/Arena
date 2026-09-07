/**
 * C.3.4.2 — Admin API das FONTES de fornecedor (coleção por fornecedor).
 *
 * GET  ?supplierId=N → listar as fontes do fornecedor (leitura = staff).
 * POST               → criar fonte (manager + CSRF), validação zod com as
 *                      MESMAS guardas puras de URL/SSRF usadas no fetch.
 *
 * Segurança herdada do padrão do repo:
 *  - nunca há valor de segredo na entrada nem na saída: apenas
 *    `secret_reference` (o NOME do secret no runtime);
 *  - a fonte nova nasce SEMPRE `enabled = false` — o `enabled` recebido no
 *    body é ignorado (ativar é um PATCH explícito, auditável);
 *  - apply_policy não é aceite: `preview_only` é o único valor desta fase.
 */
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser, isManager, isStaff } from "@/lib/auth";
import { csrfGuard } from "@/lib/csrf";
import { SupplierSourceError } from "@/lib/supplier-import/source";
import { supplierImportErrorMessage, classifyImportStorageFailure } from "@/lib/supplier-import/error-messages";
import { supplierSourceCreateSchema } from "@/lib/supplier-source-schemas";
import { createSupplierSource, listSupplierSources } from "@/lib/services/supplier-source-service";

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user || !isStaff(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

  const supplierParam = req.nextUrl.searchParams.get("supplierId");
  const supplierId = supplierParam ? Number.parseInt(supplierParam, 10) : NaN;
  if (!Number.isInteger(supplierId) || supplierId < 1) {
    return NextResponse.json({ error: "INVALID_SUPPLIER_ID", message: supplierImportErrorMessage("INVALID_SUPPLIER_ID") }, { status: 400 });
  }
  const sources = await listSupplierSources(supplierId);
  return NextResponse.json({ sources });
}

export async function POST(req: NextRequest) {
  const csrf = csrfGuard(req);
  if (csrf) return csrf;

  const user = await getCurrentUser();
  if (!user || !isManager(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "INVALID_BODY", message: supplierImportErrorMessage("INVALID_BODY") }, { status: 400 });
  }

  const parsed = supplierSourceCreateSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "VALIDATION_ERROR", message: "Dados da fonte inválidos", details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
      { status: 400 }
    );
  }

  try {
    const source = await createSupplierSource(parsed.data, user.id);
    return NextResponse.json({ source });
  } catch (e) {
    if (e instanceof SupplierSourceError) {
      return NextResponse.json({ error: e.code, message: supplierImportErrorMessage(e.code) }, { status: e.httpStatus });
    }
    console.error("supplier source create:", e);
    const storage = classifyImportStorageFailure(e);
    if (storage) return NextResponse.json({ error: storage.code, message: storage.message }, { status: 500 });
    return NextResponse.json({ error: "SOURCE_RUN_FAILED", message: supplierImportErrorMessage("SOURCE_RUN_FAILED") }, { status: 500 });
  }
}
