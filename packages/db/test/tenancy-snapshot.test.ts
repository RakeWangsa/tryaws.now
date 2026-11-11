import { v7 as uuidv7 } from "uuid";
import { beforeAll, expect, it } from "vitest";
import { TENANT_TABLES } from "../tenancy";
import { tenantSnapshot } from "../testing/snapshot";
import { useTempDatabase } from "./temp-db";
import { asRole, insertRow, type Queryable } from "./sql";
import { newCustomer, uniqueSuffix } from "./fixtures";
import {
  BIG_AMOUNT,
  seedCrossLinks,
  seedCustomer,
  seedShared,
  type RowIds,
  type Seeded,
} from "./tenancy-seed";

const t = useTempDatabase();

type Snapshot = Record<string, string[]>;
const TABLES = Object.keys(TENANT_TABLES).sort();

// Customer A has everything, a destroyed resource and a bigint of 2^53 + 1 included. Customer B has
// its own rows, and nine rows that point at the rows of A (second links the database does not tie to
// the owner). A third customer, with nothing but its own row, is made where a test needs one.
let a: Seeded;
let b: Seeded;
let links: RowIds;
let snapA: Snapshot;
let snapB: Snapshot;

beforeAll(async () => {
  const shared = await seedShared(t.pool);
  a = await seedCustomer(t.pool, shared, await newCustomer(t.pool), {
    destroyed: true,
    bigEntry: true,
  });
  b = await seedCustomer(t.pool, shared, await newCustomer(t.pool));
  links = await seedCrossLinks(t.pool, shared, b.customerId, a);
  snapA = await tenantSnapshot(t.pool, a.customerId);
  snapB = await tenantSnapshot(t.pool, b.customerId);
}, 60_000);

const idsOf = (snapshot: Snapshot, table: string): string[] => {
  const rows = snapshot[table];
  if (rows === undefined) throw new Error(`the snapshot has no key ${table}`);
  return rows.map((row) => (JSON.parse(row) as { id: string }).id);
};
// Rows come in id order; a uuid sorts as its lower-case text.
const inIdOrder = (ids: readonly string[]): string[] => [...ids].sort();

// A Queryable that records what it is asked and passes it on to the database of the test.
function spy(calls: { text: string; values: unknown[] | undefined }[]): Queryable {
  return {
    query: (text: string, values?: unknown[]) => {
      calls.push({ text, values });
      return t.pool.query(text, values);
    },
  } as unknown as Queryable;
}

it("the seed holds a row in every tenant table, for both customers: a new tenant table fails until it has a seed", () => {
  expect(Object.keys(a.rows).sort()).toEqual(TABLES);
  expect(Object.keys(b.rows).sort()).toEqual(TABLES);
});

it("the seed holds one row that points at a row of A in each of the nine tables with a second path", () => {
  expect(Object.keys(links).sort()).toEqual([
    "dns_zones",
    "domains",
    "invoices",
    "orders",
    "payments",
    "resources",
    "subscriptions",
    "support_requests",
    "wallet_adjustments",
  ]);
});

// The snapshot of a customer holds the rows of the customer, the rows of another customer that point
// at them, and no other row. B owns a resource, an account and a ledger transaction of its own, so a
// predicate that lost its link to the row (and says "any resource of the customer") shows rows of B in
// the snapshot of A. A owns a destroyed resource with an operation, which must not drop out. The rows
// of B that point at A are B's own rows: they are in the snapshot of B as well.
it.each(TABLES)("%s: A sees its own rows and the rows that point at A, B sees its own", (table) => {
  const pointingAtA = links[table] ?? [];
  expect(idsOf(snapA, table)).toEqual(inIdOrder([...(a.rows[table] ?? []), ...pointingAtA]));
  expect(idsOf(snapB, table)).toEqual(inIdOrder([...(b.rows[table] ?? []), ...pointingAtA]));
});

it("the keys are the tenant tables in name order, and a table without a row of the customer is an empty array", async () => {
  expect(Object.keys(snapA)).toEqual(TABLES);
  const alone = await tenantSnapshot(t.pool, await newCustomer(t.pool));
  expect(Object.keys(alone)).toEqual(TABLES);
  expect(Object.entries(alone).filter(([, rows]) => rows.length > 0)).toEqual([
    ["customers", [expect.any(String)]],
  ]);
});

it("a row is the whole jsonb text of the row", async () => {
  const columns = (
    await t.pool.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'resources'",
    )
  ).rows.map((r) => r.column_name);
  const row = snapA
    .resources!.map((text) => JSON.parse(text) as Record<string, unknown>)
    .find((parsed) => parsed.id === a.resource);
  expect(row).toMatchObject({
    id: a.resource,
    customer_id: a.customerId,
    family: "linux_instance",
  });
  expect(Object.keys(row!).sort()).toEqual(columns.sort());
});

it("rows come back in id order, whatever the order they were inserted in", async () => {
  const customer = await newCustomer(t.pool);
  const lo = "00000000-0000-7000-8000-000000000001";
  const hi = "00000000-0000-7000-8000-000000000002";
  // The fingerprints are in the opposite order of the ids, so neither the order of insertion nor the
  // order of the (customer_id, fingerprint) index is the id order.
  for (const [id, fingerprint] of [
    [hi, "SHA256:aaa-" + uniqueSuffix()],
    [lo, "SHA256:zzz-" + uniqueSuffix()],
  ] as const) {
    await insertRow(t.pool, "ssh_keys", {
      id,
      customer_id: customer,
      name: "k",
      public_key: "ssh-ed25519 AAAA",
      fingerprint,
    });
  }
  expect(idsOf(await tenantSnapshot(t.pool, customer), "ssh_keys")).toEqual([lo, hi]);
});

it("a bigint above 2^53 stays exact in the text of the row", () => {
  const rows = snapA.ledger_entries!.filter((row) => row.includes(BIG_AMOUNT));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toContain(`"amount_minor": ${BIG_AMOUNT}`);
});

it("two snapshots of unchanged data are equal", async () => {
  expect(await tenantSnapshot(t.pool, a.customerId)).toEqual(snapA);
});

// Fail closed (R16): a snapshot of nothing would let every before/after check pass.
it("refuses a customer id that is not a string, before any query", async () => {
  const calls: { text: string; values: unknown[] | undefined }[] = [];
  for (const id of [undefined, null, 42, {}, [a.customerId]]) {
    await expect(tenantSnapshot(spy(calls), id as never)).rejects.toThrow(TypeError);
  }
  expect(calls).toEqual([]);
});

it("refuses an id that is no customer, and the message holds no other data", async () => {
  const stranger = uuidv7();
  const error = await tenantSnapshot(t.pool, stranger).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch(/no such customer/);
  expect((error as Error).message).not.toContain(stranger);
});

it("leaves a string that is not a uuid to the database cast", async () => {
  for (const id of ["", "not-a-uuid", "someone@example.test"]) {
    await expect(tenantSnapshot(t.pool, id)).rejects.toMatchObject({ code: "22P02" });
  }
});

it("an upper-case spelling of the id of a customer gives the same snapshot, settings included", async () => {
  const upper = await tenantSnapshot(t.pool, a.customerId.toUpperCase());
  expect(upper.settings).toHaveLength(1);
  expect(upper).toEqual(snapA);
});

it("sends the customer id as the one bound parameter of every statement, never in the SQL text", async () => {
  const calls: { text: string; values: unknown[] | undefined }[] = [];
  await tenantSnapshot(spy(calls), a.customerId);
  expect(calls).toHaveLength(TABLES.length);
  for (const call of calls) {
    expect(call.values).toEqual([a.customerId]);
    expect(call.text).toContain("$1");
    expect(call.text).not.toContain(a.customerId);
  }
});

// It reads every column with to_jsonb(t): only the owner may. A role is refused, never answered with
// a snapshot that looks empty.
it("is for the owner's connection: a connection that took the role web_rw is refused", async () => {
  await expect(
    asRole(t.pool, "web_rw", (c) => tenantSnapshot(c, a.customerId)),
  ).rejects.toMatchObject({ code: "42501" });
});
