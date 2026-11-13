// WPU-Y4 fix round 2 (money review 1) against a real database: the unpaid rule retains a server with its attached
// disk at 7 days; the customer pays; the server's subscription goes back to its former status AND so does the
// disk's, the disk's destroy and final snapshot are cancelled before they ran, its mark goes, and the disk's own
// subscription gets no ledger row (R5). Needs the local PostgreSQL (pnpm db:up).
import type { Tx } from "@tc/db";
import { runTransaction, useTempDatabase } from "@tc/db/testing";
import { beforeAll, expect, it } from "vitest";
import { makeKit, placeOne, type Kit } from "../test/orders-kit";
import { runStaticIpMetering, runUnpaid } from "./index";

const t = useTempDatabase();
let kit: Kit;
const worker = <T>(fn: (tx: Tx) => Promise<T>) => runTransaction(t.db, fn, { role: "worker_rw" });
const q = async (sql: string, params: unknown[] = []) =>
  (await t.pool.query(sql, params)).rows as Record<string, unknown>[];
const DETACHED = new Date("2026-11-11T06:00:00.000Z");
const T0 = new Date("2026-11-11T07:30:00.000Z");
const DAY = 86_400_000;

beforeAll(async () => {
  kit = await makeKit(t);
});

const statusOf = async (resourceId: string) =>
  String(
    (await q("select status from subscriptions where resource_id = $1", [resourceId]))[0]!.status,
  );

it("a payment after the unpaid retention gives the server AND its attached disk back; the disk's destroy is cancelled", async () => {
  const buyer = await kit.newBuyer({ balanceMinor: 20_000_000n });
  const { resourceId: serverId } = await placeOne(kit, buyer);
  await q("update wallets set balance_minor = 0 where customer_id = $1", [buyer.customerId]);
  await q(
    `update resources set state = 'active',
       config = config || jsonb_build_object('staticIpAttached', false, 'detachedAt', $2::text)
     where id = $1`,
    [serverId, DETACHED.toISOString()],
  );
  await q("update operations set state = 'succeeded' where resource_id = $1", [serverId]);
  const diskId = crypto.randomUUID();
  const diskSub = crypto.randomUUID();
  await q(
    `insert into resources (id, customer_id, family, state, config) values ($1, $2, 'disk', 'active', $3::jsonb)`,
    [diskId, buyer.customerId, JSON.stringify({ sizeGb: 32, attachedInstanceId: serverId })],
  );
  await q(
    `insert into subscriptions (id, resource_id, customer_id, term_days, price_snapshot, period_start, period_end, status, auto_renew)
     values ($1, $2, $3, 30, '{}'::jsonb, $4, $5, 'active', false)`,
    [
      diskSub,
      diskId,
      buyer.customerId,
      new Date(T0.getTime() - DAY),
      new Date(T0.getTime() + 30 * DAY),
    ],
  );
  await q(
    `insert into settings (id, key, market, scope, scope_id, value, created_at)
     values (gen_random_uuid(), 'lifecycle_unpaid_enabled', 'BD', 'market', null, 'true'::jsonb, now())`,
  );
  // Fix round 3: a USD to BDT rate older than 7 days prices nothing (WPU-Y1), and the retry of a charge that cannot
  // be priced is "blocked" (no stage, no retention). The rate in force is re-confirmed at the clock before each run,
  // as the lifecycle tests do, so day 7 reaches the deletion stage.
  const unpaid = async (now: Date) => {
    kit.clock.set(now);
    await kit.refreshFx();
    return runUnpaid({ runTx: worker, clock: kit.clock, log: () => undefined });
  };

  kit.clock.set(T0);
  await kit.refreshFx();
  await runStaticIpMetering({ runTx: worker, clock: kit.clock, log: () => undefined });
  await unpaid(T0);
  // The episode started at T0 (the first charge failed for the empty wallet).
  const since = await q("select config ->> 'unpaidSince' as s from resources where id = $1", [
    serverId,
  ]);
  expect(since[0]!.s).toBe(T0.toISOString());
  // 7 days unpaid: the server is retained, and its attached disk with it.
  const day7 = new Date(T0.getTime() + 7 * DAY + 3_600_000);
  expect(await unpaid(day7)).toMatchObject({ retained: 1 });
  expect(await statusOf(serverId)).toBe("retained");
  expect(await statusOf(diskId)).toBe("retained");
  const diskOps = await q(
    "select kind from operations where resource_id = $1 order by created_at, id",
    [diskId],
  );
  expect(diskOps.map((o) => o.kind)).toEqual(["final_snapshot", "destroy"]);
  const ledgerBefore = Number(
    (
      await q("select count(*)::int as n from ledger_transactions where reference_id = $1", [
        diskSub,
      ])
    )[0]!.n,
  );

  // The wallet pays.
  await q("update wallets set balance_minor = 20000000 where customer_id = $1", [buyer.customerId]);
  expect(await unpaid(new Date(day7.getTime() + 3_600_000))).toMatchObject({ paid: 1 });
  expect(await statusOf(serverId)).toBe("active");
  expect(await statusOf(diskId)).toBe("active");
  const after = await q(
    "select kind, state from operations where resource_id = $1 order by created_at, id",
    [diskId],
  );
  // The disk's destroy can never run now (cancelled before it started), and neither can its final snapshot.
  expect(after.map((o) => [o.kind, o.state])).toEqual([
    ["final_snapshot", "failed"],
    ["destroy", "failed"],
  ]);
  const mark = await q("select config -> 'retainedWithServer' as m from resources where id = $1", [
    diskId,
  ]);
  expect(mark[0]!.m ?? null).toBeNull();
  // No ledger change for the disk (R5).
  expect(
    Number(
      (
        await q("select count(*)::int as n from ledger_transactions where reference_id = $1", [
          diskSub,
        ])
      )[0]!.n,
    ),
  ).toBe(ledgerBefore);
});
