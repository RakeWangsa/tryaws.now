import { adminRepos, RESERVATION_CONFIG_KEY, type AdminActor, type Tx } from "@tc/db";
import {
  ensureMarket,
  insertPurchasedResource,
  newAdmin,
  newCustomer,
  readUsed,
  resetCapacity,
  runTransaction,
  seedPool,
  setResourceState,
  useTempDatabase,
  type DatabaseRole,
} from "@tc/db/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { releaseCapacity } from "./release";
import type { ReserveInput } from "./input";
import { reserveCapacity, type Reservation } from "./reserve";
import { notifyWaitlist, type WaitlistNotifier } from "./waitlist";

const t = useTempDatabase();
const REGION = "ap-southeast-1";
const P1 = "00000000-0000-7000-8000-000000000001";
let sequence = 0;
const newResourceId = () => `0190b8e0-0000-7000-8000-${String(++sequence).padStart(12, "0")}`; // `@tc/core` has no `uuid` of its own
const clock = { now: () => new Date("2026-11-11T08:00:00.000Z") };
const INSTANCE = [
  { quotaCode: "instance_vcpu", amount: 2 },
  { quotaCode: "static_ip", amount: 1 },
] as const;
const as = <T>(role: DatabaseRole, fn: (tx: Tx) => Promise<T>) =>
  runTransaction(t.db, fn, { role });
const order = (customerId: string, over: Partial<ReserveInput> = {}): ReserveInput => ({
  customerId,
  region: REGION,
  needs: INSTANCE,
  ...over,
});
const room = (vcpuLimit: number, ipLimit: number) => [
  { region: REGION, quotaCode: "instance_vcpu" as const, limit: vcpuLimit },
  { region: REGION, quotaCode: "static_ip" as const, limit: ipLimit },
];
const used = (vcpu: number, ip: number) => ({
  [`${REGION}/instance_vcpu`]: vcpu,
  [`${REGION}/static_ip`]: ip,
});
// What placeOrder does in the purchase transaction: reserve, then insert the resource with the record in its config.
async function buy(
  customerId: string,
): Promise<{ reservation: Reservation; resourceId: string } | null> {
  return as("web_rw", async (tx) => {
    const r = await reserveCapacity(tx, order(customerId));
    if (!r.ok) return null;
    const resourceId = newResourceId();
    await insertPurchasedResource(tx, {
      resourceId,
      customerId,
      poolAccountId: r.value.poolAccountId,
      region: REGION,
      config: { bundle: "nano", [RESERVATION_CONFIG_KEY]: r.value.record },
    });
    return { reservation: r.value, resourceId };
  });
}

beforeEach(async () => {
  await ensureMarket(t.pool);
  await resetCapacity(t.pool);
});

describe("the life of a slot", () => {
  it("a failed create gives the slot back once, and the next order gets it", async () => {
    await seedPool(t.pool, { id: P1, cells: room(2, 1) });
    const [a, b] = [await newCustomer(t.pool), await newCustomer(t.pool)];
    const first = await buy(a);
    expect(first).not.toBeNull();
    expect(await buy(b)).toBeNull();
    await as("worker_rw", async (tx) => {
      // the failure step of 10.1
      await setResourceState(tx, first!.resourceId, "failed");
      await releaseCapacity(tx, { resourceId: first!.resourceId, clock });
    });
    expect(await readUsed(t.pool, P1)).toEqual(used(0, 0));
    expect(
      await as("worker_rw", (tx) => releaseCapacity(tx, { resourceId: first!.resourceId, clock })),
    ).toEqual({ ok: true, value: { released: false, reason: "already_released" } });
    expect(await buy(b)).not.toBeNull();
    expect(await readUsed(t.pool, P1)).toEqual(used(2, 1));
  });
  it("a destroy gives the slot back in the transaction that marks the resource destroyed, and a restore reserves again in the same home", async () => {
    await seedPool(t.pool, { id: P1, cells: room(2, 1) });
    const a = await newCustomer(t.pool);
    const bought = await buy(a);
    await as("worker_rw", async (tx) => {
      await setResourceState(tx, bought!.resourceId, "destroyed");
      await releaseCapacity(tx, { resourceId: bought!.resourceId, clock });
    });
    expect(await readUsed(t.pool, P1)).toEqual(used(0, 0));
    expect((await buy(a))?.reservation).toMatchObject({ poolAccountId: P1, homeCreated: false });
  });
  it("a pool account that an admin adds takes the next first orders, and never moves a customer who has a home", async () => {
    await seedPool(t.pool, { id: P1, cells: room(2, 1) });
    const admin: AdminActor = {
      adminId: await newAdmin(t.pool, "ops"),
      role: "ops",
      ip: "203.0.113.9",
    };
    const [a, b] = [await newCustomer(t.pool), await newCustomer(t.pool)];
    expect(await buy(a)).not.toBeNull();
    expect(await buy(b)).toBeNull();
    const added = await as("admin_rw", (tx) =>
      adminRepos(tx, admin).capacity.addPoolAccount(
        {
          awsAccountId: "210987654321",
          name: "tc-pool-n2",
          tier: "new",
          roleArn: "arn:aws:iam::210987654321:role/TcProvisioner",
          externalId: "ext-n2",
          limits: room(20, 5),
        },
        "second pool",
      ),
    );
    expect((await buy(b))?.reservation.poolAccountId).toBe(added.ok ? added.value.id : "");
    expect(await buy(a)).toBeNull(); // a is at home in P1, which is full
  });
  it("a notice is not a hold: the first order to arrive gets the freed slot", async () => {
    const pool = await seedPool(t.pool, { id: P1, cells: room(2, 1) });
    const admin: AdminActor = {
      adminId: await newAdmin(t.pool, "ops"),
      role: "ops",
      ip: "203.0.113.9",
    };
    const [a, b, c] = [
      await newCustomer(t.pool),
      await newCustomer(t.pool),
      await newCustomer(t.pool),
    ];
    expect(await buy(a)).not.toBeNull();
    for (const [customer, key] of [
      [b, "kb"],
      [c, "kc"],
    ] as const) {
      const r = await as("web_rw", (tx) =>
        reserveCapacity(
          tx,
          order(customer, { waitlist: { productFamily: "linux_instance", idempotencyKey: key } }),
        ),
      );
      expect(r).toMatchObject({ ok: false, data: { reason: "full", waitlist: "joined" } });
    }
    // AWS raises the quota by one instance; the admin records it and tells the first in line
    for (const [quotaCode, limit] of [
      ["instance_vcpu", 4],
      ["static_ip", 2],
    ] as const) {
      await as("admin_rw", (tx) =>
        adminRepos(tx, admin).capacity.setLimit(
          { poolAccountId: pool.poolAccountId, region: REGION, quotaCode, limit },
          "quota raised",
        ),
      );
    }
    const notifier = vi.fn<WaitlistNotifier>(async () => {});
    const told = await as("admin_rw", (tx) =>
      notifyWaitlist(
        tx,
        admin,
        {
          productFamily: "linux_instance",
          region: REGION,
          reason: "capacity",
          count: 1,
          why: "one slot",
        },
        notifier,
      ),
    );
    expect(told).toMatchObject({ ok: true, value: { notified: [{ customerId: b }] } });
    expect(notifier).toHaveBeenCalledTimes(1);
    expect((await t.pool.query("select count(*)::int as n from resources")).rows[0].n).toBe(1); // only the resource of a: a notice creates nothing
    expect(await buy(c)).not.toBeNull(); // c was not told, and arrives first
    expect(await buy(b)).toBeNull(); // b was told and finds the slot gone
    expect(await readUsed(t.pool, pool.poolAccountId)).toEqual(used(4, 2));
  });
});

describe("the purchase transaction around a reservation", () => {
  const homes = async () =>
    (await t.pool.query("select count(*)::int as n from customer_homes")).rows[0].n as number;
  it("a purchase that throws after reserveCapacity leaves used, the home and the waitlist as they were", async () => {
    await seedPool(t.pool, { id: P1, cells: room(2, 1) });
    const a = await newCustomer(t.pool);
    await expect(
      as("web_rw", async (tx) => {
        expect((await reserveCapacity(tx, order(a))).ok).toBe(true);
        throw new Error("the ledger post failed");
      }),
    ).rejects.toThrow("the ledger post failed");
    expect(await readUsed(t.pool, P1)).toEqual(used(0, 0));
    expect(await homes()).toBe(0);
  });
  it("a purchase that RETURNS a failure after reserveCapacity commits the reservation: this is why placeOrder must throw there", async () => {
    await seedPool(t.pool, { id: P1, cells: room(2, 1) });
    const a = await newCustomer(t.pool);
    const answer = await as("web_rw", async (tx) => {
      await reserveCapacity(tx, order(a));
      return { ok: false, error: "insufficient_balance" } as const; // withTx commits whatever its function returns
    });
    expect(answer).toEqual({ ok: false, error: "insufficient_balance" });
    expect(await readUsed(t.pool, P1)).toEqual(used(2, 1)); // units held for an order that did not happen
    expect(await homes()).toBe(1); // and a home that no app role can undo
  });
});
