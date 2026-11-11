import type { Tx } from "@tc/db";
import {
  ensureMarket,
  holdUntilWaiter,
  newCustomer,
  readUsed,
  resetCapacity,
  runTransaction,
  seedPool,
  useTempDatabase,
} from "@tc/db/testing";
import { beforeEach, expect, it } from "vitest";
import { cells, homesOf, REGION, used, waitlistOf } from "../test/capacity-helpers";
import type { ReserveInput } from "./input";
import { reserveCapacity } from "./reserve";

const t = useTempDatabase();
// What the review flow does in two requests, in one transaction: the order, then the click on the waitlist.
const order = (customerId: string): ReserveInput => ({
  customerId,
  region: REGION,
  needs: [
    { quotaCode: "instance_vcpu", amount: 2 },
    { quotaCode: "static_ip", amount: 1 },
  ],
  waitlist: { productFamily: "linux_instance", idempotencyKey: "order-" + customerId },
});
// With `hold`, the order that reserved keeps its locks until the other order is really waiting for them
// (no fixed sleep: on a slow machine the other order could arrive after a commit).
const place = (input: ReserveInput, hold = true) =>
  runTransaction(
    t.db,
    async (tx: Tx) => {
      const r = await reserveCapacity(tx, input);
      const sawWaiter = hold && r.ok ? await holdUntilWaiter(tx, 5) : false;
      return { r, sawWaiter };
    },
    { role: "web_rw" },
  );
const waitlist = () => waitlistOf(t.pool);
const homes = (customerId: string) => homesOf(t.pool, customerId);

beforeEach(async () => {
  await ensureMarket(t.pool);
  await resetCapacity(t.pool);
});

it("two orders race for the last slot: one reserves it, the other is refused and joins the waitlist", async () => {
  const pool = await seedPool(t.pool, { tier: "trusted", cells: cells(20, 18, 5, 4) });
  const a = await newCustomer(t.pool, { risk_tier: "trusted" });
  const b = await newCustomer(t.pool, { risk_tier: "trusted" });
  const [pa, pb] = await Promise.all([place(order(a)), place(order(b))]);
  const [ra, rb] = [pa.r, pb.r];
  const [winner, loser, refused, winnerRun] = ra.ok ? [a, b, rb, pa] : [b, a, ra, pb];
  expect([ra.ok, rb.ok].sort()).toEqual([false, true]);
  expect(refused).toMatchObject({
    ok: false,
    error: "capacity_full",
    data: { reason: "full", waitlist: "joined" },
  });
  expect(winnerRun.sawWaiter).toBe(true); // the second order really waited for the first
  expect(await readUsed(t.pool, pool.poolAccountId)).toEqual(used(20, 5));
  expect(await waitlist()).toEqual([
    { customer_id: loser, product_family: "linux_instance", region: REGION, reason: "capacity" },
  ]);
  expect(await homes(winner)).toHaveLength(1);
  expect(await homes(loser)).toEqual([]);
});

it("eight orders race for three slots: three reserve, five join the waitlist, used equals the limit", async () => {
  const pool = await seedPool(t.pool, { cells: cells(20, 0, 5, 2) });
  const customers = await Promise.all(Array.from({ length: 8 }, () => newCustomer(t.pool)));
  const results = (await Promise.all(customers.map((c) => place(order(c), false)))).map((x) => x.r);
  expect(results.filter((r) => r.ok)).toHaveLength(3);
  expect(results.filter((r) => !r.ok && r.error === "capacity_full")).toHaveLength(5);
  expect(await readUsed(t.pool, pool.poolAccountId)).toEqual(used(6, 5));
  expect(await waitlist()).toHaveLength(5);
});
