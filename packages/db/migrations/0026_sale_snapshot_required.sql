-- WPU-Y9: a sale row can never be saved without its price inputs. Forward-only; 0025 is untouched.
-- Since WPU-Y2 the code writes a price_snapshot with every purchase, renewal and metered_charge (checkPosting refuses a sale
-- without one, R16). This is the same rule in the database, so no other writer can break it. NOT VALID: the rows that were
-- written before the snapshot existed stay as they are (the ledger is append-only, R5, they cannot be changed), and every
-- NEW row is checked at once. The invoice code reads a legacy row by the lines stored with it, never by recalculation.
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_sale_snapshot_check" CHECK ("ledger_transactions"."kind" NOT IN ('purchase', 'renewal', 'metered_charge') OR "ledger_transactions"."price_snapshot" IS NOT NULL) NOT VALID;
