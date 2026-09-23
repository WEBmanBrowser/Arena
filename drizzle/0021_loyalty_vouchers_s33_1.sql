CREATE TABLE "loyalty_vouchers" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" integer NOT NULL,
  "code" varchar(32) NOT NULL,
  "points" integer NOT NULL,
  "value_cents" integer NOT NULL,
  "status" varchar(20) DEFAULT 'active' NOT NULL,
  "reserved_order_id" integer,
  "used_order_id" integer,
  "reserved_at" timestamp,
  "used_at" timestamp,
  "cancelled_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "loyalty_vouchers_points_positive" CHECK ("loyalty_vouchers"."points" > 0),
  CONSTRAINT "loyalty_vouchers_points_whole_euro" CHECK ("loyalty_vouchers"."points" % 100 = 0),
  CONSTRAINT "loyalty_vouchers_value_positive" CHECK ("loyalty_vouchers"."value_cents" > 0),
  CONSTRAINT "loyalty_vouchers_value_matches_points" CHECK ("loyalty_vouchers"."value_cents" = "loyalty_vouchers"."points"),
  CONSTRAINT "loyalty_vouchers_status_valid" CHECK ("loyalty_vouchers"."status" IN ('active','reserved','used','cancelled')),
  CONSTRAINT "loyalty_vouchers_state_consistent" CHECK (
    ("loyalty_vouchers"."status" = 'active' AND "loyalty_vouchers"."reserved_order_id" IS NULL AND "loyalty_vouchers"."used_order_id" IS NULL) OR
    ("loyalty_vouchers"."status" = 'reserved' AND "loyalty_vouchers"."reserved_order_id" IS NOT NULL AND "loyalty_vouchers"."used_order_id" IS NULL) OR
    ("loyalty_vouchers"."status" = 'used' AND "loyalty_vouchers"."reserved_order_id" IS NULL AND "loyalty_vouchers"."used_order_id" IS NOT NULL) OR
    ("loyalty_vouchers"."status" = 'cancelled' AND "loyalty_vouchers"."reserved_order_id" IS NULL AND "loyalty_vouchers"."used_order_id" IS NULL)
  )
);
--> statement-breakpoint
ALTER TABLE "loyalty_vouchers" ADD CONSTRAINT "loyalty_vouchers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "loyalty_vouchers" ADD CONSTRAINT "loyalty_vouchers_reserved_order_id_orders_id_fk" FOREIGN KEY ("reserved_order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "loyalty_vouchers" ADD CONSTRAINT "loyalty_vouchers_used_order_id_orders_id_fk" FOREIGN KEY ("used_order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "loyalty_vouchers_code_unique" ON "loyalty_vouchers" USING btree ("code");
--> statement-breakpoint
CREATE INDEX "loyalty_vouchers_user_idx" ON "loyalty_vouchers" USING btree ("user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "loyalty_vouchers_reserved_order_unique" ON "loyalty_vouchers" USING btree ("reserved_order_id") WHERE "reserved_order_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "loyalty_vouchers_used_order_unique" ON "loyalty_vouchers" USING btree ("used_order_id") WHERE "used_order_id" IS NOT NULL;
