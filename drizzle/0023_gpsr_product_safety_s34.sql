ALTER TABLE "products" ADD COLUMN "gpsr_product_type" varchar(255);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "gpsr_manufacturer_name" varchar(255);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "gpsr_manufacturer_address" text;
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "gpsr_manufacturer_email" varchar(320);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "gpsr_responsible_name" varchar(255);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "gpsr_responsible_address" text;
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "gpsr_responsible_email" varchar(320);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "gpsr_safety_information" text;
