ALTER TABLE "orders" ADD COLUMN "coupon_discount" decimal(10,2) DEFAULT '0.00' NOT NULL;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "loyalty_discount" decimal(10,2) DEFAULT '0.00' NOT NULL;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "loyalty_type" varchar(20);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "loyalty_points" integer;
--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_loyalty_type_valid" CHECK ("orders"."loyalty_type" IS NULL OR "orders"."loyalty_type" IN ('voucher','points'));
--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_loyalty_points_valid" CHECK (("orders"."loyalty_type" IS NULL AND "orders"."loyalty_points" IS NULL) OR ("orders"."loyalty_type" IS NOT NULL AND "orders"."loyalty_points" IS NOT NULL AND "orders"."loyalty_points" > 0 AND "orders"."loyalty_points" % 100 = 0));
--> statement-breakpoint
CREATE TABLE "loyalty_point_reservations" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" integer NOT NULL,
  "order_id" integer NOT NULL,
  "points" integer NOT NULL,
  "value_cents" integer NOT NULL,
  "status" varchar(20) DEFAULT 'reserved' NOT NULL,
  "reserved_at" timestamp DEFAULT now() NOT NULL,
  "consumed_at" timestamp,
  "released_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "loyalty_point_reservations_points_positive" CHECK ("loyalty_point_reservations"."points" > 0),
  CONSTRAINT "loyalty_point_reservations_points_whole_euro" CHECK ("loyalty_point_reservations"."points" % 100 = 0),
  CONSTRAINT "loyalty_point_reservations_value_matches_points" CHECK ("loyalty_point_reservations"."value_cents" = "loyalty_point_reservations"."points"),
  CONSTRAINT "loyalty_point_reservations_status_valid" CHECK ("loyalty_point_reservations"."status" IN ('reserved','used','released')),
  CONSTRAINT "loyalty_point_reservations_state_consistent" CHECK (("loyalty_point_reservations"."status" = 'reserved' AND "loyalty_point_reservations"."consumed_at" IS NULL AND "loyalty_point_reservations"."released_at" IS NULL) OR ("loyalty_point_reservations"."status" = 'used' AND "loyalty_point_reservations"."consumed_at" IS NOT NULL AND "loyalty_point_reservations"."released_at" IS NULL) OR ("loyalty_point_reservations"."status" = 'released' AND "loyalty_point_reservations"."consumed_at" IS NULL AND "loyalty_point_reservations"."released_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "loyalty_point_reservations" ADD CONSTRAINT "loyalty_point_reservations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "loyalty_point_reservations" ADD CONSTRAINT "loyalty_point_reservations_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "loyalty_point_reservations_order_unique" ON "loyalty_point_reservations" USING btree ("order_id");
--> statement-breakpoint
CREATE INDEX "loyalty_point_reservations_user_status_idx" ON "loyalty_point_reservations" USING btree ("user_id","status");
