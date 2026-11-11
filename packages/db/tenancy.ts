// Who owns the rows of every table (WP1-T2). Each of the 37 tables of the schema is either a tenant
// table, with the predicate that selects the rows of one customer, or a named non-tenant table.
// test/tenancy.test.ts compares both lists with the tables of the real schema, so a table that
// is added without a classification here fails the build.
//
// A predicate names the table as `t` and the customer id as `$1`. The text is written in this file
// only: table names and predicates never come from input (R11), and the customer id is always a
// bound parameter (R8). Internal to packages/db; @tc/db/testing re-exports both lists for tests.

// The row has a customer_id column.
const OWN = "t.customer_id = $1::uuid";
// The row belongs to a resource, and the resource to a customer.
const VIA_RESOURCE =
  "exists (select 1 from resources p where p.id = t.resource_id and p.customer_id = $1::uuid)";

export const TENANT_TABLES: Readonly<Record<string, string>> = {
  customers: "t.id = $1::uuid",
  kyc_submissions: OWN,
  ssh_keys: OWN,
  otp_challenges: OWN,
  legal_acceptances: OWN,
  wallets: OWN,
  ledger_accounts: OWN,
  ledger_entries:
    "exists (select 1 from ledger_accounts a where a.id = t.account_id and a.customer_id = $1::uuid)",
  ledger_transactions:
    "exists (select 1 from ledger_entries e join ledger_accounts a on a.id = e.account_id where e.transaction_id = t.id and a.customer_id = $1::uuid)",
  wallet_adjustments: OWN,
  payments: OWN,
  orders: OWN,
  invoices: OWN,
  customer_homes: OWN,
  resources: OWN,
  subscriptions: OWN,
  operations: VIA_RESOURCE,
  usage_records: VIA_RESOURCE,
  domains: OWN,
  dns_zones: OWN,
  notifications: OWN,
  waitlist_entries: OWN,
  support_requests: OWN,
  abuse_cases: VIA_RESOURCE,
  audit_log: "t.actor_type = 'customer' and t.actor_id = $1::uuid",
  settings: "t.scope = 'customer' and t.scope_id = $1::text",
};

// The tables that no single customer owns, and why:
//   markets           the currency, gateway and top-up limits of a market, shared by its customers
//   fx_rates          the exchange rate of a market, set by an admin
//   pricing_rules     the price steps of a market and product family, set by an admin
//   catalog_products  the catalog of AWS products, synced from AWS
//   tlds              the TLD prices, synced from Route 53
//   feature_flags     the switches of a market, set by an admin
//   admin_users       the staff accounts of the admin app, not customers
//   pool_accounts     TiCON's own AWS pool accounts
//   pool_capacity     the quota and use of the pool accounts per Region
//   rate_limits       for now: its key format is not fixed yet (see the note below)
//   discrepancies     admin reconciliation data
//
// Note on rate_limits: section 7 allows a key that names a customer, and such a row belongs to
// that customer. WP2-T3 fixes the key format and moves the table to TENANT_TABLES with a predicate
// on it; until then a snapshot cannot see the limit rows of a customer.
export const NON_TENANT_TABLES: readonly string[] = [
  "markets",
  "fx_rates",
  "pricing_rules",
  "catalog_products",
  "tlds",
  "feature_flags",
  "admin_users",
  "pool_accounts",
  "pool_capacity",
  "rate_limits",
  "discrepancies",
];
