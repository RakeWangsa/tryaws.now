-- WPU-Y9: a sale row can never be saved without its price inputs. Forward-only; 0025 is untouched.
-- Since WPU-Y2 the code writes a price_snapshot with every purchase, renewal and metered_charge (checkPosting refuses a sale
-- without one, R16). This is the same rule in the database, so no other writer can break it. NOT VALID: the rows that were
-- written before the snapshot existed stay as they are (the ledger is append-only, R5, they cannot be changed), and every
-- NEW row is checked at once. The invoice code reads a legacy row by the lines stored with it, never by recalculation.
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_sale_snapshot_check" CHECK ("ledger_transactions"."kind" NOT IN ('purchase', 'renewal', 'metered_charge') OR "ledger_transactions"."price_snapshot" IS NOT NULL) NOT VALID;
--> statement-breakpoint
-- WPU-Y9 (finding 2): the freshness of a USD to BDT rate is measured from the moment it was ENTERED (created_at), not from
-- the start it names, so a rate scheduled ahead cannot price for longer than 7 days from its entry. The two roles that price
-- (web_rw for the panel, worker_rw for metering and renewals) may now read that one column more; they still cannot write it.
GRANT SELECT (created_at) ON fx_rates TO web_rw;--> statement-breakpoint
GRANT SELECT (created_at) ON fx_rates TO worker_rw;
