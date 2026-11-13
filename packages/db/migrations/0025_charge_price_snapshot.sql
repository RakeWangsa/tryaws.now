-- WPU-Y2: the exact price inputs of every charge, saved with the charge. Forward-only; no new table (the baseline
-- pins 37): one nullable column on the ledger transaction that took the money. The value is the ChargeSnapshot of
-- @tc/core (schemaVersion 1: USD price, exchange rate with its id and effective time, rule and markup, rounding, the
-- BDT amounts). It is written by the INSERT of the header, in the same transaction as the postings; the ledger is
-- append-only (trigger r5_append_only_row), so it can never be changed afterwards. NULL means a charge from before
-- this column (legacy: invoices render from the lines stored with them) or a kind that is not a sale.
-- The table-level INSERT grants of 0006 already cover the new column. Migrations 0006 and 0024 are untouched.
ALTER TABLE "ledger_transactions" ADD COLUMN "price_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_price_snapshot_check" CHECK ("ledger_transactions"."price_snapshot" IS NULL OR (jsonb_typeof("ledger_transactions"."price_snapshot") = 'object' AND "ledger_transactions"."kind" IN ('purchase', 'renewal', 'metered_charge')));
