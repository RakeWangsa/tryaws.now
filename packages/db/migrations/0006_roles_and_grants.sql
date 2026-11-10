DO $$ DECLARE r text; BEGIN
  FOREACH r IN ARRAY ARRAY['web_rw', 'admin_rw', 'worker_rw', 'report_ro', 'migrator'] LOOP
    BEGIN
      EXECUTE format('CREATE ROLE %I NOLOGIN', r);
    EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
    END;
  END LOOP;
END $$;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO web_rw, admin_rw, worker_rw, report_ro;
--> statement-breakpoint
GRANT USAGE, CREATE ON SCHEMA public TO migrator;
--> statement-breakpoint
GRANT SELECT, INSERT ON ledger_transactions, ledger_entries, audit_log, legal_acceptances, ledger_accounts TO web_rw, admin_rw, worker_rw;
--> statement-breakpoint
GRANT SELECT ON fx_rates, pricing_rules TO web_rw;
--> statement-breakpoint
GRANT SELECT, INSERT ON fx_rates, pricing_rules TO admin_rw, worker_rw;
--> statement-breakpoint
GRANT SELECT ON feature_flags, admin_users, pool_accounts, markets, catalog_products, tlds, settings TO web_rw;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON feature_flags, admin_users, pool_accounts, markets, catalog_products, tlds, settings TO admin_rw, worker_rw;
--> statement-breakpoint
GRANT SELECT ON pool_capacity TO web_rw, worker_rw, admin_rw, report_ro;
--> statement-breakpoint
GRANT UPDATE (used) ON pool_capacity TO web_rw;
--> statement-breakpoint
GRANT UPDATE (used, checked_at) ON pool_capacity TO worker_rw;
--> statement-breakpoint
GRANT INSERT, UPDATE (quota_limit) ON pool_capacity TO admin_rw;
--> statement-breakpoint
GRANT SELECT ON operations TO web_rw;
--> statement-breakpoint
GRANT INSERT (id, created_at, resource_id, kind, state, step, attempts, enqueue_seq, next_run_at, last_error, idempotency_key, payload, needs_approval) ON operations TO web_rw;
--> statement-breakpoint
GRANT UPDATE (id, created_at, resource_id, kind, state, step, attempts, enqueue_seq, next_run_at, last_error, idempotency_key, payload) ON operations TO web_rw;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON operations TO admin_rw, worker_rw;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON invoices, orders, payments, wallet_adjustments, wallets, customer_homes, resources, subscriptions, usage_records, customers, kyc_submissions, otp_challenges, rate_limits, ssh_keys, abuse_cases, discrepancies, dns_zones, domains, notifications, support_requests, waitlist_entries TO web_rw, admin_rw, worker_rw;
--> statement-breakpoint
GRANT SELECT ON ledger_transactions, ledger_entries, audit_log, legal_acceptances, ledger_accounts, fx_rates, pricing_rules, feature_flags, admin_users, pool_accounts, markets, catalog_products, tlds, settings, operations, invoices, orders, payments, wallet_adjustments, wallets, customer_homes, resources, subscriptions, usage_records, customers, kyc_submissions, otp_challenges, rate_limits, ssh_keys, abuse_cases, discrepancies, dns_zones, domains, notifications, support_requests, waitlist_entries TO report_ro;
