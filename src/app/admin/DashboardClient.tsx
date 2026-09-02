"use client";

/**
 * B.4.1 — Operational Command Center (admin dashboard).
 *
 * Renders the READ-ONLY dashboard read model from /api/admin/dashboard:
 *  • KPI cards (paid-only revenue, integer cents on the wire)
 *  • Severity-ranked operational alerts linking to the acting surface
 *  • Order pipeline breakdown
 *  • 30-day revenue bar chart (pure SVG, no chart dependency)
 *  • Low-stock watchlist and latest orders
 *
 * This component never mutates state — it surfaces signals and links to the
 * pages where operators act. All money arrives as integer cents.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

type Severity = "critical" | "warning" | "info";

interface AlertItem {
  severity: Severity;
  code: string;
  label: string;
  count: number;
  href: string;
}
interface RevenuePoint {
  date: string;
  orders: number;
  cents: number;
}
interface DashboardData {
  generatedAt: string;
  timezone: string;
  kpis: {
    paidOrdersToday: number;
    revenueToday: { cents: number; currency: string };
    paidOrders7d: number;
    revenue7d: { cents: number; currency: string };
    paidOrders30d: number;
    revenue30d: { cents: number; currency: string };
    paidOrdersThisMonth: number;
    revenueThisMonth: { cents: number; currency: string };
    revenuePreviousMonth: { cents: number; currency: string };
    revenueMomCents: number;
    totalOrders: number;
    pendingPaymentOrders: number;
    paidOrders: number;
    awaitingFulfillment: number;
    totalActiveProducts: number;
    lowStockProducts: number;
    outOfStockProducts: number;
    totalCustomers: number;
    newCustomersToday: number;
    newCustomersThisMonth: number;
    openRma: number;
  };
  orderPipeline: { status: string; count: number }[];
  alerts: AlertItem[];
  criticalAlertCount: number;
  warningAlertCount: number;
  revenueSeries: RevenuePoint[];
  paymentMethodBreakdown: { key: string; count: number; cents: number }[];
  deliveryBreakdown: { key: string; count: number; cents: number }[];
  ignoredFinancialEvents: {
    total: number;
    paymentMismatches: number;
    refundMismatches: number;
    refundAttemptNotFound: number;
    events: {
      id: number;
      kind: "payment" | "refund" | "other";
      reasonCode: string | null;
      providerEventId: string | null;
      eventType: string | null;
      receivedAt: string;
    }[];
  };
  lowStockProducts: {
    id: number;
    name: string;
    sku: string | null;
    stock: number;
    minStock: number;
    reservedStock: number;
  }[];
  recentOrders: {
    id: number;
    orderNumber: string;
    status: string;
    paymentStatus: string;
    totalCents: number;
    paymentMethod: string | null;
    customerName: string;
    createdAt: string;
  }[];
}

const eur = (cents: number) =>
  new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR" }).format(cents / 100);

const STATUS_LABELS: Record<string, string> = {
  pending_payment: "Por pagar",
  paid: "Pago",
  processing: "Em processamento",
  ready_for_pickup: "Pronto p/ levantamento",
  shipped: "Enviado",
  delivered: "Entregue",
  cancelled: "Cancelado",
  expired: "Expirado",
  refunded: "Reembolsado",
  return_requested: "Devolução pedida",
  returned: "Devolvido",
};

const PAYMENT_LABELS: Record<string, string> = {
  mbway: "MB WAY",
  multibanco: "Multibanco",
  card: "Cartão de crédito",
  bank_transfer: "Transferência bancária",
  unknown: "Desconhecido",
};

const DELIVERY_LABELS: Record<string, string> = {
  shipping: "Envio ao domicílio",
  pickup: "Levantamento em loja",
  unknown: "Desconhecido",
};

function BreakdownCard({ title, rows, labels }: { title: string; rows: { key: string; count: number; cents: number }[]; labels: Record<string, string> }) {
  const totalCount = rows.reduce((s, r) => s + r.count, 0);
  const totalCents = rows.reduce((s, r) => s + r.cents, 0);
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
      <h3 className="font-bold text-slate-800 mb-4">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-slate-400">Sem dados no período.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => {
            const pct = totalCount > 0 ? (r.count / totalCount) * 100 : 0;
            return (
              <li key={r.key}>
                <div className="flex justify-between text-xs text-slate-600 mb-0.5">
                  <span>{labels[r.key] ?? r.key}</span>
                  <span className="font-semibold tabular-nums">
                    {r.count} · {eur(r.cents)}
                  </span>
                </div>
                <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                  <div className="h-full bg-lime-500 rounded-full" style={{ width: `${pct}%` }} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {rows.length > 0 && (
        <p className="mt-3 text-xs text-slate-400 border-t pt-2">
          Total: {totalCount} encomenda(s) · {eur(totalCents)}
        </p>
      )}
    </div>
  );
}

const SEVERITY_STYLES: Record<Severity, string> = {
  critical: "border-red-300 bg-red-50 text-red-800",
  warning: "border-amber-300 bg-amber-50 text-amber-800",
  info: "border-sky-300 bg-sky-50 text-sky-800",
};

const SEVERITY_DOT: Record<Severity, string> = {
  critical: "bg-red-500",
  warning: "bg-amber-500",
  info: "bg-sky-500",
};

function KpiCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent: string }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
      <p className="text-xs font-medium text-slate-500 mb-1">{label}</p>
      <p className={`text-xl font-bold ${accent}`}>{value}</p>
      {sub && <p className="text-xs text-slate-400 mt-0.5">{sub}</p>}
    </div>
  );
}

function RevenueChart({ series }: { series: RevenuePoint[] }) {
  const max = Math.max(1, ...series.map((p) => p.cents));
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
      <h3 className="font-bold text-slate-800 mb-4">Receita — últimos 30 dias</h3>
      <div className="flex items-end gap-[2px] h-32">
        {series.map((p) => (
          <div
            key={p.date}
            className="flex-1 bg-lime-400/80 hover:bg-lime-500 rounded-t transition-colors group relative"
            style={{ height: `${Math.max(2, (p.cents / max) * 100)}%` }}
            title={`${p.date}: ${eur(p.cents)} (${p.orders} encomendas)`}
          >
            <div className="pointer-events-none absolute bottom-full mb-1 left-1/2 -translate-x-1/2 hidden group-hover:block whitespace-nowrap rounded bg-slate-900 px-2 py-1 text-[10px] text-white z-10">
              {p.date} · {eur(p.cents)}
            </div>
          </div>
        ))}
      </div>
      <div className="flex justify-between text-[10px] text-slate-400 mt-2">
        <span>{series[0]?.date}</span>
        <span>{series[series.length - 1]?.date}</span>
      </div>
    </div>
  );
}

export default function DashboardClient() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      const res = await fetch("/api/admin/dashboard", { cache: "no-store" });
      if (!res.ok) throw new Error("dashboard fetch failed");
      const json: DashboardData = await res.json();
      setData(json);
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const initial = async () => {
      // Async fetch — setState only fires after the network round-trip.
      await load();
      return cancelled;
    };
    void initial();
    timer.current = setInterval(() => void load(true), 60000);
    return () => {
      cancelled = true;
      if (timer.current) clearInterval(timer.current);
    };
  }, [load]);

  if (loading) return <div className="text-slate-500">A carregar centro de comando...</div>;
  if (error || !data)
    return (
      <div className="text-center py-12">
        <p className="text-red-600 mb-3">Não foi possível carregar o dashboard.</p>
        <button onClick={() => load()} className="px-4 py-2 bg-slate-800 text-white rounded-lg text-sm">
          Tentar novamente
        </button>
      </div>
    );

  const k = data.kpis;
  const momPositive = k.revenueMomCents >= 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-slate-800">Centro de Comando Operacional</h2>
          <p className="text-xs text-slate-500">
            Atualizado {new Date(data.generatedAt).toLocaleString("pt-PT")} · Fuso {data.timezone}
            {refreshing && <span className="ml-2 text-slate-400">a atualizar…</span>}
          </p>
        </div>
        <button
          onClick={() => load(true)}
          className="px-3 py-1.5 text-sm bg-white border border-slate-300 rounded-lg hover:bg-slate-50 text-slate-700"
        >
          ↻ Atualizar
        </button>
      </div>

      {/* Critical summary banner */}
      {(data.criticalAlertCount > 0 || data.warningAlertCount > 0) && (
        <div
          className={`rounded-xl border p-4 flex flex-wrap items-center gap-x-6 gap-y-2 ${
            data.criticalAlertCount > 0 ? "border-red-300 bg-red-50" : "border-amber-300 bg-amber-50"
          }`}
        >
          {data.criticalAlertCount > 0 && (
            <span className="text-sm font-semibold text-red-700">
              🔴 {data.criticalAlertCount} alerta(s) crítico(s)
            </span>
          )}
          {data.warningAlertCount > 0 && (
            <span className="text-sm font-semibold text-amber-700">
              🟠 {data.warningAlertCount} alerta(s) de atenção
            </span>
          )}
          <Link href="/admin/orders" className="text-sm font-medium text-slate-700 underline ml-auto">
            Ver operações →
          </Link>
        </div>
      )}

      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
        <KpiCard label="Receita hoje" value={eur(k.revenueToday.cents)} sub={`${k.paidOrdersToday} pago(s)`} accent="text-lime-600" />
        <KpiCard label="Receita 7 dias" value={eur(k.revenue7d.cents)} sub={`${k.paidOrders7d} pago(s)`} accent="text-green-600" />
        <KpiCard label="Receita 30 dias" value={eur(k.revenue30d.cents)} sub={`${k.paidOrders30d} pago(s)`} accent="text-emerald-600" />
        <KpiCard
          label="Receita do mês"
          value={eur(k.revenueThisMonth.cents)}
          sub={`${k.paidOrdersThisMonth} pago(s)`}
          accent="text-slate-800"
        />
        <KpiCard
          label="Vs. mês anterior"
          value={`${momPositive ? "+" : ""}${eur(k.revenueMomCents)}`}
          accent={momPositive ? "text-green-600" : "text-red-600"}
        />
        <KpiCard label="Por pagar" value={String(k.pendingPaymentOrders)} accent="text-amber-600" />
        <KpiCard label="A aguardar expedição" value={String(k.awaitingFulfillment)} sub="pagos não enviados" accent="text-sky-600" />
        <KpiCard label="Total encomendas" value={String(k.totalOrders)} accent="text-slate-800" />
        <KpiCard
          label="Clientes"
          value={String(k.totalCustomers)}
          sub={`+${k.newCustomersToday} hoje · +${k.newCustomersThisMonth} mês`}
          accent="text-teal-600"
        />
        <KpiCard label="Produtos ativos" value={String(k.totalActiveProducts)} accent="text-purple-600" />
        <KpiCard label="Stock baixo" value={String(k.lowStockProducts)} accent="text-orange-600" />
        <KpiCard label="Sem stock" value={String(k.outOfStockProducts)} accent="text-red-600" />
        <KpiCard label="RMA abertos" value={String(k.openRma)} accent="text-rose-600" />
      </div>

      {/* Alerts + pipeline */}
      <div className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
          <h3 className="font-bold text-slate-800 mb-4">Alertas operacionais</h3>
          {data.alerts.length === 0 ? (
            <p className="text-sm text-green-600 flex items-center gap-2">✅ Tudo em ordem — sem alertas.</p>
          ) : (
            <ul className="space-y-2">
              {data.alerts.map((a) => (
                <li key={a.code}>
                  <Link
                    href={a.href}
                    className={`flex items-center gap-3 border rounded-lg px-3 py-2 hover:shadow-sm transition ${SEVERITY_STYLES[a.severity]}`}
                  >
                    <span className={`w-2.5 h-2.5 rounded-full ${SEVERITY_DOT[a.severity]}`} />
                    <span className="text-sm font-medium flex-1">{a.label}</span>
                    <span className="text-sm font-bold tabular-nums">{a.count}</span>
                    <span className="text-xs opacity-60">→</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
          <h3 className="font-bold text-slate-800 mb-4">Pipeline de encomendas</h3>
          <ul className="space-y-1.5">
            {data.orderPipeline.map((b) => {
              const total = data.orderPipeline.reduce((s, x) => s + x.count, 0);
              const pct = total > 0 ? (b.count / total) * 100 : 0;
              return (
                <li key={b.status}>
                  <div className="flex justify-between text-xs text-slate-600 mb-0.5">
                    <span>{STATUS_LABELS[b.status] ?? b.status}</span>
                    <span className="font-semibold tabular-nums">{b.count}</span>
                  </div>
                  <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                    <div className="h-full bg-slate-700 rounded-full" style={{ width: `${pct}%` }} />
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      {/* Requires attention — READ-ONLY ignored Eupago financial movements.
          These terminal events cannot be replayed (same-trid redelivery is
          deduped); operators reconcile them manually in /admin/orders. */}
      {data.ignoredFinancialEvents.total > 0 && (
        <div className="rounded-xl border border-red-300 bg-red-50 p-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <h3 className="font-bold text-red-800">⚠ Requer atenção — movimentos Eupago não correlacionados</h3>
            <div className="flex gap-3 text-xs font-semibold text-red-700">
              <span>{data.ignoredFinancialEvents.paymentMismatches} pagamento(s)</span>
              <span>{data.ignoredFinancialEvents.refundMismatches} reembolso(s)</span>
              {data.ignoredFinancialEvents.refundAttemptNotFound > 0 && (
                <span className="rounded bg-red-600 px-2 py-0.5 text-white">
                  {data.ignoredFinancialEvents.refundAttemptNotFound} × REFUND_ATTEMPT_NOT_FOUND
                </span>
              )}
            </div>
          </div>
          <p className="text-xs text-red-700/80 mb-3">
            Movimentos confiados e verificados que não casaram com qualquer tentativa local. São terminais no fluxo de
            webhook (a reentrega do mesmo trid é deduplicada) — não existe replay automático; reconcilie manualmente.
          </p>
          <table className="w-full text-sm bg-white/70 rounded-lg overflow-hidden">
            <thead>
              <tr className="text-left text-xs text-red-700 border-b border-red-200">
                <th className="py-1.5 px-2">Tipo</th>
                <th className="py-1.5 px-2">trid / evento</th>
                <th className="py-1.5 px-2">Código</th>
                <th className="py-1.5 px-2 text-right">Recebido</th>
              </tr>
            </thead>
            <tbody>
              {data.ignoredFinancialEvents.events.map((e) => (
                <tr key={e.id} className="border-b border-red-100 last:border-0">
                  <td className="py-1.5 px-2">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${e.kind === "refund" ? "bg-purple-100 text-purple-700" : "bg-sky-100 text-sky-700"}`}>
                      {e.kind === "refund" ? "Reembolso" : e.kind === "payment" ? "Pagamento" : e.kind}
                    </span>
                  </td>
                  <td className="py-1.5 px-2 font-mono text-xs text-slate-700">{e.providerEventId ?? "—"}</td>
                  <td className="py-1.5 px-2">
                    <code className="text-xs font-semibold text-red-700">{e.reasonCode ?? e.eventType ?? "—"}</code>
                  </td>
                  <td className="py-1.5 px-2 text-right text-xs text-slate-500">
                    {new Date(e.receivedAt).toLocaleString("pt-PT", { dateStyle: "short", timeStyle: "short" })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-3 text-right">
            <Link href="/admin/orders" className="text-sm font-medium text-red-700 underline">
              Reconciliar em encomendas →
            </Link>
          </div>
        </div>
      )}

      {/* Revenue chart + breakdowns */}
      <RevenueChart series={data.revenueSeries} />

      <div className="grid lg:grid-cols-2 gap-6">
        <BreakdownCard title="Pagamentos — últimos 30 dias" rows={data.paymentMethodBreakdown} labels={PAYMENT_LABELS} />
        <BreakdownCard title="Entrega / levantamento — últimos 30 dias" rows={data.deliveryBreakdown} labels={DELIVERY_LABELS} />
      </div>

      {/* Watchlists */}
      <div className="grid lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-bold text-slate-800">Stock a vigiar</h3>
            <Link href="/admin/inventory" className="text-xs text-sky-600 hover:underline">
              Inventário →
            </Link>
          </div>
          {data.lowStockProducts.length === 0 ? (
            <p className="text-sm text-green-600">✅ Sem produtos com stock baixo.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-400 border-b">
                  <th className="py-1.5">Produto</th>
                  <th className="py-1.5 text-right">Stock</th>
                  <th className="py-1.5 text-right">Mín.</th>
                  <th className="py-1.5 text-right">Reserv.</th>
                </tr>
              </thead>
              <tbody>
                {data.lowStockProducts.map((p) => (
                  <tr key={p.id} className="border-b last:border-0">
                    <td className="py-2">
                      <Link href={`/admin/products`} className="text-slate-700 hover:text-sky-600">
                        {p.name}
                      </Link>
                      <span className="block text-[10px] text-slate-400">{p.sku ?? "—"}</span>
                    </td>
                    <td className={`py-2 text-right font-semibold tabular-nums ${p.stock <= 0 ? "text-red-600" : "text-orange-600"}`}>
                      {p.stock}
                    </td>
                    <td className="py-2 text-right text-slate-500 tabular-nums">{p.minStock}</td>
                    <td className="py-2 text-right text-slate-500 tabular-nums">{p.reservedStock}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-bold text-slate-800">Encomendas recentes</h3>
            <Link href="/admin/orders" className="text-xs text-sky-600 hover:underline">
              Ver todas →
            </Link>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-400 border-b">
                <th className="py-1.5">Encomenda</th>
                <th className="py-1.5">Cliente</th>
                <th className="py-1.5">Estado</th>
                <th className="py-1.5 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {data.recentOrders.map((o) => (
                <tr key={o.id} className="border-b last:border-0">
                  <td className="py-2">
                    <Link href="/admin/orders" className="font-medium text-slate-700 hover:text-sky-600">
                      {o.orderNumber}
                    </Link>
                    <span className="block text-[10px] text-slate-400">
                      {new Date(o.createdAt).toLocaleString("pt-PT", { dateStyle: "short", timeStyle: "short" })}
                    </span>
                  </td>
                  <td className="py-2 text-slate-600 max-w-[120px] truncate">{o.customerName}</td>
                  <td className="py-2">
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full ${
                        o.paymentStatus === "paid" ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"
                      }`}
                    >
                      {STATUS_LABELS[o.status] ?? o.status}
                    </span>
                  </td>
                  <td className="py-2 text-right font-semibold tabular-nums">{eur(o.totalCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
