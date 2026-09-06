CREATE TABLE "supplier_import_profiles" (
	"id" serial PRIMARY KEY NOT NULL,
	"supplier_id" integer NOT NULL,
	"mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"delimiter" varchar(10),
	"created_by" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "supplier_import_profiles" ADD CONSTRAINT "supplier_import_profiles_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_import_profiles" ADD CONSTRAINT "supplier_import_profiles_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sip_supplier_idx" ON "supplier_import_profiles" USING btree ("supplier_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sip_supplier_unique" ON "supplier_import_profiles" USING btree ("supplier_id");