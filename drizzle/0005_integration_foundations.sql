CREATE TABLE "invoice_documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"provider" varchar(50) NOT NULL,
	"document_type" varchar(50) NOT NULL,
	"provider_document_id" varchar(255),
	"document_number" varchar(100),
	"series" varchar(50),
	"status" varchar(50) DEFAULT 'pending' NOT NULL,
	"issued_at" timestamp,
	"document_reference" varchar(500),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_attempts" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"provider" varchar(50) NOT NULL,
	"method" varchar(50) NOT NULL,
	"status" varchar(50) DEFAULT 'pending' NOT NULL,
	"provider_reference" varchar(255),
	"amount_cents" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'EUR' NOT NULL,
	"failure_reason" varchar(255),
	"expires_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_webhook_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider" varchar(50) NOT NULL,
	"provider_event_id" varchar(255),
	"payload_hash" varchar(64) NOT NULL,
	"event_type" varchar(100),
	"status" varchar(50) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb,
	"last_error" text,
	"received_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp,
	"failed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"provider" varchar(50) NOT NULL,
	"service" varchar(100),
	"provider_shipment_id" varchar(255),
	"tracking_number" varchar(255),
	"status" varchar(50) DEFAULT 'pending' NOT NULL,
	"label_reference" varchar(500),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invoice_documents" ADD CONSTRAINT "invoice_documents_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoice_documents_order_idx" ON "invoice_documents" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "invoice_documents_status_idx" ON "invoice_documents" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_documents_provider_document_unique" ON "invoice_documents" USING btree ("provider","provider_document_id") WHERE provider_document_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "pa_order_idx" ON "payment_attempts" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "pa_status_idx" ON "payment_attempts" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "pa_provider_reference_unique" ON "payment_attempts" USING btree ("provider","provider_reference") WHERE provider_reference IS NOT NULL;--> statement-breakpoint
CREATE INDEX "pwe_provider_idx" ON "provider_webhook_events" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "pwe_status_idx" ON "provider_webhook_events" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "pwe_provider_event_unique" ON "provider_webhook_events" USING btree ("provider","provider_event_id") WHERE provider_event_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "pwe_provider_payload_hash_unique" ON "provider_webhook_events" USING btree ("provider","payload_hash") WHERE provider_event_id IS NULL;--> statement-breakpoint
CREATE INDEX "shipments_order_idx" ON "shipments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "shipments_status_idx" ON "shipments" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "shipments_provider_shipment_unique" ON "shipments" USING btree ("provider","provider_shipment_id") WHERE provider_shipment_id IS NOT NULL;