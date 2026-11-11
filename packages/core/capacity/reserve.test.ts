import type { Tx } from "@tc/db";
import {
  ensureMarket,
  holdUntilWaiter,
  insertRow,
  newCustomer,
  readUsed,
  resetCapacity,
  runTransaction,
  seedPool,
  useTempDatabase,
} from "@tc/db/testing";
import { beforeEach, describe, expect, it } from "vitest";
import {
  cells,
  homesOf,
  INSTANCE,
  OTHER_REGION,
  P1,
  P2,
  REGION,
  used,
  waitlistOf,
} from "../test/capacity-helpers";
import type { ReserveInput } from "./input";
import { reserveCapacity } from "./reserve";

const t = useTempDatabase();
const order = (customerId: string, over: Partial<ReserveInput> = {}): ReserveInput => ({
  customerId,
  region: REGION,
  needs: INSTANCE,
  ...over,
});
// Runs as web_rw, like the purchase transaction. With `hold`, a winner keeps its locks until another transaction is really waiting for them.
const reserve = (input: ReserveInput, hold = false) =>
  runTransaction(
    t.db,
    async (tx: Tx) => {
      const r = await reserveCapacity(tx, input);
      if (hold && r.ok) await holdUntilWaiter(tx, 5);
      return r;
    },
    { role: "web_rw" },
  );
const homes = (customerId: string) => homesOf(t.pool, customerId);
const waitlist = () => waitlistOf(t.pool);

beforeEach(async () => {
  await ensureMarket(t.pool);
  await resetCapacity(t.pool);
});

describe("reserveCapacity", () => {
  it("reserves every need in the first account by id and records the home", async () => {
    const p1 = await seedPool(t.pool, { id: P1, cells: cells(4, 0, 5, 0) });
    await seedPool(t.pool, { id: P2, cells: cells(4, 0, 5, 0) });
    const a = await newCustomer(t.pool);
    expect(await reserve(order(a))).toEqual({
      ok: true,
      value: {
        poolAccountId: P1,
        homeCreated: true,
        record: {
          v: 1,
          poolAccountId: P1,
          cells: [
            { quotaCode: "instance_vcpu", region: REGION, amount: 2 },
            { quotaCode: "static_ip", region: REGION, amount: 1 },
          ],
        },
      },
    });
    expect(await readUsed(t.pool, p1.poolAccountId)).toEqual(used(2, 1));
    expect(await homes(a)).toEqual([{ region: REGION, pool_account_id: P1 }]);
  });
  it("keeps a customer in its home account, even when that account is full and another has room", async () => {
    await seedPool(t.pool, { id: P1, cells: cells(4, 0, 5, 0) });
    const p2 = await seedPool(t.pool, { id: P2, cells: cells(40, 0, 50, 0) });
    const a = await newCustomer(t.pool);
    expect(await reserve(order(a))).toMatchObject({ ok: true, value: { poolAccountId: P1 } });
    expect(await reserve(order(a))).toMatchObject({
      ok: true,
      value: { poolAccountId: P1, homeCreated: false },
    });
    expect(await reserve(order(a))).toMatchObject({
      ok: false,
      error: "capacity_full",
      data: { reason: "full", waitlist: "offered" },
    });
    expect(await readUsed(t.pool, p2.poolAccountId)).toEqual(used(0, 0));
    expect(await homes(a)).toEqual([{ region: REGION, pool_account_id: P1 }]);
  });
  it("gives a customer a home per Region, and leaves the first home as it was", async () => {
    await seedPool(t.pool, { id: P1, cells: cells(4, 0, 5, 0) });
    await seedPool(t.pool, {
      id: P2,
      cells: [
        { region: OTHER_REGION, quotaCode: "instance_vcpu", limit: 4 },
        { region: OTHER_REGION, quotaCode: "static_ip", limit: 5 },
      ],
    });
    const a = await newCustomer(t.pool);
    expect(await reserve(order(a))).toMatchObject({
      ok: true,
      value: { poolAccountId: P1, homeCreated: true },
    });
    expect(await reserve(order(a, { region: OTHER_REGION }))).toMatchObject({
      ok: true,
      value: { poolAccountId: P2, homeCreated: true },
    });
    expect(await homes(a)).toEqual([
      { region: OTHER_REGION, pool_account_id: P2 },
      { region: REGION, pool_account_id: P1 },
    ]);
  });
  it("homes a first purchase by the tier in the customers row, and refuses it when only a pool of the other tier exists", async () => {
    await seedPool(t.pool, { id: P1, tier: "trusted", cells: cells(4, 0, 5, 0) });
    await seedPool(t.pool, { id: P2, tier: "new", cells: cells(4, 0, 5, 0) });
    const trusted = await newCustomer(t.pool, { risk_tier: "trusted" });
    expect(await reserve(order(trusted))).toMatchObject({ value: { poolAccountId: P1 } });
    expect(await reserve(order(await newCustomer(t.pool)))).toMatchObject({
      value: { poolAccountId: P2 },
    });
    await resetCapacity(t.pool);
    const only = await seedPool(t.pool, { id: P1, tier: "trusted", cells: cells(4, 0, 5, 0) });
    const fresh = await newCustomer(t.pool); // risk_tier new: no field of the call can say otherwise
    expect(await reserve(order(fresh))).toMatchObject({
      error: "capacity_full",
      data: { reason: "not_configured" },
    });
    expect(await homes(fresh)).toEqual([]);
    expect(await readUsed(t.pool, only.poolAccountId)).toEqual(used(0, 0));
  });
  it("is all or nothing, and a refused first order leaves no home, no used unit and no waitlist entry", async () => {
    const p1 = await seedPool(t.pool, { id: P1, cells: cells(4, 0, 5, 5) });
    const a = await newCustomer(t.pool);
    expect(await reserve(order(a))).toMatchObject({
      ok: false,
      error: "capacity_full",
      data: { reason: "full" },
    });
    expect(await readUsed(t.pool, p1.poolAccountId)).toEqual(used(0, 5));
    expect(await homes(a)).toEqual([]);
    expect(await waitlist()).toEqual([]);
  });
  it("takes the reservation, the home and the waitlist back when the purchase transaction fails after it", async () => {
    const p1 = await seedPool(t.pool, { id: P1, cells: cells(4, 0, 5, 0) });
    const a = await newCustomer(t.pool);
    await expect(
      runTransaction(
        t.db,
        async (tx: Tx) => {
          expect((await reserveCapacity(tx, order(a))).ok).toBe(true);
          throw new Error("the order insert failed");
        },
        { role: "web_rw" },
      ),
    ).rejects.toThrow("the order insert failed");
    expect(await readUsed(t.pool, p1.poolAccountId)).toEqual(used(0, 0));
    expect(await homes(a)).toEqual([]);
    expect(await waitlist()).toEqual([]);
  });
  it("answers too_large and not_configured, and offers no waitlist for them", async () => {
    const a = await newCustomer(t.pool);
    expect(await reserve(order(a))).toMatchObject({
      error: "capacity_full",
      data: { reason: "not_configured", waitlist: "not_offered" },
    });
    const p1 = await seedPool(t.pool, {
      id: P1,
      cells: [{ region: REGION, quotaCode: "instance_vcpu", limit: 4 }],
    });
    expect(await reserve(order(a))).toMatchObject({ data: { reason: "not_configured" } });
    expect(await readUsed(t.pool, p1.poolAccountId)).toEqual({ [`${REGION}/instance_vcpu`]: 0 });
    await seedPool(t.pool, { id: P2, cells: cells(4, 0, 5, 0) });
    const big = [
      { quotaCode: "instance_vcpu", amount: 8 },
      { quotaCode: "static_ip", amount: 1 },
    ] as const;
    expect(await reserve(order(a, { needs: big }))).toMatchObject({
      data: { reason: "too_large", waitlist: "not_offered" },
    });
  });
  it("treats an account with a limit of 0 as full, offers the waitlist, and joins when asked", async () => {
    const p1 = await seedPool(t.pool, { id: P1, cells: cells(0, 0, 5, 0) });
    const a = await newCustomer(t.pool);
    expect(await reserve(order(a))).toMatchObject({
      error: "capacity_full",
      data: { reason: "full", waitlist: "offered" },
    });
    const joined = await reserve(
      order(a, { waitlist: { productFamily: "linux_instance", idempotencyKey: "k" } }),
    );
    expect(joined).toMatchObject({
      error: "capacity_full",
      data: { reason: "full", waitlist: "joined" },
    });
    expect(await waitlist()).toHaveLength(1);
    expect(await readUsed(t.pool, p1.poolAccountId)).toEqual(used(0, 0));
  });
  it("leaves the reserve of a quota unsold", async () => {
    await seedPool(t.pool, { id: P1, cells: cells(4, 2, 5, 0) });
    await insertRow(t.pool, "settings", {
      key: "capacity.reserve.instance_vcpu",
      market: "BD",
      scope: "market",
      value: "1",
    });
    const a = await newCustomer(t.pool);
    expect(await reserve(order(a))).toMatchObject({
      error: "capacity_full",
      data: { reason: "full" },
    });
    expect(
      await reserve(order(a, { needs: [{ quotaCode: "instance_vcpu", amount: 1 }] })),
    ).toMatchObject({ ok: true });
  });
  it("takes nothing from an account that is not active, not even for its home", async () => {
    const p1 = await seedPool(t.pool, { id: P1, cells: cells(4, 0, 5, 0) });
    const a = await newCustomer(t.pool);
    expect(await reserve(order(a))).toMatchObject({ ok: true });
    await t.pool.query("update pool_accounts set status = 'disabled' where id = $1", [P1]);
    expect(await reserve(order(a))).toMatchObject({
      error: "capacity_full",
      data: { reason: "not_configured" },
    });
    expect(await reserve(order(await newCustomer(t.pool)))).toMatchObject({
      data: { reason: "not_configured" },
    });
    expect(await readUsed(t.pool, p1.poolAccountId)).toEqual(used(2, 1));
  });
  it("writes one waitlist entry when asked, once per key, and none for a request that cannot be served", async () => {
    await seedPool(t.pool, { id: P1, cells: cells(4, 4, 5, 0) });
    const a = await newCustomer(t.pool);
    const ask = (key: string, needs: ReserveInput["needs"] = INSTANCE) =>
      reserve(
        order(a, { needs, waitlist: { productFamily: "linux_instance", idempotencyKey: key } }),
      );
    const first = await ask("k1");
    expect(first).toMatchObject({
      ok: false,
      data: { reason: "full", waitlist: "joined", waitlistEntryId: expect.any(String) },
    });
    expect(await ask("k1")).toEqual(first);
    expect(await waitlist()).toHaveLength(1);
    await ask("k2");
    expect(await waitlist()).toHaveLength(2);
    expect(await ask("k3", [{ quotaCode: "instance_vcpu", amount: 8 }])).toMatchObject({
      data: { reason: "too_large", waitlist: "not_offered" },
    });
    expect(await waitlist()).toEqual(
      Array(2).fill({
        customer_id: a,
        product_family: "linux_instance",
        region: REGION,
        reason: "capacity",
      }),
    );
  });
  it("uses the global row of an account-wide quota and the row of the Region that a need names", async () => {
    const p1 = await seedPool(t.pool, {
      id: P1,
      cells: [
        { region: "global", quotaCode: "bucket", limit: 20, used: 19 },
        { region: "us-east-1", quotaCode: "certificate_active", limit: 10 },
      ],
    });
    const a = await newCustomer(t.pool);
    const needs = [
      { quotaCode: "bucket", amount: 1 },
      { quotaCode: "certificate_active", amount: 1, region: "us-east-1" },
    ] as const;
    expect(await reserve(order(a, { needs }))).toMatchObject({ ok: true });
    expect(await readUsed(t.pool, p1.poolAccountId)).toEqual({
      "global/bucket": 20,
      "us-east-1/certificate_active": 1,
    });
    expect(await reserve(order(a, { needs }))).toMatchObject({
      error: "capacity_full",
      data: { reason: "full" },
    });
  });
  it("refuses a bad input before any query, answers not_found for an unknown customer, and throws for a customer id that is not a UUID", async () => {
    const a = await newCustomer(t.pool);
    const bad: [Partial<ReserveInput>, string][] = [
      [{ region: "Dhaka" }, "region"],
      [{ needs: [] }, "needs"],
      [{ needs: [{ quotaCode: "static_ip", amount: 0 }] }, "needs"],
      [{ waitlist: { productFamily: "Linux", idempotencyKey: "k" } }, "waitlist"],
      [{ waitlist: { productFamily: "linux_instance", idempotencyKey: "" } }, "waitlist"],
    ];
    for (const [over, field] of bad)
      expect(await reserve(order(a, over))).toMatchObject({
        ok: false,
        error: "validation",
        fields: { [field]: expect.any(String) },
      });
    expect(await reserve(order("0190b8e0-0000-7000-8000-00000000dead"))).toEqual({
      ok: false,
      error: "not_found",
    });
    await expect(reserve(order("not-a-uuid"))).rejects.toThrow(
      new TypeError("customerRepos: the customer id is not a UUID"),
    );
  });
  it("rejects with the database error when the first read fails (R16)", async () => {
    // profile.get is the first read, a Drizzle select: it fails and the error is not turned into an answer
    const down = {
      execute: () => Promise.reject(new Error("db down")),
      select: () => {
        throw new Error("db down");
      },
    } as unknown as Tx;
    await expect(
      reserveCapacity(down, order("0190b8e0-0000-7000-8000-000000000000")),
    ).rejects.toThrow("db down");
  });
  it("gives a customer one home when two of its first orders run at the same moment", async () => {
    const p1 = await seedPool(t.pool, { id: P1, cells: cells(2, 0, 1, 0) });
    const p2 = await seedPool(t.pool, { id: P2, cells: cells(4, 0, 5, 0) });
    const a = await newCustomer(t.pool);
    // the winner holds its locks until the other order is waiting for them
    const [x, y] = await Promise.all([reserve(order(a), true), reserve(order(a), true)]);
    expect([x.ok, y.ok].sort()).toEqual([false, true]);
    expect(x.ok ? y : x).toEqual({ ok: false, error: "conflict" });
    expect(await homes(a)).toEqual([{ region: REGION, pool_account_id: P1 }]);
    expect(await readUsed(t.pool, p1.poolAccountId)).toEqual(used(2, 1));
    expect(await readUsed(t.pool, p2.poolAccountId)).toEqual(used(0, 0));
  }, 20000);
});
