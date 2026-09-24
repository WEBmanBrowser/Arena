CREATE TABLE "product_catalog_enrichments" (
  "id" serial PRIMARY KEY NOT NULL,
  "product_id" integer NOT NULL,
  "supplier_id" integer NOT NULL,
  "supplier_sku" varchar(100) NOT NULL,
  "provider" varchar(50) DEFAULT 'also_1worldsync' NOT NULL,
  "source_url" varchar(1000),
  "source_short_description" text,
  "source_description" text,
  "source_attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "source_images" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "content_hash" varchar(64) NOT NULL,
  "fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_applied_at" timestamp with time zone,
  "applied_description_hash" varchar(64),
  "applied_short_description_hash" varchar(64),
  "applied_attributes_hash" varchar(64),
  "applied_attributes_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "pce_provider_valid" CHECK ("provider" IN ('also_1worldsync'))
);
--> statement-breakpoint
ALTER TABLE "product_catalog_enrichments" ADD CONSTRAINT "pce_product_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "product_catalog_enrichments" ADD CONSTRAINT "pce_supplier_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "pce_product_supplier_provider_unique" ON "product_catalog_enrichments" USING btree ("product_id","supplier_id","provider");
--> statement-breakpoint
CREATE INDEX "pce_product_idx" ON "product_catalog_enrichments" USING btree ("product_id");
--> statement-breakpoint
CREATE INDEX "pce_supplier_sku_idx" ON "product_catalog_enrichments" USING btree ("supplier_id","supplier_sku");
--> statement-breakpoint
ALTER TABLE "product_images" ADD COLUMN "source" varchar(30) DEFAULT 'manual' NOT NULL;
--> statement-breakpoint
ALTER TABLE "product_images" ADD COLUMN "source_ref" varchar(500);
--> statement-breakpoint
ALTER TABLE "product_images" ADD COLUMN "source_url" varchar(1000);
--> statement-breakpoint
ALTER TABLE "product_images" ADD COLUMN "source_hash" varchar(64);
--> statement-breakpoint
ALTER TABLE "product_images" ADD COLUMN "imported_at" timestamp with time zone;
--> statement-breakpoint
CREATE UNIQUE INDEX "pi_product_source_ref_unique" ON "product_images" USING btree ("product_id","source","source_ref") WHERE source_ref IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "pi_source_valid" CHECK ("source" IN ('manual','also_1worldsync'));
