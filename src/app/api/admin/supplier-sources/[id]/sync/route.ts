/**
 * C.3.4.2 — POST "Sincronizar agora" para uma fonte HTTPS.
 *
 * Autorização idêntica ao resto de suppliers/import (mutação = manager +
 * CSRF) e rate limit com o padrão administrativo (fixed-window Postgres,
 * compatível com Workers). A rota NUNCA aplica nada: o resultado máximo é o
 * preview persistido à espera de revisão humana.
 *
 * Estado devolvido (nunca segredos, nunca corpo do remoto):
 *  - status: "success" | "no_change" — run registada em supplier_source_runs;
 *  - importId quando existe preview novo (a UI oferece o link para a fila de
 *    importação, onde a revisão/apply acontece — no mesmo painel C.3.1);
 *  - erros do run viram código estável + frase segura da tabela partilhada.
 */
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser, isManager } from "@/lib/auth";
import { csrfGuard } from "@/lib/csrf";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { SupplierSourceError } from "@/lib/supplier-import/source";
import { supplierImportErrorMessage } from "@/lib/supplier-import/error-messages";
import { runSupplierSource } from "@/lib/services/supplier-source-service";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const csrf = csrfGuard(req);
  if (csrf) return csrf;

  const user = await getCurrentUser();
  if (!user || !isManager(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

  const { id } = await params;
  const sourceId = Number.parseInt(id, 10);
  if (!Number.isInteger(sourceId) || sourceId < 1) {
    return NextResponse.json({ error: "SOURCE_NOT_FOUND" }, { status: 404 });
  }

  // Padrão administrativo existente (src/lib/rate-limit.ts): janela fixa em
  // Postgres por utilizador+fonte — o custo protegido aqui é o pedido externo.
  const limit = await checkRateLimit(`supplier-source-sync:${user.id}:${sourceId}`, { limit: 10, windowSeconds: 60 });
  if (!limit.allowed) {
    return rateLimitResponse(
      limit.retryAfterSeconds,
      `Demasiadas sincronizações em pouco tempo. Tenta novamente em ${Math.max(1, limit.retryAfterSeconds)}s.`
    );
  }

  try {
    const outcome = await runSupplierSource(sourceId, user.id);
    return NextResponse.json({
      run: {
        runId: outcome.runId,
        status: outcome.status,
        noChangeReason: outcome.noChangeReason ?? null,
        httpStatus: outcome.httpStatus,
        durationMs: outcome.durationMs,
        importId: outcome.importId,
        rowCount: outcome.rowCount,
        newCount: outcome.newCount,
        updatedCount: outcome.updatedCount,
        missingCount: outcome.missingCount,
        etag: outcome.etag,
        lastModified: outcome.lastModified,
        fileHash: outcome.fileHash,
        // A resposta do preview é deliberadamente resumida: a revisão usa o
        // painel existente (GET /api/admin/supplier-import/:id), nunca esta
        // resposta, para reaplicar valores financeiros.
        previewSummary: outcome.preview
          ? {
              importId: outcome.preview.importId,
              fileName: outcome.preview.fileName,
              summary: outcome.preview.summary,
              status: outcome.preview.status,
              truncated: outcome.preview.truncated,
            }
          : null,
      },
    });
  } catch (e) {
    if (e instanceof SupplierSourceError) {
      return NextResponse.json({ error: e.code, message: supplierImportErrorMessage(e.code) }, { status: e.httpStatus });
    }
    // Nunca um erro inesperado do remoto/BD em claro: log do servidor + categoria.
    console.error("supplier source sync:", e);
    return NextResponse.json({ error: "SOURCE_RUN_FAILED", message: supplierImportErrorMessage("SOURCE_RUN_FAILED") }, { status: 500 });
  }
}
