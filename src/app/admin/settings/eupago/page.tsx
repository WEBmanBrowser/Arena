"use client";
import { useEffect, useState } from "react";
import Link from "next/link";

/**
 * Backoffice — configuração Eupago.
 *
 * Presence-only: a API nunca devolve valores de segredos, por isso os campos
 * de segredo nascem sempre vazios (vazio = manter; "Limpar" = apagar).
 * Leitura para manager+; guardar/testar apenas para admin (a API impõe).
 */

// Local view types (the server module is server-only and must not be bundled).
type CoreField = "environment" | "apiKey" | "oauthClientId" | "oauthClientSecret" | "webhookKey";
interface StatusView {
  status: "configured" | "incomplete" | "error";
  origin: "backoffice" | "env" | "none";
  environment: string | null;
  storedEnvironment: string | null;
  fields: Record<CoreField, { set: boolean }>;
  missing: string[];
  warnings: string[];
  error: string | null;
  webhook: { endpoint: string | null; encryption: boolean | null; types: string[] };
  lastTest: { at: string; ok: boolean; environment: string; latencyMs?: number } | null;
}

const SECRET_FIELDS: Array<{ id: Exclude<CoreField, "environment">; label: string; hint: string }> = [
  { id: "apiKey", label: "Chave de API (chave)", hint: "Autenticação da API REST Multibanco." },
  { id: "oauthClientId", label: "OAuth Client ID", hint: "Credencial OAuth (server-to-server)." },
  { id: "oauthClientSecret", label: "OAuth Client Secret", hint: "Credencial OAuth (server-to-server)." },
  { id: "webhookKey", label: "Chave de webhook", hint: "Assinatura HMAC + AES das notificações. Gerada no portal Eupago." },
];

const WEBHOOK_TYPE_LABELS: Record<string, string> = {
  pagamento: "Pagamento",
  cancelamento: "Cancelamento",
  expiracao: "Expiração",
  erro: "Erro",
  reembolso: "Reembolso",
};

const MISSING_LABELS: Record<string, string> = {
  environment: "Ambiente",
  apiKey: "Chave de API",
  oauthClientId: "OAuth Client ID",
  oauthClientSecret: "OAuth Client Secret",
  webhookKey: "Chave de webhook",
  EUPAGO_API_KEY: "EUPAGO_API_KEY (variável de ambiente)",
  EUPAGO_OAUTH_CLIENT_ID: "EUPAGO_OAUTH_CLIENT_ID (variável de ambiente)",
  EUPAGO_OAUTH_CLIENT_SECRET: "EUPAGO_OAUTH_CLIENT_SECRET (variável de ambiente)",
  EUPAGO_WEBHOOK_KEY: "EUPAGO_WEBHOOK_KEY (variável de ambiente)",
};

const WARNING_LABELS: Record<string, string> = {
  WEBHOOK_KEY_NOT_32_BYTES:
    "Com encriptação ativa no portal, a chave de webhook deve ter exatamente 32 bytes — as notificações encriptadas vão falhar.",
};

const ERROR_LABELS: Record<string, string> = {
  BACKOFFICE_UNREADABLE:
    "Segredos do Backoffice ilegíveis — verifique a chave SETTINGS_ENCRYPTION_KEY no servidor.",
  BACKOFFICE_INVALID: "Valor de ambiente guardado inválido — volte a guardar o ambiente.",
  ENV_INVALID: "EUPAGO_ENVIRONMENT inválido no servidor (tem de ser sandbox ou production).",
};

const TEST_REASON_LABELS: Record<string, string> = {
  oauth_failure: "falha de autenticação OAuth (verifique Client ID, Client Secret e ambiente)",
  timeout: "tempo esgotado a contactar a Eupago",
  network_error: "erro de rede a contactar a Eupago",
  server_error: "a Eupago respondeu com erro",
  malformed_response: "a Eupago respondeu de forma inválida",
};

export default function EupagoSettingsPage() {
  const [status, setStatus] = useState<StatusView | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [show, setShow] = useState<Record<string, boolean>>({});
  const [env, setEnv] = useState<string | null>(null);
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [encryption, setEncryption] = useState<boolean | null>(null);
  const [types, setTypes] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  const refresh = async () => {
    const r = await fetch("/api/admin/settings/eupago");
    if (r.status === 401 || r.status === 403) {
      setDenied(true);
      setLoading(false);
      return;
    }
    const d = (await r.json()) as StatusView;
    setStatus(d);
    setLoading(false);
  };

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => setRole(d?.user?.role ?? null))
      .catch(() => setRole(null));
    fetch("/api/admin/settings/eupago").then(async (r) => {
      if (r.status === 401 || r.status === 403) {
        setDenied(true);
        setLoading(false);
        return;
      }
      setStatus((await r.json()) as StatusView);
      setLoading(false);
    });
  }, []);

  if (loading) return <div className="text-sm text-slate-500">A carregar configuração Eupago…</div>;
  if (denied || !status) {
    return (
      <div className="bg-white border rounded-xl p-6">
        <h2 className="text-xl font-bold text-slate-800 mb-2">Eupago — Pagamentos</h2>
        <p className="text-sm text-red-600">Sem acesso — esta área requer nível manager ou superior.</p>
        <Link href="/admin/settings" className="text-sm text-sky-700 hover:underline mt-4 inline-block">← Voltar a Definições</Link>
      </div>
    );
  }

  const isAdmin = role === "admin";
  const envValue = env ?? status.storedEnvironment ?? "sandbox";
  const endpointValue = endpoint ?? status.webhook.endpoint ?? "";
  const encryptionValue = encryption ?? status.webhook.encryption ?? false;
  const typesValue = types ?? status.webhook.types;

  const dirtySecretIds = Object.entries(secrets)
    .filter(([, v]) => v.length > 0)
    .map(([k]) => k);
  const isDirty =
    dirtySecretIds.length > 0 ||
    (env !== null && env !== (status.storedEnvironment ?? "sandbox")) ||
    (endpoint !== null && endpoint !== (status.webhook.endpoint ?? "")) ||
    (encryption !== null && encryption !== (status.webhook.encryption ?? false)) ||
    (types !== null && JSON.stringify([...types].sort()) !== JSON.stringify([...status.webhook.types].sort()));

  const save = async () => {
    setSaving(true);
    setNotice(null);
    const payload: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(secrets)) if (v.length > 0) payload[k] = v;
    if (env !== null && env !== (status.storedEnvironment ?? "sandbox")) payload.environment = env;
    if (endpoint !== null && endpoint !== (status.webhook.endpoint ?? "")) {
      if (endpoint.trim().length === 0) {
        setNotice({ kind: "err", text: "O endpoint vazio não é válido — use «Limpar» para remover." });
        setSaving(false);
        return;
      }
      payload.webhookEndpoint = endpoint;
    }
    if (encryption !== null && encryption !== (status.webhook.encryption ?? false)) {
      payload.webhookEncryption = encryption;
    }
    if (types !== null && JSON.stringify([...types].sort()) !== JSON.stringify([...status.webhook.types].sort())) {
      payload.webhookTypes = types;
    }
    try {
      const r = await fetch("/api/admin/settings/eupago", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (!r.ok) {
        const fieldLabel = d.field ? (MISSING_LABELS[d.field] ?? d.field) : null;
        const text =
          d.error === "EUPAGO_ENCRYPTION_UNAVAILABLE"
            ? "Encriptação indisponível no servidor (SETTINGS_ENCRYPTION_KEY em falta)."
            : d.error === "EMPTY_VALUE"
              ? `«${fieldLabel}» não pode ficar vazio.`
              : d.error === "UNKNOWN_FIELD"
                ? `Campo desconhecido: ${d.field}.`
                : `«${fieldLabel ?? "Pedido"}» inválido — verifique o valor.`;
        setNotice({ kind: "err", text });
      } else {
        setNotice({ kind: "ok", text: "Configuração guardada." });
        setSecrets({});
        setEnv(null);
        setEndpoint(null);
        setEncryption(null);
        setTypes(null);
        await refresh();
      }
    } catch {
      setNotice({ kind: "err", text: "Falha de rede ao guardar." });
    }
    setSaving(false);
  };

  const clearField = async (field: string, label: string) => {
    if (!window.confirm(`Remover «${label}» da configuração do Backoffice?`)) return;
    setSaving(true);
    setNotice(null);
    try {
      const r = await fetch("/api/admin/settings/eupago", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: null }),
      });
      if (!r.ok) {
        setNotice({ kind: "err", text: `Não foi possível remover «${label}».` });
      } else {
        setNotice({ kind: "ok", text: `«${label}» removido.` });
        if (field === "webhookEndpoint") setEndpoint(null);
        await refresh();
      }
    } catch {
      setNotice({ kind: "err", text: "Falha de rede." });
    }
    setSaving(false);
  };

  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await fetch("/api/admin/settings/eupago/test", { method: "POST" });
      const d = await r.json();
      if (r.ok && d.ok) {
        setTestResult({
          ok: true,
          text: `Ligação OK — ambiente ${d.environment} (${d.latencyMs} ms). OAuth válido.`,
        });
      } else if (d.error === "EUPAGO_CONFIG_INCOMPLETE") {
        setTestResult({ ok: false, text: "Configuração incompleta — complete os campos em falta antes de testar." });
      } else {
        const reason = d.reason ? (TEST_REASON_LABELS[d.reason] ?? d.reason) : "falha de comunicação";
        setTestResult({ ok: false, text: `Falha na ligação (${d.environment ?? "?"}): ${reason}.` });
      }
      await refresh();
    } catch {
      setTestResult({ ok: false, text: "Falha de rede ao testar." });
    }
    setTesting(false);
  };

  const statusBadge =
    status.status === "configured" ? (
      <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-green-100 text-green-800">Configurado</span>
    ) : status.status === "incomplete" ? (
      <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-100 text-amber-800">Incompleto</span>
    ) : (
      <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-red-100 text-red-800">Erro</span>
    );
  const originBadge =
    status.origin === "backoffice" ? (
      <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-sky-100 text-sky-800">Origem: Backoffice</span>
    ) : status.origin === "env" ? (
      <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-slate-200 text-slate-700">Origem: variáveis de ambiente</span>
    ) : (
      <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-slate-200 text-slate-700">Origem: nenhuma</span>
    );

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-slate-800">Eupago — Pagamentos</h2>
          <p className="text-xs text-slate-500 mt-1">
            Credenciais e notificações. Os segredos ficam encriptados na base de dados e nunca são mostrados.
          </p>
        </div>
        <Link href="/admin/settings" className="text-sm text-sky-700 hover:underline">← Definições</Link>
      </div>

      {!isAdmin && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-6 text-sm text-amber-800">
          Apenas leitura — guardar e testar requer nível admin.
        </div>
      )}

      {notice && (
        <div
          className={`rounded-xl p-4 mb-6 text-sm ${notice.kind === "ok" ? "bg-green-50 border border-green-200 text-green-800" : "bg-red-50 border border-red-200 text-red-800"}`}
        >
          {notice.text}
        </div>
      )}

      {/* Estado */}
      <div className="bg-white border rounded-xl p-6 mb-6">
        <div className="flex items-center gap-2 mb-4">
          <h3 className="font-bold text-slate-800">Estado</h3>
          {statusBadge}
          {originBadge}
          {status.environment && (
            <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-violet-100 text-violet-800">
              {status.environment === "production" ? "Produção" : "Sandbox"}
            </span>
          )}
        </div>
        {status.missing.length > 0 && (
          <div className="text-sm text-amber-800 mb-2">
            Em falta: {status.missing.map((m) => MISSING_LABELS[m] ?? m).join("; ")}
          </div>
        )}
        {status.error && (
          <div className="text-sm text-red-700 mb-2">{ERROR_LABELS[status.error] ?? status.error}</div>
        )}
        {status.warnings.map((w) => (
          <div key={w} className="text-sm text-amber-800 mb-2">⚠ {WARNING_LABELS[w] ?? w}</div>
        ))}
        <div className="text-xs text-slate-500 mt-2">
          {status.lastTest
            ? `Último teste: ${status.lastTest.ok ? "OK" : "falha"} em ${new Date(status.lastTest.at).toLocaleString("pt-PT")} (${status.lastTest.environment}${status.lastTest.latencyMs !== undefined ? `, ${status.lastTest.latencyMs} ms` : ""}).`
            : "Ainda sem testes de ligação."}
        </div>
        <div className="text-xs text-slate-500 mt-2">
          Regra de precedência: enquanto o Backoffice estiver vazio, valem as variáveis de ambiente. A partir do
          momento em que guarda o primeiro valor no Backoffice, o conjunto do Backoffice tem de ficar completo —
          nunca se misturam valores das duas origens.
        </div>
      </div>

      {/* Credenciais */}
      <div className="bg-white border rounded-xl p-6 mb-6">
        <h3 className="font-bold text-slate-800 mb-1">Credenciais</h3>
        <p className="text-xs text-slate-500 mb-4">Deixe um campo vazio para manter o valor guardado.</p>
        <div className="grid sm:grid-cols-3 gap-2 items-center mb-4">
          <label className="text-sm text-slate-600">Ambiente</label>
          <select
            value={envValue}
            onChange={(e) => setEnv(e.target.value)}
            disabled={!isAdmin}
            className="sm:col-span-2 border rounded px-3 py-1.5 text-sm disabled:opacity-50"
          >
            <option value="sandbox">Sandbox (testes)</option>
            <option value="production">Produção</option>
          </select>
        </div>
        <div className="space-y-4">
          {SECRET_FIELDS.map((f) => (
            <div key={f.id} className="grid sm:grid-cols-3 gap-2 items-center">
              <div>
                <label className="text-sm text-slate-600">{f.label}</label>
                <div className="text-[11px] text-slate-400">{f.hint}</div>
              </div>
              <div className="sm:col-span-2 flex items-center gap-2">
                <input
                  type={show[f.id] ? "text" : "password"}
                  value={secrets[f.id] ?? ""}
                  onChange={(e) => setSecrets((s) => ({ ...s, [f.id]: e.target.value }))}
                  placeholder={status.fields[f.id].set ? "•••••••• (configurado)" : "Por configurar"}
                  disabled={!isAdmin}
                  autoComplete="off"
                  className="border rounded px-3 py-1.5 text-sm flex-1 disabled:opacity-50"
                />
                <button
                  type="button"
                  onClick={() => setShow((s) => ({ ...s, [f.id]: !s[f.id] }))}
                  disabled={!isAdmin}
                  className="px-2 py-1.5 text-xs text-slate-500 hover:text-slate-800 disabled:opacity-50"
                  aria-label={show[f.id] ? "Ocultar" : "Mostrar"}
                >
                  {show[f.id] ? "🙈" : "👁"}
                </button>
                {status.fields[f.id].set ? (
                  <>
                    <span className="text-[11px] font-medium text-green-700 whitespace-nowrap">✓ Configurado</span>
                    {isAdmin && (
                      <button
                        type="button"
                        onClick={() => clearField(f.id, f.label)}
                        disabled={saving}
                        className="text-[11px] text-red-600 hover:underline whitespace-nowrap disabled:opacity-50"
                      >
                        Limpar
                      </button>
                    )}
                  </>
                ) : (
                  <span className="text-[11px] text-slate-400 whitespace-nowrap">Por configurar</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Webhooks */}
      <div className="bg-white border rounded-xl p-6 mb-6">
        <h3 className="font-bold text-slate-800 mb-1">Notificações (webhooks)</h3>
        <p className="text-xs text-slate-500 mb-4">
          Estes campos documentam o que está configurado no portal Eupago — são informativos e não alteram o
          comportamento. O endpoint real da loja é fixo: <code className="bg-slate-100 px-1 rounded">/api/webhooks/eupago</code>.
        </p>
        <div className="grid sm:grid-cols-3 gap-2 items-center mb-4">
          <label className="text-sm text-slate-600">URL do endpoint no portal</label>
          <div className="sm:col-span-2 flex items-center gap-2">
            <input
              type="url"
              value={endpointValue}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder="https://…/api/webhooks/eupago"
              disabled={!isAdmin}
              autoComplete="off"
              className="border rounded px-3 py-1.5 text-sm flex-1 disabled:opacity-50"
            />
            {isAdmin && status.webhook.endpoint && (
              <button
                type="button"
                onClick={() => clearField("webhookEndpoint", "URL do endpoint")}
                disabled={saving}
                className="text-[11px] text-red-600 hover:underline whitespace-nowrap disabled:opacity-50"
              >
                Limpar
              </button>
            )}
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm mb-4">
          <input
            type="checkbox"
            checked={encryptionValue}
            onChange={(e) => setEncryption(e.target.checked)}
            disabled={!isAdmin}
            className="disabled:opacity-50"
          />
          Encriptação ativa no portal Eupago
          {status.webhook.encryption === null && encryption === null && (
            <span className="text-[11px] text-slate-400">(não definido)</span>
          )}
        </label>
        <div className="text-sm text-slate-600 mb-2">Tipos de evento subscritos no portal</div>
        <div className="flex flex-wrap gap-4">
          {Object.entries(WEBHOOK_TYPE_LABELS).map(([value, label]) => (
            <label key={value} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={typesValue.includes(value)}
                onChange={(e) =>
                  setTypes((t) => {
                    const base = t ?? status.webhook.types;
                    return e.target.checked ? [...base, value] : base.filter((x) => x !== value);
                  })
                }
                disabled={!isAdmin}
                className="disabled:opacity-50"
              />
              {label}
            </label>
          ))}
        </div>
      </div>

      {/* Ações */}
      {isAdmin && (
        <div className="bg-white border rounded-xl p-6 mb-6">
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={save}
              disabled={saving || !isDirty}
              className="px-4 py-2 bg-sky-600 text-white rounded-lg text-sm font-medium hover:bg-sky-700 disabled:opacity-50"
            >
              {saving ? "A guardar…" : "Guardar Alterações"}
            </button>
            <button
              onClick={testConnection}
              disabled={testing || saving}
              className="px-4 py-2 bg-slate-800 text-white rounded-lg text-sm font-medium hover:bg-slate-900 disabled:opacity-50"
            >
              {testing ? "A testar…" : "Testar ligação"}
            </button>
            <span className="text-xs text-slate-500">
              O teste usa as credenciais efetivas (Backoffice ou ambiente) numa chamada OAuth sem efeitos — não cria pagamentos.
            </span>
          </div>
          {testResult && (
            <div
              className={`mt-4 rounded-lg p-3 text-sm ${testResult.ok ? "bg-green-50 border border-green-200 text-green-800" : "bg-red-50 border border-red-200 text-red-800"}`}
            >
              {testResult.ok ? "✓ " : "✗ "}{testResult.text}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
