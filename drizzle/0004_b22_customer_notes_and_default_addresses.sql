CREATE TABLE "customer_notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"author_user_id" integer NOT NULL,
	"note" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "addresses" ADD COLUMN "is_default_billing" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "addresses" ADD COLUMN "is_default_shipping" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_notes" ADD CONSTRAINT "customer_notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_notes" ADD CONSTRAINT "customer_notes_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_notes_user_idx" ON "customer_notes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "customer_notes_author_idx" ON "customer_notes" USING btree ("author_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "addresses_default_billing_unique" ON "addresses" USING btree ("user_id") WHERE is_default_billing = true;--> statement-breakpoint
CREATE UNIQUE INDEX "addresses_default_shipping_unique" ON "addresses" USING btree ("user_id") WHERE is_default_shipping = true;