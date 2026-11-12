-- WPU-D3 (audit C.6). Two guards on payments, forward-only.
--
-- (1) One EPS transaction id belongs to one payment. gatewayIdUsedElsewhere of the EPS verifier is a
-- check-then-act; this partial unique index is the last word (a replayed or forged answer cannot take a
-- second payment). A violation inside the credit transaction rolls it back: nothing is credited (R6, R16),
-- and the next sweep sees the id in use and sends the payment to review.
CREATE UNIQUE INDEX "payments_gateway_transaction_id_unique" ON "payments" USING btree ("gateway_transaction_id") WHERE "payments"."gateway_transaction_id" IS NOT NULL;
--> statement-breakpoint
-- (2) The web role updates payments through the EPS return route (the credit: status, gateway id, verify
-- payload, verified_at, ledger id) and through markRedirected and markFailed (status, gateway id). Every
-- one of the five granted columns is written by some path, so the column grant cannot be narrowed without
-- breaking the credit. The narrowing is done on the row instead: a credited payment is final. Its status,
-- ledger transaction, gateway id, verification time and payload cannot change, whatever the role is (R5, R6).
CREATE FUNCTION payments_credited_is_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'credited' AND (
       NEW.status IS DISTINCT FROM OLD.status
    OR NEW.ledger_transaction_id IS DISTINCT FROM OLD.ledger_transaction_id
    OR NEW.gateway_transaction_id IS DISTINCT FROM OLD.gateway_transaction_id
    OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
    OR NEW.verify_payload IS DISTINCT FROM OLD.verify_payload
  ) THEN
    RAISE EXCEPTION 'R5: a credited payment is final' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payments_credited_is_final BEFORE UPDATE ON "payments" FOR EACH ROW EXECUTE FUNCTION payments_credited_is_final();
