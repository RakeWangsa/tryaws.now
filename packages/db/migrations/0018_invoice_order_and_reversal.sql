-- WPU-I5: order and honesty of the invoice queue. Forward-only; no table or column changes, only grants and
-- one function. Migrations 0016 and 0017 are untouched.
--
-- 1. The invoice records the instant it was issued, and the fiscal year is derived from that same instant
--    (the caller passes one `at`): web_rw and worker_rw may insert issued_at. Before this the fiscal year came
--    from the application clock and the printed date from the database default, which can differ across the
--    Dhaka midnight of 30 June / 1 July.
GRANT INSERT (issued_at) ON invoices TO web_rw;
--> statement-breakpoint
GRANT INSERT (issued_at) ON invoices TO worker_rw;
--> statement-breakpoint
-- 2. The scheduler closes a queue row whose charge was reversed (no invoice is owed for money that went back)
--    and resolves its own marker rows. Only the status column; the details of a row stay as written.
GRANT UPDATE (status) ON discrepancies TO worker_rw;
--> statement-breakpoint
-- 3. A new charge must not take a number before an older charge that is still waiting for the seller
--    details. web_rw cannot read `discrepancies` (it holds every customer's charges), so the live path asks
--    this function, which answers one boolean and exposes no row: is any older charge of the market of this
--    customer still owed an invoice (queued, no invoice, not closed, not reversed)? A row that cannot be
--    read has no customerId and does not count (the scheduler marks it). Compared as text, so a corrupt
--    value never raises a cast error in the path of a payment.
CREATE FUNCTION invoice_backlog_blocked(p_customer uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1
    FROM discrepancies d
    JOIN customers c ON c.id::text = d.details->>'customerId'
    WHERE d.kind = 'missing'
      AND d.details->>'source' = 'invoice_seller_missing'
      AND c.market = (SELECT m.market FROM customers m WHERE m.id = p_customer)
      AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.ledger_transaction_id::text = d.details->>'ledgerTransactionId')
      AND NOT EXISTS (SELECT 1 FROM discrepancies k
                       WHERE k.details->>'source' = 'invoice_backlog_mark'
                         AND k.details->>'for' = d.id::text
                         AND k.details->>'state' IN ('resolved', 'skipped'))
      AND NOT EXISTS (SELECT 1 FROM ledger_transactions r
                       WHERE r.kind = 'reversal' AND r.reference_type = 'ledger_transaction'
                         AND r.reference_id::text = d.details->>'ledgerTransactionId')
  )
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION invoice_backlog_blocked(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION invoice_backlog_blocked(uuid) TO web_rw, worker_rw;
