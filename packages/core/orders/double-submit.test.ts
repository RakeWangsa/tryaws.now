import { randomUUID } from "node:crypto";
import { useTempDatabase } from "@tc/db/testing";
import { describe, expect, it } from "vitest";
import { walletBalance, walletEntriesSum } from "../ledger/balance";
import {
  makeKit,
  PLAN_TOTAL,
  REGION,
  snapshotRows,
  type Buyer,
  type Kit,
} from "../test/orders-kit";
import { makeOrders } from "./place";

// The first proof of WP4-T4: a double submit with one idempotency key charges once. The concurrency
// cases carry the 20 s timeout of reserve.test.ts (WP4-T3 hardening item H2).
const t = useTempDatabase();
const SLOW = 20_000;

const newKey = () => "k" + randomUUID().replaceAll("-", "");
const place = (kit: Kit, token: string, key: string, who: Buyer = kit) =>
  makeOrders(kit.deps).placeOrder(who.session, { token, idempotencyKey: key });
const count = async (sql: string, params: unknown[]): Promise<number> =>
  ((await t.pool.query(sql, params)).rows[0] as { n: number }).n;

/** What one customer has of each kind, so that "one of everything" is one assertion. */
async function inventory(customerId: string) {
  return {
    purchases: await count(
      `select count(*)::int as n from ledger_transactions x
         join orders o on o.id = x.reference_id
        where x.kind = 'purchase' and o.customer_id = $1`,
      [customerId],
    ),
    orders: await count("select count(*)::int as n from orders where customer_id = $1", [
      customerId,
    ]),
    resources: await count("select count(*)::int as n from resources where customer_id = $1", [
      customerId,
    ]),
    subscriptions: await count(
      "select count(*)::int as n from subscriptions where customer_id = $1",
      [customerId],
    ),
    operations: await count(
      `select count(*)::int as n from operations p join resources r on r.id = p.resource_id
        where r.customer_id = $1`,
      [customerId],
    ),
  };
}
const ONE_OF_EACH = { purchases: 1, orders: 1, resources: 1, subscriptions: 1, operations: 1 };

describe("placeOrder: one draft, one order, one charge", () => {
  it(
    "(a) one key twice at once: both ok with one order id, and one of everything",
    async () => {
      const kit = await makeKit(t);
      const start = await kit.balance();
      const usedBefore = await kit.used();
      const { token } = await kit.draft();
      const key = newKey();
      const [first, second] = await Promise.all([place(kit, token, key), place(kit, token, key)]);
      expect(first.ok && second.ok).toBe(true);
      expect(first).toEqual(second);
      expect(await inventory(kit.customerId)).toEqual(ONE_OF_EACH);
      expect(await kit.balance()).toBe(start - PLAN_TOTAL);
      const usedAfter = await kit.used();
      expect(usedAfter[`${REGION}/instance_vcpu`]).toBe(
        (usedBefore[`${REGION}/instance_vcpu`] ?? 0) + 2,
      );
      expect(usedAfter[`${REGION}/static_ip`]).toBe((usedBefore[`${REGION}/static_ip`] ?? 0) + 1);
      expect(kit.queue.depth).toBe(1);
    },
    SLOW,
  );

  it("(b) the same key again, one after the other: the same answer, nothing more", async () => {
    const kit = await makeKit(t);
    const { token } = await kit.draft();
    const key = newKey();
    const first = await place(kit, token, key);
    const after = await snapshotRows(t);
    expect(first.ok).toBe(true);
    expect(await place(kit, token, key)).toEqual(first);
    expect(await snapshotRows(t)).toEqual(after);
    expect(await inventory(kit.customerId)).toEqual(ONE_OF_EACH);
    expect(kit.queue.depth).toBe(1);
  });

  it("(c) the same token with another client key: the first order, still one of everything", async () => {
    const kit = await makeKit(t);
    const { token } = await kit.draft();
    const first = await place(kit, token, newKey());
    const second = await place(kit, token, newKey());
    expect(second).toEqual(first);
    expect(await inventory(kit.customerId)).toEqual(ONE_OF_EACH);
    // the second client key is not stored: the order keeps the first
    expect(
      await count("select count(*)::int as n from orders where customer_id = $1", [kit.customerId]),
    ).toBe(1);
  });

  it("(d) the same client key with another draft: conflict, and the second call writes nothing", async () => {
    const kit = await makeKit(t);
    const key = newKey();
    const first = await place(kit, (await kit.draft()).token, key);
    expect(first.ok).toBe(true);
    const after = await snapshotRows(t);
    const second = await place(kit, (await kit.draft()).token, key);
    expect(second).toMatchObject({ ok: false, error: "conflict" });
    expect(await snapshotRows(t)).toEqual(after);
  });

  it(
    "(e) five callers, one token, five client keys: one order",
    async () => {
      const kit = await makeKit(t);
      const start = await kit.balance();
      const { token } = await kit.draft();
      const results = await Promise.all(
        Array.from({ length: 5 }, () => place(kit, token, newKey())),
      );
      expect(results.every((r) => r.ok)).toBe(true);
      expect(new Set(results.map((r) => (r.ok ? r.value.orderId : ""))).size).toBe(1);
      expect(await inventory(kit.customerId)).toEqual(ONE_OF_EACH);
      expect(await kit.balance()).toBe(start - PLAN_TOTAL);
      expect(kit.queue.depth).toBe(1);
    },
    SLOW,
  );

  it(
    "(f) the wallet never goes negative: eight drafts for a balance that fits one",
    async () => {
      const kit = await makeKit(t, { balanceMinor: PLAN_TOTAL + 1n });
      const tokens = [];
      for (let i = 0; i < 8; i += 1) tokens.push((await kit.draft()).token);
      const results = await Promise.all(tokens.map((token) => place(kit, token, newKey())));
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok && r.error === "insufficient_balance")).toHaveLength(7);
      expect(await kit.balance()).toBe(1n);
      // the cache equals the ledger
      const [cache, ledger] = await kit.run(async (tx) => [
        await walletBalance(tx, kit.customerId),
        await walletEntriesSum(tx, kit.customerId),
      ]);
      expect(cache).toBe(ledger);
      expect(await inventory(kit.customerId)).toEqual(ONE_OF_EACH);
    },
    SLOW,
  );

  it(
    "(g) reserve once: a pool with room for one instance, two customers at once",
    async () => {
      const kit = await makeKit(t, { vcpuLimit: 2, ipLimit: 1 });
      const other = await kit.newBuyer();
      const mine = (await kit.draft()).token;
      const theirs = (await kit.draft({}, other)).token;
      const [a, b] = await Promise.all([
        place(kit, mine, newKey()),
        place(kit, theirs, newKey(), other),
      ]);
      const results = [
        { buyer: kit as Buyer, result: a },
        { buyer: other, result: b },
      ];
      expect(results.filter((r) => r.result.ok)).toHaveLength(1);
      const loser = results.find((r) => !r.result.ok);
      expect(loser?.result).toMatchObject({ ok: false, error: "capacity_full" });
      // the loser's wallet and rows are untouched
      expect(await kit.balance(loser?.buyer.customerId)).toBe(10_000_000n);
      expect(
        await count("select count(*)::int as n from orders where customer_id = $1", [
          loser?.buyer.customerId,
        ]),
      ).toBe(0);
      expect(
        await count("select count(*)::int as n from customer_homes where customer_id = $1", [
          loser?.buyer.customerId,
        ]),
      ).toBe(0);
      const used = await kit.used();
      expect(used[`${REGION}/instance_vcpu`]).toBe(2);
      expect(used[`${REGION}/static_ip`]).toBe(1);
    },
    SLOW,
  );

  it("(h) a queue that refuses does not change the result: the order is ok and committed", async () => {
    const logs: unknown[] = [];
    const kit = await makeKit(t);
    const deps = { ...kit.deps, log: (event: unknown) => void logs.push(event) };
    kit.queue.failNextSends(1);
    const { token } = await kit.draft();
    const key = newKey();
    const r = await makeOrders(deps as typeof kit.deps).placeOrder(kit.session, {
      token,
      idempotencyKey: key,
    });
    expect(r.ok).toBe(true);
    expect(await inventory(kit.customerId)).toEqual(ONE_OF_EACH);
    expect(kit.queue.depth).toBe(0);
    // a fixed-text event, without the token, the key or any id (R14)
    expect(logs).toEqual([{ event: "orders.queue_send_failed" }]);
  });
});

describe("placeOrder: the order is bought at the price of the draft", () => {
  it("charges exactly the total of the token", async () => {
    const kit = await makeKit(t);
    const start = await kit.balance();
    const draft = await kit.draft();
    expect((await place(kit, draft.token, newKey())).ok).toBe(true);
    expect(await kit.balance()).toBe(start - draft.quote.totalMinor);
  });
});
