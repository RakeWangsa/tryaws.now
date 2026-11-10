<!-- GENERATED, do not edit. Source: TICON_CLOUD_MEGA_PLAN.md lines 834-875. Change the plan, then run pnpm spec:split. -->

## 7. Data model

All primary keys are UUID v7. All money columns end in `_minor` and are `BIGINT`. Every table has `created_at`. Tables marked (A) are append-only.

| Table | Key columns |
| --- | --- |
| `customers` | `cognito_sub` unique, email, phone, `phone_verified_at`, name, type, `kyc_status`, `risk_tier`, market, locale, status |
| `kyc_submissions` | customer, document type, encrypted document number, S3 keys, status, reviewer, reviewed at, note |
| `ssh_keys` | customer, name, public key, fingerprint (public keys only) |
| `legal_acceptances` (A) | customer, document (terms, acceptable use, privacy, refund, domain registration agreement), version, accepted at, IP |
| `markets` | code (`BD`), currency (`BDT`), gateway, active |
| `fx_rates` (A) | market, rate (numeric), effective from, set by admin |
| `pricing_rules` (A) | market, optional product family, ordered steps (JSON), effective from, set by admin |
| `catalog_products` | family, AWS bundle or power id, platform, Region, specs (JSON), `aws_price_usd` (numeric 12,4), billing unit, feature flag, active, synced at |
| `tlds` | TLD, registration, renewal and transfer price in USD, needs extra parameters (bool), synced at |
| `feature_flags` | key, market, enabled |
| `wallets` | customer unique, currency, `balance_minor` (cached), version |
| `ledger_accounts` | type (`customer_wallet`, `gateway_clearing`, `revenue_aws_base`, `vat_korea_payable`, `vat_bd_payable`, `processing_fee_income`, `markup_income`, `refunds`, `adjustments`), customer (nullable), currency |
| `ledger_transactions` (A) | kind, reference type and id, `idempotency_key` unique, actor, memo |
| `ledger_entries` (A) | transaction, account, direction, `amount_minor` > 0 |
| `payments` | customer, gateway, `merchant_transaction_id` unique, `amount_minor`, currency, status, gateway transaction id, verify payload (JSON), verified at, ledger transaction |
| `orders` | customer, kind (`new`, `renew`, `addon`, `restore`), items and price snapshot (JSON), `total_minor`, ledger transaction, status |
| `invoices` | sequential number per fiscal year, customer, order, lines (JSON), `total_minor`, issued at, PDF key |
| `pool_accounts` | AWS account id, name, tier, role ARN, ExternalId secret reference, status |
| `pool_capacity` | pool account, Region, quota code, limit, used, checked at |
| `customer_homes` | customer, Region, pool account (unique per customer and Region) |
| `resources` | customer, family, product, pool account, Region, AWS name, state, config (JSON), deleted at |
| `subscriptions` | resource, customer, term days, price snapshot, period start and end, auto renew, status |
| `operations` | resource, kind, state, step, attempts, last error, `idempotency_key` unique, payload (JSON), needs approval, approved by |
| `usage_records` | resource, metric, period, quantity (for metered items) |
| `domains` | customer, name, TLD, Route 53 operation id, status, expires at, hosted zone |
| `dns_zones` | customer, name, hosted zone id, name servers, delegated at |
| `notifications` | customer, channel (`email`, `sms`, `in_app`), template, payload, status, sent at, read at |
| `waitlist_entries` | customer (nullable), email (for visitors who are not signed in), product family, Region, reason (`capacity` or `flag_off`), notified at |
| `support_requests` | customer (nullable), name and email (for visitors who are not signed in), category, related resource (nullable), subject, message, status, handled by |
| `admin_users` | `cognito_sub` unique, role, status |
| `abuse_cases` | resource, source, status, notes |
| `discrepancies` | kind (`orphan`, `missing`, `cost`, `payment`), details (JSON), status |
| `audit_log` (A) | actor type and id, action, target type and id, IP, user agent, metadata (JSON) |

Constraints to implement in the database, not only in code: unique keys above; `amount_minor > 0`; a deferred constraint trigger that rejects a ledger transaction whose debits and credits differ; `wallets.balance_minor >= 0`.

