import type { AdminActor, Tx } from "@tc/db";
import {
  ensureMarket,
  insertRow,
  newAdmin,
  newCustomer,
  resetCapacity,
  runTransaction,
  useTempDatabase,
} from "@tc/db/testing";
import { beforeEach, expect, it, vi } from "vitest";
import { notifyWaitlist, type WaitlistNotifier } from "./waitlist";

const t = useTempDatabase();
const REGION = "ap-southeast-1";
const INPUT = {
  productFamily: "linux_instance",
  region: REGION,
  reason: "capacity" as const,
  count: 1,
  why: "one unit freed",
};
const actor = async (): Promise<AdminActor> => ({
  adminId: await newAdmin(t.pool, "ops"),
  role: "ops",
  ip: "203.0.113.9",
});
const asAdmin = <T>(fn: (tx: Tx) => Promise<T>) => runTransaction(t.db, fn, { role: "admin_rw" });
const joined = async (customerId: string, createdAt: string) =>
  insertRow(t.pool, "waitlist_entries", {
    customer_id: customerId,
    product_family: "linux_instance",
    region: REGION,
    reason: "capacity",
    created_at: createdAt,
  });

beforeEach(async () => {
  await ensureMarket(t.pool);
  await resetCapacity(t.pool);
});

it("notifies each taken entry once, in order, with a notice that holds only the family and the Region", async () => {
  const a = await actor();
  const [c1, c2] = [await newCustomer(t.pool), await newCustomer(t.pool)];
  const e1 = await joined(c1, "2026-11-01T00:01:00Z");
  await joined(c2, "2026-11-01T00:02:00Z");
  const notifier = vi.fn<WaitlistNotifier>(async () => {});
  expect(await asAdmin((tx) => notifyWaitlist(tx, a, INPUT, notifier))).toMatchObject({
    ok: true,
    value: { notified: [{ id: e1, customerId: c1 }] },
  });
  expect(notifier).toHaveBeenCalledTimes(1);
  expect(notifier.mock.calls[0]![1]).toEqual({
    customerId: c1,
    email: null,
    template: "waitlist_capacity_available",
    dedupeKey: `waitlist:${e1}`,
    data: { productFamily: "linux_instance", region: REGION },
  });
});
it("takes the marks back when the notifier fails", async () => {
  const a = await actor();
  const e = await joined(await newCustomer(t.pool), "2026-11-01T00:01:00Z");
  await expect(
    asAdmin((tx) =>
      notifyWaitlist(tx, a, INPUT, async () => {
        throw new Error("notify is down");
      }),
    ),
  ).rejects.toThrow("notify is down");
  expect(
    (await t.pool.query("select notified_at from waitlist_entries where id = $1", [e])).rows[0]
      .notified_at,
  ).toBeNull();
});
it("calls no notifier for a refused request", async () => {
  const a = await actor();
  const notifier = vi.fn(async () => {});
  expect(await asAdmin((tx) => notifyWaitlist(tx, a, { ...INPUT, count: 0 }, notifier))).toEqual({
    ok: false,
    error: "validation",
  });
  expect(notifier).not.toHaveBeenCalled();
});
