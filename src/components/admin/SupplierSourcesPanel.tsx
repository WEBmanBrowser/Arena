"use client";
/**
 * C.3.4.2 — Gestão de FONTES remotas de um fornecedor.
 *
 * O painel só sabe o que a API devolve: metadados e observabilidade. Nunca há
 * aqui um campo para o VALOR de um segredo — a UI apenas aceita/mostra a
 * referência do secret (o nome no runtime); o valor nunca viaja pelo browser.
 *
 * Regras respeitadas na UI (além das que o servidor impõe):
 *  - "Sincronizar agora" não dispara duas vezes (button desativado enquanto a
 *    mutação está em voo + estado ativo vindo do servidor);
 *  - o resultado de um sync é sempre "Preview criado — rever e aplicar" (ou
 *    "sem alterações"); nada é aplicado automaticamente — o aplicar continua
 *    a ser exclusivamente o painel de importação (C.3.1) com o token assinado.
 *    O link abre a importação CONCRETA (/admin/import?open=<id>): a página
 *    reabre o preview persistido e recebe aí um token novo — o token nunca
 *    entra numa URL;
 *  - fonte nova nasce desativada: o toggle "Ativar" é um ato separado.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { supplierImportErrorMessage } from "@/lib/supplier-import/error-messages";
import { supplierImportReviewHref } from "@/lib/import-review-link";

type SourceRow = {
  id: number;
  name: string;
  url: string | null;
  format: string;
  authType: string;
  username: string | null;
  secretReference: string | null;
  headersConfig: Record<string, unknown> | null;
  enabled: boolean;
  applyPolicy: string;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  lastHttpStatus: number | null;
  lastRowCount: number | null;
  lastEtag: string | null;
  lastModified: string | null;
};

type SyncOutcome = {
  runId: number;
  status: "success" | "no_change";
  noChangeReason: string | null;
  importId: number | null;
  rowCount: number | null;
  durationMs: number;
};

type FormState = {
  name: string;
  url: string;
  format: "auto" | "csv" | "xlsx";
  authType: "none" | "basic" | "bearer" | "header";
  username: string;
  secretReference: string;
  headerName: string;
};

const emptyForm: FormState = { name: "", url: "", format: "auto", authType: "none", username: "", secretReference: "", headerName: "" };

const dt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("pt-PT", { dateStyle: "short", timeStyle: "short" }) : "—");

async function readBody(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export default function SupplierSourcesPanel({ supplierId, supplierName }: { supplierId: number; supplierName: string }) {
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<SourceRow | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Uma sincronização por clique, e nunca duas em voo: o busy é local e a
  // corrida ativa é confirmada pelo servidor (claim Postgres, SOURCE_ALREADY_RUNNING).
  const [busySourceId, setBusySourceId] = useState<number | null>(null);
  const [syncResults, setSyncResults] = useState<Record<number, { kind: "ok" | "info" | "err"; text: string; importId?: number } | undefined>>({});
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Padrão do repo (SupplierImportPanel): fetch dentro de IIFE async no
  // effect — nenhum setState síncrono no corpo do efeito (React 19).
  useEffect(() => {
    let stopped = false;
    (async () => {
      const res = await fetch(`/api/admin/supplier-sources?supplierId=${supplierId}`);
      const data = await readBody(res);
      if (stopped) return;
      if (res.ok) setSources(data?.sources ?? []);
      setLoading(false);
    })();
    return () => {
      stopped = true;
    };
  }, [supplierId]);

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/supplier-sources?supplierId=${supplierId}`);
    const data = await readBody(res);
    if (!mounted.current) return;
    if (res.ok) setSources(data?.sources ?? []);
  }, [supplierId]);

  const openNew = () => {
    setEditing(null);
    setForm(emptyForm);
    setFormError(null);
    setShowForm(true);
  };

  const openEdit = (s: SourceRow) => {
    setEditing(s);
    setForm({
      name: s.name,
      url: s.url ?? "",
      format: (s.format as FormState["format"]) ?? "auto",
      authType: (s.authType as FormState["authType"]) ?? "none",
      username: s.username ?? "",
      secretReference: s.secretReference ?? "",
      headerName: typeof s.headersConfig?.headerName === "string" ? s.headersConfig.headerName : "",
    });
    setFormError(null);
    setShowForm(true);
  };

  const buildPayload = () => {
    const headersConfig: Record<string, string> = {};
    if (form.authType === "header" && form.headerName.trim()) headersConfig.headerName = form.headerName.trim();
    return {
      supplierId,
      name: form.name.trim(),
      url: form.url.trim(),
      format: form.format,
      authType: form.authType,
      username: form.authType === "basic" && form.username.trim() ? form.username.trim() : null,
      secretReference: form.authType !== "none" && form.secretReference.trim() ? form.secretReference.trim() : null,
      headersConfig: Object.keys(headersConfig).length ? headersConfig : null,
    };
  };

  const save = async () => {
    setSaving(true);
    setFormError(null);
    try {
      const res = await fetch(editing ? `/api/admin/supplier-sources/${editing.id}` : "/api/admin/supplier-sources", {
        method: editing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload()),
      });
      const data = await readBody(res);
      if (!res.ok) {
        const detail = data?.details?.[0];
        setFormError(`${supplierImportErrorMessage(data?.error) || "Falha ao gravar"}${detail ? ` (${detail.path}: ${detail.message})` : ""}`);
        return;
      }
      setShowForm(false);
      await load();
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (s: SourceRow) => {
    const res = await fetch(`/api/admin/supplier-sources/${s.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !s.enabled }),
    });
    const data = await readBody(res);
    if (!res.ok) {
      setSyncResults((prev) => ({ ...prev, [s.id]: { kind: "err", text: supplierImportErrorMessage(data?.error) || "Falha ao alterar estado" } }));
    }
    await load();
  };

  const syncNow = async (s: SourceRow) => {
    if (busySourceId !== null) return; // dupla proteção contra duplo clique
    setBusySourceId(s.id);
    setSyncResults((prev) => ({ ...prev, [s.id]: { kind: "info", text: "A sincronizar…" } }));
    try {
      const res = await fetch(`/api/admin/supplier-sources/${s.id}/sync`, { method: "POST" });
      const data = await readBody(res);
      if (res.ok && data?.run) {
        const run = data.run as SyncOutcome;
        if (run.status === "success") {
          setSyncResults((prev) => ({
            ...prev,
            [s.id]: { kind: "ok", text: "Preview criado — rever e aplicar", importId: run.importId ?? undefined },
          }));
        } else {
          setSyncResults((prev) => ({
            ...prev,
            [s.id]: {
              kind: "info",
              text: run.noChangeReason === "http_304" ? "Sem alterações (HTTP 304 — validador do servidor)." : "Sem alterações (conteúdo igual ao último snapshot).",
            },
          }));
        }
      } else {
        setSyncResults((prev) => ({
          ...prev,
          [s.id]: { kind: "err", text: supplierImportErrorMessage(data?.error) || "Falha na sincronização" },
        }));
      }
    } catch {
      setSyncResults((prev) => ({ ...prev, [s.id]: { kind: "err", text: "Falha de rede ao sincronizar." } }));
    } finally {
      await load(); // refresh do resultado/observabilidade
      if (mounted.current) setBusySourceId(null);
    }
  };

  const input = "w-full border rounded px-3 py-1.5 text-sm";
  const label = "text-xs text-slate-500 block mb-1";

  return (
    <div className="p-4 bg-slate-50/60">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-slate-700">Fontes de sincronização — {supplierName}</h3>
        <button onClick={openNew} className="px-3 py-1.5 bg-slate-700 text-white rounded text-xs font-medium hover:bg-slate-800">
          + Nova Fonte
        </button>
      </div>

      {showForm && (
        <div className="bg-white border rounded-xl p-4 mb-4 animate-fade-in space-y-3">
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
            <div>
              <span className={label}>Nome *</span>
              <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} className={input} placeholder="Lista diária" />
            </div>
            <div className="lg:col-span-2">
              <span className={label}>URL (apenas HTTPS) *</span>
              <input value={form.url} onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))} className={input} placeholder="https://supplier.example.com/files/lista.csv" />
            </div>
            <div>
              <span className={label}>Formato</span>
              <select value={form.format} onChange={(e) => setForm((f) => ({ ...f, format: e.target.value as FormState["format"] }))} className={input}>
                <option value="auto">Auto (deteção por bytes)</option>
                <option value="csv">CSV</option>
                <option value="xlsx">XLSX</option>
              </select>
            </div>
            <div>
              <span className={label}>Autenticação</span>
              <select value={form.authType} onChange={(e) => setForm((f) => ({ ...f, authType: e.target.value as FormState["authType"] }))} className={input}>
                <option value="none">Nenhuma</option>
                <option value="basic">Basic</option>
                <option value="bearer">Bearer</option>
                <option value="header">Header</option>
              </select>
            </div>
            {form.authType === "basic" && (
              <div>
                <span className={label}>Username (Basic) *</span>
                <input value={form.username} onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))} className={input} autoComplete="off" />
              </div>
            )}
            {form.authType === "header" && (
              <div>
                <span className={label}>Nome do header *</span>
                <input value={form.headerName} onChange={(e) => setForm((f) => ({ ...f, headerName: e.target.value }))} className={input} placeholder="X-Api-Key" autoComplete="off" />
              </div>
            )}
            {form.authType !== "none" && (
              <div>
                <span className={label}>Referência do secret *</span>
                <input value={form.secretReference} onChange={(e) => setForm((f) => ({ ...f, secretReference: e.target.value }))} className={input} placeholder="SUPPLIER_SRC_12_TOKEN" autoComplete="off" spellCheck={false} />
                <p className="text-[11px] text-slate-400 mt-1">
                  Apenas o NOME do secret disponível no runtime (ex.: variável de ambiente provisionada por CLI).
                  Nunca escreva aqui a password/token/key — a aplicação nunca aceita nem guarda valores de segredos.
                </p>
              </div>
            )}
            <div className="lg:col-span-3 text-[11px] text-slate-500">
              Perfil de mapeamento: usa automaticamente o perfil normal do fornecedor (C.3.2). Nova fonte nasce SEMPRE desativada e o resultado de uma
              sincronização é sempre um preview para revisão humana — nunca aplicação automática.
            </div>
          </div>
          {formError && <p className="text-xs text-red-600">{formError}</p>}
          <div className="flex gap-2">
            <button onClick={() => setShowForm(false)} className="px-3 py-1.5 border rounded text-sm bg-white">Cancelar</button>
            <button onClick={save} disabled={saving} className="px-3 py-1.5 bg-sky-600 disabled:opacity-50 text-white rounded text-sm font-medium">
              {saving ? "A gravar…" : editing ? "Guardar alterações" : "Criar fonte (desativada)"}
            </button>
          </div>
        </div>
      )}

      <div className="bg-white border rounded-xl overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50">
            <tr>
              <th className="text-left p-2 font-medium text-slate-600">Fonte</th>
              <th className="text-left p-2 font-medium text-slate-600">URL</th>
              <th className="text-center p-2 font-medium text-slate-600">Estado</th>
              <th className="text-left p-2 font-medium text-slate-600">Último check</th>
              <th className="text-left p-2 font-medium text-slate-600">Último sucesso</th>
              <th className="text-center p-2 font-medium text-slate-600">HTTP</th>
              <th className="text-center p-2 font-medium text-slate-600">Linhas</th>
              <th className="text-left p-2 font-medium text-slate-600">Último erro</th>
              <th className="text-right p-2 font-medium text-slate-600">Ações</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={9} className="p-3 text-slate-400">A carregar fontes…</td>
              </tr>
            )}
            {!loading && sources.length === 0 && (
              <tr>
                <td colSpan={9} className="p-3 text-slate-400">
                  Sem fontes. Uploads manuais (CSV/XLSX) continuam a funcionar sem fonte configurada — as fontes servem apenas sincronização por URL.
                </td>
              </tr>
            )}
            {sources.map((s) => (
              <tr key={s.id} className="border-t align-top">
                <td className="p-2">
                  <div className="font-medium text-slate-800">{s.name}</div>
                  <div className="text-slate-400">
                    {s.format} · auth {s.authType === "none" ? "nenhuma" : s.authType}
                    {s.authType === "basic" && s.username ? ` (${s.username})` : ""}
                    {s.secretReference ? ` · secret: ${s.secretReference}` : ""}
                    {typeof s.headersConfig?.headerName === "string" ? ` · header: ${s.headersConfig.headerName}` : ""}
                  </div>
                </td>
                <td className="p-2 max-w-[260px] break-all text-slate-500">{s.url}</td>
                <td className="p-2 text-center">
                  <span className={`px-2 py-0.5 rounded text-[11px] ${s.enabled ? "bg-green-50 text-green-600" : "bg-slate-100 text-slate-500"}`}>
                    {s.enabled ? "Ativa" : "Desativada"}
                  </span>
                </td>
                <td className="p-2 whitespace-nowrap">{dt(s.lastCheckedAt)}</td>
                <td className="p-2 whitespace-nowrap">{dt(s.lastSuccessAt)}</td>
                <td className="p-2 text-center">{s.lastHttpStatus ?? "—"}</td>
                <td className="p-2 text-center">{s.lastRowCount ?? "—"}</td>
                <td className="p-2 text-red-500 max-w-[220px]">
                  {s.lastErrorCode ? (
                    <>
                      <span className="font-mono text-[10px]">{s.lastErrorCode}</span>
                      <div className="text-slate-500">{s.lastErrorMessage || ""}</div>
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="p-2 text-right whitespace-nowrap space-x-2">
                  <button onClick={() => openEdit(s)} className="text-sky-600 font-medium">Editar</button>
                  <button onClick={() => toggleEnabled(s)} className="text-slate-600 font-medium">
                    {s.enabled ? "Desativar" : "Ativar"}
                  </button>
                  <button
                    onClick={() => syncNow(s)}
                    disabled={!s.enabled || busySourceId !== null}
                    title={s.enabled ? "Executa a sincronização agora; o resultado é sempre um preview para revisão" : "Ative a fonte para sincronizar"}
                    className="px-2 py-1 rounded bg-sky-600 text-white font-medium disabled:opacity-40"
                  >
                    {busySourceId === s.id ? "A sincronizar…" : "Sincronizar agora"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {Object.entries(syncResults).some(([, r]) => r) && (
        <div className="mt-2 space-y-1">
          {sources.map((s) => {
            const r = syncResults[s.id];
            if (!r) return null;
            return (
              <p
                key={s.id}
                className={`text-xs rounded border px-3 py-2 ${
                  r.kind === "ok" ? "bg-green-50 border-green-200 text-green-700" : r.kind === "err" ? "bg-red-50 border-red-200 text-red-600" : "bg-sky-50 border-sky-200 text-sky-700"
                }`}
              >
                <span className="font-medium">{s.name}:</span> {r.text}
                {r.kind === "ok" && r.importId ? (
                  <>
                    {" — "}
                    {/* Só o id viaja na URL: o token de apply é reemitido pela
                        página de revisão (GET …/preview), nunca por um link. */}
                    <a href={supplierImportReviewHref(r.importId)} className="underline font-medium">
                      abrir a importação gerada (#{r.importId}) e rever/aplicar
                    </a>
                  </>
                ) : null}
              </p>
            );
          })}
        </div>
      )}
    </div>
  );
}
