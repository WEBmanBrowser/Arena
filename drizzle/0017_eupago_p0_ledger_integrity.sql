-- ─────────────────────────────────────────────────────────────────────────────
-- PAYMENT P0 (Eupago) — LEDGER INTEGRITY, VERSIONED MIGRATION 0017
--
-- ADDITIVE ONLY. No DROP. NO automatic financial backfill.
--
-- What this migration does
--   • payment_attempts.payment_id          → canonical orders → payments →
--                                            payment_attempts linkage (item 1/4)
--   • payment_attempts.operation_revision / refund_attempts.operation_revision
--                                          → fencing against stale provider
--                                            responses (item 2/16)
--   • email_notifications.dispatch_started_at → post-commit outbox fencing
--                                            (item 3/20/M5)
--   • composite FKs (payment_id, order_id) → payments(id, order_id) for both
--     payment_attempts and refund_attempts (items 5/6). MATCH SIMPLE means a
--     legacy row with payment_id IS NULL is not checked, so historical rows are
--     preserved exactly as they are.
--   • identity / snapshot / refund guards (item 7) + the M2 trigger that closes
--     "non-Eupago row updated into a Eupago row with a NULL payment_id", plus the
--     L3 guard that makes a non-null canonical linkage IMMUTABLE.
--   • reconciliation_observations.payment_id + nullable recorded_by: durable,
--     operator-visible anomalies raised by the settlement pipeline (HIGH-1/HIGH-2
--     — double charge, late payment, incoherent canonical payment).
--
-- ROLLOUT (B1) — see docs/integrations/eupago-p0-rollout.md
--   This migration is only installed on a VIRGIN EUPAGO LEDGER, verified by a
--   READ-ONLY diagnostic BEFORE deploy. It is NOT installed with `db:push`.
--   If the diagnostic reports any existing Eupago attempt/refund/webhook/
--   payment context or any in-flight Eupago operation, the rollout STOPS and a
--   separate compatibility/backfill/cutover plan is required.
--
-- No column is dropped, no row is rewritten, no existing value is
-- reinterpreted, and no historical row is given a payment_id automatically.
-- ─────────────────────────────────────────────────────────────────────────────

-- The FK target for the composite references below must exist first.
CREATE UNIQUE INDEX "payments_id_order_unique" ON "payments" USING btree ("id","order_id");--> statement-breakpoint
ALTER TABLE "email_notifications" ADD COLUMN "dispatch_started_at" timestamp;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD COLUMN "payment_id" integer;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD COLUMN "operation_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "refund_attempts" ADD COLUMN "operation_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "pa_payment_idx" ON "payment_attempts" USING btree ("payment_id");--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_payment_order_fk" FOREIGN KEY ("payment_id","order_id") REFERENCES "public"."payments"("id","order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_attempts" ADD CONSTRAINT "refund_attempts_payment_order_fk" FOREIGN KEY ("payment_id","order_id") REFERENCES "public"."payments"("id","order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- ─── PAYMENT P0 item 7 / M2: payment_attempts identity + snapshot guard ──────
-- IDENTITY
--   A real provider attempt (eupago) must carry the canonical payment it settles.
--   INSERT with a NULL payment_id  → rejected.
--   UPDATE that turns a row INTO a Eupago row with a NULL payment_id → rejected
--   (this is the M2 hole: legacy/other-provider row + payment_id NULL + UPDATE
--   provider = 'eupago' would otherwise mint an uncorrelated financial row).
--   LEGACY EXCEPTION: only a row that ALREADY was Eupago AND ALREADY had
--   payment_id IS NULL may be updated while keeping NULL — its historical
--   identity is never rewritten and no automatic backfill is performed.
-- SNAPSHOT
--   A linked attempt must agree with its canonical payment on order, integer
--   amount and currency. This makes "attempt says 10.00, payment says 100.00"
--   impossible at the PostgreSQL level, not just in service code.
CREATE OR REPLACE FUNCTION "enforce_payment_attempt_identity"() RETURNS trigger AS $$
DECLARE
  payment_amount_cents integer;
  payment_currency varchar(3);
  payment_order_id integer;
BEGIN
  IF NEW.provider = 'eupago' AND NEW.payment_id IS NULL THEN
    IF TG_OP = 'UPDATE'
       AND OLD.provider = 'eupago'
       AND OLD.payment_id IS NULL
       AND NEW.provider = OLD.provider THEN
      RETURN NEW; -- legacy Eupago row: preserved, never retro-linked automatically
    END IF;
    RAISE EXCEPTION 'PAYMENT_ATTEMPT_EUPAGO_PAYMENT_REQUIRED' USING ERRCODE = '23514';
  END IF;

  -- L3/G4 — LINKAGE IMMUTABILITY. Once an attempt is bound to a canonical
  -- payment it may never be re-pointed: without this guard a linked attempt could
  -- be moved to ANOTHER payment of the same order that happens to share amount
  -- and currency, silently detaching the two records that a later refund
  -- correlates against. The only tolerated transition is
  -- payment_id NULL → a specific payment (explicit, controlled backfill of a
  -- historical row — never automatic); NULL → NULL stays the legacy exception.
  IF TG_OP = 'UPDATE' AND OLD.payment_id IS NOT NULL AND NEW.payment_id IS DISTINCT FROM OLD.payment_id THEN
    RAISE EXCEPTION 'PAYMENT_ATTEMPT_PAYMENT_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF NEW.payment_id IS NOT NULL THEN
    SELECT (amount * 100)::integer, currency, order_id
      INTO payment_amount_cents, payment_currency, payment_order_id
      FROM payments WHERE id = NEW.payment_id;

    IF payment_amount_cents IS NULL THEN
      RAISE EXCEPTION 'PAYMENT_ATTEMPT_PAYMENT_NOT_FOUND' USING ERRCODE = '23503';
    END IF;

    IF payment_order_id <> NEW.order_id THEN
      RAISE EXCEPTION 'PAYMENT_ATTEMPT_ORDER_MISMATCH' USING ERRCODE = '23514';
    END IF;

    IF payment_amount_cents <> NEW.amount_cents OR payment_currency <> NEW.currency THEN
      RAISE EXCEPTION 'PAYMENT_ATTEMPT_SNAPSHOT_MISMATCH' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "payment_attempts_identity_guard"
  BEFORE INSERT OR UPDATE ON "payment_attempts"
  FOR EACH ROW EXECUTE FUNCTION "enforce_payment_attempt_identity"();--> statement-breakpoint

-- ─── PAYMENT P0 HIGH-1/HIGH-2: operability of anomalies raised by settlement ──
-- A Paid movement that cannot be settled coherently (second movement for an
-- already settled order, payment after expiry/cancellation, missing/incoherent
-- canonical payment) must be recorded as a DURABLE anomaly instead of being
-- silently marked processed.
--   • `payment_id`   → keeps the canonical payment visible so a later
--                      refund/reconciliation stays bound to the right payment.
--   • `recorded_by`  → becomes NULLABLE: a system-observed anomaly has no human
--                      operator behind it (operator-ingested rows keep their id).
ALTER TABLE "reconciliation_observations" ADD COLUMN "payment_id" integer;--> statement-breakpoint
ALTER TABLE "reconciliation_observations" ALTER COLUMN "recorded_by" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX "reconciliation_observations_payment_idx" ON "reconciliation_observations" USING btree ("payment_id");--> statement-breakpoint
ALTER TABLE "reconciliation_observations" ADD CONSTRAINT "reconciliation_observations_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- ─── PAYMENT P0 item 7 / 23: refund_attempts binding + transmission guard ────
-- BINDING
--   A PROVIDER refund (provider = 'eupago') must be attached to the CANONICAL
--   provider payment (payments.provider = 'eupago'). A provider refund attached
--   to a manual payment could not be correlated with a provider movement.
--   The opposite direction stays allowed by design: an operator may legitimately
--   refund a provider-paid order by bank transfer (provider = 'manual').
-- TRANSMISSION
--   A Eupago refund may only transition INTO recovery_state = 'requested' (the
--   state that authorizes the single HTTP call to the provider) when the
--   ORIGINAL payment movement (originalTrid) is already persisted. Without it
--   the refund would be sent with no correlation anchor.
CREATE OR REPLACE FUNCTION "enforce_refund_payment_binding"() RETURNS trigger AS $$
DECLARE
  payment_provider varchar(50);
BEGIN
  SELECT provider INTO payment_provider FROM payments WHERE id = NEW.payment_id;

  IF payment_provider IS NULL THEN
    RAISE EXCEPTION 'REFUND_PAYMENT_NOT_FOUND' USING ERRCODE = '23503';
  END IF;

  IF NEW.provider = 'eupago' AND payment_provider <> 'eupago' THEN
    RAISE EXCEPTION 'REFUND_PAYMENT_PROVIDER_MISMATCH' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.provider = 'eupago'
     AND NEW.recovery_state = 'requested'
     AND OLD.recovery_state IS DISTINCT FROM 'requested'
     AND NEW.provider_original_transaction_id IS NULL THEN
    RAISE EXCEPTION 'REFUND_ORIGINAL_MOVEMENT_REQUIRED' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "refund_attempts_payment_binding_guard"
  BEFORE INSERT OR UPDATE ON "refund_attempts"
  FOR EACH ROW EXECUTE FUNCTION "enforce_refund_payment_binding"();
