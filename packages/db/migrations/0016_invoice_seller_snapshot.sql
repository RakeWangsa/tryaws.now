-- WPU-I2: a legal document does not change on a reprint, and every charge has one invoice.
-- (1) invoices.seller: the seller details (the setting invoice_seller) as they were on the day of issue,
--     written by invoices.issue in the same transaction. A row issued before this column existed has
--     NULL and is never printed (the readers fail closed).
-- (2) invoices.ledger_transaction_id: the money transaction of the charge (a purchase or a renewal),
--     unique: one invoice for each charge (R7). A renewal has no order, so this is its reference.
-- No new table: the spec has 37 tables. A charge whose invoice waits for the seller details is a row of
-- `discrepancies` (kind missing, details.source invoice_seller_missing), which web_rw and worker_rw
-- already may insert and the admin queue already shows.
-- Forward-only. The grants add two columns to the insert grants of 0006; 0006 is not changed.
ALTER TABLE "invoices" ADD COLUMN "seller" jsonb;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "ledger_transaction_id" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_ledger_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("ledger_transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_ledger_transaction_id_unique" UNIQUE("ledger_transaction_id");--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_seller_check" CHECK ("invoices"."seller" IS NULL OR jsonb_typeof("invoices"."seller") = 'object');
--> statement-breakpoint
GRANT INSERT (seller, ledger_transaction_id) ON invoices TO web_rw;--> statement-breakpoint
GRANT INSERT (seller, ledger_transaction_id) ON invoices TO worker_rw;
