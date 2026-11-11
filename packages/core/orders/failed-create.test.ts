import { newAdmin, runTransaction, useTempDatabase } from "@tc/db/testing";
import { describe, expect, it } from "vitest";
import { walletEntriesSum } from "../ledger/balance";
import { reverseTransaction } from "../ledger/reverse";
import { makeKit, placeOne, type Kit } from "../test/orders-kit";
import { compensateFailedCreate } from "./compensate";

// The second proof of WP4-T4: a failed create refunds once, whatever the number of calls, their
// timing, or an admin who was first.
const t = useTempDatabase();
const SLOW = 20_000;

const hook = (kit: Kit, resourceId: string) =>
  runTransaction(
    t.db,
    (tx) =>
      compensateFailedCreate(tx, kit.deps, {
        resourceId,
        customerId: kit.customerId,
        code: "step_failed",
      }),
    { role: "worker_rw" },
  );
const count = async (sql: string, params: unknown[]): Promise<number> =>
  ((await t.pool.query(sql, params)).rows[0] as { n: number }).n;
const reversalsOf = (orderId: string) =>
  count(
    `select count(*)::int as n from ledger_transactions x
      where x.kind = 'reversal' and x.reference_id = (select ledger_transaction_id from orders where id = $1)`,
    [orderId],
  );

/** What must hold after any number of hook calls, whoever refunded. */
async function expectRefundedOnce(kit: Kit, orderId: string, resourceId: string, start: bigint) {
  expect(await reversalsOf(orderId)).toBe(1);
  expect(await kit.balance()).toBe(start);
  expect(await kit.run((tx) => walletEntriesSum(tx, kit.customerId))).toBe(start);
  expect(
    (
      (await t.pool.query("select status from orders where id = $1", [orderId])).rows[0] as {
        status: string;
      }
    ).status,
  ).toBe("reversed");
  expect(
    (
      (await t.pool.query("select status from subscriptions where resource_id = $1", [resourceId]))
        .rows[0] as { status: string }
    ).status,
  ).toBe("ended");
  expect(
    (
      (await t.pool.query("select state from resources where id = $1", [resourceId])).rows[0] as {
        state: string;
      }
    ).state,
  ).toBe("failed");
}

describe("the failed hook of a create", () => {
  it("(a) run twice in a row: one reversal, the balance restored once, the capacity lowered once", async () => {
    const kit = await makeKit(t);
    const start = await kit.balance();
    const usedStart = await kit.used();
    const { orderId, resourceId } = await placeOne(kit);
    expect(await hook(kit, resourceId)).toEqual({
      reversed: true,
      released: true,
      replayed: false,
    });
    expect(await hook(kit, resourceId)).toEqual({
      reversed: true,
      released: false,
      replayed: true,
    });
    await expectRefundedOnce(kit, orderId, resourceId, start);
    expect(await kit.used()).toEqual(usedStart);
  });

  it(
    "(b) run twice at once in two transactions: the same, with no deadlock",
    async () => {
      const kit = await makeKit(t);
      const start = await kit.balance();
      const usedStart = await kit.used();
      const { orderId, resourceId } = await placeOne(kit);
      const [a, b] = await Promise.all([hook(kit, resourceId), hook(kit, resourceId)]);
      expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
      expect([a.released, b.released].sort()).toEqual([false, true]);
      await expectRefundedOnce(kit, orderId, resourceId, start);
      expect(await kit.used()).toEqual(usedStart);
    },
    SLOW,
  );

  it("(c) after an admin reversed the purchase first: still one reversal, the capacity released once", async () => {
    const kit = await makeKit(t);
    const start = await kit.balance();
    const usedStart = await kit.used();
    const { orderId, resourceId } = await placeOne(kit);
    const [purchase] = (
      await t.pool.query("select ledger_transaction_id as id from orders where id = $1", [orderId])
    ).rows as { id: string }[];
    const adminId = await newAdmin(t.pool, "finance");
    const reversed = await kit.owner((tx) =>
      reverseTransaction(tx, {
        transactionId: purchase?.id ?? "",
        actor: { type: "admin", id: adminId },
        memo: "test: an admin reverses first",
      }),
    );
    expect(reversed.ok).toBe(true);
    await hook(kit, resourceId);
    await expectRefundedOnce(kit, orderId, resourceId, start);
    expect(await kit.used()).toEqual(usedStart);
    // the hook did not post under its own key: the admin's key is the only one
    expect(
      await count("select count(*)::int as n from ledger_transactions where idempotency_key = $1", [
        "order-reversal:" + orderId,
      ]),
    ).toBe(0);
  });

  it("(g) shows the refund to the customer: a reversal line for the order, and the balance of before", async () => {
    const kit = await makeKit(t);
    const start = await kit.balance();
    const { orderId, resourceId } = await placeOne(kit);
    expect(await kit.balance()).toBeLessThan(start);
    await hook(kit, resourceId);
    expect(await reversalsOf(orderId)).toBe(1);
    expect(await kit.balance()).toBe(start);
  });

  it("(i) leaves the order of another customer alone", async () => {
    const kit = await makeKit(t);
    const other = await kit.newBuyer();
    const mine = await placeOne(kit);
    const theirs = await placeOne(kit, other);
    await hook(kit, mine.resourceId);
    expect(await kit.balance(other.customerId)).toBeLessThan(10_000_000n);
    expect(
      (
        (await t.pool.query("select status from orders where id = $1", [theirs.orderId]))
          .rows[0] as { status: string }
      ).status,
    ).toBe("paid");
  });
});
