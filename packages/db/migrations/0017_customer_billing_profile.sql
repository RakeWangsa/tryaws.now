-- WPU-I3: the customer billing profile and the buyer snapshot of the invoice. Forward-only.
--
-- customers gets four nullable columns the customer enters in settings: billing_name, billing_address,
-- customer_bin (13 digits, a registered business) and customer_nid (10, 13 or 17 digits). They are
-- personal or business identifiers: web_rw may update only these four (and never insert them: a row
-- starts empty), worker_rw may read only these four (the purchase path copies them onto the invoice),
-- and admin_rw loses its table-wide SELECT on customers and keeps SELECT on every column it had, so it
-- cannot read the four new ones (the tax ids are shown to the customer and on the customer's invoice only).
-- The KYC document and its encrypted number are untouched: no decryption, no crypto here.
--
-- invoices gets the nullable jsonb column buyer: the billing profile read on the day of issue, so a
-- reprint shows what the invoice said that day. web_rw and worker_rw may insert it with the invoice.
ALTER TABLE "customers" ADD COLUMN "billing_name" text;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "billing_address" text;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "customer_bin" text;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "customer_nid" text;
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "buyer" jsonb;
--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_billing_name_check" CHECK ("customers"."billing_name" is null or (char_length("customers"."billing_name") between 2 and 120 and "customers"."billing_name" !~ '[[:cntrl:]<>]'));
--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_billing_address_check" CHECK ("customers"."billing_address" is null or (char_length("customers"."billing_address") between 5 and 300 and "customers"."billing_address" !~ '[[:cntrl:]<>]'));
--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_customer_bin_check" CHECK ("customers"."customer_bin" is null or "customers"."customer_bin" ~ '^[0-9]{13}$');
--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_customer_nid_check" CHECK ("customers"."customer_nid" is null or "customers"."customer_nid" ~ '^([0-9]{10}|[0-9]{13}|[0-9]{17})$');
--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_tax_id_one_check" CHECK ("customers"."customer_bin" is null or "customers"."customer_nid" is null);
--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_buyer_check" CHECK ("invoices"."buyer" is null or jsonb_typeof("invoices"."buyer") = 'object');
--> statement-breakpoint
GRANT UPDATE (billing_name, billing_address, customer_bin, customer_nid) ON customers TO web_rw;
--> statement-breakpoint
GRANT SELECT (billing_name, billing_address, customer_bin, customer_nid) ON customers TO worker_rw;
--> statement-breakpoint
GRANT INSERT (buyer) ON invoices TO web_rw;
--> statement-breakpoint
GRANT INSERT (buyer) ON invoices TO worker_rw;
--> statement-breakpoint
REVOKE SELECT ON customers FROM admin_rw;
--> statement-breakpoint
GRANT SELECT (id, cognito_sub, sessions_valid_after, email, phone, phone_verified_at, name, type, kyc_status, risk_tier, market, locale, status, created_at) ON customers TO admin_rw;
