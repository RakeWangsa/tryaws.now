-- WPU-C1: the date of supply on the tax invoice (ruling 5) and the credit note (ruling 6). Forward-only; no new
-- table (the baseline pins 37): the credit note is a row of `invoices` with kind 'credit_note'. Migrations 0016
-- to 0018 are untouched.
--
-- 1. supply_at: the instant of the charge (the ledger transaction time). The tax point of the supply. Written by
--    the issue from the ledger transaction in the same statement, never from a clock of the application. NULL on
--    a row issued before this column existed (the reader falls back to the ledger transaction time).
ALTER TABLE "invoices" ADD COLUMN "supply_at" timestamp with time zone;--> statement-breakpoint
-- 2. kind: 'invoice' (Mushak-6.3, every existing row) or 'credit_note' (Mushak-6.7). A credit note names the
--    invoice it credits (original_invoice_id), the reversal transaction it answers (credit_for_ledger_transaction_id,
--    unique: one credit note for each reversal, R7) and the reason. A full credit only: one credit note for each
--    original invoice (the unique key on original_invoice_id); a partial credit note is not built.
ALTER TABLE "invoices" ADD COLUMN "kind" text DEFAULT 'invoice' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "original_invoice_id" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "credit_for_ledger_transaction_id" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_original_invoice_id_invoices_id_fk" FOREIGN KEY ("original_invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_credit_for_ledger_tx_fk" FOREIGN KEY ("credit_for_ledger_transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_original_invoice_id_unique" UNIQUE("original_invoice_id");--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_credit_for_ledger_transaction_id_unique" UNIQUE("credit_for_ledger_transaction_id");--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_kind_check" CHECK ("invoices"."kind" in ('invoice', 'credit_note'));--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_credit_note_check" CHECK (("invoices"."kind" = 'credit_note') = ("invoices"."original_invoice_id" is not null and "invoices"."credit_for_ledger_transaction_id" is not null and "invoices"."reason" is not null) and ("invoices"."kind" = 'credit_note' or ("invoices"."original_invoice_id" is null and "invoices"."credit_for_ledger_transaction_id" is null and "invoices"."reason" is null)));--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_reason_check" CHECK ("invoices"."reason" is null or "invoices"."reason" in ('refund', 'plan_change_not_delivered', 'order_failed'));--> statement-breakpoint
-- 3. Each kind has its own gap-free numbers for each fiscal year: the key (fiscal_year, number) becomes
--    (fiscal_year, kind, number). Every number allocation filters on its kind (repositories/customer/invoices.ts).
ALTER TABLE "invoices" DROP CONSTRAINT "invoices_fiscal_year_number_unique";--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_fiscal_year_kind_number_unique" UNIQUE("fiscal_year","kind","number");--> statement-breakpoint
-- 4. Grants. supply_at is written by both issuing roles (as issued_at in 0018). The credit note is issued by the
--    scheduler only (worker_rw): the web role never writes the other columns.
GRANT INSERT (supply_at) ON invoices TO web_rw;--> statement-breakpoint
GRANT INSERT (supply_at, kind, original_invoice_id, credit_for_ledger_transaction_id, reason) ON invoices TO worker_rw;
