/**
 * C.3.1 — Apply (or resume) a persisted supplier import snapshot.
 *
 * The only input is the import id, plus the signed token for the FIRST apply.
 * Financial values never travel back from the browser: apply consumes
 * supplier_import_rows. A resume of a `partial` (or abandoned `applying`)
 * import therefore needs no re-upload of the CSV.
 */
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser, isManager } from "@/lib/auth";
import { csrfGuard } from "@/lib/csrf";
import { SupplierImportError, applySupplierImport } from "@/lib/services/supplier-import-service";
import {
  classifyImportStorageFailure,
  supplierImportErrorMessage,
} from "@/lib/supplier-import/error-messages";

export async function POST(req: NextRequest) {
  const csrf = csrfGuard(req);
  if (csrf) return csrf;

  const user = await getCurrentUser();
  if (!user || !isManager(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "INVALID_BODY", message: supplierImportErrorMessage("INVALID_BODY") }, { status: 400 });
  }

  const importId = Number(body.importId);
  if (!Number.isInteger(importId) || importId < 1) {
    return NextResponse.json({ error: "IMPORT_ID_REQUIRED", message: supplierImportErrorMessage("IMPORT_ID_REQUIRED") }, { status: 400 });
  }
  const previewToken = typeof body.previewToken === "string" ? body.previewToken : undefined;

  try {
    const outcome = await applySupplierImport({ importId, previewToken, userId: user.id });
    return NextResponse.json({ ok: !outcome.error, ...outcome });
  } catch (e) {
    if (e instanceof SupplierImportError) {
      return NextResponse.json(
        { error: e.code, message: supplierImportErrorMessage(e.code, e.detail) },
        { status: e.httpStatus }
      );
    }
    // The technical error stays in the server log; the browser only receives a
    // classified, safe category — never SQL, query, params or a stack trace.
    console.error("supplier import apply:", e);
    const storage = classifyImportStorageFailure(e);
    if (storage) return NextResponse.json({ error: storage.code, message: storage.message }, { status: 500 });
    return NextResponse.json(
      { error: "SUPPLIER_IMPORT_APPLY_FAILED", message: supplierImportErrorMessage("SUPPLIER_IMPORT_APPLY_FAILED") },
      { status: 500 }
    );
  }
}
