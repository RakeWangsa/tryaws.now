import { beforeEach, expect, it } from "vitest";
import type { CustomerRepos } from "../repositories/customer/index";
import type { WaitlistJoin } from "../repositories/customer/waitlist";
import { resetCapacity, seedPool } from "../testing/capacity";
import { withCustomerRepos } from "../testing/repos";
import { ensureMarket, newCustomer } from "./fixtures";
import { useTempDatabase } from "./temp-db";

const t = useTempDatabase();
const REGION = "ap-southeast-1";
const as = <T>(customerId: string, fn: (r: CustomerRepos) => Promise<T>) =>
  withCustomerRepos(t.db, customerId, fn);
const join = (key: string, over: Partial<WaitlistJoin> = {}): WaitlistJoin => ({
  productFamily: "linux_instance",
  region: REGION,
  reason: "capacity",
  idempotencyKey: key,
  ...over,
});
const rows = async () =>
  (
    await t.pool.query(
      "select customer_id, email, product_family, region, reason, notified_at from waitlist_entries order by region, id",
    )
  ).rows;

beforeEach(async () => {
  await ensureMarket(t.pool);
  await resetCapacity(t.pool);
});

it("joins once per request and key, with an id that comes from the customer and the request", async () => {
  const a = await newCustomer(t.pool);
  const first = await as(a, (r) => r.waitlist.join(join("k1")));
  expect(first).toMatchObject({ ok: true, replayed: false, value: { id: expect.any(String) } });
  expect(await as(a, (r) => r.waitlist.join(join("k1")))).toEqual({
    ok: true,
    replayed: true,
    value: first.ok ? first.value : null,
  });
  expect(await as(a, (r) => r.waitlist.join(join("k2")))).toMatchObject({
    ok: true,
    replayed: false,
  });
  expect(await as(a, (r) => r.waitlist.join(join("k1", { region: "ap-south-1" })))).toMatchObject({
    ok: true,
    replayed: false,
  });
  const all = await rows();
  expect(all).toHaveLength(3);
  expect(all[0]).toEqual({
    customer_id: a,
    email: null,
    product_family: "linux_instance",
    region: "ap-south-1",
    reason: "capacity",
    notified_at: null,
  });
});
it("keeps two customers with the same key apart, and takes flag_off as a reason", async () => {
  const [a, b] = [await newCustomer(t.pool), await newCustomer(t.pool)];
  const x = await as(a, (r) => r.waitlist.join(join("same", { reason: "flag_off" })));
  const y = await as(b, (r) => r.waitlist.join(join("same", { reason: "flag_off" })));
  expect(x.ok && y.ok && x.value.id !== y.value.id).toBe(true);
  expect((await rows()).map((r) => r.reason)).toEqual(["flag_off", "flag_off"]);
});
it("refuses a bad request before any query", async () => {
  const a = await newCustomer(t.pool);
  const bad = [
    join("k", { productFamily: "Linux" }),
    join("k", { productFamily: "" }),
    join("k", { region: "x" }),
    join("k", { reason: "other" as never }),
    join(""),
    join("k".repeat(129)),
  ];
  for (const input of bad)
    expect(await as(a, (r) => r.waitlist.join(input))).toEqual({ ok: false, error: "validation" });
  expect(await rows()).toEqual([]);
});
it("gives one row when the same request arrives twice at the same moment", async () => {
  const a = await newCustomer(t.pool);
  const both = await Promise.all([
    as(a, (r) => r.waitlist.join(join("race"))),
    as(a, (r) => r.waitlist.join(join("race"))),
  ]);
  expect(both.map((r) => r.ok && r.replayed).sort()).toEqual([false, true]);
  expect(await rows()).toHaveLength(1);
});
it("neither waits for a lock on the capacity rows nor changes a used unit", async () => {
  const pool = await seedPool(t.pool, {
    cells: [{ region: REGION, quotaCode: "static_ip", limit: 5, used: 5 }],
  });
  const a = await newCustomer(t.pool);
  const holder = await t.pool.connect();
  try {
    await holder.query("begin");
    await holder.query("select id from pool_capacity where pool_account_id = $1 for update", [
      pool.poolAccountId,
    ]);
    const answer = await Promise.race([
      as(a, (r) => r.waitlist.join(join("k"))),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 2000)),
    ]);
    expect(answer).toMatchObject({ ok: true, replayed: false });
  } finally {
    await holder.query("rollback").catch(() => undefined);
    holder.release();
  }
  expect(
    (
      await t.pool.query("select used from pool_capacity where pool_account_id = $1", [
        pool.poolAccountId,
      ])
    ).rows,
  ).toEqual([{ used: 5 }]);
  expect(await rows()).toHaveLength(1);
});
