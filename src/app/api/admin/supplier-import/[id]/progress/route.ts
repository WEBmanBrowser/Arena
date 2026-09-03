/**
 * C.3.1 — Import progress, read from the persisted rows.
 *
 * The counters come from supplier_import_rows, never from what a client
 * reported, and `canResume` is decided server-side (partial, or an `applying`
 * whose heartbeat went stale). The UI may poll this and render the result — it
 * is never allowed to decide staleness itself.
 */
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser, isStaff } from "@/lib/auth";
import { getImportProgress } from "@/lib/services/supplier-import-service";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser();
  if (!user || !isStaff(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

  const { id } = await params;
  const importId = Number.parseInt(id, 10);
  if (!Number.isInteger(importId) || importId < 1) return NextResponse.json({ error: "INVALID_IMPORT_ID" }, { status: 400 });

  const progress = await getImportProgress(importId);
  if (!progress) return NextResponse.json({ error: "IMPORT_NOT_FOUND" }, { status: 404 });
  return NextResponse.json(progress);
}
