// Who owns the rows of every table (WP1-T2). Each of the 37 tables of the schema is either a tenant
// table, with the predicate that selects the rows of one customer, or a named non-tenant table.
// test/tenancy.test.ts compares both lists with the tables of the real schema, so a table that
// is added without a classification here fails the build.
//
// A predicate names the table as `t` and the customer id as `$1`. The text is written in this file
// only: table names and predicates never come from input (R11), and the customer id is always a
// bound parameter (R8). Both exports are frozen. Internal to packages/db; @tc/db/testing re-exports
// both lists for tests. A predicate may hold `or`: wrap it in parentheses wherever it is spliced into
// a longer condition.
//
// Rows that point at a customer's rows (ruling D16). The database has no composite foreign key
// (resource_id, customer_id), so a row with customer_id = B can point at a resource, a parent
// resource, an order or a ledger transaction of customer A. The snapshot is the oracle of every
// cross-tenant proof, and a row it cannot see is a leak the proof cannot detect. So a table with a
// customer_id column that also points at a row of an owned table is selected by its own customer_id
// or by the owner of the row it points at. Such a row is in the snapshot of both customers; if that
// is more than needed, a before/after check is stricter, never weaker.

// The row has a customer_id column.
const OWN = "t.customer_id = $1::uuid";
// The row belongs to a resource, and the resource to a customer.
const VIA_RESOURCE =
  "exists (select 1 from resources p where p.id = t.resource_id and p.customer_id = $1::uuid)";
// The row has a customer_id column, or it points at a resource, a parent resource, an order or a
// ledger transaction of the customer. The transaction is the customer's when one of its entries is on
// an account of the customer.
const OWN_OR_RESOURCE = `${OWN} or ${VIA_RESOURCE}`;
const OWN_OR_RELATED_RESOURCE = `${OWN} or exists (select 1 from resources p where p.id = t.related_resource_id and p.customer_id = $1::uuid)`;
const OWN_OR_PARENT_RESOURCE = `${OWN} or exists (select 1 from resources p where p.id = t.parent_resource_id and p.customer_id = $1::uuid)`;
const OWN_OR_ORDER = `${OWN} or exists (select 1 from orders o where o.id = t.order_id and o.customer_id = $1::uuid)`;
const OWN_OR_LEDGER_TRANSACTION = `${OWN} or exists (select 1 from ledger_entries e join ledger_accounts a on a.id = e.account_id where e.transaction_id = t.ledger_transaction_id and a.customer_id = $1::uuid)`;

export const TENANT_TABLES: Readonly<Record<string, string>> = Object.freeze({
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
  wallet_adjustments: OWN_OR_LEDGER_TRANSACTION,
  payments: OWN_OR_LEDGER_TRANSACTION,
  orders: OWN_OR_LEDGER_TRANSACTION,
  invoices: OWN_OR_ORDER,
  customer_homes: OWN,
  resources: OWN_OR_PARENT_RESOURCE,
  subscriptions: OWN_OR_RESOURCE,
  operations: VIA_RESOURCE,
  usage_records: VIA_RESOURCE,
  domains: OWN_OR_RESOURCE,
  dns_zones: OWN_OR_RESOURCE,
  notifications: OWN,
  waitlist_entries: OWN,
  support_requests: OWN_OR_RELATED_RESOURCE,
  abuse_cases: VIA_RESOURCE,
  audit_log: "t.actor_type = 'customer' and t.actor_id = $1::uuid",
  // The id is compared as text, written the way uuid::text writes it, so that the case of the id
  // that was passed in cannot matter; a value that is no uuid is refused by the cast, as in the
  // other predicates.
  settings: "t.scope = 'customer' and t.scope_id = $1::uuid::text",
});

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
//
// Known blind spots of the snapshot, one per line, with the work package that adds the path:
//   - notifications, waitlist_entries, support_requests with a null customer_id name the customer by e-mail: WP5-T5, WP4-T3, WP9-T4
//   - audit_log rows ABOUT a customer, written by an admin or the system (the predicate is the actor path only): WP8-T1
//   - ledger_transactions whose actor or reference is the customer but that have no line on its account: WP3-T4
//   - rate_limits, whose scope key can name a customer (see the note above): WP2-T3
//   - discrepancies, whose details can name a customer or a payment, and which customers cannot read: WP7-T6, WP8-T7
export const NON_TENANT_TABLES: readonly string[] = Object.freeze([
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
]);
