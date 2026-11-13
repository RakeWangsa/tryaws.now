// WPU-Z12 (written without a database in the sandbox: it needs PostgreSQL, NOT RUN here; run with pnpm db:up). The
// finding of the WPU-Z1 review: a held subscription stays active with its old period end, so it stays at the head of
// the candidate list; with more held ones than one page (500), a subscription behind them was never examined again
// (no renewal, no grace, no end of retention). The pass now walks every page of the list: the one behind them is
// renewed in the same sweep. Own database; the rate is kept fresh (keepFxFresh), so only the price snapshots below
// hold anything.
import type { Tx } from "@tc/db";
import { newCustomer, runTransaction, useTempDatabase } from "@tc/db/testing";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LogEvent } from "../operations/types";
import { makeKit, placeOne, START, type Kit } from "../test/orders-kit";
import { LIFECYCLE_LIMIT, runLifecycle } from "./engine";

const t = useTempDatabase();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
let kit: Kit;

const worker = <T>(fn: (tx: Tx) => Promise<T>) => runTransaction(t.db, fn, { role: "worker_rw" });
let logged: LogEvent[] = [];
const sweep = (pageSize?: number) =>
  runLifecycle({
    runTx: worker,
    clock: kit.clock,
    log: (e) => void logged.push(e),
    ...(pageSize === undefined ? {} : { pageSize }),
  });
const q = async (sql: string, params: unknown[] = []) =>
  (await t.pool.query(sql, params)).rows as Record<string, unknown>[];

// A purchased, activated instance with auto-renew on, bought at START (its period ends at START + 30 days), of a new
// customer whose wallet covers the renewal.
async function renewable(): Promise<{ subscriptionId: string; end: Date }> {
  kit.clock.set(START);
  const buyer = await kit.newBuyer({ balanceMinor: 50_000_000n });
  const { resourceId } = await placeOne(kit, buyer);
  const s = (
    await q("select id, period_end from subscriptions where resource_id = $1", [resourceId])
  )[0]!;
  await q("update resources set state = 'active' where id = $1", [resourceId]);
  await q("update operations set state = 'succeeded' where resource_id = $1", [resourceId]);
  await q("update subscriptions set auto_renew = true where id = $1", [s.id]);
  return { subscriptionId: String(s.id), end: s.period_end as Date };
}

// `count` subscriptions of the customer, each of a resource of its own, in two statements: active, auto-renew on,
// all with the SAME period end (so a page boundary falls inside a tie that the id breaks), and a price snapshot that
// does not parse: the renewal fails with `internal` and is held for price_unavailable (WPU-Z1). The customer needs a
// wallet for that: renewSubscription locks it before it prices; without one the row fails instead.
async function heldRows(customerId: string, count: number, end: Date): Promise<string[]> {
  const { rows } = await t.pool.query<{ id: string }>(
    `with r as (
       insert into resources (id, customer_id, family, state, config)
       select gen_random_uuid(), $1::uuid, 'linux_instance', 'active', '{}'::jsonb
       from generate_series(1, $2::int)
       returning id)
     insert into subscriptions
       (id, resource_id, customer_id, term_days, price_snapshot, period_start, period_end, auto_renew, status)
     select gen_random_uuid(), r.id, $1::uuid, 30, '{"v": 0}'::jsonb,
            $3::timestamptz - interval '30 days', $3::timestamptz, true, 'active'
     from r
     returning id`,
    [customerId, count, end.toISOString()],
  );
  return rows.map((r) => r.id);
}

const renewals = async (subscriptionId: string) =>
  Number(
    (
      await q(
        "select count(*)::int as n from ledger_transactions where kind = 'renewal' and reference_id = $1",
        [subscriptionId],
      )
    )[0]!.n,
  );
const periodOf = async (subscriptionId: string) => {
  const row = (
    await q("select status, period_start, period_end from subscriptions where id = $1", [
      subscriptionId,
    ])
  )[0]!;
  return {
    status: String(row.status),
    start: row.period_start as Date,
    end: row.period_end as Date,
  };
};
// The held ones as stored: still active, the marker of a price hold, no suspend queued.
const heldState = async (ids: readonly string[]) =>
  (
    await q(
      `select count(*) filter (where s.status = 'active')::int as active,
              count(*) filter (where r.config->'fxRateHold'->>'reason' = 'price_unavailable')::int as marked,
              (select count(*)::int from operations o
                 join subscriptions x on x.resource_id = o.resource_id
                where x.id = any($1::uuid[]) and o.kind = 'suspend') as suspends
         from subscriptions s join resources r on r.id = s.resource_id
        where s.id = any($1::uuid[])`,
      [ids],
    )
  )[0]!;
const heldLines = () => logged.filter((e) => e.event === "lifecycle_renewal_held");

beforeAll(async () => {
  kit = await makeKit(t, { keepFxFresh: true });
});

// Every case starts from an empty candidate list: the rows of an earlier case are ended (an ended subscription is no
// candidate), so the counts of a report are the case's own.
beforeEach(async () => {
  await t.pool.query("update subscriptions set status = 'ended' where status <> 'ended'");
  logged = [];
});

describe("the lifecycle pass walks every candidate (keyset paging, WPU-Z12)", () => {
  it("more held subscriptions than one page, then a renewable one: the renewable one is renewed in the same sweep", async () => {
    const r = await renewable();
    const holder = await kit.newBuyer({ balanceMinor: 50_000_000n });
    // One more than a page, all ending an hour BEFORE the renewable one: the first page holds only held rows.
    const held = await heldRows(
      holder.customerId,
      LIFECYCLE_LIMIT + 1,
      new Date(r.end.getTime() - HOUR),
    );
    expect(held).toHaveLength(501);

    kit.clock.set(new Date(r.end.getTime() + MINUTE));
    expect(await sweep()).toEqual({
      examined: LIFECYCLE_LIMIT + 2,
      reminded: 0,
      renewed: 1,
      graced: 0,
      retained: 0,
      ended: 0,
      failed: 0,
    });
    // Renewed once, from the OLD period end.
    expect(await renewals(r.subscriptionId)).toBe(1);
    const renewed = await periodOf(r.subscriptionId);
    expect(renewed.status).toBe("active");
    expect(renewed.start.getTime()).toBe(r.end.getTime());
    // Every held subscription was examined once and held: one line each, nothing charged, graced or suspended.
    expect(heldLines()).toHaveLength(held.length);
    expect(new Set(heldLines().map((e) => e.subscriptionId))).toEqual(new Set(held));
    expect(await heldState(held)).toEqual({ active: 501, marked: 501, suspends: 0 });
    expect(await kit.balance(holder.customerId)).toBe(50_000_000n);

    // R7: a second sweep at the same instant starts again at the head. The renewed subscription is no candidate any
    // more (its period end is 30 days ahead, beyond the 7 reminder days); the held ones are examined again and stay
    // held; nothing is charged twice.
    logged = [];
    expect(await sweep()).toEqual({
      examined: LIFECYCLE_LIMIT + 1,
      reminded: 0,
      renewed: 0,
      graced: 0,
      retained: 0,
      ended: 0,
      failed: 0,
    });
    expect(await renewals(r.subscriptionId)).toBe(1);
    expect(heldLines()).toHaveLength(held.length);
    expect(await heldState(held)).toEqual({ active: 501, marked: 501, suspends: 0 });
  }, 300_000);

  it("a subscription that fails does not stop the walk across pages, and the counts stay right", async () => {
    const r = await renewable();
    const holder = await kit.newBuyer({ balanceMinor: 50_000_000n });
    const held = await heldRows(holder.customerId, 3, new Date(r.end.getTime() - 2 * HOUR));
    // A customer without a wallet: the renewal throws (no_wallet), so the row fails, an hour before the renewable one.
    const broken = await heldRows(await newCustomer(t.pool), 1, new Date(r.end.getTime() - HOUR));

    kit.clock.set(new Date(r.end.getTime() + MINUTE));
    // Pages of two: [held, held], [held, broken], [renewable].
    expect(await sweep(2)).toEqual({
      examined: 5,
      reminded: 0,
      renewed: 1,
      graced: 0,
      retained: 0,
      ended: 0,
      failed: 1,
    });
    expect(await renewals(r.subscriptionId)).toBe(1);
    expect(logged).toContainEqual(
      expect.objectContaining({ event: "lifecycle", action: "error", subscriptionId: broken[0] }),
    );
    expect(new Set(heldLines().map((e) => e.subscriptionId))).toEqual(new Set(held));
    // The failed row is left as it was (its transaction rolled back) and is a candidate again next sweep.
    expect((await periodOf(broken[0]!)).status).toBe("active");
  });
});
