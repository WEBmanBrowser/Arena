/**
 * C.3.4.2 — Reopen a persisted supplier import preview for manual review.
 *
 * GET only. Returns the snapshot exactly as persisted (header + the same
 * visible window of rows as a fresh preview) plus a FRESH signed apply token —
 * the missing link between "Sync Now created import #N" (or a manual preview
 * followed by a reload) and the existing Apply button.
 *
 * What this route never does:
 *  - apply anything: the token only becomes an action through
 *    POST /api/admin/supplier-import/apply (manager + CSRF, unchanged);
 *  - re-parse, re-match or re-price: nothing is recomputed, nothing is
 *    written — supplier_imports/supplier_import_rows/status are untouched;
 *  - persist the token: it lives in this response only, like the original.
 *
 * RBAC mirrors the other read routes of the import panel (staff+ can look);
 * the write side keeps its own gate. Errors are the shared safe codes.
 */
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser, isStaff } from "@/lib/auth";
import { SupplierImportError, reopenSupplierImportPreview } from "@/lib/services/supplier-import-service";
import {
  classifyImportStorageFailure,
  supplierImportErrorMessage,
} from "@/lib/supplier-import/error-messages";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser();
  if (!user || !isStaff(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

  const { id } = await params;
  const importId = Number.parseInt(id, 10);
  if (!Number.isInteger(importId) || importId < 1 || String(importId) !== id.trim()) {
    return NextResponse.json({ error: "INVALID_IMPORT_ID" }, { status: 400 });
  }

  try {
    const preview = await reopenSupplierImportPreview(importId);
    return NextResponse.json(preview);
  } catch (e) {
    if (e instanceof SupplierImportError) {
      return NextResponse.json(
        { error: e.code, message: supplierImportErrorMessage(e.code, e.detail) },
        { status: e.httpStatus }
      );
    }
    // The technical error stays in the server log; the browser only receives a
    // classified, safe category — never SQL, query, params or a stack trace.
    console.error("supplier import preview reopen:", e);
    const storage = classifyImportStorageFailure(e);
    if (storage) return NextResponse.json({ error: storage.code, message: storage.message }, { status: 500 });
    return NextResponse.json(
      { error: "SUPPLIER_IMPORT_PREVIEW_FAILED", message: supplierImportErrorMessage("SUPPLIER_IMPORT_PREVIEW_FAILED") },
      { status: 500 }
    );
  }
}
