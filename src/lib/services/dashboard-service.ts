/**
 * B.4.1 — Admin Dashboard & Operational Command Center
 *
 * READ-ONLY operational analytics for the backoffice command center.
 *
 * Design constraints (consistent with the B-series financial work):
 *  • Money is ALWAYS integer cents at this boundary. Order totals are stored
 *    as decimal strings; they are converted in SQL with `ROUND(x*100)` and
 *    aggregated as numeric — no binary floating point anywhere.
 *  • "Revenue" counts only FINANCIALLY-PAID orders (payment_status = 'paid').
 *    Unpaid / pending / cancelled / expired orders never contribute to
 *    revenue or the "paid order" count.
 *  • Counts use status enums from the schema as the single source of truth.
 *  • Pure SELECTs — this module NEVER mutates any table, stock, order or
 *    payment state. It surfaces operational signals; it does not act on them.
 *  • No raw provider payloads, no PII beyond order/customer names, no secrets.
 *
 * B.3.5.1 operational visibility (READ-ONLY — this module never acts):
 *  • Eupago financial webhook movements that were received, trusted and
 *    reason-verified but could not be correlated to a local attempt are
 *    persisted as `ignored` ledger rows. They surface here as critical
 *    "requires attention" signals, including REFUND_ATTEMPT_NOT_FOUND.
 *  • These events are terminal by design (same-trid redelivery is deduped by
 *    the ledger and can NEVER replay them) — the dashboard only lists them
 *    for manual reconciliation. There is deliberately NO replay/reprocess
 *    endpoint or mutation here.
 */
import { db } from "@/db";
import { sql, eq, and, desc, inArray, notInArray } from "drizzle-orm";
import { toEuros, decimalToCents } from "@/lib/money";
import {
  orders,
  products,
  users,
  rmaRequests,
  paymentAttempts,
  refundAttempts,
  reconciliationObservations,
  providerWebhookEvents,
  invoiceDocuments,
  ORDER_STATUSES,
  type OrderStatus,
} from "@/db/schema";

/** Allowlisted payment provider id whose webhook ledger feeds B.3.5.1 visibility. */
const EUPAGO_PROVIDER = "eupago";

/**
 * Minimal structural type for the transaction handle. The service only calls
 * `.select` / `.execute` on it; deriving the full Drizzle transaction type is
 * version-fragile, so we constrain just what is used.
 */
type Tx = {
  select: typeof db.select;
  execute: typeof db.execute;
};

// ─── Types ───────────────────────────────────────────────────────

/** Integer-cent money aggregate. */
export interface DashboardMoney {
  /** Integer euro cents (never float). */
  cents: number;
  currency: "EUR";
}

export interface DashboardKpis {
  paidOrdersToday: number;
  revenueToday: DashboardMoney;
  paidOrders7d: number;
  revenue7d: DashboardMoney;
  paidOrders30d: number;
  revenue30d: DashboardMoney;
  paidOrdersThisMonth: number;
  revenueThisMonth: DashboardMoney;
  revenuePreviousMonth: DashboardMoney;
  /** Month-over-month revenue delta in cents (this - previous). */
  revenueMomCents: number;
  totalOrders: number;
  pendingPaymentOrders: number;
  paidOrders: number;
  awaitingFulfillment: number;
  totalActiveProducts: number;
  lowStockProducts: number;
  outOfStockProducts: number;
  totalCustomers: number;
  /** New customer accounts created today (Europe/Lisbon day). */
  newCustomersToday: number;
  /** New customer accounts in the current calendar month. */
  newCustomersThisMonth: number;
  openRma: number;
}

export interface MethodBreakdown {
  /** Payment method / delivery type value (unknown bucketed as "unknown"). */
  key: string;
  count: number;
  cents: number;
}

/**
 * READ-ONLY view of an ignored (trusted but uncorrelated) Eupago financial
 * webhook movement. Sanitized: only ledger identifiers and the mismatch code
 * are exposed — NO raw payload, NO headers, NO provider secrets.
 */
export interface IgnoredFinancialEvent {
  id: number;
  /** payment | refund — which ledger movement could not be correlated. */
  kind: "payment" | "refund" | "other";
  /** Sanitized reason code (e.g. ATTEMPT_NOT_FOUND, REFUND_ATTEMPT_NOT_FOUND). */
  reasonCode: string | null;
  /** Provider event/trx id (Eupago trid) — a public reference, not a secret. */
  providerEventId: string | null;
  eventType: string | null;
  receivedAt: string;
}

export interface IgnoredFinancialSummary {
  /** All trusted-but-uncorrelated Eupago financial movements needing review. */
  total: number;
  /** Those where a PAYMENT movement matched no local attempt. */
  paymentMismatches: number;
  /** Those where a REFUND movement matched no local refund attempt. */
  refundMismatches: number;
  /** Explicit count of the REFUND_ATTEMPT_NOT_FOUND case. */
  refundAttemptNotFound: number;
  events: IgnoredFinancialEvent[];
}

export interface StatusBreakdown {
  status: OrderStatus;
  count: number;
}

export interface AlertItem {
  /** Severity rank: critical > warning > info. */
  severity: "critical" | "warning" | "info";
  /** Machine-readable code for stable tests / icons. */
  code:
    | "PAYMENT_RECONCILIATION"
    | "OPEN_RECONCILIATION_ANOMALY"
    | "REFUND_ATTENTION"
    | "IGNORED_PAYMENT_WEBHOOK"
    | "IGNORED_REFUND_WEBHOOK"
    | "MANUAL_INVOICE_ATTENTION"
    | "PAYMENT_PENDING"
    | "AWAITING_FULFILLMENT"
    | "OPEN_RMA"
    | "OUT_OF_STOCK"
    | "LOW_STOCK"
    | "INVOICE_FAILURE"
    | "WEBHOOK_FAILURES";
  label: string;
  count: number;
  /** Where the operator acts on this signal. */
  href: string;
}

export interface RevenuePoint {
  /** ISO calendar date (YYYY-MM-DD), Europe/Lisbon day boundary. */
  date: string;
  orders: number;
  cents: number;
}

export interface RecentOrder {
  id: number;
  orderNumber: string;
  status: string;
  paymentStatus: string;
  totalCents: number;
  paymentMethod: string | null;
  customerName: string;
  createdAt: string;
}

export interface DashboardData {
  generatedAt: string;
  timezone: string;
  kpis: DashboardKpis;
  orderPipeline: StatusBreakdown[];
  alerts: AlertItem[];
  criticalAlertCount: number;
  warningAlertCount: number;
  revenueSeries: RevenuePoint[];
  /** Payment-method breakdown of PAID orders (last 30 days). */
  paymentMethodBreakdown: MethodBreakdown[];
  /** Delivery-type breakdown of PAID orders (shipping vs pickup, last 30 days). */
  deliveryBreakdown: MethodBreakdown[];
  /** READ-ONLY list of trusted-but-uncorrelated Eupago financial movements. */
  ignoredFinancialEvents: IgnoredFinancialSummary;
  lowStockProducts: Array<{
    id: number;
    name: string;
    sku: string | null;
    stock: number;
    minStock: number;
    reservedStock: number;
  }>;
  recentOrders: RecentOrder[];
}

// ─── Helpers ─────────────────────────────────────────────────────

/** Orders whose payment has actually been settled (financial truth). */
const PAID = sql`${orders.paymentStatus} = 'paid'`;

function money(cents: number | bigint | string): DashboardMoney {
  return { cents: Number(cents), currency: "EUR" };
}

async function orderStatusCountsTx(tx: Tx): Promise<Record<string, number>> {
  const rows = await tx
    .select({ status: orders.status, count: sql<number>`count(*)::int` })
    .from(orders)
    .groupBy(orders.status);
  const map: Record<string, number> = {};
  for (const r of rows) map[r.status] = Number(r.count);
  return map;
}

// ─── Main read model ─────────────────────────────────────────────

/**
 * Assemble the full command-center read model.
 * All reads run in a single read-only transaction for a consistent snapshot.
 */
export async function getDashboardData(): Promise<DashboardData> {
  const tz = "Europe/Lisbon";

  return db.transaction(async (tx) => {
    // ── Time anchors: Europe/Lisbon day/month boundaries, all in SQL.
    // created_at is timestamptz. date_trunc(... , now() AT TIME ZONE tz) yields
    // a tz-local wall-clock timestamp; AT TIME ZONE tz on that converts it back
    // to an absolute timestamptz instant, which compares directly against the
    // column. No Date object is round-tripped through the driver.
    const localStartOfDay = sql`date_trunc('day', now() AT TIME ZONE ${tz}) AT TIME ZONE ${tz}`;
    const localStartOfMonth = sql`date_trunc('month', now() AT TIME ZONE ${tz}) AT TIME ZONE ${tz}`;
    const localStartOfPrevMonth = sql`date_trunc('month', (now() AT TIME ZONE ${tz}) - interval '1 month') AT TIME ZONE ${tz}`;

    // ── KPIs: revenue (paid orders only), integer cents in SQL ──
    const [todayAgg] = await tx
      .select({
        orders: sql<number>`count(*)::int`,
        cents: sql<string>`COALESCE(SUM(ROUND(${orders.total}::numeric * 100)), 0)`,
      })
      .from(orders)
      .where(and(PAID, sql`${orders.createdAt} >= ${localStartOfDay}`));

    const [monthAgg] = await tx
      .select({
        orders: sql<number>`count(*)::int`,
        cents: sql<string>`COALESCE(SUM(ROUND(${orders.total}::numeric * 100)), 0)`,
      })
      .from(orders)
      .where(and(PAID, sql`${orders.createdAt} >= ${localStartOfMonth}`));

    const [prevMonthAgg] = await tx
      .select({
        cents: sql<string>`COALESCE(SUM(ROUND(${orders.total}::numeric * 100)), 0)`,
      })
      .from(orders)
      .where(
        and(
          PAID,
          sql`${orders.createdAt} >= ${localStartOfPrevMonth}`,
          sql`${orders.createdAt} < ${localStartOfMonth}`
        )
      );

    // ── Order counts ──
    const [totalOrders] = await tx.select({ c: sql<number>`count(*)::int` }).from(orders);
    const [paidOrders] = await tx.select({ c: sql<number>`count(*)::int` }).from(orders).where(PAID);
    const [pendingPayment] = await tx
      .select({ c: sql<number>`count(*)::int` })
      .from(orders)
      .where(eq(orders.status, "pending_payment"));

    const statusCounts = await orderStatusCountsTx(tx);
    // Awaiting fulfillment = paid but not yet handed to carrier / picked up.
    const awaitingFulfillment = (statusCounts["paid"] ?? 0) + (statusCounts["processing"] ?? 0);

    // ── Catalog ──
    const [activeProducts] = await tx
      .select({ c: sql<number>`count(*)::int` })
      .from(products)
      .where(eq(products.isActive, true));
    const [lowStock] = await tx
      .select({ c: sql<number>`count(*)::int` })
      .from(products)
      .where(
        and(
          eq(products.isActive, true),
          eq(products.isService, false),
          sql`${products.stock} <= ${products.minStock}`,
          sql`${products.stock} > 0`
        )
      );
    const [outOfStock] = await tx
      .select({ c: sql<number>`count(*)::int` })
      .from(products)
      .where(and(eq(products.isActive, true), eq(products.isService, false), sql`${products.stock} <= 0`));

    // ── Customers ──
    const [customers] = await tx
      .select({ c: sql<number>`count(*)::int` })
      .from(users)
      .where(eq(users.role, "customer"));

    // ── RMA ──
    const [openRma] = await tx
      .select({ c: sql<number>`count(*)::int` })
      .from(rmaRequests)
      .where(sql`${rmaRequests.status} NOT IN ('completed', 'cancelled')`);

    // ── Operational signals (B.3.x integration surfaces) ──
    // Payment attempts stuck waiting on an ambiguous provider outcome.
    const [reconciliationRequired] = await tx
      .select({ c: sql<number>`count(*)::int` })
      .from(paymentAttempts)
      .where(eq(paymentAttempts.recoveryState, "reconciliation_required"));

    const [openAnomalies] = await tx
      .select({ c: sql<number>`count(*)::int` })
      .from(reconciliationObservations)
      .where(eq(reconciliationObservations.status, "open"));

    // Refunds that still commit balance but have not succeeded (need action).
    const [refundsAttention] = await tx
      .select({ c: sql<number>`count(*)::int` })
      .from(refundAttempts)
      .where(
        sql`${refundAttempts.status} IN ('pending', 'processing')
            OR ${refundAttempts.recoveryState} = 'reconciliation_required'`
      );

    const [invoiceFailures] = await tx
      .select({ c: sql<number>`count(*)::int` })
      .from(invoiceDocuments)
      .where(eq(invoiceDocuments.status, "failed"));

    const [failedWebhooks] = await tx
      .select({ c: sql<number>`count(*)::int` })
      .from(providerWebhookEvents)
      .where(eq(providerWebhookEvents.status, "failed"));

    // ── 7-day and 30-day windows (paid orders only, integer cents) ──
    // Bounds are hardcoded literals (no user input), so inlining is safe.
    const paidWindow = async (intervalSql: string) =>
      tx
        .select({
          orders: sql<number>`count(*)::int`,
          cents: sql<string>`COALESCE(SUM(ROUND(${orders.total}::numeric * 100)), 0)`,
        })
        .from(orders)
        .where(and(PAID, sql`${orders.createdAt} >= now() - ${sql.raw(intervalSql)}`));
    const [agg7] = await paidWindow("interval '7 days'");
    const [agg30] = await paidWindow("interval '30 days'");

    // ── Customer growth (accounts created, Europe/Lisbon day/month) ──
    const [newCustomersToday] = await tx
      .select({ c: sql<number>`count(*)::int` })
      .from(users)
      .where(and(eq(users.role, "customer"), sql`${users.createdAt} >= ${localStartOfDay}`));
    const [newCustomersMonth] = await tx
      .select({ c: sql<number>`count(*)::int` })
      .from(users)
      .where(and(eq(users.role, "customer"), sql`${users.createdAt} >= ${localStartOfMonth}`));

    // ── Payment-method & delivery breakdown of PAID orders (last 30 days) ──
    const methodRows = await tx.execute<{ key: string; orders: number; cents: string }>(
      sql`SELECT COALESCE(NULLIF(${orders.paymentMethod}, ''), 'unknown') AS key,
                 count(*)::int AS orders,
                 COALESCE(SUM(ROUND(${orders.total}::numeric * 100)), 0) AS cents
          FROM ${orders}
          WHERE ${PAID} AND ${orders.createdAt} >= now() - interval '30 days'
          GROUP BY 1 ORDER BY cents DESC`
    );
    const paymentMethodBreakdown: MethodBreakdown[] = methodRows.rows.map((r) => ({
      key: r.key,
      count: Number(r.orders),
      cents: Number(r.cents),
    }));

    const deliveryRows = await tx.execute<{ key: string; orders: number; cents: string }>(
      sql`SELECT COALESCE(NULLIF(${orders.deliveryType}, ''), 'unknown') AS key,
                 count(*)::int AS orders,
                 COALESCE(SUM(ROUND(${orders.total}::numeric * 100)), 0) AS cents
          FROM ${orders}
          WHERE ${PAID} AND ${orders.createdAt} >= now() - interval '30 days'
          GROUP BY 1 ORDER BY cents DESC`
    );
    const deliveryBreakdown: MethodBreakdown[] = deliveryRows.rows.map((r) => ({
      key: r.key,
      count: Number(r.orders),
      cents: Number(r.cents),
    }));

    // ── Manual invoice attention: paid orders (last 30d) with no ISSUED
    //    fiscal document (excluding cancelled/refunded). In manual invoicing mode the operator must record
    //    each document; these orders still need one. ──
    const [manualInvoiceAttention] = await tx
      .select({ c: sql<number>`count(*)::int` })
      .from(orders)
      .where(
        and(
          PAID,
          sql`${orders.createdAt} >= now() - interval '30 days'`,
          notInArray(orders.status, ["cancelled", "refunded"]),
          sql`NOT EXISTS (
            SELECT 1 FROM ${invoiceDocuments} d
            WHERE d.order_id = ${orders.id}
              AND d.document_type = 'invoice'
              AND d.status = 'issued'
          )`
        )
      );

    // ── B.3.5.1 visibility: IGNORED trusted-but-uncorrelated Eupago
    //    financial webhook movements (READ-ONLY; never replayed here).
    //    The ledger stores a sanitized metadata.kind (payment|refund) and the
    //    mismatch code in last_error; raw payloads are never persisted.
    const ignoredEventRows = await tx
      .select({
        id: providerWebhookEvents.id,
        providerEventId: providerWebhookEvents.providerEventId,
        eventType: providerWebhookEvents.eventType,
        lastError: providerWebhookEvents.lastError,
        metadata: providerWebhookEvents.metadata,
        receivedAt: providerWebhookEvents.receivedAt,
      })
      .from(providerWebhookEvents)
      .where(
        and(
          eq(providerWebhookEvents.provider, EUPAGO_PROVIDER),
          eq(providerWebhookEvents.status, "ignored")
        )
      )
      .orderBy(desc(providerWebhookEvents.receivedAt))
      .limit(10);

    const ignoredEvents: IgnoredFinancialEvent[] = ignoredEventRows.map((e) => {
      const metaKind = (e.metadata as { kind?: string } | null)?.kind;
      const eventType = e.eventType ?? null;
      // metadata.kind is authoritative; fall back to the eventType prefix.
      const kind: IgnoredFinancialEvent["kind"] =
        metaKind === "refund" || eventType?.startsWith("refund")
          ? "refund"
          : metaKind === "payment" || eventType?.startsWith("payment")
            ? "payment"
            : "other";
      return {
        id: e.id,
        kind,
        reasonCode: e.lastError,
        providerEventId: e.providerEventId,
        eventType,
        receivedAt: e.receivedAt.toISOString(),
      };
    });

    // ── B.3.5.1 counters over the COMPLETE population (never the capped
    //    display list). All counts are DB aggregates; the 10-row `events`
    //    list below is display-only. Classification reuses the exact trusted
    //    semantics established by B.3.2/B.3.5.1: a mismatched (ignored)
    //    movement is a refund when metadata.kind='refund' or the event type
    //    starts with 'refund', and a payment when metadata.kind='payment' or
    //    the event type starts with 'payment' — mirroring the row mapping.
    const [ignoredCountRow] = await tx
      .select({
        total: sql<number>`count(*)::int`,
        paymentMismatches: sql<number>`count(*) FILTER (WHERE
          ${providerWebhookEvents.lastError} IS NOT NULL AND (
            ${providerWebhookEvents.metadata}->>'kind' = 'payment'
            OR ${providerWebhookEvents.eventType} LIKE 'payment%'))::int`,
        refundMismatches: sql<number>`count(*) FILTER (WHERE
          ${providerWebhookEvents.lastError} IS NOT NULL AND (
            ${providerWebhookEvents.metadata}->>'kind' = 'refund'
            OR ${providerWebhookEvents.eventType} LIKE 'refund%'))::int`,
        refundAttemptNotFound: sql<number>`count(*) FILTER (WHERE
          ${providerWebhookEvents.lastError} = 'REFUND_ATTEMPT_NOT_FOUND')::int`,
      })
      .from(providerWebhookEvents)
      .where(
        and(
          eq(providerWebhookEvents.provider, EUPAGO_PROVIDER),
          eq(providerWebhookEvents.status, "ignored")
        )
      );

    const ignoredFinancialEvents: IgnoredFinancialSummary = {
      total: Number(ignoredCountRow.total),
      paymentMismatches: Number(ignoredCountRow.paymentMismatches),
      refundMismatches: Number(ignoredCountRow.refundMismatches),
      refundAttemptNotFound: Number(ignoredCountRow.refundAttemptNotFound),
      events: ignoredEvents,
    };

    // ── Revenue series: dense last-30-days, paid orders, tz-aligned ──
    // The day axis is GENERATED IN SQL in the store timezone and LEFT JOINed
    // to the aggregated paid orders, so bucket alignment cannot drift from
    // the JS calendar (server TZ may differ from Europe/Lisbon).
    const seriesResult = await tx.execute<{
      day: string;
      orders: number;
      cents: string;
    }>(sql`
      WITH days AS (
        SELECT to_char(d, 'YYYY-MM-DD') AS day
        FROM generate_series(
          date_trunc('day', now() AT TIME ZONE ${tz}) - interval '29 days',
          date_trunc('day', now() AT TIME ZONE ${tz}),
          interval '1 day'
        ) d
      ),
      agg AS (
        SELECT
          to_char(${orders.createdAt} AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS day,
          count(*)::int AS orders,
          COALESCE(SUM(ROUND(${orders.total}::numeric * 100)), 0) AS cents
        FROM ${orders}
        WHERE ${PAID}
          AND ${orders.createdAt} >= (date_trunc('day', now() AT TIME ZONE ${tz}) - interval '29 days') AT TIME ZONE ${tz}
        GROUP BY 1
      )
      SELECT days.day,
             COALESCE(agg.orders, 0)::int AS orders,
             COALESCE(agg.cents, 0) AS cents
      FROM days
      LEFT JOIN agg ON agg.day = days.day
      ORDER BY days.day
    `);

    const revenueSeries: RevenuePoint[] = seriesResult.rows.map((r) => ({
      date: r.day,
      orders: Number(r.orders),
      cents: Number(r.cents),
    }));

    // ── Order pipeline breakdown (every known status, zero counts dropped) ──
    const orderPipeline: StatusBreakdown[] = ORDER_STATUSES.map((s) => ({
      status: s,
      count: statusCounts[s] ?? 0,
    })).filter((b) => b.count > 0);

    // ── Low stock list (worst first) ──
    const lowStockProducts = await tx
      .select({
        id: products.id,
        name: products.name,
        sku: products.sku,
        stock: products.stock,
        minStock: products.minStock,
        reservedStock: products.reservedStock,
      })
      .from(products)
      .where(
        and(
          eq(products.isActive, true),
          eq(products.isService, false),
          sql`${products.stock} <= ${products.minStock}`
        )
      )
      .orderBy(products.stock)
      .limit(10);

    // ── Recent orders (latest 10) ──
    const recentOrderRows = await tx
      .select({
        id: orders.id,
        orderNumber: orders.orderNumber,
        status: orders.status,
        paymentStatus: orders.paymentStatus,
        total: orders.total,
        paymentMethod: orders.paymentMethod,
        guestName: orders.guestName,
        userId: orders.userId,
        createdAt: orders.createdAt,
      })
      .from(orders)
      .orderBy(desc(orders.createdAt))
      .limit(10);

    // Resolve registered customer names; guests fall back to guest name.
    const userIds = [...new Set(recentOrderRows.map((o) => o.userId).filter((u): u is number => u != null))];
    const userRows = userIds.length
      ? await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds))
      : [];
    const userName = new Map(userRows.map((u) => [u.id, u.name]));

    const recentOrders: RecentOrder[] = recentOrderRows.map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      status: o.status,
      paymentStatus: o.paymentStatus,
      // Deterministic decimal-string → integer cents (no binary float).
      totalCents: decimalToCents(o.total) ?? Math.round(Number(o.total) * 100),
      paymentMethod: o.paymentMethod,
      customerName: o.guestName || (o.userId ? userName.get(o.userId) ?? `Cliente #${o.userId}` : "Convidado"),
      createdAt: o.createdAt.toISOString(),
    }));

    // ── Alerts (severity-ranked) ──
    const alerts: AlertItem[] = [];
    const push = (a: AlertItem) => {
      if (a.count > 0) alerts.push(a);
    };

    push({ severity: "critical", code: "PAYMENT_RECONCILIATION", label: "Pagamentos em reconciliação manual", count: Number(reconciliationRequired.c), href: "/admin/orders?queue=exceptions" });
    push({ severity: "critical", code: "OPEN_RECONCILIATION_ANOMALY", label: "Anomalias de reconciliação abertas", count: Number(openAnomalies.c), href: "/admin/orders?queue=exceptions" });
    push({ severity: "critical", code: "REFUND_ATTENTION", label: "Reembolsos a aguardar resolução", count: Number(refundsAttention.c), href: "/admin/orders?queue=refund_attention" });
    // B.3.5.1: trusted Eupago movements that could not be correlated. Terminal
    // on the webhook path (same-trid redelivery is deduped) — manual review.
    push({ severity: "critical", code: "IGNORED_PAYMENT_WEBHOOK", label: "Webhooks de pagamento Eupago não correlacionados", count: ignoredFinancialEvents.paymentMismatches, href: "/admin/orders?queue=exceptions&webhookFilter=ignored_payment" });
    push({ severity: "critical", code: "IGNORED_REFUND_WEBHOOK", label: "Webhooks de reembolso Eupago não correlacionados", count: ignoredFinancialEvents.refundMismatches, href: "/admin/orders?queue=exceptions&webhookFilter=ignored_refund" });
    push({ severity: "warning", code: "PAYMENT_PENDING", label: "Encomendas por pagar", count: Number(pendingPayment.c), href: "/admin/orders?queue=awaiting_payment" });
    push({ severity: "warning", code: "AWAITING_FULFILLMENT", label: "Encomendas pagas a aguardar expedição", count: awaitingFulfillment, href: "/admin/orders?queue=paid_needs_processing" });
    push({ severity: "warning", code: "MANUAL_INVOICE_ATTENTION", label: "Encomendas pagas sem documento de faturação", count: Number(manualInvoiceAttention.c), href: "/admin/orders?queue=missing_invoice" });
    push({ severity: "warning", code: "OPEN_RMA", label: "Pedidos RMA abertos", count: Number(openRma.c), href: "/admin/rma" });
    push({ severity: "warning", code: "OUT_OF_STOCK", label: "Produtos sem stock", count: Number(outOfStock.c), href: "/admin/inventory" });
    push({ severity: "warning", code: "LOW_STOCK", label: "Produtos com stock baixo", count: Number(lowStock.c), href: "/admin/inventory" });
    push({ severity: "warning", code: "INVOICE_FAILURE", label: "Documentos de faturação com falha", count: Number(invoiceFailures.c), href: "/admin/orders?queue=exceptions" });
    push({ severity: "info", code: "WEBHOOK_FAILURES", label: "Webhooks de fornecedor com falha", count: Number(failedWebhooks.c), href: "/admin/orders?queue=exceptions&webhookFilter=failed" });

    alerts.sort((a, b) => {
      const rank = { critical: 0, warning: 1, info: 2 };
      return rank[a.severity] - rank[b.severity] || b.count - a.count;
    });

    const revenueTodayCents = Number(todayAgg.cents);
    const revenueMonthCents = Number(monthAgg.cents);
    const revenuePrevMonthCents = Number(prevMonthAgg.cents);

    return {
      generatedAt: new Date().toISOString(),
      timezone: tz,
      kpis: {
        paidOrdersToday: Number(todayAgg.orders),
        revenueToday: money(revenueTodayCents),
        paidOrders7d: Number(agg7.orders),
        revenue7d: money(Number(agg7.cents)),
        paidOrders30d: Number(agg30.orders),
        revenue30d: money(Number(agg30.cents)),
        paidOrdersThisMonth: Number(monthAgg.orders),
        revenueThisMonth: money(revenueMonthCents),
        revenuePreviousMonth: money(revenuePrevMonthCents),
        revenueMomCents: revenueMonthCents - revenuePrevMonthCents,
        totalOrders: Number(totalOrders.c),
        pendingPaymentOrders: Number(pendingPayment.c),
        paidOrders: Number(paidOrders.c),
        awaitingFulfillment,
        totalActiveProducts: Number(activeProducts.c),
        lowStockProducts: Number(lowStock.c),
        outOfStockProducts: Number(outOfStock.c),
        totalCustomers: Number(customers.c),
        newCustomersToday: Number(newCustomersToday.c),
        newCustomersThisMonth: Number(newCustomersMonth.c),
        openRma: Number(openRma.c),
      },
      orderPipeline,
      alerts,
      criticalAlertCount: alerts.filter((a) => a.severity === "critical").reduce((s, a) => s + a.count, 0),
      warningAlertCount: alerts.filter((a) => a.severity === "warning").reduce((s, a) => s + a.count, 0),
      revenueSeries,
      paymentMethodBreakdown,
      deliveryBreakdown,
      ignoredFinancialEvents,
      lowStockProducts: lowStockProducts.map((p) => ({
        id: p.id,
        name: p.name,
        sku: p.sku,
        stock: p.stock,
        minStock: p.minStock,
        reservedStock: p.reservedStock,
      })),
      recentOrders,
    };
  });
}

// ── Legacy stats compatibility ──────────────────────────────────
// /api/admin/stats keeps its old shape for the original card layout, but the
// numbers now come from the SAME corrected read model (paid-only revenue).
export async function getLegacyStats() {
  const d = await getDashboardData();
  return {
    totalOrders: d.kpis.totalOrders,
    todaySales: d.kpis.paidOrdersToday,
    // Integer-cent source, deterministic 2-decimal euro string.
    todayRevenue: toEuros(d.kpis.revenueToday.cents),
    monthSales: d.kpis.paidOrdersThisMonth,
    monthRevenue: toEuros(d.kpis.revenueThisMonth.cents),
    pendingOrders: d.kpis.pendingPaymentOrders,
    totalProducts: d.kpis.totalActiveProducts,
    lowStock: d.kpis.lowStockProducts,
    outOfStock: d.kpis.outOfStockProducts,
    totalCustomers: d.kpis.totalCustomers,
    openRma: d.kpis.openRma,
  };
}
