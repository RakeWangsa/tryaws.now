// WPU-Y4 (owner decision 2026-11-14): a server whose subscription is retained by the lifecycle takes its attached
// disks with it. Their subscriptions are retained in the same transaction (never renewed or charged again) and
// their final snapshot and destroy are queued under the engine's own keys, so every later pass replays them (R7).
import type { Tx } from "@tc/db";
import {
  ensureFinalBackup,
  lifecycleOperationKey,
  lifecycleRepo,
  loadRunView,
  markFinalBackup,
} from "@tc/db";
import { newAdmin, runTransaction, useTempDatabase } from "@tc/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { makeKit, placeOne, START, type Kit } from "../test/orders-kit";
import type { QueueMessage } from "../operations/queue";
import { retainSubscription, runLifecycle, SERVER_HOLD_KEY } from "./engine";
import { decideDestructive, destructiveGuard } from "./guard";
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

// WPU-Y4 fix round 4 (A): after a release, the next retention in the same disk period queues LIVE operations.
it("a disk released with from:grace gets a new live destroy when its server is retained again", async () => {
  const s = await serverPastGrace();
  const d = await disk(s.customerId, s.serverId);
  await q("update subscriptions set status = 'grace' where id = $1", [d.subscriptionId]);
  await kit.refreshFx();
  await runLifecycle({ runTx: worker, clock: kit.clock, log: () => undefined });
  expect(await statusOf(d.id)).toBe("retained");
  const serverSub = String(
    (await q("select id from subscriptions where resource_id = $1", [s.serverId]))[0]!.id,
  );
  expect(
    (await worker((tx) => completeRestore(tx, { subscriptionId: serverSub, clock: kit.clock }))).ok,
  ).toBe(true);
  expect(await statusOf(d.id)).toBe("grace");
  // The server's grace runs out again in the same disk period.
  await q(
    "update subscriptions set status = 'grace', auto_renew = false, period_start = $2, period_end = $3 where id = $1",
    [serverSub, new Date(START.getTime() - 60 * DAY), new Date(START.getTime() - 30 * DAY)],
  );
  kit.clock.set(new Date(kit.clock.now().getTime() + 3_600_000));
  await kit.refreshFx();
  await runLifecycle({ runTx: worker, clock: kit.clock, log: () => undefined });
  expect(await statusOf(s.serverId)).toBe("retained");
  expect(await statusOf(d.id)).toBe("retained");
  const live = await q(
    "select kind, idempotency_key from operations where resource_id = $1 and state not in ('failed', 'succeeded') order by created_at, id",
    [d.id],
  );
  expect(live.map((o) => o.kind)).toEqual(["final_snapshot", "destroy"]);
  expect(String(live[1]!.idempotency_key)).toContain(":after:");
});

// WPU-Y4 fix round 4 (B): release unless DeleteDisk may have been sent.
it("a disk whose destroy waits for the server (approved, started) is still given back", async () => {
  const s = await serverPastGrace();
  const d = await disk(s.customerId, s.serverId);
  await kit.refreshFx();
  await runLifecycle({ runTx: worker, clock: kit.clock, log: () => undefined });
  await q(
    // operations_unapproved_state_check: a flagged destroy (R13) runs only after an admin approved it.
    "update operations set state = 'waiting', step = 'wait_server', attempts = 1, approved_by = case when needs_approval then $2::uuid end where resource_id = $1 and kind = 'destroy'",
    [d.id, await newAdmin(t.pool, "ops")],
  );
  const serverSub = String(
    (await q("select id from subscriptions where resource_id = $1", [s.serverId]))[0]!.id,
  );
  await worker((tx) => completeRestore(tx, { subscriptionId: serverSub, clock: kit.clock }));
  expect(await statusOf(d.id)).toBe("active");
  expect(await markOf(d.id)).toBeNull();
  // Fix round 5 (N1): the approved, waiting destroy is ended (failed), so it can never stay alive under the
  // period's key; nothing of the disk's retention is left alive.
  const left = await q(
    "select kind, state from operations where resource_id = $1 and kind in ('destroy', 'final_snapshot') order by created_at, id",
    [d.id],
  );
  expect(left.map((o) => o.state)).toEqual(left.map(() => "failed"));
  expect(left.some((o) => o.kind === "destroy")).toBe(true);

  // Then the disk's own retention in the same period (its grace runs out): a live destroy under a fresh key, and
  // the guard lets it pass once its final snapshot exists.
  const locked = await worker((tx) => lifecycleRepo(tx).lock(d.subscriptionId));
  await worker((tx) => retainSubscription(tx, locked!, kit.clock.now()));
  expect(await statusOf(d.id)).toBe("retained");
  const live = await q(
    "select id, idempotency_key, payload from operations where resource_id = $1 and kind = 'destroy' and state not in ('failed', 'succeeded')",
    [d.id],
  );
  expect(live).toHaveLength(1);
  expect(String(live[0]!.idempotency_key)).toContain(":after:");
  expect(live[0]!.payload).toEqual({ subscriptionId: d.subscriptionId });
  await q(
    `insert into resources (id, customer_id, family, state, parent_resource_id, config)
     values (gen_random_uuid(), $1, 'backup', 'active', $2, '{"final": true}'::jsonb)`,
    [s.customerId, d.id],
  );
  const allowed = await worker(async (tx) => {
    const view = await loadRunView(tx, String(live[0]!.id));
    return view === null ? false : destructiveGuard(tx, view);
  });
  expect(allowed).toBe(true);
});

// Fix round 5 (M1): a destroy that is running (claimed by the provisioner) at any step holds the disk.
it("a disk whose destroy is running (claimed) stays retained, with an attention item", async () => {
  const s = await serverPastGrace();
  const d = await disk(s.customerId, s.serverId);
  await kit.refreshFx();
  await runLifecycle({ runTx: worker, clock: kit.clock, log: () => undefined });
  await q(
    "update operations set state = 'running', step = 'wait_server', attempts = 1, approved_by = case when needs_approval then $2::uuid end where resource_id = $1 and kind = 'destroy'",
    [d.id, await newAdmin(t.pool, "ops")],
  );
  const serverSub = String(
    (await q("select id from subscriptions where resource_id = $1", [s.serverId]))[0]!.id,
  );
  await worker((tx) => completeRestore(tx, { subscriptionId: serverSub, clock: kit.clock }));
  expect(await statusOf(d.id)).toBe("retained");
  const items = await q("select details from discrepancies where details ->> 'resourceId' = $1", [
    d.id,
  ]);
  expect(items).toHaveLength(1);
});

it("a disk whose destroy reached the DeleteDisk step stays retained, with an attention item", async () => {
  const s = await serverPastGrace();
  const d = await disk(s.customerId, s.serverId);
  await kit.refreshFx();
  await runLifecycle({ runTx: worker, clock: kit.clock, log: () => undefined });
  await q(
    // operations_unapproved_state_check: a flagged destroy (R13) runs only after an admin approved it.
    "update operations set state = 'running', step = 'delete_disk', attempts = 1, approved_by = case when needs_approval then $2::uuid end where resource_id = $1 and kind = 'destroy'",
    [d.id, await newAdmin(t.pool, "ops")],
  );
  const serverSub = String(
    (await q("select id from subscriptions where resource_id = $1", [s.serverId]))[0]!.id,
  );
  await worker((tx) => completeRestore(tx, { subscriptionId: serverSub, clock: kit.clock }));
  expect(await statusOf(s.serverId)).toBe("active");
  expect(await statusOf(d.id)).toBe("retained");
  const items = await q(
    "select kind, details from discrepancies where details ->> 'resourceId' = $1",
    [d.id],
  );
  expect(items).toEqual([
    {
      kind: "missing",
      details: {
        resourceId: d.id,
        serverId: s.serverId,
        reason: "disk_destroy_may_have_run",
        source: "attached_disks",
      },
    },
  ]);
});

// WPU-X1 (the round-5 money review, required before the disk flag): a release never ends a final snapshot of the
// disk that already started. It finishes, and its backup is an ordinary one: `active` (metered like any snapshot,
// usage-writer), not final, so the customer may delete it. Only one that never started is ended, and the release
// logs the ids of what it ended (ids and fixed words only, R14).
describe("a disk final snapshot at the release of its server (WPU-X1)", () => {
  const serverSubOf = async (serverId: string) =>
    String((await q("select id from subscriptions where resource_id = $1", [serverId]))[0]!.id);
  const opsOf = async (diskId: string) =>
    (await q(
      "select id, kind, state from operations where resource_id = $1 and kind in ('final_snapshot', 'destroy') order by created_at, id",
      [diskId],
    )) as { id: string; kind: string; state: string }[];
  const backupOf = async (id: string) =>
    (await q("select state, aws_name, config from resources where id = $1", [id]))[0] as {
      state: string;
      aws_name: string | null;
      config: Record<string, unknown>;
    };
  const deletable = async (backupId: string) => {
    const facts = await worker((tx) => lifecycleRepo(tx).resourceOfOperation(backupId));
    return facts !== null && decideDestructive("delete_backup", facts);
  };
  const snapshotName = (id: string) => `tc-snapshot-${id.replaceAll("-", "")}`;

  async function retainedDisk() {
    const s = await serverPastGrace();
    const d = await disk(s.customerId, s.serverId);
    await kit.refreshFx();
    await runLifecycle({ runTx: worker, clock: kit.clock, log: () => undefined });
    expect(await statusOf(d.id)).toBe("retained");
    const ops = await opsOf(d.id);
    const snap = ops.find((o) => o.kind === "final_snapshot")!.id;
    const destroy = ops.find((o) => o.kind === "destroy")!.id;
    return { s, d, snap, destroy };
  }
  async function release(serverId: string) {
    const lines: Record<string, unknown>[] = [];
    const done = await worker(async (tx) =>
      completeRestore(tx, {
        subscriptionId: await serverSubOf(serverId),
        clock: kit.clock,
        log: (line) => lines.push(line),
      }),
    );
    expect(done.ok).toBe(true);
    return lines;
  }

  it("one waiting at wait_snapshot is left to finish and ends as an active, deletable backup", async () => {
    const { s, d, snap, destroy } = await retainedDisk();
    // The adapter's first step: the backup row (creating, final) and CreateDiskSnapshot; then it waits.
    const { id: backupId } = await worker((tx) =>
      ensureFinalBackup(tx, {
        customerId: s.customerId,
        parentResourceId: d.id,
        operationId: snap,
      }),
    );
    await q(
      "update operations set state = 'waiting', step = 'wait_snapshot', attempts = 1 where id = $1",
      [snap],
    );
    const lines = await release(s.serverId);
    expect(await statusOf(d.id)).toBe("active");
    expect((await opsOf(d.id)).map((o) => [o.kind, o.state])).toEqual([
      ["final_snapshot", "waiting"],
      ["destroy", "failed"],
    ]);
    // The release logs the ids of what it ended, and only those.
    expect(lines.filter((l) => l.action === "ended")).toEqual([
      {
        event: "attached_disks",
        action: "ended",
        diskId: d.id,
        serverId: s.serverId,
        operationId: destroy,
        kind: "destroy",
      },
    ]);
    // The snapshot is available: the adapter marks the row of the same operation.
    await worker((tx) =>
      markFinalBackup(tx, {
        id: backupId,
        customerId: s.customerId,
        operationId: snap,
        awsName: snapshotName(backupId),
        sizeGb: 32,
      }),
    );
    const row = await backupOf(backupId);
    expect(row.state).toBe("active");
    expect(row.config).toMatchObject({ final: false, finalOperation: snap, sizeGb: 32 });
    expect(await deletable(backupId)).toBe(true);
  });

  it("one running at the release, whose row is made after it, ends as an active, deletable backup", async () => {
    const { s, d, snap, destroy } = await retainedDisk();
    // Claimed by the provisioner, no backup row yet.
    await q("update operations set state = 'running', attempts = 1 where id = $1", [snap]);
    const lines = await release(s.serverId);
    expect(await statusOf(d.id)).toBe("active");
    expect((await opsOf(d.id)).map((o) => [o.kind, o.state])).toEqual([
      ["final_snapshot", "running"],
      ["destroy", "failed"],
    ]);
    expect(lines.filter((l) => l.action === "ended").map((l) => l.operationId)).toEqual([destroy]);
    // After the release committed, the adapter makes the row and the snapshot completes.
    const { id: backupId } = await worker((tx) =>
      ensureFinalBackup(tx, {
        customerId: s.customerId,
        parentResourceId: d.id,
        operationId: snap,
      }),
    );
    expect((await backupOf(backupId)).config).toMatchObject({ final: false });
    await worker((tx) =>
      markFinalBackup(tx, {
        id: backupId,
        customerId: s.customerId,
        operationId: snap,
        awsName: snapshotName(backupId),
        sizeGb: 32,
      }),
    );
    const row = await backupOf(backupId);
    expect(row.state).toBe("active");
    expect(row.config).toMatchObject({ final: false, sizeGb: 32 });
    expect(await deletable(backupId)).toBe(true);
  });

  it("one that never started is ended, and its id is logged", async () => {
    const { s, d, snap, destroy } = await retainedDisk();
    const lines = await release(s.serverId);
    expect((await opsOf(d.id)).map((o) => [o.kind, o.state])).toEqual([
      ["final_snapshot", "failed"],
      ["destroy", "failed"],
    ]);
    const ended = lines.filter((l) => l.action === "ended" && l.diskId === d.id);
    expect(ended.map((l) => l.operationId).sort()).toEqual([snap, destroy].sort());
    // Ids and fixed words only (R14).
    for (const line of ended) {
      expect(Object.keys(line).sort()).toEqual(
        ["action", "diskId", "event", "kind", "operationId", "serverId"].sort(),
      );
    }
  });
});
