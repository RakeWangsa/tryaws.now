CREATE FUNCTION tc_reject_append_only_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'R5: % is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER r5_append_only_row BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION tc_reject_append_only_change();
--> statement-breakpoint
CREATE TRIGGER r5_append_only_truncate BEFORE TRUNCATE ON ledger_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION tc_reject_append_only_change();
--> statement-breakpoint
CREATE TRIGGER r5_append_only_row BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION tc_reject_append_only_change();
--> statement-breakpoint
CREATE TRIGGER r5_append_only_truncate BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION tc_reject_append_only_change();
--> statement-breakpoint
CREATE TRIGGER r5_append_only_row BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION tc_reject_append_only_change();
--> statement-breakpoint
CREATE TRIGGER r5_append_only_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION tc_reject_append_only_change();
--> statement-breakpoint
CREATE TRIGGER r5_append_only_row BEFORE UPDATE OR DELETE ON legal_acceptances
  FOR EACH ROW EXECUTE FUNCTION tc_reject_append_only_change();
--> statement-breakpoint
CREATE TRIGGER r5_append_only_truncate BEFORE TRUNCATE ON legal_acceptances
  FOR EACH STATEMENT EXECUTE FUNCTION tc_reject_append_only_change();
--> statement-breakpoint
CREATE TRIGGER r5_append_only_row BEFORE UPDATE OR DELETE ON fx_rates
  FOR EACH ROW EXECUTE FUNCTION tc_reject_append_only_change();
--> statement-breakpoint
CREATE TRIGGER r5_append_only_truncate BEFORE TRUNCATE ON fx_rates
  FOR EACH STATEMENT EXECUTE FUNCTION tc_reject_append_only_change();
--> statement-breakpoint
CREATE TRIGGER r5_append_only_row BEFORE UPDATE OR DELETE ON pricing_rules
  FOR EACH ROW EXECUTE FUNCTION tc_reject_append_only_change();
--> statement-breakpoint
CREATE TRIGGER r5_append_only_truncate BEFORE TRUNCATE ON pricing_rules
  FOR EACH STATEMENT EXECUTE FUNCTION tc_reject_append_only_change();
--> statement-breakpoint
CREATE FUNCTION tc_check_ledger_balanced() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE txid uuid;
BEGIN
  IF TG_TABLE_NAME = 'ledger_entries' THEN txid := NEW.transaction_id; ELSE txid := NEW.id; END IF;
  IF NOT EXISTS (SELECT 1 FROM ledger_entries WHERE transaction_id = txid AND direction = 'debit')
     OR NOT EXISTS (SELECT 1 FROM ledger_entries WHERE transaction_id = txid AND direction = 'credit')
     OR EXISTS (
       SELECT 1 FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
       WHERE e.transaction_id = txid
       GROUP BY a.currency
       HAVING sum(CASE e.direction WHEN 'debit' THEN e.amount_minor ELSE -e.amount_minor END) <> 0)
  THEN
    RAISE EXCEPTION 'ledger transaction % is not balanced', txid USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tc_check_ledger_balanced();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_transactions_balanced AFTER INSERT ON ledger_transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tc_check_ledger_balanced();
--> statement-breakpoint
CREATE FUNCTION tc_reject_needs_approval_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.needs_approval IS DISTINCT FROM OLD.needs_approval THEN
    RAISE EXCEPTION 'R13: operations.needs_approval cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER r13_needs_approval_fixed BEFORE UPDATE ON operations
  FOR EACH ROW EXECUTE FUNCTION tc_reject_needs_approval_change();
