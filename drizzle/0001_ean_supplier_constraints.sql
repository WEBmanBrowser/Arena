-- B.1.2: EAN unique, product+supplier unique, preferred supplier partial unique

CREATE UNIQUE INDEX IF NOT EXISTS "products_ean_unique" ON "products" ("ean") WHERE "ean" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ps_product_supplier_unique" ON "product_suppliers" ("product_id", "supplier_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ps_preferred_unique" ON "product_suppliers" ("product_id") WHERE "is_preferred" = true;
