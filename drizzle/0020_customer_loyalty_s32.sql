CREATE TABLE "loyalty_point_movements" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" integer NOT NULL,
  "order_id" integer,
  "type" varchar(20) NOT NULL,
  "points_delta" integer NOT NULL,
  "eligible_amount_cents" integer,
  "idempotency_key" varchar(160) NOT NULL,
  "reason" varchar(500),
  "actor_user_id" integer,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "loyalty_points_delta_nonzero" CHECK ("loyalty_point_movements"."points_delta" <> 0),
  CONSTRAINT "loyalty_points_eligible_non_negative" CHECK ("loyalty_point_movements"."eligible_amount_cents" IS NULL OR "loyalty_point_movements"."eligible_amount_cents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "loyalty_point_movements" ADD CONSTRAINT "loyalty_point_movements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "loyalty_point_movements" ADD CONSTRAINT "loyalty_point_movements_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "loyalty_point_movements" ADD CONSTRAINT "loyalty_point_movements_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "loyalty_points_user_idx" ON "loyalty_point_movements" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "loyalty_points_order_idx" ON "loyalty_point_movements" USING btree ("order_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "loyalty_points_idempotency_unique" ON "loyalty_point_movements" USING btree ("idempotency_key");
