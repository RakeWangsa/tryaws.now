import { v7 as uuidv7 } from "uuid";
import { expect, it } from "vitest";
import { NON_TENANT_TABLES, TENANT_TABLES } from "../tenancy";
import { tenantSnapshot } from "../testing/snapshot";
import { useTempDatabase } from "./temp-db";
import { inTransaction, insertRow } from "./sql";
import {
  newCustomer,
  newLedgerAccount,
  newResource,
  postLedger,
  systemAccount,
  uniqueSuffix,
} from "./fixtures";

const t = useTempDatabase();
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

it("every table with a customer_id column is owned through that column", async () => {
  const { rows } = await t.pool.query(
    "select table_name from information_schema.columns where table_schema = 'public' and column_name = 'customer_id'",
  );
  for (const { table_name } of rows)
    expect(TENANT_TABLES[table_name], table_name).toBe("t.customer_id = $1::uuid");
});

it("every owner predicate runs", async () => {
  for (const [table, predicate] of Object.entries(TENANT_TABLES)) {
    const { rows } = await t.pool.query(
      `select count(*)::int as n from ${table} t where ${predicate}`,
      [uuidv7()],
    );
    expect({ table, n: rows[0].n }).toEqual({ table, n: 0 });
  }
});

it("a snapshot holds the rows of one customer, through parents and the ledger, and none of another", async () => {
  const a = await newCustomer(t.pool);
  const b = await newCustomer(t.pool);
  const resource = await newResource(t.pool, a);
  await insertRow(t.pool, "operations", {
    resource_id: resource,
    kind: "reboot",
    idempotency_key: uniqueSuffix(),
  });
  await insertRow(t.pool, "ssh_keys", {
    customer_id: a,
    name: "k",
    public_key: "ssh-ed25519 AAAA",
    fingerprint: "SHA256:" + uniqueSuffix(),
  });
  const wallet = await newLedgerAccount(t.pool, "customer_wallet", a);
  const clearing = await systemAccount(t.pool, "gateway_clearing");
  await inTransaction(t.pool, (c) =>
    postLedger(c, uniqueSuffix(), [
      [clearing, "debit", 1000],
      [wallet, "credit", 1000],
    ]),
  );
  const counts = (s: Record<string, string[]>) =>
    Object.fromEntries(
      Object.entries(s)
        .filter(([, r]) => r.length > 0)
        .map(([k, r]) => [k, r.length]),
    );
  const snapA = await tenantSnapshot(t.pool, a);
  expect(counts(snapA)).toEqual({
    customers: 1,
    ledger_accounts: 1,
    ledger_entries: 1,
    ledger_transactions: 1,
    operations: 1,
    resources: 1,
    ssh_keys: 1,
  });
  expect(snapA.resources![0]).toContain(resource);
  expect(counts(await tenantSnapshot(t.pool, b))).toEqual({ customers: 1 });
});
