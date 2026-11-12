-- WPU-D3 (owner decision): the service is prepaid, so an individual customer needs no national id
-- number on the tax invoice; only a business may give an optional BIN. The column customer_nid of
-- migration 0017, its two checks and its grants are removed. Forward-only: 0017 is not edited.
-- Dropping the column also drops the column privileges of web_rw (UPDATE) and worker_rw (SELECT) on it.
-- The checks are dropped by name first so that the file says what goes (customers_tax_id_one_check names
-- both the BIN and the NID; the BIN check customers_customer_bin_check stays). Any NID already entered is
-- deleted with the column (owner decision; the platform is not live). Invoice snapshots (invoices.buyer)
-- that hold a NID tax id stay readable: the parser of the core accepts them and never prints the number.
ALTER TABLE "customers" DROP CONSTRAINT IF EXISTS "customers_tax_id_one_check";
--> statement-breakpoint
ALTER TABLE "customers" DROP CONSTRAINT IF EXISTS "customers_customer_nid_check";
--> statement-breakpoint
ALTER TABLE "customers" DROP COLUMN "customer_nid";
