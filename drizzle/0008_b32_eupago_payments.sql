ALTER TABLE "payment_attempts" ADD COLUMN "provider_identifier" varchar(64);--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD COLUMN "provider_transaction_id" varchar(64);--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD COLUMN "provider_entity" varchar(20);--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD COLUMN "recovery_state" varchar(30);--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD COLUMN "operator_action_code" varchar(60);--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD COLUMN "provider_requested_at" timestamp;--> statement-breakpoint
ALTER TABLE "refund_attempts" ADD COLUMN "provider_original_transaction_id" varchar(64);--> statement-breakpoint
ALTER TABLE "refund_attempts" ADD COLUMN "recovery_state" varchar(30);--> statement-breakpoint
ALTER TABLE "refund_attempts" ADD COLUMN "operator_action_code" varchar(60);--> statement-breakpoint
ALTER TABLE "refund_attempts" ADD COLUMN "provider_requested_at" timestamp;--> statement-breakpoint
CREATE UNIQUE INDEX "pa_provider_identifier_unique" ON "payment_attempts" USING btree ("provider","provider_identifier") WHERE provider_identifier IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "pa_provider_transaction_unique" ON "payment_attempts" USING btree ("provider","provider_transaction_id") WHERE provider_transaction_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "refund_attempts_provider_refund_unique" ON "refund_attempts" USING btree ("provider","provider_refund_id") WHERE provider_refund_id IS NOT NULL AND provider <> 'manual';