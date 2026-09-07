CREATE TABLE "supplier_source_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"source_id" integer NOT NULL,
	"status" varchar(20) DEFAULT 'running' NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp,
	"duration_ms" integer,
	"row_count" integer,
	"new_count" integer,
	"updated_count" integer,
	"missing_count" integer,
	"http_status" integer,
	"etag" varchar(500),
	"last_modified" varchar(100),
	"import_id" integer,
	"error_code" varchar(80),
	"error_message" varchar(500),
	CONSTRAINT "ssr_status_valid" CHECK ("supplier_source_runs"."status" IN ('running','success','no_change','error','skipped')),
	CONSTRAINT "ssr_duration_non_negative" CHECK ("supplier_source_runs"."duration_ms" IS NULL OR "supplier_source_runs"."duration_ms" >= 0),
	CONSTRAINT "ssr_counts_non_negative" CHECK ("supplier_source_runs"."row_count" IS NULL OR "supplier_source_runs"."row_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "supplier_sources" (
	"id" serial PRIMARY KEY NOT NULL,
	"supplier_id" integer NOT NULL,
	"name" varchar(100) NOT NULL,
	"source_type" varchar(20) DEFAULT 'upload' NOT NULL,
	"format" varchar(10) DEFAULT 'auto' NOT NULL,
	"url" varchar(1000),
	"enabled" boolean DEFAULT false NOT NULL,
	"auth_type" varchar(20) DEFAULT 'none' NOT NULL,
	"username" varchar(255),
	"secret_reference" varchar(255),
	"headers_config" jsonb,
	"api_config" jsonb,
	"profile_id" integer,
	"apply_policy" varchar(20) DEFAULT 'preview_only' NOT NULL,
	"schedule" varchar(100),
	"next_run_at" timestamp,
	"last_checked_at" timestamp,
	"last_success_at" timestamp,
	"last_error_code" varchar(80),
	"last_error_message" varchar(500),
	"last_duration_ms" integer,
	"last_row_count" integer,
	"last_http_status" integer,
	"last_etag" varchar(500),
	"last_modified" varchar(100),
	"created_by" integer,
	"updated_by" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ss_source_type_valid" CHECK ("supplier_sources"."source_type" IN ('upload','url')),
	CONSTRAINT "ss_format_valid" CHECK ("supplier_sources"."format" IN ('auto','csv','xlsx')),
	CONSTRAINT "ss_auth_type_valid" CHECK ("supplier_sources"."auth_type" IN ('none','basic','bearer','header')),
	CONSTRAINT "ss_apply_policy_valid" CHECK ("supplier_sources"."apply_policy" IN ('preview_only','auto_if_clean')),
	CONSTRAINT "ss_url_https_only" CHECK ("supplier_sources"."url" IS NULL OR "supplier_sources"."url" ~ '^https://'),
	CONSTRAINT "ss_url_no_credentials" CHECK ("supplier_sources"."url" IS NULL OR "supplier_sources"."url" !~ '//[^@/]+@'),
	CONSTRAINT "ss_non_negative" CHECK ("supplier_sources"."last_duration_ms" IS NULL OR "supplier_sources"."last_duration_ms" >= 0),
	CONSTRAINT "ss_row_count_non_negative" CHECK ("supplier_sources"."last_row_count" IS NULL OR "supplier_sources"."last_row_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "supplier_imports" ADD COLUMN "source_id" integer;--> statement-breakpoint
ALTER TABLE "supplier_imports" ADD COLUMN "source_label" varchar(255);--> statement-breakpoint
ALTER TABLE "supplier_imports" ADD COLUMN "http_etag" varchar(500);--> statement-breakpoint
ALTER TABLE "supplier_imports" ADD COLUMN "http_last_modified" varchar(100);--> statement-breakpoint
ALTER TABLE "supplier_source_runs" ADD CONSTRAINT "supplier_source_runs_source_id_supplier_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."supplier_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_source_runs" ADD CONSTRAINT "supplier_source_runs_import_id_supplier_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."supplier_imports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_sources" ADD CONSTRAINT "supplier_sources_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_sources" ADD CONSTRAINT "supplier_sources_profile_id_supplier_import_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."supplier_import_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_sources" ADD CONSTRAINT "supplier_sources_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_sources" ADD CONSTRAINT "supplier_sources_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ssr_source_idx" ON "supplier_source_runs" USING btree ("source_id","started_at");--> statement-breakpoint
CREATE INDEX "ssr_status_idx" ON "supplier_source_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ss_supplier_idx" ON "supplier_sources" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "ss_due_idx" ON "supplier_sources" USING btree ("enabled","next_run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ss_supplier_name_unique" ON "supplier_sources" USING btree ("supplier_id","name");--> statement-breakpoint
ALTER TABLE "supplier_imports" ADD CONSTRAINT "supplier_imports_source_id_supplier_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."supplier_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "supplier_imports_source_idx" ON "supplier_imports" USING btree ("source_id");