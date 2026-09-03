CREATE SEQUENCE "public"."product_internal_sku_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;
--> statement-breakpoint
CREATE TABLE "supplier_import_rows" (
	"id" serial PRIMARY KEY NOT NULL,
	"import_id" integer NOT NULL,
	"row_number" integer NOT NULL,
	"supplier_sku" varchar(100),
	"ean" varchar(50),
	"internal_sku" varchar(100),
	"name" varchar(255),
	"product_id" integer,
	"match_type" varchar(20) DEFAULT 'none' NOT NULL,
	"status" varchar(20) NOT NULL,
	"cost_price" numeric(10, 2),
	"stock" integer,
	"lead_time_days" integer,
	"applied" boolean DEFAULT false NOT NULL,
	"message" varchar(500),
	"current_price" numeric(10, 2),
	"computed_price" numeric(10, 2),
	"price_mode" varchar(10),
	"price_message" varchar(255),
	"is_preferred_supplier" boolean DEFAULT false NOT NULL,
	"applied_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_import_rows_match_type_valid" CHECK ("supplier_import_rows"."match_type" IN ('supplier_sku','ean','internal_sku','none')),
	CONSTRAINT "supplier_import_rows_status_valid" CHECK ("supplier_import_rows"."status" IN ('ready','new_product','conflict','error')),
	CONSTRAINT "supplier_import_rows_row_number_positive" CHECK ("supplier_import_rows"."row_number" > 0),
	CONSTRAINT "supplier_import_rows_cost_non_negative" CHECK ("supplier_import_rows"."cost_price" IS NULL OR "supplier_import_rows"."cost_price" >= 0),
	CONSTRAINT "supplier_import_rows_stock_non_negative" CHECK ("supplier_import_rows"."stock" IS NULL OR "supplier_import_rows"."stock" >= 0),
	CONSTRAINT "supplier_import_rows_price_mode_valid" CHECK ("supplier_import_rows"."price_mode" IS NULL OR "supplier_import_rows"."price_mode" IN ('auto','manual')),
	CONSTRAINT "supplier_import_rows_target_matches_status" CHECK ("supplier_import_rows"."status" <> 'new_product' OR "supplier_import_rows"."product_id" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "supplier_imports" (
	"id" serial PRIMARY KEY NOT NULL,
	"supplier_id" integer NOT NULL,
	"file_name" varchar(255) NOT NULL,
	"file_hash" varchar(64) NOT NULL,
	"file_size_bytes" integer NOT NULL,
	"row_count" integer NOT NULL,
	"status" varchar(20) DEFAULT 'preview' NOT NULL,
	"mapping" jsonb,
	"summary" jsonb,
	"error_summary" jsonb,
	"batches_total" integer DEFAULT 0 NOT NULL,
	"batches_done" integer DEFAULT 0 NOT NULL,
	"user_id" integer NOT NULL,
	"started_at" timestamp,
	"heartbeat_at" timestamp,
	"finished_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_imports_status_valid" CHECK ("supplier_imports"."status" IN ('preview','applying','completed','failed','partial')),
	CONSTRAINT "supplier_imports_row_count_non_negative" CHECK ("supplier_imports"."row_count" >= 0),
	CONSTRAINT "supplier_imports_file_size_non_negative" CHECK ("supplier_imports"."file_size_bytes" >= 0),
	CONSTRAINT "supplier_imports_batches_non_negative" CHECK ("supplier_imports"."batches_total" >= 0 AND "supplier_imports"."batches_done" >= 0),
	CONSTRAINT "supplier_imports_batches_done_le_total" CHECK ("supplier_imports"."batches_done" <= "supplier_imports"."batches_total"),
	CONSTRAINT "supplier_imports_file_hash_format" CHECK ("supplier_imports"."file_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "supplier_import_rows" ADD CONSTRAINT "supplier_import_rows_import_id_supplier_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."supplier_imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_import_rows" ADD CONSTRAINT "supplier_import_rows_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_imports" ADD CONSTRAINT "supplier_imports_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_imports" ADD CONSTRAINT "supplier_imports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_import_rows_line_unique" ON "supplier_import_rows" USING btree ("import_id","row_number");--> statement-breakpoint
CREATE INDEX "supplier_import_rows_claim_idx" ON "supplier_import_rows" USING btree ("import_id","applied");--> statement-breakpoint
CREATE INDEX "supplier_import_rows_status_idx" ON "supplier_import_rows" USING btree ("import_id","status");--> statement-breakpoint
CREATE INDEX "supplier_import_rows_product_idx" ON "supplier_import_rows" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "supplier_imports_supplier_idx" ON "supplier_imports" USING btree ("supplier_id","created_at");--> statement-breakpoint
CREATE INDEX "supplier_imports_status_idx" ON "supplier_imports" USING btree ("status");--> statement-breakpoint
CREATE INDEX "supplier_imports_hash_idx" ON "supplier_imports" USING btree ("supplier_id","file_hash");