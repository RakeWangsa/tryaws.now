CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"fiscal_year" smallint NOT NULL,
	"number" integer NOT NULL,
	"customer_id" uuid NOT NULL,
	"order_id" uuid,
	"lines" jsonb NOT NULL,
	"total_minor" bigint NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pdf_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_fiscal_year_number_unique" UNIQUE("fiscal_year","number"),
	CONSTRAINT "invoices_order_id_unique" UNIQUE("order_id"),
	CONSTRAINT "invoices_fiscal_year_check" CHECK ("invoices"."fiscal_year" >= 2026),
	CONSTRAINT "invoices_number_check" CHECK ("invoices"."number" > 0),
	CONSTRAINT "invoices_lines_check" CHECK (jsonb_typeof("invoices"."lines") = 'array'),
	CONSTRAINT "invoices_total_minor_check" CHECK ("invoices"."total_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ledger_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"customer_id" uuid,
	"currency" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_accounts_customer_id_type_currency_unique" UNIQUE NULLS NOT DISTINCT("customer_id","type","currency"),
	CONSTRAINT "ledger_accounts_type_check" CHECK ("ledger_accounts"."type" in ('customer_wallet', 'gateway_clearing', 'revenue_aws_base', 'vat_korea_payable', 'vat_bd_payable', 'processing_fee_income', 'markup_income', 'refunds', 'adjustments')),
	CONSTRAINT "ledger_accounts_owner_check" CHECK (("ledger_accounts"."type" = 'customer_wallet') = ("ledger_accounts"."customer_id" IS NOT NULL)),
	CONSTRAINT "ledger_accounts_currency_check" CHECK ("ledger_accounts"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"transaction_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_direction_check" CHECK ("ledger_entries"."direction" in ('debit', 'credit')),
	CONSTRAINT "ledger_entries_amount_minor_check" CHECK ("ledger_entries"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "ledger_transactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"reference_type" text NOT NULL,
	"reference_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"memo" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_transactions_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "ledger_transactions_actor_type_check" CHECK ("ledger_transactions"."actor_type" in ('customer', 'admin', 'system')),
	CONSTRAINT "ledger_transactions_actor_check" CHECK (("ledger_transactions"."actor_type" = 'system') = ("ledger_transactions"."actor_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"items" jsonb NOT NULL,
	"price_snapshot" jsonb NOT NULL,
	"total_minor" bigint NOT NULL,
	"ledger_transaction_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'paid' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_ledger_transaction_id_unique" UNIQUE("ledger_transaction_id"),
	CONSTRAINT "orders_customer_id_idempotency_key_unique" UNIQUE("customer_id","idempotency_key"),
	CONSTRAINT "orders_kind_check" CHECK ("orders"."kind" in ('new', 'renew', 'addon', 'restore')),
	CONSTRAINT "orders_total_minor_check" CHECK ("orders"."total_minor" >= 0),
	CONSTRAINT "orders_status_check" CHECK ("orders"."status" in ('paid', 'fulfilled', 'reversed'))
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"gateway" text NOT NULL,
	"merchant_transaction_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"status" text DEFAULT 'initiated' NOT NULL,
	"gateway_transaction_id" text,
	"verify_payload" jsonb,
	"verified_at" timestamp with time zone,
	"ledger_transaction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_merchant_transaction_id_unique" UNIQUE("merchant_transaction_id"),
	CONSTRAINT "payments_customer_id_idempotency_key_unique" UNIQUE("customer_id","idempotency_key"),
	CONSTRAINT "payments_ledger_transaction_id_unique" UNIQUE("ledger_transaction_id"),
	CONSTRAINT "payments_merchant_transaction_id_check" CHECK (length("payments"."merchant_transaction_id") >= 10),
	CONSTRAINT "payments_amount_minor_check" CHECK ("payments"."amount_minor" > 0),
	CONSTRAINT "payments_currency_check" CHECK ("payments"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "payments_status_check" CHECK ("payments"."status" in ('initiated', 'redirected', 'credited', 'failed', 'cancelled', 'expired', 'review')),
	CONSTRAINT "payments_credit_check" CHECK (("payments"."status" = 'credited') = ("payments"."ledger_transaction_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "wallet_adjustments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"evidence_ref" text,
	"requested_by" uuid NOT NULL,
	"approved_by" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"ledger_transaction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_adjustments_ledger_transaction_id_unique" UNIQUE("ledger_transaction_id"),
	CONSTRAINT "wallet_adjustments_direction_check" CHECK ("wallet_adjustments"."direction" in ('credit', 'debit')),
	CONSTRAINT "wallet_adjustments_amount_minor_check" CHECK ("wallet_adjustments"."amount_minor" > 0),
	CONSTRAINT "wallet_adjustments_kind_check" CHECK ("wallet_adjustments"."kind" in ('goodwill', 'deposit', 'correction')),
	CONSTRAINT "wallet_adjustments_reason_check" CHECK (length(btrim("wallet_adjustments"."reason")) > 0),
	CONSTRAINT "wallet_adjustments_approver_check" CHECK ("wallet_adjustments"."approved_by" IS NULL OR "wallet_adjustments"."approved_by" <> "wallet_adjustments"."requested_by"),
	CONSTRAINT "wallet_adjustments_status_check" CHECK ("wallet_adjustments"."status" in ('pending', 'approved', 'rejected')),
	CONSTRAINT "wallet_adjustments_posting_check" CHECK (("wallet_adjustments"."status" = 'approved') = ("wallet_adjustments"."ledger_transaction_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"balance_minor" bigint DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallets_customer_id_unique" UNIQUE("customer_id"),
	CONSTRAINT "wallets_currency_check" CHECK ("wallets"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "wallets_balance_minor_check" CHECK ("wallets"."balance_minor" >= 0)
);
--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_ledger_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_ledger_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("ledger_transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_ledger_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("ledger_transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_adjustments" ADD CONSTRAINT "wallet_adjustments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_adjustments" ADD CONSTRAINT "wallet_adjustments_requested_by_admin_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_adjustments" ADD CONSTRAINT "wallet_adjustments_approved_by_admin_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_adjustments" ADD CONSTRAINT "wallet_adjustments_ledger_transaction_id_fk" FOREIGN KEY ("ledger_transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoices_customer_id_idx" ON "invoices" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_transaction_id_idx" ON "ledger_entries" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_account_id_idx" ON "ledger_entries" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "ledger_transactions_reference_type_reference_id_idx" ON "ledger_transactions" USING btree ("reference_type","reference_id");--> statement-breakpoint
CREATE INDEX "payments_status_created_at_idx" ON "payments" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "wallet_adjustments_customer_id_idx" ON "wallet_adjustments" USING btree ("customer_id");