/**
 * S29 — GET /api/admin/system/db-diagnostics
 *
 * Temporary, staff-only, read-only database diagnostic for staging.
 * It exposes schema/migration metadata only: no customer rows, credentials,
 * connection strings, fiscal data, writes, migrations, or external API calls.
 */
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getCurrentUser, isStaff } from "@/lib/auth";

export const dynamic = "force-dynamic";

const EXPECTED = {
  migration0018When: 1790011909734,
  migration0019When: 1790110800000,
  legalSlugs: [
    "politica-privacidade",
    "termos-condicoes",
    "politica-cookies",
    "politica-devolucoes",
    "garantias",
    "resolucao-litigios",
  ],
  companySettingKeys: ["company_name", "company_address", "company_nif"],
  consentColumns: [
    "terms_accepted_at",
    "terms_version",
    "privacy_acknowledged_at",
    "privacy_version",
    "marketing_consent_at",
    "marketing_consent_version",
  ],
} as const;

function rowsOf<T extends Record<string, unknown>>(result: unknown): T[] {
  const candidate = result as { rows?: T[] } | T[];
  if (Array.isArray(candidate)) return candidate;
  return Array.isArray(candidate?.rows) ? candidate.rows : [];
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sessão requerida" }, { status: 401 });
  if (!isStaff(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

  try {
    const migrationTableResult = await db.execute(sql`
      SELECT to_regclass('drizzle.__drizzle_migrations')::text AS relation
    `);
    const migrationTable = rowsOf<{ relation: string | null }>(migrationTableResult)[0]?.relation ?? null;

    let migrationRows: Array<{ id: number; created_at: string }> = [];
    if (migrationTable) {
      const migrationResult = await db.execute(sql`
        SELECT id, created_at::text AS created_at
        FROM drizzle.__drizzle_migrations
        ORDER BY created_at ASC, id ASC
      `);
      migrationRows = rowsOf<{ id: number; created_at: string }>(migrationResult);
    }

    const columnsResult = await db.execute(sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'users'
        AND column_name IN (
          'terms_accepted_at', 'terms_version', 'privacy_acknowledged_at',
          'privacy_version', 'marketing_consent_at', 'marketing_consent_version'
        )
      ORDER BY column_name
    `);
    const consentColumns = rowsOf<{ column_name: string }>(columnsResult).map((r) => r.column_name);

    const stockResult = await db.execute(sql`
      SELECT
        to_regclass('public.order_item_stock_allocations') IS NOT NULL AS allocation_table,
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'product_suppliers'
            AND column_name = 'supplier_reserved_stock'
        ) AS supplier_reserved_stock_column
    `);
    const stock = rowsOf<{ allocation_table: boolean; supplier_reserved_stock_column: boolean }>(stockResult)[0] ?? {
      allocation_table: false,
      supplier_reserved_stock_column: false,
    };

    const legalPagesResult = await db.execute(sql`
      SELECT slug, is_published
      FROM pages
      WHERE slug IN (
        'politica-privacidade', 'termos-condicoes', 'politica-cookies',
        'politica-devolucoes', 'garantias', 'resolucao-litigios'
      )
      ORDER BY slug
    `);
    const legalPages = rowsOf<{ slug: string; is_published: boolean }>(legalPagesResult);

    const settingsResult = await db.execute(sql`
      SELECT key, (value IS NOT NULL AND btrim(value) <> '') AS configured
      FROM settings
      WHERE key IN ('company_name', 'company_address', 'company_nif')
      ORDER BY key
    `);
    const companySettings = rowsOf<{ key: string; configured: boolean }>(settingsResult);

    const migrationTimes = migrationRows.map((r) => Number(r.created_at)).filter(Number.isFinite);
    const has0018History = migrationTimes.includes(EXPECTED.migration0018When);
    const has0019History = migrationTimes.includes(EXPECTED.migration0019When);
    const has0018Schema = stock.allocation_table && stock.supplier_reserved_stock_column;
    const has0019Schema = EXPECTED.consentColumns.every((name) => consentColumns.includes(name));
    const has0019Pages = EXPECTED.legalSlugs.every((slug) => legalPages.some((p) => p.slug === slug && p.is_published));
    const has0019Settings = EXPECTED.companySettingKeys.every((key) => companySettings.some((s) => s.key === key && s.configured));

    return NextResponse.json({
      diagnostic: "S29_READ_ONLY",
      database: {
        migrationTable,
        migrationCount: migrationRows.length,
        latestMigrationCreatedAt: migrationRows.at(-1)?.created_at ?? null,
      },
      migration0018: {
        historyRecorded: has0018History,
        schemaPresent: has0018Schema,
        allocationTablePresent: stock.allocation_table,
        supplierReservedStockColumnPresent: stock.supplier_reserved_stock_column,
      },
      migration0019: {
        historyRecorded: has0019History,
        schemaPresent: has0019Schema,
        consentColumnsPresent: consentColumns,
        legalPagesPresentAndPublished: has0019Pages,
        legalPageSlugsPresent: legalPages.map((p) => p.slug),
        companySettingsConfigured: has0019Settings,
        companySettingKeysPresent: companySettings.filter((s) => s.configured).map((s) => s.key),
      },
      consistency: {
        migration0018: has0018History === has0018Schema ? "consistent" : "mismatch",
        migration0019:
          has0019History === (has0019Schema && has0019Pages && has0019Settings) ? "consistent" : "mismatch",
      },
    }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("S29 db diagnostic failed:", error);
    return NextResponse.json({ error: "Falha no diagnóstico S29" }, { status: 500 });
  }
}
