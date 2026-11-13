import { v7 as uuidv7 } from "uuid";
import { expect, it } from "vitest";
import { NON_TENANT_TABLES, TENANT_TABLES } from "../tenancy";
import { useTempDatabase } from "./temp-db";

const t = useTempDatabase();

// The Ownership map of docs/superpowers/plans/2026-11-11-wp1-t2-tenant-scoped-repositories.md is the
// specification of tenancy.ts. It is restated here on purpose: a table that moves from one list to the
// other, or a predicate that changes, must fail a test that was written from the map and not from the code.
const TENANT = [
  "abuse_cases",
  "audit_log",
  "customer_homes",
  "customers",
  "dns_zones",
  "domains",
  "invoices",
  "kyc_submissions",
  "ledger_accounts",
  "ledger_entries",
  "ledger_transactions",
  "legal_acceptances",
  "notifications",
  "operations",
  "orders",
  "otp_challenges",
  "payments",
  "rate_limits",
  "resources",
  "settings",
  "ssh_keys",
  "subscriptions",
  // WPU-Z5: a message of the thread belongs to the customer of its request.
  "support_messages",
  "support_requests",
  "usage_records",
  "waitlist_entries",
  "wallet_adjustments",
  "wallets",
];
const NON_TENANT = [
  "admin_users",
  "catalog_products",
  "discrepancies",
  "feature_flags",
  "fx_rates",
  "markets",
  "pool_accounts",
  "pool_capacity",
  "pricing_rules",
  "tlds",
];

// Of the 18 tables with a customer_id column, nine are owned through that column alone ...
const OWN = "t.customer_id = $1::uuid";
const OWNED_BY_COLUMN = [
  "customer_homes",
  "kyc_submissions",
  "ledger_accounts",
  "legal_acceptances",
  "notifications",
  "otp_challenges",
  "ssh_keys",
  "waitlist_entries",
  "wallets",
];
// ... and nine also through the row they point at (ruling D16): a row of customer B that refers to a
// resource, parent resource, order or ledger transaction of customer A is visible in the snapshot of A.
const ALSO_BY_LINK = [
  "dns_zones",
  "domains",
  "invoices",
  "orders",
  "payments",
  "resources",
  "subscriptions",
  "support_requests",
  "wallet_adjustments",
];
// The table names are spliced into SQL text.
const PLAIN_NAME = /^[a-z_][a-z0-9_]*$/;

const tables = async () =>
  (
    await t.pool.query(
      "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'",
    )
  ).rows
    .map((r) => r.table_name as string)
    .sort();

it("every table is a tenant table or a named non-tenant table, never both", async () => {
  const tenant = Object.keys(TENANT_TABLES);
  expect(tenant.filter((x) => NON_TENANT_TABLES.includes(x))).toEqual([]);
  expect([...tenant, ...NON_TENANT_TABLES].sort()).toEqual(await tables());
});

it("the split is the Ownership map: 28 tenant tables and 10 named non-tenant tables", () => {
  expect(Object.keys(TENANT_TABLES).sort()).toEqual(TENANT);
  expect([...NON_TENANT_TABLES].sort()).toEqual(NON_TENANT);
});

// WPU-Z5: support_messages has no customer_id column; a message is the customer's through its request,
// in one step like an operation through its resource.
it("a message of the support thread is owned through its request", () => {
  expect(TENANT_TABLES["support_messages"]).toBe(
    "exists (select 1 from support_requests r where r.id = t.request_id and r.customer_id = $1::uuid)",
  );
});

it("every table with a customer_id column is owned through that column, nine of them also through a link", async () => {
  const { rows } = await t.pool.query<{ table_name: string }>(
    "select table_name from information_schema.columns where table_schema = 'public' and column_name = 'customer_id'",
  );
  // A query that returns nothing would let the loop below pass without a single check.
  expect(rows).toHaveLength(18);
  expect(rows.map((r) => r.table_name).sort()).toEqual(
    [...OWNED_BY_COLUMN, ...ALSO_BY_LINK].sort(),
  );
  for (const { table_name } of rows) {
    const predicate = TENANT_TABLES[table_name];
    if (ALSO_BY_LINK.includes(table_name)) {
      expect(predicate, table_name).toMatch(/^t\.customer_id = \$1::uuid or /);
    } else {
      expect(predicate, table_name).toBe(OWN);
    }
  }
});

it("every owner predicate parses and names columns that exist (an empty database has no row to select)", async () => {
  for (const [table, predicate] of Object.entries(TENANT_TABLES)) {
    expect(table).toMatch(PLAIN_NAME);
    // A predicate may hold `or`: it is spliced into a where clause in parentheses.
    const { rows } = await t.pool.query(
      `select count(*)::int as n from ${table} t where (${predicate})`,
      [uuidv7()],
    );
    expect({ table, n: rows[0].n }).toEqual({ table, n: 0 });
  }
});

// A table that no customer owns must not point at one: a row of it would belong to a customer without
// being found by a predicate. Today every foreign key of a non-tenant table leads to markets,
// admin_users or pool_accounts.
it("no foreign key leads from a non-tenant table to a tenant table", async () => {
  const { rows } = await t.pool.query<{ from: string; to: string }>(`
    select (select relname from pg_class where oid = c.conrelid) as "from",
           (select relname from pg_class where oid = c.confrelid) as "to"
      from pg_constraint c
     where c.contype = 'f' and c.connamespace = 'public'::regnamespace`);
  // The query sees the real graph: it finds a tenant table that points at a non-tenant one ...
  expect(rows.length).toBeGreaterThan(30);
  expect(rows).toContainEqual({ from: "customer_homes", to: "pool_accounts" });
  // ... and no foreign key the other way round: not to customers, resources or ledger_accounts either.
  expect(rows.filter((r) => NON_TENANT_TABLES.includes(r.from) && r.to in TENANT_TABLES)).toEqual(
    [],
  );
});

it("the map is frozen: its text goes into SQL that runs as the owner", () => {
  expect(Object.isFrozen(TENANT_TABLES)).toBe(true);
  expect(Object.isFrozen(NON_TENANT_TABLES)).toBe(true);
});
