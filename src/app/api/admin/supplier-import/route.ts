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
import { classifySupplierFileName } from "@/lib/supplier-import/file";
import { XLSX_MAX_SIZE_BYTES, decodeBase64Strict } from "@/lib/supplier-import/xlsx";
import {
  SupplierImportError,
  listSupplierImports,
  previewSupplierImport,
  loadSupplierProfile,
  saveSupplierProfile,
} from "@/lib/services/supplier-import-service";
import {
  classifyImportStorageFailure,
  supplierImportErrorMessage,
} from "@/lib/supplier-import/error-messages";

function errorResponse(e: unknown): NextResponse {
  if (e instanceof SupplierCsvError) {
    // Canonical message from the shared API/UI table; an unrecognised code
    // (e.g. a legacy parser message) gets the generic sentence, never the raw
    // error text.
    return NextResponse.json(
      { error: e.code, message: supplierImportErrorMessage(e.code, undefined, "Erro ao processar o CSV") },
      { status: e.httpStatus }
    );
  }
  if (e instanceof SupplierImportError) {
    return NextResponse.json(
      { error: e.code, message: supplierImportErrorMessage(e.code, e.detail) },
      { status: e.httpStatus }
    );
  }
  // Unexpected database failure: the technical error is logged server-side and
  // the browser only ever receives a classified, safe category.
  console.error("supplier import preview:", e);
  const storage = classifyImportStorageFailure(e);
  if (storage) return NextResponse.json({ error: storage.code, message: storage.message }, { status: 500 });
  return NextResponse.json(
    { error: "SUPPLIER_IMPORT_PREVIEW_FAILED", message: supplierImportErrorMessage("SUPPLIER_IMPORT_PREVIEW_FAILED") },
    { status: 500 }
  );
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

  const profileParam = req.nextUrl.searchParams.get("profile");
  if (profileParam === "1" && supplierId) {
    const profile = await loadSupplierProfile(supplierId);
    return NextResponse.json({ profile });
  }

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
  if (body.action === "saveProfile") {
    const profileMapping = body.mapping && typeof body.mapping === "object"
      ? (body.mapping as Record<string, string>)
      : {};
    const profileDelimiter = typeof body.delimiter === "string" ? body.delimiter : null;
    const saved = await saveSupplierProfile(supplierId, profileMapping, profileDelimiter, user.id);
    return NextResponse.json({ profile: saved, action: "saveProfile" });
  }

  // C.3.2 — a UI envia sempre `mapping` ({} quando não há escolha manual); um
  // mapping vazio é tratado como AUSENTE para não esconder o perfil guardado.
  // Só um mapping manual com pelo menos uma entrada string→string passa adiante.
  const bodyMapping = body.mapping && typeof body.mapping === "object" && !Array.isArray(body.mapping)
    ? (body.mapping as Record<string, unknown>)
    : undefined;
  const mapping = bodyMapping && Object.values(bodyMapping).some((v) => typeof v === "string")
    ? (bodyMapping as Record<string, string>)
    : undefined;
  // C.3.2 — o preview pode pedir para guardar o perfil do fornecedor.
  const saveProfile = body.saveProfile === true || body.saveProfile === "true";

  if (!Number.isInteger(supplierId) || supplierId < 1) {
    return NextResponse.json({ error: "SUPPLIER_ID_REQUIRED", message: "Fornecedor obrigatório" }, { status: 400 });
  }

  // C.3.3 (etapa 2) — o formato é escolhido pela extensão e confirmado pela
  // assinatura dos bytes no parser (ZIP/OOXML), nunca só pela extensão.
  const kind = classifySupplierFileName(fileName);
  if (kind === "unsupported") {
    return NextResponse.json(
      { error: "FILE_TYPE_NOT_SUPPORTED", message: supplierImportErrorMessage("FILE_TYPE_NOT_SUPPORTED") },
      { status: 400 }
    );
  }

  if (kind === "xlsx") {
    // XLSX viaja como base64 estrito no mesmo JSON (sem multipart nesta fase).
    // A decodificação é estrita: charset/padding/canonicidade verificados, e
    // tudo a seguir (teto de 5 MB, SHA-256) opera sobre os BYTES decodificados.
    const xlsxBytes = decodeBase64Strict(data);
    if (!xlsxBytes) {
      return NextResponse.json(
        { error: "XLSX_INVALID", message: supplierImportErrorMessage("XLSX_INVALID") },
        { status: 400 }
      );
    }
    // Recusado ANTES de qualquer parsing pesado — e medido em bytes.
    if (xlsxBytes.length > XLSX_MAX_SIZE_BYTES) {
      const limitMb = Math.round(XLSX_MAX_SIZE_BYTES / (1024 * 1024));
      return NextResponse.json({
        error: "XLSX_TOO_LARGE",
        message: `Ficheiro com ${(xlsxBytes.length / (1024 * 1024)).toFixed(1)} MB — o limite é ${limitMb} MB`,
      }, { status: 400 });
    }
    try {
      const preview = await previewSupplierImport({
        supplierId, fileName, csvText: "", xlsxBytes, mapping, userId: user.id, saveProfile,
      });
      return NextResponse.json(preview);
    } catch (e) {
      return errorResponse(e);
    }
  }

  // ── CSV/TXT — caminho exatamente como antes da etapa 2 ──
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
    const preview = await previewSupplierImport({ supplierId, fileName, csvText: data, mapping, userId: user.id, saveProfile });
    return NextResponse.json(preview);
  } catch (e) {
    return errorResponse(e);
  }
}
