CREATE TABLE "shipping_classes" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" varchar(50) NOT NULL,
	"display_name" varchar(100) NOT NULL,
	"rate_cents" integer NOT NULL,
	"priority" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "shipping_classes_key_unique" UNIQUE("key"),
	CONSTRAINT "shipping_classes_key_format" CHECK ("shipping_classes"."key" ~ '^[a-z0-9][a-z0-9_-]{0,49}$'),
	CONSTRAINT "shipping_classes_rate_non_negative" CHECK ("shipping_classes"."rate_cents" >= 0),
	CONSTRAINT "shipping_classes_priority_non_negative" CHECK ("shipping_classes"."priority" >= 0)
);
--> statement-breakpoint
INSERT INTO "shipping_classes" ("key", "display_name", "rate_cents", "priority", "is_active", "notes") VALUES
  ('small', 'Pequeno', 490, 10, true, 'Classe inicial para produtos pequenos'),
  ('large', 'Grande', 790, 20, true, 'Classe inicial para produtos grandes')
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "settings" ("key", "value", "group") VALUES
  ('shipping_free_threshold_enabled', 'true', 'shipping'),
  ('shipping_free_threshold_cents', '10000', 'shipping'),
  ('invoice_mode', 'manual', 'invoicing')
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
ALTER TABLE "invoice_documents" ADD COLUMN "amount_cents" integer;--> statement-breakpoint
ALTER TABLE "invoice_documents" ADD COLUMN "currency" varchar(3) DEFAULT 'EUR' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_documents" ADD COLUMN "source" varchar(50) DEFAULT 'provider' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_documents" ADD COLUMN "original_document_id" integer;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "shipping_class_id" integer;--> statement-breakpoint
CREATE INDEX "shipping_classes_active_idx" ON "shipping_classes" USING btree ("is_active");--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_shipping_class_id_shipping_classes_id_fk" FOREIGN KEY ("shipping_class_id") REFERENCES "public"."shipping_classes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
UPDATE "products" SET "shipping_class_id" = (SELECT "id" FROM "shipping_classes" WHERE "key" = 'small') WHERE "shipping_class_id" IS NULL AND "is_service" = false;
--> statement-breakpoint
CREATE INDEX "invoice_documents_original_idx" ON "invoice_documents" USING btree ("original_document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_documents_one_manual_invoice_per_order" ON "invoice_documents" USING btree ("order_id","source","document_type") WHERE source = 'manual' AND document_type = 'invoice';--> statement-breakpoint
CREATE INDEX "products_shipping_class_idx" ON "products" USING btree ("shipping_class_id");--> statement-breakpoint
ALTER TABLE "invoice_documents" ADD CONSTRAINT "invoice_documents_amount_non_negative" CHECK (amount_cents IS NULL OR amount_cents >= 0);--> statement-breakpoint
ALTER TABLE "invoice_documents" ADD CONSTRAINT "invoice_documents_currency_format" CHECK (currency ~ '^[A-Z]{3}$');