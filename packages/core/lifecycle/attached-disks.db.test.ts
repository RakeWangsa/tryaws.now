// WPU-Y4 (owner decision 2026-11-14): a server whose subscription is retained by the lifecycle takes its attached
// disks with it. Their subscriptions are retained in the same transaction (never renewed or charged again) and
// their final snapshot and destroy are queued under the engine's own keys, so every later pass replays them (R7).
import type { Tx } from "@tc/db";
import { lifecycleOperationKey } from "@tc/db";
import { runTransaction, useTempDatabase } from "@tc/db/testing";
import { beforeAll, expect, it } from "vitest";
import { makeKit, placeOne, START, type Kit } from "../test/orders-kit";
import type { QueueMessage } from "../operations/queue";
import { runLifecycle, SERVER_HOLD_KEY } from "./engine";
import { completeRestore } from "./restore";

const t = useTempDatabase();
const DAY = 24 * 3_600_000;
let kit: Kit;

const worker = <T>(fn: (tx: Tx) => Promise<T>) => runTransaction(t.db, fn, { role: "worker_rw" });
const q = async (sql: string, params: unknown[] = []) =>
  (await t.pool.query(sql, params)).rows as Record<string, unknown>[];

const markOf = async (id: string) =>
  (await q("select config -> 'retainedWithServer' as m from resources where id = $1", [id]))[0]!
    .m ?? null;
const configOf = async (id: string) =>
  (await q("select config from resources where id = $1", [id]))[0]!.config as Record<
    string,
    unknown
  >;
const statusOf = async (resourceId: string) =>
  String(
    (await q("select status from subscriptions where resource_id = $1", [resourceId]))[0]!.status,
  );
const ledgerRows = async (subscriptionId: string) =>
  Number(
    (
      await q("select count(*)::int as n from ledger_transactions where reference_id = $1", [
        subscriptionId,
      ])
    )[0]!.n,
  );

beforeAll(async () => {
  kit = await makeKit(t);
});

async function serverPastGrace(): Promise<{ customerId: string; serverId: string }> {
  kit.clock.set(START);
  const buyer = await kit.newBuyer({ balanceMinor: 20_000_000n });
  const { resourceId } = await placeOne(kit, buyer);
  await q("update resources set state = 'active' where id = $1", [resourceId]);
  await q("update operations set state = 'succeeded' where resource_id = $1", [resourceId]);
  // In grace since long ago, auto-renew off: the next pass retains it.
  await q(
    // subscriptions_period_check: the period end stays after its start.
    "update subscriptions set status = 'grace', auto_renew = false, period_start = $2, period_end = $3 where resource_id = $1",
    [resourceId, new Date(START.getTime() - 60 * DAY), new Date(START.getTime() - 30 * DAY)],
  );
  return { customerId: buyer.customerId, serverId: resourceId };
}

async function disk(
  customerId: string,
  attachedTo: string | null,
): Promise<{ id: string; subscriptionId: string; end: Date }> {
  const id = crypto.randomUUID();
  const subscriptionId = crypto.randomUUID();
  const end = new Date(START.getTime() + 20 * DAY);
  await q(
    `insert into resources (id, customer_id, family, state, config) values ($1, $2, 'disk', 'active', $3::jsonb)`,
    [
      id,
      customerId,
      JSON.stringify({ region: "ap-southeast-1", sizeGb: 32, attachedInstanceId: attachedTo }),
    ],
  );
  await q(
    `insert into subscriptions (id, resource_id, customer_id, term_days, price_snapshot, period_start, period_end, status, auto_renew)
     values ($1, $2, $3, 30, '{}'::jsonb, $4, $5, 'active', true)`,
    [subscriptionId, id, customerId, START, end],
  );
  return { id, subscriptionId, end };
}

it("retaining a server retains its attached disks and queues their final snapshot and destroy", async () => {
  const s = await serverPastGrace();
  const attached = await disk(s.customerId, s.serverId);
  const free = await disk(s.customerId, null);
  const sent: QueueMessage[] = [];
  await kit.refreshFx();
  const report = await runLifecycle({
    runTx: worker,
    clock: kit.clock,
    log: () => undefined,
    queue: { send: async (m: QueueMessage) => void sent.push(m) },
  });
  expect(report.retained).toBeGreaterThanOrEqual(1);
  const subs = await q(
    "select resource_id, status from subscriptions where resource_id = any($1)",
    [[s.serverId, attached.id, free.id]],
  );
  const status = new Map(subs.map((r) => [String(r.resource_id), String(r.status)]));
  expect(status.get(s.serverId)).toBe("retained");
  expect(status.get(attached.id)).toBe("retained");
  expect(status.get(free.id)).toBe("active");

  const ops = await q(
    "select id, kind, state, idempotency_key, payload from operations where resource_id = $1 order by created_at, id",
    [attached.id],
  );
  expect(ops.map((o) => o.kind)).toEqual(["final_snapshot", "destroy"]);
  expect(ops.map((o) => o.idempotency_key)).toEqual([
    lifecycleOperationKey("final_snapshot", attached.subscriptionId, attached.end),
    lifecycleOperationKey("destroy", attached.subscriptionId, attached.end),
  ]);
  expect(ops[1]!.payload).toEqual({
    subscriptionId: attached.subscriptionId,
    withServer: s.serverId,
    from: "active",
  });
  // Fix round 2: the worker path marks the disk with the server and its former status.
  expect(await markOf(attached.id)).toEqual({ serverId: s.serverId, from: "active" });
  // A queued operation of the disk is sent after the commit; one that waits for an admin is not (R13).
  const sentIds = new Set(sent.map((m) => JSON.stringify(m)));
  for (const op of ops) {
    const wasSent = [...sentIds].some((m) => m.includes(String(op.id)));
    expect(wasSent).toBe(op.state === "queued");
  }
  // No charge for the disk: its subscription ended with the server (R5 unchanged, nothing posted).
  const charges = await q(
    "select count(*)::int as n from ledger_transactions where reference_id = $1",
    [attached.subscriptionId],
  );
  expect(Number(charges[0]!.n)).toBe(0);

  // The next passes replay the rows (the disk's own retention pass and the server's) and add none (R7).
  kit.clock.set(new Date(kit.clock.now().getTime() + 3_600_000));
  await kit.refreshFx();
  await runLifecycle({ runTx: worker, clock: kit.clock, log: () => undefined });
  const again = await q("select count(*)::int as n from operations where resource_id = $1", [
    attached.id,
  ]);
  expect(Number(again[0]!.n)).toBe(2);
});

// WPU-Y4 fix round 2 (money review 1): a revival of the server gives its disks back.
it("completeRestore of the server gives the disk its former status, cancels its destroy and clears the mark", async () => {
  const s = await serverPastGrace();
  const attached = await disk(s.customerId, s.serverId);
  await kit.refreshFx();
  await runLifecycle({ runTx: worker, clock: kit.clock, log: () => undefined });
  expect(await statusOf(attached.id)).toBe("retained");
  const serverSub = String(
    (await q("select id from subscriptions where resource_id = $1", [s.serverId]))[0]!.id,
  );
  const before = await ledgerRows(attached.subscriptionId);
  const restored = await worker((tx) =>
    completeRestore(tx, { subscriptionId: serverSub, clock: kit.clock }),
  );
  expect(restored.ok).toBe(true);
  expect(await statusOf(s.serverId)).toBe("active");
  expect(await statusOf(attached.id)).toBe("active");
  expect(await markOf(attached.id)).toBeNull();
  const ops = await q(
    "select kind, state, attempts from operations where resource_id = $1 order by created_at, id",
    [attached.id],
  );
  // Neither the destroy nor the final snapshot of the disk can run any more (cancelled before they started).
  expect(ops.map((o) => [o.kind, o.state])).toEqual([
    ["final_snapshot", "failed"],
    ["destroy", "failed"],
  ]);
  // No ledger change for the disk (R5).
  expect(await ledgerRows(attached.subscriptionId)).toBe(before);
  // A later pass does not retain the disk again: the server is active.
  kit.clock.set(new Date(kit.clock.now().getTime() + 3_600_000));
  await kit.refreshFx();
  await runLifecycle({ runTx: worker, clock: kit.clock, log: () => undefined });
  expect(await statusOf(attached.id)).toBe("active");
});

// WPU-Y4 fix round 2 (money review 2): no renewal charge of a disk while its server is in grace.
it("a disk whose server is in grace is not renewed (held with a mark); the mark goes once the server is active", async () => {
  kit.clock.set(START);
  const buyer = await kit.newBuyer({ balanceMinor: 20_000_000n });
  const { resourceId: serverId } = await placeOne(kit, buyer);
  await q("update resources set state = 'active' where id = $1", [serverId]);
  await q("update operations set state = 'succeeded' where resource_id = $1", [serverId]);
  // In grace for one hour (the grace lasts longer): neither retained nor renewed on this pass.
  await q(
    "update subscriptions set status = 'grace', auto_renew = false, period_start = $2, period_end = $3 where resource_id = $1",
    [serverId, new Date(START.getTime() - 30 * DAY), new Date(START.getTime() - 3_600_000)],
  );
  const d = await disk(buyer.customerId, serverId);
  // The disk's own period ended an hour ago, auto-renew on: without the hold it would be charged now.
  await q("update subscriptions set period_start = $2, period_end = $3 where id = $1", [
    d.subscriptionId,
    new Date(START.getTime() - 30 * DAY),
    new Date(START.getTime() - 3_600_000),
  ]);
  await kit.refreshFx();
  await runLifecycle({ runTx: worker, clock: kit.clock, log: () => undefined });
  expect(await statusOf(d.id)).toBe("active");
  expect(await ledgerRows(d.subscriptionId)).toBe(0);
  expect((await configOf(d.id))[SERVER_HOLD_KEY]).toMatchObject({ serverId });

  // The server is paid up again: the hold mark goes on the next pass.
  await q("update subscriptions set status = 'active', period_end = $2 where resource_id = $1", [
    serverId,
    new Date(START.getTime() + 30 * DAY),
  ]);
  await kit.refreshFx();
  await runLifecycle({ runTx: worker, clock: kit.clock, log: () => undefined });
  expect((await configOf(d.id))[SERVER_HOLD_KEY] ?? null).toBeNull();
});
