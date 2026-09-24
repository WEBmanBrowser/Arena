ALTER TABLE "product_catalog_enrichments" DROP CONSTRAINT IF EXISTS "pce_provider_valid";--> statement-breakpoint
ALTER TABLE "product_catalog_enrichments" ADD CONSTRAINT "pce_provider_valid" CHECK ("provider" IN ('also_1worldsync','upcitemdb'));--> statement-breakpoint
CREATE TABLE "catalog_enrichment_attempts" (
  "id" serial PRIMARY KEY NOT NULL,
  "product_id" integer NOT NULL,
  "supplier_id" integer NOT NULL,
  "provider" varchar(50) NOT NULL,
  "lookup_key" varchar(255) NOT NULL,
  "status" varchar(30) NOT NULL,
  "detail" text,
  "attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
  "retry_after" timestamp with time zone,
  CONSTRAINT "cea_provider_valid" CHECK ("provider" IN ('upcitemdb')),
  CONSTRAINT "cea_status_valid" CHECK ("status" IN ('found','not_found','error','rate_limited','skipped'))
);--> statement-breakpoint
ALTER TABLE "catalog_enrichment_attempts" ADD CONSTRAINT "catalog_enrichment_attempts_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_enrichment_attempts" ADD CONSTRAINT "catalog_enrichment_attempts_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cea_product_idx" ON "catalog_enrichment_attempts" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "cea_supplier_status_idx" ON "catalog_enrichment_attempts" USING btree ("supplier_id","status");--> statement-breakpoint
CREATE INDEX "cea_attempted_idx" ON "catalog_enrichment_attempts" USING btree ("attempted_at");
