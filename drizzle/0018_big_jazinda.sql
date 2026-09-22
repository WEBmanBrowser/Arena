CREATE TABLE "order_item_stock_allocations" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_item_id" integer NOT NULL,
	"allocation_type" varchar(20) NOT NULL,
	"product_supplier_id" integer,
	"quantity" integer NOT NULL,
	"status" varchar(20) DEFAULT 'reserved' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "oisa_quantity_positive" CHECK ("order_item_stock_allocations"."quantity" > 0),
	CONSTRAINT "oisa_status_valid" CHECK ("order_item_stock_allocations"."status" IN ('reserved','committed','released','fulfilled')),
	CONSTRAINT "oisa_allocation_type_valid" CHECK ("order_item_stock_allocations"."allocation_type" IN ('local','supplier')),
	CONSTRAINT "oisa_supplier_link_valid" CHECK (("order_item_stock_allocations"."allocation_type" = 'local' AND "order_item_stock_allocations"."product_supplier_id" IS NULL) OR ("order_item_stock_allocations"."allocation_type" = 'supplier' AND "order_item_stock_allocations"."product_supplier_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "product_suppliers" ADD COLUMN "supplier_reserved_stock" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "order_item_stock_allocations" ADD CONSTRAINT "order_item_stock_allocations_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_stock_allocations" ADD CONSTRAINT "order_item_stock_allocations_product_supplier_id_product_suppliers_id_fk" FOREIGN KEY ("product_supplier_id") REFERENCES "public"."product_suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oisa_order_item_idx" ON "order_item_stock_allocations" USING btree ("order_item_id");--> statement-breakpoint
CREATE INDEX "oisa_product_supplier_idx" ON "order_item_stock_allocations" USING btree ("product_supplier_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oisa_local_unique" ON "order_item_stock_allocations" USING btree ("order_item_id") WHERE allocation_type = 'local';--> statement-breakpoint
CREATE UNIQUE INDEX "oisa_supplier_unique" ON "order_item_stock_allocations" USING btree ("order_item_id","product_supplier_id") WHERE allocation_type = 'supplier';--> statement-breakpoint
ALTER TABLE "product_suppliers" ADD CONSTRAINT "ps_supplier_reserved_stock_non_negative" CHECK ("product_suppliers"."supplier_reserved_stock" >= 0);