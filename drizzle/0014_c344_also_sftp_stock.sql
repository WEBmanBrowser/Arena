-- C.3.4.4 — ALSO SFTP + separação de stock de fornecedor + diff incremental.
--
-- IMPACTO (auditado contra a HEAD real 3758c66, migrations 0000–0013):
--  - Só colunas NULLABLE novas + CHECKs alargados: zero backfill, zero downtime,
--    100% compatível com dados e código anteriores (linhas antigas têm
--    supplier_stock/diff_status NULL e seguem o caminho genérico inalterado).
--  - product_suppliers.supplier_stock: stock do FORNECEDOR (ALSO). products.stock
--    continua a ser o stock físico MDTech e NUNCA é escrito pelo sync ALSO.
--  - supplier_import_rows.supplier_stock: snapshot do stock de fornecedor por
--    linha (a coluna `stock` deixa de transportar stock ALSO).
--  - supplier_import_rows.diff_status/changed_fields: vocabulário incremental
--    (new/changed/unchanged/error) persistido para linhas ALSO stock-only.
--  - supplier_sources: source_type += 'sftp', format += also_stock/also_pricelist,
--    colunas de config SFTP (host/port/path/fingerprint — NUNCA password) e
--    validadores remotos size+mtime (otimização; o hash de conteúdo é a identidade).
--  - supplier_source_runs: size+mtime observados por run.
--
-- ROLLBACK (manual, nesta ordem):
--  ALTER TABLE supplier_source_runs DROP CONSTRAINT ssr_remote_size_non_negative;
--  ALTER TABLE supplier_source_runs DROP COLUMN remote_size, DROP COLUMN remote_mtime;
--  ALTER TABLE supplier_sources DROP CONSTRAINT ss_last_remote_size_non_negative;
--  ALTER TABLE supplier_sources DROP CONSTRAINT ss_sftp_port_valid;
--  ALTER TABLE supplier_sources DROP CONSTRAINT ss_format_valid;
--  ALTER TABLE supplier_sources ADD CONSTRAINT ss_format_valid CHECK (format IN ('auto','csv','xlsx'));
--  ALTER TABLE supplier_sources DROP CONSTRAINT ss_source_type_valid;
--  ALTER TABLE supplier_sources ADD CONSTRAINT ss_source_type_valid CHECK (source_type IN ('upload','url'));
--  ALTER TABLE supplier_sources DROP COLUMN sftp_host, DROP COLUMN sftp_port,
--    DROP COLUMN sftp_remote_path, DROP COLUMN sftp_host_key_fingerprint,
--    DROP COLUMN last_remote_size, DROP COLUMN last_remote_mtime;
--  ALTER TABLE supplier_import_rows DROP CONSTRAINT supplier_import_rows_diff_status_valid;
--  ALTER TABLE supplier_import_rows DROP CONSTRAINT supplier_import_rows_supplier_stock_non_negative;
--  ALTER TABLE supplier_import_rows DROP COLUMN supplier_stock, DROP COLUMN diff_status, DROP COLUMN changed_fields;
--  ALTER TABLE product_suppliers DROP CONSTRAINT ps_supplier_stock_non_negative;
--  ALTER TABLE product_suppliers DROP COLUMN supplier_stock;
--> statement-breakpoint
ALTER TABLE "product_suppliers" ADD COLUMN "supplier_stock" integer;
--> statement-breakpoint
ALTER TABLE "product_suppliers" ADD CONSTRAINT "ps_supplier_stock_non_negative" CHECK ("product_suppliers"."supplier_stock" IS NULL OR "product_suppliers"."supplier_stock" >= 0);
--> statement-breakpoint
ALTER TABLE "supplier_import_rows" ADD COLUMN "supplier_stock" integer;
--> statement-breakpoint
ALTER TABLE "supplier_import_rows" ADD COLUMN "diff_status" varchar(20);
--> statement-breakpoint
ALTER TABLE "supplier_import_rows" ADD COLUMN "changed_fields" jsonb;
--> statement-breakpoint
ALTER TABLE "supplier_import_rows" ADD CONSTRAINT "supplier_import_rows_supplier_stock_non_negative" CHECK ("supplier_import_rows"."supplier_stock" IS NULL OR "supplier_import_rows"."supplier_stock" >= 0);
--> statement-breakpoint
ALTER TABLE "supplier_import_rows" ADD CONSTRAINT "supplier_import_rows_diff_status_valid" CHECK ("supplier_import_rows"."diff_status" IS NULL OR "supplier_import_rows"."diff_status" IN ('new','changed','unchanged','error'));
--> statement-breakpoint
ALTER TABLE "supplier_sources" ADD COLUMN "sftp_host" varchar(255);
--> statement-breakpoint
ALTER TABLE "supplier_sources" ADD COLUMN "sftp_port" integer;
--> statement-breakpoint
ALTER TABLE "supplier_sources" ADD COLUMN "sftp_remote_path" varchar(1000);
--> statement-breakpoint
ALTER TABLE "supplier_sources" ADD COLUMN "sftp_host_key_fingerprint" varchar(255);
--> statement-breakpoint
ALTER TABLE "supplier_sources" ADD COLUMN "last_remote_size" integer;
--> statement-breakpoint
ALTER TABLE "supplier_sources" ADD COLUMN "last_remote_mtime" varchar(100);
--> statement-breakpoint
ALTER TABLE "supplier_sources" DROP CONSTRAINT "ss_source_type_valid";
--> statement-breakpoint
ALTER TABLE "supplier_sources" ADD CONSTRAINT "ss_source_type_valid" CHECK ("supplier_sources"."source_type" IN ('upload','url','sftp'));
--> statement-breakpoint
ALTER TABLE "supplier_sources" DROP CONSTRAINT "ss_format_valid";
--> statement-breakpoint
ALTER TABLE "supplier_sources" ADD CONSTRAINT "ss_format_valid" CHECK ("supplier_sources"."format" IN ('auto','csv','xlsx','also_stock','also_pricelist'));
--> statement-breakpoint
ALTER TABLE "supplier_sources" ADD CONSTRAINT "ss_sftp_port_valid" CHECK ("supplier_sources"."sftp_port" IS NULL OR ("supplier_sources"."sftp_port" >= 1 AND "supplier_sources"."sftp_port" <= 65535));
--> statement-breakpoint
ALTER TABLE "supplier_sources" ADD CONSTRAINT "ss_last_remote_size_non_negative" CHECK ("supplier_sources"."last_remote_size" IS NULL OR "supplier_sources"."last_remote_size" >= 0);
--> statement-breakpoint
ALTER TABLE "supplier_source_runs" ADD COLUMN "remote_size" integer;
--> statement-breakpoint
ALTER TABLE "supplier_source_runs" ADD COLUMN "remote_mtime" varchar(100);
--> statement-breakpoint
ALTER TABLE "supplier_source_runs" ADD CONSTRAINT "ssr_remote_size_non_negative" CHECK ("supplier_source_runs"."remote_size" IS NULL OR "supplier_source_runs"."remote_size" >= 0);
