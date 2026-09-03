/**
 * C.3.1 — Supplier import: preview + history.
 *
 * POST  → parse, match and PERSIST a preview snapshot. Nothing in the catalogue
 *         moves: products, prices, stock and supplier links are only touched by
 *         /apply, which consumes this snapshot.
 * GET   → import history for a supplier (or overall), newest first.
 *
 * RBAC mirrors the rest of the backoffice: reading is staff, importing is
 * manager, and the mutation additionally passes the same-origin CSRF guard.
 */
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser, isManager, isStaff } from "@/lib/auth";
import { csrfGuard } from "@/lib/csrf";
import { CSV_MAX_SIZE } from "@/lib/csv";
import { SupplierCsvError, byteLengthUtf8 } from "@/lib/supplier-import/normalize";
import {
  SupplierImportError,
  listSupplierImports,
  previewSupplierImport,
} from "@/lib/services/supplier-import-service";
import { SUPPLIER_IMPORT_MAX_ROWS } from "@/lib/supplier-import/constants";

function errorResponse(e: unknown): NextResponse {
  if (e instanceof SupplierCsvError) {
    const message = e.code === "CSV_TOO_MANY_ROWS"
      ? `Ficheiro com demasiadas linhas (máx. ${SUPPLIER_IMPORT_MAX_ROWS})`
      : e.code === "CSV_EMPTY" ? "CSV vazio"
      : e.code === "CSV_NO_DATA" ? "CSV sem linhas de dados"
      : e.code === "CSV_MISSING_KEY_COLUMN" ? "Ficheiro sem coluna de SKU do fornecedor, EAN ou SKU interno"
      : e.code === "CSV_NO_COLUMNS_MAPPED" ? "Nenhuma coluna reconhecida — mapeie as colunas"
      : e.code.startsWith("DUPLICATE_MAPPING") ? "Duas colunas mapeadas para o mesmo campo"
      : "Erro ao processar o CSV";
    return NextResponse.json({ error: e.code, message }, { status: e.httpStatus });
  }
  if (e instanceof SupplierImportError) {
    return NextResponse.json({ error: e.code, ...(e.detail ? { message: e.detail } : {}) }, { status: e.httpStatus });
  }
  console.error("supplier import preview:", e);
  return NextResponse.json({ error: "SUPPLIER_IMPORT_PREVIEW_FAILED" }, { status: 500 });
}

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user || !isStaff(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

  const supplierParam = req.nextUrl.searchParams.get("supplierId");
  const supplierId = supplierParam ? Number.parseInt(supplierParam, 10) : undefined;
  if (supplierParam && (!Number.isInteger(supplierId) || (supplierId as number) < 1)) {
    return NextResponse.json({ error: "INVALID_SUPPLIER_ID" }, { status: 400 });
  }
  const limitParam = req.nextUrl.searchParams.get("limit");
  const limit = limitParam ? Number.parseInt(limitParam, 10) : 20;

  const imports = await listSupplierImports({ supplierId, limit: Number.isFinite(limit) ? limit : 20 });
  return NextResponse.json({ imports });
}

export async function POST(req: NextRequest) {
  const csrf = csrfGuard(req);
  if (csrf) return csrf;

  const user = await getCurrentUser();
  if (!user || !isManager(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }

  const supplierId = Number(body.supplierId);
  const data = typeof body.data === "string" ? body.data : "";
  const fileName = typeof body.fileName === "string" && body.fileName.trim() ? body.fileName.trim() : "supplier-list.csv";
  const mapping = body.mapping && typeof body.mapping === "object"
    ? (body.mapping as Record<string, string>)
    : undefined;

  if (!Number.isInteger(supplierId) || supplierId < 1) {
    return NextResponse.json({ error: "SUPPLIER_ID_REQUIRED", message: "Fornecedor obrigatório" }, { status: 400 });
  }
  if (!data.trim()) return NextResponse.json({ error: "CSV_EMPTY", message: "CSV vazio" }, { status: 400 });
  // Bytes, not characters: a pt-PT file full of "§" and accents is several times
  // heavier than its string length claims, and the ceiling is a memory ceiling.
  const sizeBytes = byteLengthUtf8(data);
  if (sizeBytes > CSV_MAX_SIZE) {
    const limitMb = Math.round(CSV_MAX_SIZE / (1024 * 1024));
    return NextResponse.json({
      error: "CSV_FILE_TOO_LARGE",
      message: `Ficheiro com ${(sizeBytes / (1024 * 1024)).toFixed(1)} MB — o limite é ${limitMb} MB`,
    }, { status: 400 });
  }

  try {
    const preview = await previewSupplierImport({ supplierId, fileName, csvText: data, mapping, userId: user.id });
    return NextResponse.json(preview);
  } catch (e) {
    return errorResponse(e);
  }
}
