ALTER TABLE "product_suppliers" ADD COLUMN "manufacturer_part_number" varchar(100);--> statement-breakpoint
ALTER TABLE "product_suppliers" ADD COLUMN "supplier_category_path" text;--> statement-breakpoint
ALTER TABLE "product_suppliers" ADD COLUMN "available_next_date" date;--> statement-breakpoint
ALTER TABLE "product_suppliers" ADD COLUMN "available_next_quantity" integer;--> statement-breakpoint
ALTER TABLE "product_suppliers" ADD COLUMN "availability_timestamp" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_suppliers" ADD COLUMN "last_sync_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "supplier_import_rows" ADD COLUMN "manufacturer_part_number" varchar(100);--> statement-breakpoint
ALTER TABLE "supplier_import_rows" ADD COLUMN "manufacturer_name" varchar(255);--> statement-breakpoint
ALTER TABLE "supplier_import_rows" ADD COLUMN "supplier_category_path" text;--> statement-breakpoint
ALTER TABLE "supplier_import_rows" ADD COLUMN "available_next_date" date;--> statement-breakpoint
ALTER TABLE "supplier_import_rows" ADD COLUMN "available_next_quantity" integer;--> statement-breakpoint
ALTER TABLE "supplier_import_rows" ADD COLUMN "availability_timestamp" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_suppliers" ADD CONSTRAINT "ps_available_next_quantity_non_negative" CHECK ("product_suppliers"."available_next_quantity" IS NULL OR "product_suppliers"."available_next_quantity" >= 0);--> statement-breakpoint
ALTER TABLE "supplier_import_rows" ADD CONSTRAINT "supplier_import_rows_available_next_quantity_non_negative" CHECK ("supplier_import_rows"."available_next_quantity" IS NULL OR "supplier_import_rows"."available_next_quantity" >= 0);