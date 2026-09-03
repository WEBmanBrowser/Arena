CREATE TABLE "pricing_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"scope" varchar(20) NOT NULL,
	"product_id" integer,
	"category_id" integer,
	"brand_id" integer,
	"supplier_id" integer,
	"method" varchar(20) NOT NULL,
	"rate_percent" numeric(6, 3) NOT NULL,
	"rounding_policy" varchar(10) DEFAULT 'auto' NOT NULL,
	"min_margin_percent" numeric(6, 3),
	"priority" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_rules_scope_valid" CHECK ("pricing_rules"."scope" IN ('product','category','brand','supplier','global')),
	CONSTRAINT "pricing_rules_method_valid" CHECK ("pricing_rules"."method" IN ('markup_on_cost','margin_on_sale')),
	CONSTRAINT "pricing_rules_rounding_valid" CHECK ("pricing_rules"."rounding_policy" IN ('auto','none','end_90','end_99')),
	CONSTRAINT "pricing_rules_rate_non_negative" CHECK ("pricing_rules"."rate_percent" >= 0),
	CONSTRAINT "pricing_rules_margin_below_100" CHECK ("pricing_rules"."method" <> 'margin_on_sale' OR "pricing_rules"."rate_percent" < 100),
	CONSTRAINT "pricing_rules_priority_non_negative" CHECK ("pricing_rules"."priority" >= 0),
	CONSTRAINT "pricing_rules_target_matches_scope" CHECK (
    ("pricing_rules"."scope" = 'product'  AND "pricing_rules"."product_id" IS NOT NULL AND "pricing_rules"."category_id" IS NULL AND "pricing_rules"."brand_id" IS NULL AND "pricing_rules"."supplier_id" IS NULL) OR
    ("pricing_rules"."scope" = 'category' AND "pricing_rules"."category_id" IS NOT NULL AND "pricing_rules"."product_id" IS NULL AND "pricing_rules"."brand_id" IS NULL AND "pricing_rules"."supplier_id" IS NULL) OR
    ("pricing_rules"."scope" = 'brand'    AND "pricing_rules"."brand_id" IS NOT NULL AND "pricing_rules"."product_id" IS NULL AND "pricing_rules"."category_id" IS NULL AND "pricing_rules"."supplier_id" IS NULL) OR
    ("pricing_rules"."scope" = 'supplier' AND "pricing_rules"."supplier_id" IS NOT NULL AND "pricing_rules"."product_id" IS NULL AND "pricing_rules"."category_id" IS NULL AND "pricing_rules"."brand_id" IS NULL) OR
    ("pricing_rules"."scope" = 'global'   AND "pricing_rules"."product_id" IS NULL AND "pricing_rules"."category_id" IS NULL AND "pricing_rules"."brand_id" IS NULL AND "pricing_rules"."supplier_id" IS NULL)
  )
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "price_mode" varchar(10) DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "price_rule_id" integer;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "price_calculated_at" timestamp;--> statement-breakpoint
ALTER TABLE "pricing_rules" ADD CONSTRAINT "pricing_rules_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_rules" ADD CONSTRAINT "pricing_rules_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_rules" ADD CONSTRAINT "pricing_rules_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_rules" ADD CONSTRAINT "pricing_rules_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pricing_rules_scope_idx" ON "pricing_rules" USING btree ("scope","is_active");--> statement-breakpoint
CREATE INDEX "pricing_rules_product_idx" ON "pricing_rules" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "pricing_rules_category_idx" ON "pricing_rules" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "pricing_rules_brand_idx" ON "pricing_rules" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "pricing_rules_supplier_idx" ON "pricing_rules" USING btree ("supplier_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pricing_rules_active_product_unique" ON "pricing_rules" USING btree ("product_id") WHERE scope = 'product' AND is_active = true;--> statement-breakpoint
CREATE UNIQUE INDEX "pricing_rules_active_category_unique" ON "pricing_rules" USING btree ("category_id") WHERE scope = 'category' AND is_active = true;--> statement-breakpoint
CREATE UNIQUE INDEX "pricing_rules_active_brand_unique" ON "pricing_rules" USING btree ("brand_id") WHERE scope = 'brand' AND is_active = true;--> statement-breakpoint
CREATE UNIQUE INDEX "pricing_rules_active_supplier_unique" ON "pricing_rules" USING btree ("supplier_id") WHERE scope = 'supplier' AND is_active = true;--> statement-breakpoint
CREATE UNIQUE INDEX "pricing_rules_active_global_unique" ON "pricing_rules" USING btree ("scope") WHERE scope = 'global' AND is_active = true;--> statement-breakpoint
CREATE INDEX "products_price_mode_idx" ON "products" USING btree ("price_mode");--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_price_mode_valid" CHECK ("products"."price_mode" IN ('auto','manual'));--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_price_rule_id_pricing_rules_id_fk" FOREIGN KEY ("price_rule_id") REFERENCES "public"."pricing_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Safety backfill: every product that ALREADY EXISTS when this migration runs
-- keeps its human-set price and is marked 'manual'. Without this, the first
-- supplier cost change would silently reprice the whole live catalogue.
-- Products created AFTER this point default to 'auto'.
UPDATE "products" SET "price_mode" = 'manual';
