import type { Tx } from "@tc/db";
import {
  ensureMarket,
  insertRow,
  newCustomer,
  readUsed,
  resetCapacity,
  runTransaction,
  seedPool,
  useTempDatabase,
} from "@tc/db/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { cells, count, INSTANCE, P1, P2, REGION } from "../test/capacity-helpers";
import { checkCapacity } from "./check";
import type { CheckInput } from "./input";
import { reserveCapacity } from "./reserve";

const t = useTempDatabase();
const order = (customerId: string, over: Partial<CheckInput> = {}): CheckInput => ({
  customerId,
  region: REGION,
  needs: INSTANCE,
  ...over,
});
const check = (input: CheckInput) =>
  runTransaction(t.db, (tx: Tx) => checkCapacity(tx, input), { role: "web_rw" });

beforeEach(async () => {
  await ensureMarket(t.pool);
  await resetCapacity(t.pool);
});

describe("checkCapacity", () => {
  it("says available when there is room, and writes nothing: no used unit, no home, no waitlist entry", async () => {
    const p1 = await seedPool(t.pool, { id: P1, cells: cells(4, 0, 5, 0) });
    const a = await newCustomer(t.pool);
    expect(await check(order(a))).toEqual({ ok: true, value: { available: true } });
    expect(await readUsed(t.pool, p1.poolAccountId)).toEqual({
      [`${REGION}/instance_vcpu`]: 0,
      [`${REGION}/static_ip`]: 0,
    });
    expect([
      await count(t.pool, "customer_homes"),
      await count(t.pool, "waitlist_entries"),
    ]).toEqual([0, 0]);
    expect(
      await runTransaction(t.db, (tx: Tx) => reserveCapacity(tx, order(a)), { role: "web_rw" }),
    ).toMatchObject({ ok: true }); // the check did not use the slot
  });
  it("gives the refusals of reserveCapacity, offers the waitlist and never joins it", async () => {
    const a = await newCustomer(t.pool);
    expect(await check(order(a))).toMatchObject({
      error: "capacity_full",
      data: { reason: "not_configured", waitlist: "not_offered" },
    });
    await seedPool(t.pool, { id: P1, cells: cells(4, 4, 5, 0) });
    expect(await check(order(a))).toMatchObject({
      error: "capacity_full",
      data: { reason: "full", waitlist: "offered" },
    });
    expect(
      await check(order(a, { needs: [{ quotaCode: "instance_vcpu", amount: 8 }] })),
    ).toMatchObject({ data: { reason: "too_large", waitlist: "not_offered" } });
    expect(await check(order(a, { region: "Dhaka" }))).toMatchObject({
      ok: false,
      error: "validation",
      fields: { region: expect.any(String) },
    });
    expect(await check(order("0190b8e0-0000-7000-8000-00000000dead"))).toEqual({
      ok: false,
      error: "not_found",
    });
    await expect(check(order("not-a-uuid"))).rejects.toThrow(
      new TypeError("customerRepos: the customer id is not a UUID"),
    );
    expect([
      await count(t.pool, "customer_homes"),
      await count(t.pool, "waitlist_entries"),
    ]).toEqual([0, 0]);
  });
  it("reads the home of the customer: a full home account is full though another account has room", async () => {
    await seedPool(t.pool, { id: P1, cells: cells(4, 4, 5, 0) });
    await seedPool(t.pool, { id: P2, cells: cells(40, 0, 50, 0) });
    const a = await newCustomer(t.pool);
    await insertRow(t.pool, "customer_homes", {
      customer_id: a,
      region: REGION,
      pool_account_id: P1,
    });
    expect(await check(order(a))).toMatchObject({
      error: "capacity_full",
      data: { reason: "full" },
    });
  });
  it("does not wait for a lock that another transaction holds", async () => {
    await seedPool(t.pool, { id: P1, cells: cells(4, 0, 5, 0) });
    const a = await newCustomer(t.pool);
    const holder = await t.pool.connect();
    try {
      await holder.query("begin");
      await holder.query("select id from pool_capacity where pool_account_id = $1 for update", [
        P1,
      ]);
      const answer = await Promise.race([
        check(order(a)),
        new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 2000)),
      ]);
      expect(answer).toEqual({ ok: true, value: { available: true } });
    } finally {
      await holder.query("rollback").catch(() => undefined);
      holder.release();
    }
  });
});
