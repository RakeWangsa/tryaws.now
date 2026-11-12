import { randomUUID } from "node:crypto";
import { useTempDatabase } from "@tc/db/testing";
import { describe, expect, it } from "vitest";
import { walletBalance, walletEntriesSum } from "../ledger/balance";
import { checkLedger } from "../ledger/check";
import { makeKit, PLAN_TOTAL, REGION, type Buyer, type Kit } from "../test/orders-kit";
import { makeOrders } from "./place";

// WP9-T3 (a): 50 orders (draft, then place) at once, from the same and from different customers, against
// a pool with little room and wallets with little money. The real createOrderDraft and placeOrder run
// over real PostgreSQL; the adapters are stubs (the create operation only reaches an in-memory queue, so
// no AWS client exists). The pool of the temporary database has ten connections, so the transactions
// really overlap on the wallet lock and on the capacity cells. Fixed counts and no sleeps: the totals
// below follow from the limits whatever the order of the arrivals is. The buyers are of the trusted
// tier, so the limit of two instances of a new customer (10.2) does not hide the two limits under test.
const t = useTempDatabase();
const SLOW = 60_000;
const VCPU_PER_ORDER = 2;
const IP_PER_ORDER = 1;
const MANY = 10_000_000_000n; // a wallet that never limits

type Outcome =
  | { ok: true; orderId: string; buyer: string; key: string }
  | { ok: false; error: string; buyer: string; key: string };

const newKey = () => "k" + randomUUID().replaceAll("-", "");

async function attempt(kit: Kit, who: Buyer, token?: string, key = newKey()): Promise<Outcome> {
  const orders = makeOrders(kit.deps);
  let signed = token;
  if (signed === undefined) {
    const drafted = await orders.createOrderDraft(who.session, kit.input());
    if (!drafted.ok) {
      return { ok: false, error: `draft:${drafted.error}`, buyer: who.customerId, key };
    }
    signed = drafted.value.token;
  }
  const placed = await orders.placeOrder(who.session, { token: signed, idempotencyKey: key });
  return placed.ok
    ? { ok: true, orderId: placed.value.orderId, buyer: who.customerId, key }
    : { ok: false, error: placed.error, buyer: who.customerId, key };
}

async function buyers(kit: Kit, count: number, balanceMinor: bigint): Promise<Buyer[]> {
  const out: Buyer[] = [];
  for (let i = 0; i < count; i++)
    out.push(await kit.newBuyer({ balanceMinor, riskTier: "trusted" }));
  return out;
}

const rows = async (sql: string, params: unknown[] = []) => (await t.pool.query(sql, params)).rows;
const countOf = async (table: string, ids: string[]): Promise<number> =>
  Number(
    (
      await rows(`select count(*)::int as n from ${table} where customer_id = any($1::uuid[])`, [
        ids,
      ])
    )[0].n,
  );

/** Everything that must hold after any storm of orders. Returns the distinct orders that were made. */
async function expectSound(
  kit: Kit,
  who: Buyer[],
  funded: bigint,
  results: Outcome[],
): Promise<string[]> {
  const ids = who.map((b) => b.customerId);
  const made = new Set(results.filter((r) => r.ok).map((r) => (r as { orderId: string }).orderId));

  // No double spend. A wallet never goes below zero; the cache equals the ledger; every buyer paid for
  // exactly the orders that are theirs, once each.
  for (const b of who) {
    const own = new Set(
      results
        .filter((r) => r.ok && r.buyer === b.customerId)
        .map((r) => (r as { orderId: string }).orderId),
    );
    const balance = await kit.owner((tx) => walletBalance(tx, b.customerId));
    expect(balance >= 0n).toBe(true);
    expect(balance).toBe(await kit.owner((tx) => walletEntriesSum(tx, b.customerId)));
    expect(balance).toBe(funded - BigInt(own.size) * PLAN_TOTAL);
  }
  expect((await kit.owner((tx) => checkLedger(tx))).ok).toBe(true);

  // Exactly one order per idempotency key, and one of everything per order. A loser wrote nothing:
  // the counts equal the number of distinct orders that were reported as made.
  expect(
    await rows(
      `select idempotency_key, count(*)::int as n from orders where customer_id = any($1::uuid[])
        group by 1 having count(*) > 1`,
      [ids],
    ),
  ).toEqual([]);
  expect(await countOf("orders", ids)).toBe(made.size);
  expect(await countOf("resources", ids)).toBe(made.size);
  expect(await countOf("subscriptions", ids)).toBe(made.size);
  expect(
    (
      await rows(
        `select count(*)::int as n from ledger_transactions x join orders o on o.id = x.reference_id
          where x.kind = 'purchase' and o.customer_id = any($1::uuid[])`,
        [ids],
      )
    )[0].n,
  ).toBe(made.size);
  expect(
    (
      await rows(
        `select count(*)::int as n from operations p join resources r on r.id = p.resource_id
          where p.kind = 'create' and r.customer_id = any($1::uuid[])`,
        [ids],
      )
    )[0].n,
  ).toBe(made.size);
  expect(await countOf("waitlist_entries", ids)).toBe(0);

  // No over-reservation. used never exceeds the limit, and it equals the units of the live reservations.
  expect(
    await rows("select 1 from pool_capacity where pool_account_id = $1 and used > quota_limit", [
      kit.poolAccountId,
    ]),
  ).toEqual([]);
  const reserved = await rows(
    `select c->>'region' as region, c->>'quotaCode' as code, sum((c->>'amount')::int)::int as units
       from resources r, jsonb_array_elements(r.config #> '{capacityReservation,cells}') c
      where r.customer_id = any($1::uuid[]) and r.config #>> '{capacityReservation,releasedAt}' is null
      group by 1, 2`,
    [ids],
  );
  const live = Object.fromEntries(
    reserved.map((r) => [`${r.region}/${r.code}`, r.units as number]),
  );
  const used = await kit.used();
  expect(used[`${REGION}/instance_vcpu`] ?? 0).toBe(live[`${REGION}/instance_vcpu`] ?? 0);
  expect(used[`${REGION}/static_ip`] ?? 0).toBe(live[`${REGION}/static_ip`] ?? 0);
  expect(used[`${REGION}/instance_vcpu`] ?? 0).toBe(made.size * VCPU_PER_ORDER);
  expect(used[`${REGION}/static_ip`] ?? 0).toBe(made.size * IP_PER_ORDER);

  return [...made];
}

const refusals = (results: Outcome[]) =>
  results.filter((r) => !r.ok).map((r) => (r as { error: string }).error);

describe("50 orders at once (WP9-T3 a)", () => {
  it(
    "limited capacity, plenty of money: exactly 10 orders, 40 clean capacity_full refusals",
    async () => {
      // Room for 10 instances: 20 vCPU and 10 static IPs. 10 buyers place 5 orders each.
      const kit = await makeKit(t, { vcpuLimit: 20, ipLimit: 10, riskTier: "trusted" });
      const who = await buyers(kit, 10, MANY);
      const results = await Promise.all(
        who.flatMap((b) => Array.from({ length: 5 }, () => attempt(kit, b))),
      );
      expect(results).toHaveLength(50);
      expect(results.filter((r) => r.ok)).toHaveLength(10);
      expect(refusals(results)).toEqual(Array(40).fill("capacity_full"));
      await expectSound(kit, who, MANY, results);
    },
    SLOW,
  );

  it(
    "limited money, plenty of room: exactly 10 orders, 40 clean insufficient_balance refusals",
    async () => {
      // Each buyer can pay for two orders and not for a third. 5 buyers place 10 orders each.
      const funded = 3n * PLAN_TOTAL - 1n;
      const kit = await makeKit(t, { vcpuLimit: 200, ipLimit: 100, riskTier: "trusted" });
      const who = await buyers(kit, 5, funded);
      const results = await Promise.all(
        who.flatMap((b) => Array.from({ length: 10 }, () => attempt(kit, b))),
      );
      expect(results).toHaveLength(50);
      expect(results.filter((r) => r.ok)).toHaveLength(10);
      expect(refusals(results)).toEqual(Array(40).fill("insufficient_balance"));
      for (const b of who) {
        expect(await kit.owner((tx) => walletBalance(tx, b.customerId))).toBe(
          funded - 2n * PLAN_TOTAL,
        );
      }
      await expectSound(kit, who, funded, results);
    },
    SLOW,
  );

  it(
    "both limited: room for 12, money for 2 orders each, 10 buyers: exactly 12 orders, every refusal is clean",
    async () => {
      const funded = 3n * PLAN_TOTAL - 1n;
      const kit = await makeKit(t, { vcpuLimit: 24, ipLimit: 12, riskTier: "trusted" });
      const who = await buyers(kit, 10, funded);
      const results = await Promise.all(
        who.flatMap((b) => Array.from({ length: 5 }, () => attempt(kit, b))),
      );
      expect(results).toHaveLength(50);
      // 10 buyers could pay for 20 orders, the pool takes 12: the pool is full at the end, so the
      // totals do not depend on who arrived first.
      expect(results.filter((r) => r.ok)).toHaveLength(12);
      for (const e of refusals(results)) {
        expect(["capacity_full", "insufficient_balance"]).toContain(e);
      }
      expect(refusals(results)).toHaveLength(38);
      await expectSound(kit, who, funded, results);
    },
    SLOW,
  );

  it(
    "the same draft and the same key five times at once for each of 10 buyers, room for 6: one order per key",
    async () => {
      const kit = await makeKit(t, { vcpuLimit: 12, ipLimit: 6, riskTier: "trusted" });
      const who = await buyers(kit, 10, MANY);
      // The drafts are made first (they do not touch the wallet or the pool); then 50 placements.
      const drafts = await Promise.all(
        who.map(async (b) => ({
          b,
          key: newKey(),
          token: (await kit.draft({}, b)).token,
        })),
      );
      const results = await Promise.all(
        drafts.flatMap(({ b, key, token }) =>
          Array.from({ length: 5 }, () => attempt(kit, b, token, key)),
        ),
      );
      expect(results).toHaveLength(50);
      const byKey = new Map<string, Outcome[]>();
      for (const r of results) byKey.set(r.key, [...(byKey.get(r.key) ?? []), r]);
      expect(byKey.size).toBe(10);
      let winners = 0;
      for (const same of byKey.values()) {
        const oks = same.filter((r) => r.ok) as Array<Extract<Outcome, { ok: true }>>;
        // A key has one answer: all five report the same order, or all five are refused for room.
        if (oks.length > 0) {
          winners += 1;
          expect(oks).toHaveLength(5);
          expect(new Set(oks.map((r) => r.orderId)).size).toBe(1);
        } else {
          expect(refusals(same)).toEqual(Array(5).fill("capacity_full"));
        }
      }
      expect(winners).toBe(6);
      const made = await expectSound(kit, who, MANY, results);
      expect(made).toHaveLength(6);
    },
    SLOW,
  );
});
