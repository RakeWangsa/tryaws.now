import { v7 as uuidv7 } from "uuid";
import { beforeAll, expect, it } from "vitest";
import type { CustomerRepos } from "../repositories/customer/index";
import type { NewPaidOrder } from "../repositories/customer/orders";
import { withCustomerRepos } from "../testing/repos";
import { newCustomer, newLedgerTransaction, newPoolAccount, uniqueSuffix } from "./fixtures";
import { insertRow } from "./sql";
import { useTempDatabase } from "./temp-db";

const t = useTempDatabase();
const as = <T>(customerId: string, fn: (r: CustomerRepos) => Promise<T>) =>
  withCustomerRepos(t.db, customerId, fn);

let productId: string;
let poolAccountId: string;

beforeAll(async () => {
  productId = await insertRow(t.pool, "catalog_products", {
    family: "instance",
    aws_id: "small_3_0-" + uniqueSuffix(),
    platform: "linux",
    region: "ap-south-1",
    aws_price_usd: "3.5",
    billing_unit: "month",
    feature_flag: "linux_instance",
    synced_at: "2026-11-11T00:00:00Z",
  });
  poolAccountId = await newPoolAccount(t.pool);
});

async function paid(customerId: string, over: Partial<NewPaidOrder> = {}): Promise<NewPaidOrder> {
  return {
    id: uuidv7(),
    items: [{ family: "instance" }],
    priceSnapshot: { v: 1, totalMinor: "100" },
    totalMinor: 100n,
    ledgerTransactionId: await newLedgerTransaction(t.pool, customerId),
    idempotencyKey: "key-" + uniqueSuffix(),
    ...over,
  };
}
const orderRows = async (customerId: string) =>
  (await t.pool.query("select * from orders where customer_id = $1", [customerId])).rows;

it("creates a paid order and reads it back through each finder", async () => {
  const a = await newCustomer(t.pool);
  const input = await paid(a);
  const result = await as(a, (r) => r.orders.createPaid(input));
  expect(result).toMatchObject({
    ok: true,
    replayed: false,
    value: {
      id: input.id,
      kind: "new",
      items: input.items,
      priceSnapshot: input.priceSnapshot,
      totalMinor: 100n,
      ledgerTransactionId: input.ledgerTransactionId,
      idempotencyKey: input.idempotencyKey,
      status: "paid",
    },
  });
  const created = result.ok ? result.value : null;
  expect(created?.createdAt).toBeInstanceOf(Date);
  expect(await as(a, (r) => r.orders.get(input.id))).toEqual(created);
  expect(await as(a, (r) => r.orders.findByIdempotencyKey(input.idempotencyKey))).toEqual(created);
  expect(await as(a, (r) => r.orders.findByLedgerTransaction(input.ledgerTransactionId))).toEqual(
    created,
  );
});

it("answers null for an unknown id, key and transaction, and for an id that is not a UUID", async () => {
  const a = await newCustomer(t.pool);
  expect(await as(a, (r) => r.orders.get(uuidv7()))).toBeNull();
  expect(await as(a, (r) => r.orders.get("not-a-uuid"))).toBeNull();
  expect(await as(a, (r) => r.orders.findByIdempotencyKey("nothing-here-1234"))).toBeNull();
  expect(await as(a, (r) => r.orders.findByLedgerTransaction(uuidv7()))).toBeNull();
  expect(await as(a, (r) => r.orders.findByLedgerTransaction("nope"))).toBeNull();
});

it("replays the same key and ledger transaction and leaves one row", async () => {
  const a = await newCustomer(t.pool);
  const input = await paid(a);
  const first = await as(a, (r) => r.orders.createPaid(input));
  const second = await as(a, (r) => r.orders.createPaid(input));
  expect(first).toMatchObject({ ok: true, replayed: false });
  expect(second).toMatchObject({ ok: true, replayed: true });
  expect(second.ok && first.ok && second.value).toEqual(first.ok && first.value);
  expect(await orderRows(a)).toHaveLength(1);
});

it("refuses the same key with another ledger transaction as conflict and writes nothing", async () => {
  const a = await newCustomer(t.pool);
  const input = await paid(a);
  await as(a, (r) => r.orders.createPaid(input));
  const other = await paid(a, { idempotencyKey: input.idempotencyKey });
  expect(await as(a, (r) => r.orders.createPaid(other))).toEqual({ ok: false, error: "conflict" });
  const rows = await orderRows(a);
  expect(rows).toHaveLength(1);
  expect(rows[0].ledger_transaction_id).toBe(input.ledgerTransactionId);
});

it("writes the total as the bigint and reads a total above 2^53 back exactly", async () => {
  const a = await newCustomer(t.pool);
  const big = 9007199254740993n; // 2^53 + 1
  const input = await paid(a, { totalMinor: big });
  const result = await as(a, (r) => r.orders.createPaid(input));
  expect(result.ok && result.value.totalMinor).toBe(big);
  const { rows } = await t.pool.query(
    "select total_minor::text as total from orders where id = $1",
    [input.id],
  );
  expect(rows[0].total).toBe("9007199254740993");
  expect((await as(a, (r) => r.orders.get(input.id)))?.totalMinor).toBe(big);
});

it("refuses inputs it can check itself before any query", async () => {
  const a = await newCustomer(t.pool);
  const input = await paid(a);
  expect(await as(a, (r) => r.orders.createPaid({ ...input, totalMinor: -1n }))).toEqual({
    ok: false,
    error: "validation",
  });
  expect(await as(a, (r) => r.orders.createPaid({ ...input, idempotencyKey: "" }))).toEqual({
    ok: false,
    error: "validation",
  });
  await expect(as(a, (r) => r.orders.createPaid({ ...input, id: "x" }))).rejects.toBeInstanceOf(
    TypeError,
  );
  expect(await orderRows(a)).toHaveLength(0);
});

it("B's createPaid with A's key writes B's own row and leaves A's row as it was", async () => {
  const a = await newCustomer(t.pool);
  const b = await newCustomer(t.pool);
  const forA = await paid(a);
  await as(a, (r) => r.orders.createPaid(forA));
  const before = await orderRows(a);
  const forB = await paid(b, { idempotencyKey: forA.idempotencyKey });
  expect(await as(b, (r) => r.orders.createPaid(forB))).toMatchObject({
    ok: true,
    replayed: false,
  });
  expect(await orderRows(a)).toEqual(before);
  expect(await orderRows(b)).toHaveLength(1);
  // The lookup by key finds each customer's own row.
  expect((await as(a, (r) => r.orders.findByIdempotencyKey(forA.idempotencyKey)))?.id).toBe(
    forA.id,
  );
  expect((await as(b, (r) => r.orders.findByIdempotencyKey(forA.idempotencyKey)))?.id).toBe(
    forB.id,
  );
});

it("creates a resource that starts in creating, with the granted columns only", async () => {
  const a = await newCustomer(t.pool);
  const id = uuidv7();
  const result = await as(a, (r) =>
    r.orders.createResource({
      id,
      family: "instance",
      productId,
      poolAccountId,
      region: "ap-south-1",
      config: { displayName: "web" },
    }),
  );
  expect(result).toEqual({ ok: true, replayed: false, value: { id } });
  const { rows } = await t.pool.query(
    "select customer_id, family, state, region, config, aws_name from resources where id = $1",
    [id],
  );
  expect(rows[0]).toEqual({
    customer_id: a,
    family: "instance",
    state: "creating",
    region: "ap-south-1",
    config: { displayName: "web" },
    aws_name: null,
  });
});

it("refuses a pool account or product that is not a UUID with a TypeError", async () => {
  const a = await newCustomer(t.pool);
  const base = {
    id: uuidv7(),
    family: "instance",
    productId,
    poolAccountId,
    region: "ap-south-1",
    config: {},
  };
  await expect(
    as(a, (r) => r.orders.createResource({ ...base, poolAccountId: "1; drop table x" })),
  ).rejects.toBeInstanceOf(TypeError);
  await expect(
    as(a, (r) => r.orders.createResource({ ...base, productId: "nope" })),
  ).rejects.toBeInstanceOf(TypeError);
});

// WPU-Z2: a purchase turns auto-renew on. The value given is stored, not the column default (false),
// so both values are written and read back.
it("creates a subscription for the customer's own resource, with the auto-renew it is given", async () => {
  const a = await newCustomer(t.pool);
  const periodStart = new Date("2026-11-11T10:00:00.000Z");
  const periodEnd = new Date("2026-12-11T10:00:00.000Z");
  for (const autoRenew of [true, false]) {
    const resourceId = uuidv7();
    await as(a, (r) =>
      r.orders.createResource({
        id: resourceId,
        family: "instance",
        productId,
        poolAccountId,
        region: "ap-south-1",
        config: {},
      }),
    );
    const id = uuidv7();
    const result = await as(a, (r) =>
      r.orders.createSubscription({
        id,
        resourceId,
        termDays: 30,
        priceSnapshot: { v: 1 },
        periodStart,
        periodEnd,
        autoRenew,
      }),
    );
    expect(result).toEqual({ ok: true, replayed: false, value: { id } });
    const { rows } = await t.pool.query(
      "select customer_id, resource_id, term_days, status, auto_renew, period_start, period_end from subscriptions where id = $1",
      [id],
    );
    expect(rows[0]).toEqual({
      customer_id: a,
      resource_id: resourceId,
      term_days: 30,
      status: "active",
      auto_renew: autoRenew,
      period_start: periodStart,
      period_end: periodEnd,
    });
  }
});

it("refuses an auto-renew that is not a boolean before any query, and writes nothing (R16)", async () => {
  const a = await newCustomer(t.pool);
  const resourceId = await insertRow(t.pool, "resources", { customer_id: a, family: "instance" });
  const result = await as(a, (r) =>
    r.orders.createSubscription({
      id: uuidv7(),
      resourceId,
      termDays: 30,
      priceSnapshot: {},
      periodStart: new Date("2026-11-11T10:00:00.000Z"),
      periodEnd: new Date("2026-12-11T10:00:00.000Z"),
      autoRenew: "true" as unknown as boolean,
    }),
  );
  expect(result).toEqual({ ok: false, error: "validation" });
  expect(
    (await t.pool.query("select 1 from subscriptions where resource_id = $1", [resourceId])).rows,
  ).toHaveLength(0);
});

it("refuses a subscription for another customer's resource, or a missing one, as not_found", async () => {
  const a = await newCustomer(t.pool);
  const b = await newCustomer(t.pool);
  const resourceId = await insertRow(t.pool, "resources", { customer_id: a, family: "instance" });
  const input = (id: string) => ({
    id: uuidv7(),
    resourceId: id,
    termDays: 30,
    priceSnapshot: {},
    periodStart: new Date("2026-11-11T10:00:00.000Z"),
    periodEnd: new Date("2026-12-11T10:00:00.000Z"),
    autoRenew: true,
  });
  expect(await as(b, (r) => r.orders.createSubscription(input(resourceId)))).toEqual({
    ok: false,
    error: "not_found",
  });
  expect(await as(b, (r) => r.orders.createSubscription(input(uuidv7())))).toEqual({
    ok: false,
    error: "not_found",
  });
  expect(await as(b, (r) => r.orders.createSubscription(input("nope")))).toEqual({
    ok: false,
    error: "not_found",
  });
  expect(
    (await t.pool.query("select 1 from subscriptions where resource_id = $1", [resourceId])).rows,
  ).toHaveLength(0);
});

it("countLive counts creating and active resources, not failed, destroyed or soft-deleted ones", async () => {
  const a = await newCustomer(t.pool);
  const b = await newCustomer(t.pool);
  const mk = (customer: string, over: Record<string, unknown>) =>
    insertRow(t.pool, "resources", { customer_id: customer, family: "instance", ...over });
  await mk(a, { state: "creating" });
  await mk(a, { state: "active" });
  await mk(a, { state: "stopped" });
  await mk(a, { state: "failed" });
  // resources_deleted_check ties deleted_at to the state destroyed, so a soft-deleted row is one.
  await mk(a, { state: "destroyed", deleted_at: "2026-11-01T00:00:00Z" });
  await mk(a, { state: "active", family: "linux_instance" });
  await mk(b, { state: "active" });
  expect(await as(a, (r) => r.resources.countLive("instance"))).toBe(3);
  expect(await as(a, (r) => r.resources.countLive("linux_instance"))).toBe(1);
  expect(await as(a, (r) => r.resources.countLive("database"))).toBe(0);
  expect(await as(b, (r) => r.resources.countLive("instance"))).toBe(1);
});
