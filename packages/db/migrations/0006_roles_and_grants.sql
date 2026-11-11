DO $$ DECLARE r text; BEGIN
  FOREACH r IN ARRAY ARRAY['web_rw', 'admin_rw', 'worker_rw', 'report_ro', 'migrator'] LOOP
    BEGIN
      EXECUTE format('CREATE ROLE %I NOLOGIN', r);
    EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
    END;
  END LOOP;
END $$;
--> statement-breakpoint
-- Schema: usage for the four application roles, DDL only for migrator, no CREATE for PUBLIC.
GRANT USAGE ON SCHEMA public TO web_rw, admin_rw, worker_rw, report_ro;
--> statement-breakpoint
GRANT USAGE, CREATE ON SCHEMA public TO migrator;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
-- web_rw (customer panel): only the columns that a customer flow of the specification writes; no UPDATE on operations, no DELETE except ssh_keys.
GRANT SELECT ON catalog_products TO web_rw;
--> statement-breakpoint
GRANT SELECT (key, market, enabled) ON feature_flags TO web_rw;
--> statement-breakpoint
GRANT SELECT (id, market, rate, effective_from) ON fx_rates TO web_rw;
--> statement-breakpoint
GRANT SELECT ON markets TO web_rw;
--> statement-breakpoint
GRANT SELECT (id, market, product_family, steps, effective_from) ON pricing_rules TO web_rw;
--> statement-breakpoint
GRANT SELECT (id, key, market, scope, scope_id, value) ON settings TO web_rw;
--> statement-breakpoint
GRANT SELECT ON tlds TO web_rw;
--> statement-breakpoint
GRANT SELECT ON customers TO web_rw;
--> statement-breakpoint
GRANT INSERT (id, cognito_sub, email, phone, name, type, market, locale) ON customers TO web_rw;
--> statement-breakpoint
GRANT UPDATE (name, locale, email, phone, phone_verified_at, sessions_valid_after, type) ON customers TO web_rw;
--> statement-breakpoint
GRANT SELECT (id, customer_id, document_type, status, reviewed_at, note, created_at) ON kyc_submissions TO web_rw;
--> statement-breakpoint
GRANT INSERT (id, customer_id, document_type, document_number_encrypted, s3_keys) ON kyc_submissions TO web_rw;
--> statement-breakpoint
GRANT INSERT (id, customer_id, document, version, ip) ON legal_acceptances TO web_rw;
--> statement-breakpoint
GRANT SELECT ON otp_challenges TO web_rw;
--> statement-breakpoint
GRANT INSERT (id, customer_id, phone, code_hash, expires_at) ON otp_challenges TO web_rw;
--> statement-breakpoint
GRANT UPDATE (attempts, consumed_at) ON otp_challenges TO web_rw;
--> statement-breakpoint
GRANT SELECT (id, scope_key, window_start, count) ON rate_limits TO web_rw;
--> statement-breakpoint
GRANT INSERT (id, scope_key, window_start, count) ON rate_limits TO web_rw;
--> statement-breakpoint
GRANT UPDATE (count) ON rate_limits TO web_rw;
--> statement-breakpoint
GRANT SELECT, DELETE ON ssh_keys TO web_rw;
--> statement-breakpoint
GRANT INSERT (id, customer_id, name, public_key, fingerprint) ON ssh_keys TO web_rw;
--> statement-breakpoint
GRANT SELECT ON invoices TO web_rw;
--> statement-breakpoint
GRANT INSERT (id, fiscal_year, number, customer_id, order_id, lines, total_minor) ON invoices TO web_rw;
--> statement-breakpoint
GRANT SELECT ON ledger_accounts TO web_rw;
--> statement-breakpoint
GRANT INSERT (id, type, customer_id, currency) ON ledger_accounts TO web_rw;
--> statement-breakpoint
GRANT SELECT, INSERT ON ledger_entries TO web_rw;
--> statement-breakpoint
GRANT SELECT, INSERT ON ledger_transactions TO web_rw;
--> statement-breakpoint
GRANT SELECT ON orders TO web_rw;
--> statement-breakpoint
GRANT INSERT (id, customer_id, kind, items, price_snapshot, total_minor, ledger_transaction_id, idempotency_key) ON orders TO web_rw;
--> statement-breakpoint
GRANT SELECT (id, customer_id, gateway, merchant_transaction_id, idempotency_key, amount_minor, currency, status, gateway_transaction_id, verified_at, ledger_transaction_id, created_at) ON payments TO web_rw;
--> statement-breakpoint
GRANT INSERT (id, customer_id, gateway, merchant_transaction_id, idempotency_key, amount_minor, currency) ON payments TO web_rw;
--> statement-breakpoint
GRANT UPDATE (status, gateway_transaction_id, verify_payload, verified_at, ledger_transaction_id) ON payments TO web_rw;
--> statement-breakpoint
GRANT SELECT ON wallets TO web_rw;
--> statement-breakpoint
GRANT INSERT (id, customer_id, currency) ON wallets TO web_rw;
--> statement-breakpoint
GRANT UPDATE (balance_minor, version) ON wallets TO web_rw;
--> statement-breakpoint
GRANT SELECT ON customer_homes TO web_rw;
--> statement-breakpoint
GRANT INSERT (id, customer_id, region, pool_account_id) ON customer_homes TO web_rw;
--> statement-breakpoint
GRANT SELECT (id, resource_id, kind, state, step, needs_approval, idempotency_key, enqueue_seq, created_at) ON operations TO web_rw;
--> statement-breakpoint
GRANT INSERT (id, resource_id, kind, state, idempotency_key, payload, needs_approval) ON operations TO web_rw;
--> statement-breakpoint
GRANT SELECT (id, tier, status) ON pool_accounts TO web_rw;
--> statement-breakpoint
GRANT SELECT ON pool_capacity TO web_rw;
--> statement-breakpoint
GRANT UPDATE (used) ON pool_capacity TO web_rw;
--> statement-breakpoint
GRANT SELECT ON resources TO web_rw;
--> statement-breakpoint
GRANT INSERT (id, customer_id, family, product_id, pool_account_id, region, parent_resource_id, config) ON resources TO web_rw;
--> statement-breakpoint
GRANT SELECT ON subscriptions TO web_rw;
--> statement-breakpoint
GRANT INSERT (id, resource_id, customer_id, term_days, price_snapshot, period_start, period_end, auto_renew) ON subscriptions TO web_rw;
--> statement-breakpoint
GRANT UPDATE (auto_renew, period_start, period_end, status) ON subscriptions TO web_rw;
--> statement-breakpoint
GRANT INSERT (id, actor_type, actor_id, action, target_type, target_id, ip, user_agent, metadata) ON audit_log TO web_rw;
--> statement-breakpoint
GRANT INSERT (id, kind, details) ON discrepancies TO web_rw;
--> statement-breakpoint
GRANT SELECT (id, customer_id, resource_id, name, name_servers, delegated_at, status, created_at) ON dns_zones TO web_rw;
--> statement-breakpoint
GRANT INSERT (id, customer_id, resource_id, name, status) ON dns_zones TO web_rw;
--> statement-breakpoint
GRANT SELECT (id, customer_id, resource_id, name, tld, status, expires_at, created_at) ON domains TO web_rw;
--> statement-breakpoint
GRANT INSERT (id, customer_id, resource_id, name, tld, status, registrant_contact_encrypted) ON domains TO web_rw;
--> statement-breakpoint
GRANT SELECT (id, customer_id, channel, template, payload, status, read_at, created_at) ON notifications TO web_rw;
--> statement-breakpoint
GRANT INSERT (id, customer_id, email, channel, template, payload, dedupe_key) ON notifications TO web_rw;
--> statement-breakpoint
GRANT UPDATE (read_at) ON notifications TO web_rw;
--> statement-breakpoint
GRANT SELECT (id, customer_id, category, related_resource_id, subject, message, status, created_at) ON support_requests TO web_rw;
--> statement-breakpoint
GRANT INSERT (id, customer_id, name, email, category, related_resource_id, subject, message) ON support_requests TO web_rw;
--> statement-breakpoint
GRANT INSERT (id, customer_id, email, product_family, region, reason) ON waitlist_entries TO web_rw;
--> statement-breakpoint
-- admin_rw (admin panel): admin decisions (KYC, risk tier, adjustments, approvals, flags, prices, limits); no DELETE anywhere.
GRANT SELECT ON admin_users TO admin_rw;
--> statement-breakpoint
GRANT INSERT (id, cognito_sub, role, status) ON admin_users TO admin_rw;
--> statement-breakpoint
GRANT UPDATE (role, status) ON admin_users TO admin_rw;
--> statement-breakpoint
GRANT SELECT ON catalog_products TO admin_rw;
--> statement-breakpoint
GRANT SELECT ON feature_flags TO admin_rw;
--> statement-breakpoint
GRANT INSERT (id, key, market, enabled) ON feature_flags TO admin_rw;
--> statement-breakpoint
GRANT UPDATE (enabled) ON feature_flags TO admin_rw;
--> statement-breakpoint
GRANT SELECT ON fx_rates TO admin_rw;
--> statement-breakpoint
GRANT INSERT (id, market, rate, effective_from, set_by) ON fx_rates TO admin_rw;
--> statement-breakpoint
GRANT SELECT ON markets TO admin_rw;
--> statement-breakpoint
GRANT SELECT ON pricing_rules TO admin_rw;
--> statement-breakpoint
GRANT INSERT (id, market, product_family, steps, effective_from, set_by) ON pricing_rules TO admin_rw;
--> statement-breakpoint
GRANT SELECT ON settings TO admin_rw;
--> statement-breakpoint
GRANT INSERT (id, key, market, scope, scope_id, value, set_by) ON settings TO admin_rw;
--> statement-breakpoint
GRANT UPDATE (value, set_by) ON settings TO admin_rw;
--> statement-breakpoint
GRANT SELECT ON tlds TO admin_rw;
--> statement-breakpoint
GRANT SELECT ON customers TO admin_rw;
--> statement-breakpoint
GRANT UPDATE (kyc_status, risk_tier, status, sessions_valid_after) ON customers TO admin_rw;
--> statement-breakpoint
GRANT SELECT (id, customer_id, document_type, s3_keys, status, reviewer_id, reviewed_at, note, created_at) ON kyc_submissions TO admin_rw;
--> statement-breakpoint
GRANT UPDATE (status, reviewer_id, reviewed_at, note) ON kyc_submissions TO admin_rw;
--> statement-breakpoint
GRANT SELECT (id, scope_key, window_start, count) ON rate_limits TO admin_rw;
--> statement-breakpoint
GRANT INSERT (id, scope_key, window_start, count) ON rate_limits TO admin_rw;
--> statement-breakpoint
GRANT UPDATE (count) ON rate_limits TO admin_rw;
--> statement-breakpoint
GRANT SELECT ON invoices TO admin_rw;
--> statement-breakpoint
GRANT SELECT ON ledger_accounts TO admin_rw;
--> statement-breakpoint
GRANT SELECT, INSERT ON ledger_entries TO admin_rw;
--> statement-breakpoint
GRANT SELECT, INSERT ON ledger_transactions TO admin_rw;
--> statement-breakpoint
GRANT SELECT ON orders TO admin_rw;
--> statement-breakpoint
GRANT SELECT ON payments TO admin_rw;
--> statement-breakpoint
GRANT UPDATE (status, gateway_transaction_id, verify_payload, verified_at, ledger_transaction_id) ON payments TO admin_rw;
--> statement-breakpoint
GRANT SELECT ON wallet_adjustments TO admin_rw;
--> statement-breakpoint
GRANT INSERT (id, customer_id, direction, amount_minor, kind, reason, evidence_ref, requested_by, status, ledger_transaction_id) ON wallet_adjustments TO admin_rw;
--> statement-breakpoint
GRANT UPDATE (approved_by, status, ledger_transaction_id) ON wallet_adjustments TO admin_rw;
--> statement-breakpoint
GRANT SELECT ON wallets TO admin_rw;
--> statement-breakpoint
GRANT UPDATE (balance_minor, version) ON wallets TO admin_rw;
--> statement-breakpoint
GRANT SELECT ON operations TO admin_rw;
--> statement-breakpoint
GRANT INSERT (id, resource_id, kind, state, idempotency_key, payload) ON operations TO admin_rw;
--> statement-breakpoint
GRANT UPDATE (state, approved_by, next_run_at, enqueue_seq) ON operations TO admin_rw;
--> statement-breakpoint
GRANT SELECT (id, name, tier, status, created_at) ON pool_accounts TO admin_rw;
--> statement-breakpoint
GRANT INSERT (id, aws_account_id, name, tier, role_arn, external_id, status) ON pool_accounts TO admin_rw;
--> statement-breakpoint
GRANT SELECT, INSERT ON pool_capacity TO admin_rw;
--> statement-breakpoint
GRANT UPDATE (quota_limit) ON pool_capacity TO admin_rw;
--> statement-breakpoint
GRANT SELECT ON resources TO admin_rw;
--> statement-breakpoint
GRANT SELECT ON subscriptions TO admin_rw;
--> statement-breakpoint
GRANT SELECT ON abuse_cases TO admin_rw;
--> statement-breakpoint
GRANT INSERT (id, resource_id, source, notes) ON abuse_cases TO admin_rw;
--> statement-breakpoint
GRANT UPDATE (status, notes) ON abuse_cases TO admin_rw;
--> statement-breakpoint
GRANT SELECT ON audit_log TO admin_rw;
--> statement-breakpoint
GRANT INSERT (id, actor_type, actor_id, action, target_type, target_id, ip, user_agent, metadata) ON audit_log TO admin_rw;
--> statement-breakpoint
GRANT SELECT ON discrepancies TO admin_rw;
--> statement-breakpoint
GRANT INSERT (id, kind, details) ON discrepancies TO admin_rw;
--> statement-breakpoint
GRANT UPDATE (status) ON discrepancies TO admin_rw;
--> statement-breakpoint
GRANT SELECT (id, customer_id, resource_id, name, tld, route53_operation_id, status, expires_at, hosted_zone_id, created_at) ON domains TO admin_rw;
--> statement-breakpoint
GRANT INSERT (id, customer_id, email, channel, template, payload, dedupe_key) ON notifications TO admin_rw;
--> statement-breakpoint
GRANT SELECT ON support_requests TO admin_rw;
--> statement-breakpoint
GRANT UPDATE (status, handled_by) ON support_requests TO admin_rw;
--> statement-breakpoint
GRANT SELECT ON waitlist_entries TO admin_rw;
--> statement-breakpoint
GRANT UPDATE (notified_at) ON waitlist_entries TO admin_rw;
--> statement-breakpoint
-- worker_rw (Lambda functions): the columns that provisioner, scheduler, sweeper, catalog-sync, reconciler, notifier and reader own; no DELETE anywhere.
GRANT SELECT (id, status) ON admin_users TO worker_rw;
--> statement-breakpoint
GRANT SELECT ON catalog_products TO worker_rw;
--> statement-breakpoint
GRANT INSERT (id, family, aws_id, platform, region, specs, aws_price_usd, billing_unit, feature_flag, active, synced_at) ON catalog_products TO worker_rw;
--> statement-breakpoint
GRANT UPDATE (platform, specs, aws_price_usd, billing_unit, active, synced_at) ON catalog_products TO worker_rw;
--> statement-breakpoint
GRANT SELECT (id, market, rate, effective_from) ON fx_rates TO worker_rw;
--> statement-breakpoint
GRANT SELECT (code, currency, locales, numerals) ON markets TO worker_rw;
--> statement-breakpoint
GRANT SELECT (id, market, product_family, steps, effective_from) ON pricing_rules TO worker_rw;
--> statement-breakpoint
GRANT SELECT (id, key, market, scope, scope_id, value) ON settings TO worker_rw;
--> statement-breakpoint
GRANT SELECT ON tlds TO worker_rw;
--> statement-breakpoint
GRANT INSERT (id, tld, registration_price_usd, renewal_price_usd, transfer_price_usd, needs_extra_params, synced_at) ON tlds TO worker_rw;
--> statement-breakpoint
GRANT UPDATE (registration_price_usd, renewal_price_usd, transfer_price_usd, needs_extra_params, synced_at) ON tlds TO worker_rw;
--> statement-breakpoint
GRANT SELECT (id, email, phone, phone_verified_at, locale, market) ON customers TO worker_rw;
--> statement-breakpoint
GRANT SELECT (id, customer_id, public_key, fingerprint) ON ssh_keys TO worker_rw;
--> statement-breakpoint
GRANT SELECT ON invoices TO worker_rw;
--> statement-breakpoint
GRANT INSERT (id, fiscal_year, number, customer_id, order_id, lines, total_minor) ON invoices TO worker_rw;
--> statement-breakpoint
GRANT SELECT ON ledger_accounts TO worker_rw;
--> statement-breakpoint
GRANT SELECT, INSERT ON ledger_entries TO worker_rw;
--> statement-breakpoint
GRANT SELECT, INSERT ON ledger_transactions TO worker_rw;
--> statement-breakpoint
GRANT SELECT ON orders TO worker_rw;
--> statement-breakpoint
GRANT UPDATE (status) ON orders TO worker_rw;
--> statement-breakpoint
GRANT SELECT (id, customer_id, gateway, merchant_transaction_id, idempotency_key, amount_minor, currency, status, gateway_transaction_id, verified_at, ledger_transaction_id, created_at) ON payments TO worker_rw;
--> statement-breakpoint
GRANT UPDATE (status, gateway_transaction_id, verify_payload, verified_at, ledger_transaction_id) ON payments TO worker_rw;
--> statement-breakpoint
GRANT SELECT ON wallets TO worker_rw;
--> statement-breakpoint
GRANT UPDATE (balance_minor, version) ON wallets TO worker_rw;
--> statement-breakpoint
GRANT SELECT ON operations TO worker_rw;
--> statement-breakpoint
GRANT INSERT (id, resource_id, kind, state, idempotency_key, payload, needs_approval, next_run_at) ON operations TO worker_rw;
--> statement-breakpoint
GRANT UPDATE (state, step, attempts, enqueue_seq, next_run_at, last_error) ON operations TO worker_rw;
--> statement-breakpoint
GRANT SELECT (id, aws_account_id, role_arn, external_id, status) ON pool_accounts TO worker_rw;
--> statement-breakpoint
GRANT SELECT ON pool_capacity TO worker_rw;
--> statement-breakpoint
GRANT UPDATE (used, checked_at) ON pool_capacity TO worker_rw;
--> statement-breakpoint
GRANT SELECT ON resources TO worker_rw;
--> statement-breakpoint
GRANT INSERT (id, customer_id, family, product_id, pool_account_id, region, aws_name, state, parent_resource_id, config) ON resources TO worker_rw;
--> statement-breakpoint
GRANT UPDATE (state, config, deleted_at, aws_name) ON resources TO worker_rw;
--> statement-breakpoint
GRANT SELECT ON subscriptions TO worker_rw;
--> statement-breakpoint
GRANT UPDATE (status, period_start, period_end) ON subscriptions TO worker_rw;
--> statement-breakpoint
GRANT SELECT ON usage_records TO worker_rw;
--> statement-breakpoint
GRANT INSERT (id, resource_id, metric, period, quantity) ON usage_records TO worker_rw;
--> statement-breakpoint
GRANT UPDATE (quantity) ON usage_records TO worker_rw;
--> statement-breakpoint
GRANT INSERT (id, actor_type, actor_id, action, target_type, target_id, ip, user_agent, metadata) ON audit_log TO worker_rw;
--> statement-breakpoint
GRANT SELECT ON discrepancies TO worker_rw;
--> statement-breakpoint
GRANT INSERT (id, kind, details) ON discrepancies TO worker_rw;
--> statement-breakpoint
GRANT SELECT ON dns_zones TO worker_rw;
--> statement-breakpoint
GRANT UPDATE (hosted_zone_id, name_servers, delegated_at, status, notices_sent_at) ON dns_zones TO worker_rw;
--> statement-breakpoint
GRANT SELECT ON domains TO worker_rw;
--> statement-breakpoint
GRANT UPDATE (route53_operation_id, status, expires_at, hosted_zone_id) ON domains TO worker_rw;
--> statement-breakpoint
GRANT SELECT ON notifications TO worker_rw;
--> statement-breakpoint
GRANT INSERT (id, customer_id, email, channel, template, payload, dedupe_key) ON notifications TO worker_rw;
--> statement-breakpoint
GRANT UPDATE (status, attempts, sent_at) ON notifications TO worker_rw;
--> statement-breakpoint
-- report_ro (read-only reports): SELECT only on the columns that the first-day report (E WP10-T2) and the reconciliation report (M) name.
GRANT SELECT (id, amount_minor, currency, status, verified_at, created_at) ON payments TO report_ro;
--> statement-breakpoint
GRANT SELECT (id, resource_id, kind, state, attempts, next_run_at, created_at) ON operations TO report_ro;
--> statement-breakpoint
GRANT SELECT (id, family, state, region, created_at) ON resources TO report_ro;
--> statement-breakpoint
GRANT SELECT ON discrepancies TO report_ro;
