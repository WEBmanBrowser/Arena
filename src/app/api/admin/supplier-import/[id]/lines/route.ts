/**
 * C.3.1 — Snapshot lines of a persisted import.
 *
 * Lets the UI rebuild the preview (matching, conflicts, prices) after a reload
 * or a resume, straight from supplier_import_rows — the same source apply uses.
 */
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser, isStaff } from "@/lib/auth";
import { getImportLines } from "@/lib/services/supplier-import-service";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser();
  if (!user || !isStaff(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

  const { id } = await params;
  const importId = Number.parseInt(id, 10);
  if (!Number.isInteger(importId) || importId < 1) return NextResponse.json({ error: "INVALID_IMPORT_ID" }, { status: 400 });

  const rows = await getImportLines(importId);
  return NextResponse.json({ rows });
}
