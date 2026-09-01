CREATE TABLE "reconciliation_observations" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"provider" varchar(30) NOT NULL,
	"provider_reference" varchar(255),
	"observed_paid_cents" integer NOT NULL,
	"observed_refunded_cents" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'EUR' NOT NULL,
	"observed_at" timestamp NOT NULL,
	"expected_paid_cents" integer NOT NULL,
	"internal_refunded_cents" integer NOT NULL,
	"anomaly_code" varchar(40),
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"recorded_by" integer NOT NULL,
	"resolved_by" integer,
	"resolved_at" timestamp,
	"resolution_note" varchar(500),
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "reconciliation_observed_non_negative" CHECK ("reconciliation_observations"."observed_paid_cents" >= 0 AND "reconciliation_observations"."observed_refunded_cents" >= 0),
	CONSTRAINT "reconciliation_currency_format" CHECK ("reconciliation_observations"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "refund_attempts" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"payment_id" integer NOT NULL,
	"provider" varchar(30) NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"provider_refund_id" varchar(255),
	"amount_cents" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'EUR' NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"reason" varchar(500),
	"error_code" varchar(60),
	"error_message" varchar(500),
	"requested_by" integer NOT NULL,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "refund_attempts_amount_positive" CHECK ("refund_attempts"."amount_cents" > 0),
	CONSTRAINT "refund_attempts_currency_format" CHECK ("refund_attempts"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
ALTER TABLE "reconciliation_observations" ADD CONSTRAINT "reconciliation_observations_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_observations" ADD CONSTRAINT "reconciliation_observations_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_attempts" ADD CONSTRAINT "refund_attempts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_attempts" ADD CONSTRAINT "refund_attempts_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_attempts" ADD CONSTRAINT "refund_attempts_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reconciliation_observations_order_idx" ON "reconciliation_observations" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "reconciliation_observations_status_idx" ON "reconciliation_observations" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "reconciliation_observations_reference_unique" ON "reconciliation_observations" USING btree ("provider","provider_reference") WHERE provider_reference IS NOT NULL;--> statement-breakpoint
CREATE INDEX "refund_attempts_order_idx" ON "refund_attempts" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "refund_attempts_payment_idx" ON "refund_attempts" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "refund_attempts_status_idx" ON "refund_attempts" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "refund_attempts_idempotency_key_unique" ON "refund_attempts" USING btree ("idempotency_key");--> statement-breakpoint

-- ─── B.3.5: OVER-REFUND GUARD (database-level invariant) ──
-- For any refund attempt that COMMITTED balance (pending/processing/succeeded),
-- the payment row is locked (FOR UPDATE) and the sum of all committed refunds
-- on that payment is verified against the authoritative paid amount.
-- Currency must also match the payment currency.
-- This makes over-refund impossible even for concurrent transactions that
-- bypass application-level locking.
CREATE OR REPLACE FUNCTION "enforce_refund_balance"() RETURNS trigger AS $$
DECLARE
  paid_cents integer;
  payment_currency varchar(3);
  committed_cents integer;
BEGIN
  SELECT (amount * 100)::integer, currency INTO paid_cents, payment_currency
    FROM payments WHERE id = NEW.payment_id FOR UPDATE;

  IF paid_cents IS NULL THEN
    RAISE EXCEPTION 'REFUND_PAYMENT_NOT_FOUND' USING ERRCODE = '23503';
  END IF;

  IF NEW.currency <> payment_currency THEN
    RAISE EXCEPTION 'REFUND_CURRENCY_MISMATCH' USING ERRCODE = '23514';
  END IF;

  IF NEW.status IN ('pending', 'processing', 'succeeded') THEN
    SELECT COALESCE(SUM(amount_cents), 0)::integer INTO committed_cents
      FROM refund_attempts
      WHERE payment_id = NEW.payment_id
        AND status IN ('pending', 'processing', 'succeeded')
        AND (TG_OP = 'INSERT' OR id <> OLD.id);

    IF committed_cents + NEW.amount_cents > paid_cents THEN
      RAISE EXCEPTION 'REFUND_EXCEEDS_REFUNDABLE_AMOUNT' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "refund_attempts_balance_guard"
  BEFORE INSERT OR UPDATE ON "refund_attempts"
  FOR EACH ROW EXECUTE FUNCTION "enforce_refund_balance"();
