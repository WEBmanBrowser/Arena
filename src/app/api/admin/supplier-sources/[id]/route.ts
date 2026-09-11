/**
 * C.3.4.2 — Admin API de uma FONTE de fornecedor: detalhe, edição, toggle.
 *
 * GET   → fonte + último estado/histórico mínimo de runs (leitura = staff).
 * PUT   → editar (manager + CSRF). Duas fases de validação:
 *         1. o patch contra o schema parcial;
 *         2. o ESTADO FINAL (linha + patch) contra o schema de create — a
 *            política de URL/auth é sempre verificada sobre a combinação real.
 * PATCH → ativar/desativar (manager + CSRF). Ativar revalida a URL GUARDA
 *         PURA C.3.4.1; `enabled` nunca muda pelo PUT.
 *
 * Nunca devolve segredos: a BD só guarda `secret_reference` (o nome) e é esse
 * valor que aparece na projeção. `apply_policy` não é editável (preview_only).
 */
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser, isManager, isStaff } from "@/lib/auth";
import { csrfGuard } from "@/lib/csrf";
import { SupplierSourceError } from "@/lib/supplier-import/source";
import { supplierImportErrorMessage } from "@/lib/supplier-import/error-messages";
import {
  sftpSourceCreateSchema,
  sftpSourceUpdateSchema,
  supplierSourceCreateSchema,
  supplierSourceEnabledSchema,
  supplierSourceUpdateSchema,
} from "@/lib/supplier-source-schemas";
import {
  getSupplierSourceDetail,
  loadSupplierSourceRow,
  normalizeAuthState,
  setSupplierSourceEnabled,
  updateSftpSource,
  updateSupplierSource,
} from "@/lib/services/supplier-source-service";

function badRequest(issues: { path: (string | number | symbol)[]; message: string }[]) {
  return NextResponse.json(
    {
      error: "VALIDATION_ERROR",
      message: "Dados da fonte inválidos",
      details: issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    },
    { status: 400 }
  );
}

function parseId(raw: string): number | null {
  const id = Number.parseInt(raw, 10);
  return Number.isInteger(id) && id >= 1 ? id : null;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user || !isStaff(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });
  const id = parseId((await params).id);
  if (id === null) return NextResponse.json({ error: "SOURCE_NOT_FOUND" }, { status: 404 });
  const detail = await getSupplierSourceDetail(id);
  if (!detail) return NextResponse.json({ error: "SOURCE_NOT_FOUND", message: supplierImportErrorMessage("SOURCE_NOT_FOUND") }, { status: 404 });
  return NextResponse.json(detail);
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const csrf = csrfGuard(req);
  if (csrf) return csrf;
  const user = await getCurrentUser();
  if (!user || !isManager(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

  const id = parseId((await params).id);
  if (id === null) return NextResponse.json({ error: "SOURCE_NOT_FOUND" }, { status: 404 });

  let raw: Record<string, unknown>;
  try {
    raw = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "INVALID_BODY", message: supplierImportErrorMessage("INVALID_BODY") }, { status: 400 });
  }
  // enabled/apply_policy/supplier_id/source_type NÃO são editáveis por PUT
  // (flags de estado: PATCH dedicado; política: fixa em preview_only; o tipo
  // da fonte é imutável — SFTP ↔ HTTPS não converte).
  delete raw.enabled;
  delete raw.applyPolicy;
  delete raw.supplierId;
  delete raw.sourceType;

  const existing = await loadSupplierSourceRow(id);
  if (!existing) return NextResponse.json({ error: "SOURCE_NOT_FOUND", message: supplierImportErrorMessage("SOURCE_NOT_FOUND") }, { status: 404 });

  // C.3.4.4: linhas SFTP validam-se contra as schemas SFTP (forma do patch +
  // estado final) e atualizam-se pelo serviço SFTP — o ramo HTTPS abaixo fica
  // intocado.
  if (existing.sourceType === "sftp") {
    const patch = sftpSourceUpdateSchema.safeParse(raw);
    if (!patch.success) return badRequest(patch.error.issues);
    const finalState = {
      supplierId: existing.supplierId,
      name: patch.data.name ?? existing.name,
      sftpHost: patch.data.sftpHost ?? existing.sftpHost,
      sftpPort: patch.data.sftpPort ?? existing.sftpPort,
      sftpRemotePath: patch.data.sftpRemotePath ?? existing.sftpRemotePath,
      username: patch.data.username ?? existing.username,
      secretReference: patch.data.secretReference ?? existing.secretReference,
      sftpHostKeyFingerprint: patch.data.sftpHostKeyFingerprint ?? existing.sftpHostKeyFingerprint,
      format: patch.data.format ?? existing.format,
      profileId: patch.data.profileId !== undefined ? patch.data.profileId : existing.profileId,
    };
    const finalParsed = sftpSourceCreateSchema.safeParse(finalState);
    if (!finalParsed.success) return badRequest(finalParsed.error.issues);
    try {
      const source = await updateSftpSource(id, patch.data, user.id);
      return NextResponse.json({ source });
    } catch (e) {
      if (e instanceof SupplierSourceError) {
        return NextResponse.json({ error: e.code, message: supplierImportErrorMessage(e.code) }, { status: e.httpStatus });
      }
      console.error("supplier source update:", e);
      return NextResponse.json({ error: "SOURCE_RUN_FAILED", message: supplierImportErrorMessage("SOURCE_RUN_FAILED") }, { status: 500 });
    }
  }

  const patch = supplierSourceUpdateSchema.safeParse(raw);
  if (!patch.success) return badRequest(patch.error.issues);

  const finalState = normalizeAuthState({
    supplierId: existing.supplierId,
    name: patch.data.name ?? existing.name,
    url: patch.data.url ?? existing.url,
    format: patch.data.format ?? existing.format,
    authType: patch.data.authType ?? existing.authType,
    username: patch.data.username !== undefined ? patch.data.username : existing.username,
    secretReference: patch.data.secretReference !== undefined ? patch.data.secretReference : existing.secretReference,
    headersConfig: patch.data.headersConfig !== undefined ? patch.data.headersConfig : existing.headersConfig,
    profileId: patch.data.profileId !== undefined ? patch.data.profileId : existing.profileId,
  });
  const finalParsed = supplierSourceCreateSchema.safeParse(finalState);
  if (!finalParsed.success) return badRequest(finalParsed.error.issues);

  try {
    const source = await updateSupplierSource(id, patch.data, user.id);
    return NextResponse.json({ source });
  } catch (e) {
    if (e instanceof SupplierSourceError) {
      return NextResponse.json({ error: e.code, message: supplierImportErrorMessage(e.code) }, { status: e.httpStatus });
    }
    console.error("supplier source update:", e);
    return NextResponse.json({ error: "SOURCE_RUN_FAILED", message: supplierImportErrorMessage("SOURCE_RUN_FAILED") }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const csrf = csrfGuard(req);
  if (csrf) return csrf;
  const user = await getCurrentUser();
  if (!user || !isManager(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

  const id = parseId((await params).id);
  if (id === null) return NextResponse.json({ error: "SOURCE_NOT_FOUND" }, { status: 404 });

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "INVALID_BODY", message: supplierImportErrorMessage("INVALID_BODY") }, { status: 400 });
  }
  const parsed = supplierSourceEnabledSchema.safeParse(raw);
  if (!parsed.success) return badRequest(parsed.error.issues);

  try {
    const source = await setSupplierSourceEnabled(id, parsed.data.enabled, user.id);
    return NextResponse.json({ source });
  } catch (e) {
    if (e instanceof SupplierSourceError) {
      return NextResponse.json({ error: e.code, message: supplierImportErrorMessage(e.code) }, { status: e.httpStatus });
    }
    console.error("supplier source toggle:", e);
    return NextResponse.json({ error: "SOURCE_RUN_FAILED", message: supplierImportErrorMessage("SOURCE_RUN_FAILED") }, { status: 500 });
  }
}
