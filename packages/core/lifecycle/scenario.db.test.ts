// The proof of backlog row WP5-T4: one instance passes renew, grace, suspend, final snapshot,
// destroy, restore and purge on the test clock. Real database, real ledger, real operations rows;
// the provisioner is played by `settle` (it runs what the lifecycle queued and calls the hooks).
import { loadRunView, type Tx } from "@tc/db";
import { newAdmin, runTransaction, useTempDatabase, approveOperation } from "@tc/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { createManualClock } from "../operations/manual-clock";
import { makeKit, placeOne, PLAN_TOTAL, type Kit } from "../test/orders-kit";
import { destructiveGuard } from "./guard";
import { lifecycleHooks } from "./hooks";
import { runLifecycle } from "./engine";
import { completeRestore } from "./restore";
import type { LogEvent } from "../operations/types";

const t = useTempDatabase();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let kit: Kit;
let resourceId: string;
let subscriptionId: string;
let adminId: string;
const logged: LogEvent[] = [];

const worker = <T>(fn: (tx: Tx) => Promise<T>) => runTransaction(t.db, fn, { role: "worker_rw" });
const q = async (sql: string, params: unknown[] = []) =>
  (await t.pool.query(sql, params)).rows as Record<string, unknown>[];

const sub = async () =>
  (
    await q(
      "select status, period_start, period_end, auto_renew from subscriptions where id = $1",
      [subscriptionId],
    )
  )[0]!;
const resourceState = async () =>
  (await q("select state, deleted_at from resources where id = $1", [resourceId]))[0]!;
const ops = async (kind?: string) =>
  await q(
    `select id, kind, state, needs_approval from operations
      where resource_id = $1 and ($2::text is null or kind = $2) order by created_at, id`,
    [resourceId, kind ?? null],
  );
const notes = async () =>
  (
    await q(
      "select channel, template, payload from notifications where customer_id = $1 order by created_at, id",
      [kit.customerId],
    )
  ).map((r) => `${String(r.channel)}:${String(r.template)}`);

const tick = (to: Date) => kit.clock.set(to);
// WPU-Y1: a rate older than 7 days prices nothing, so the rate in force is re-confirmed at the clock before each run.
const run = async () => {
  await kit.refreshFx();
  return runLifecycle({
    runTx: worker,
    clock: kit.clock,
    log: (e) => logged.push(e),
  });
};
const setSub = (autoRenew: boolean) =>
  t.pool.query("update subscriptions set auto_renew = $2 where id = $1", [
    subscriptionId,
    autoRenew,
  ]);

// The provisioner: every queued or approved operation of the resource runs, in order, and its
// success hook runs in the same way as in functions/provisioner.
async function settle(): Promise<string[]> {
  const done: string[] = [];
  for (;;) {
    const next = (
      await q(
        `select id, kind, state from operations where resource_id = $1 and state in ('queued', 'needs_approval') order by created_at, id limit 1`,
        [resourceId],
      )
    )[0];
    if (next === undefined) return done;
    const id = String(next.id);
    const kind = String(next.kind);
    if (next.state === "needs_approval") {
      // R13: nothing destructive has run without an approver.
      await runTransaction(t.db, (tx) =>
        approveOperation(tx, { operationId: id, adminId, at: kit.clock.now() }),
      );
    }
    // The guard speaks in the claim transaction.
    const allowed = await worker(async (tx) => {
      const view = await loadRunView(tx, id);
      return view === null ? false : await destructiveGuard(tx, view);
    });
    const destructive = kind === "destroy" || kind === "purge_snapshots";
    if (destructive && !allowed) throw new Error(`guard refused ${kind}`);
    if (kind === "final_snapshot") {
      // What the adapter leaves behind: the final snapshot as a child `backup` resource.
      await q(
        `insert into resources (id, customer_id, family, parent_resource_id, config, state)
         values (gen_random_uuid(), $1, 'backup', $2, '{"final": true}'::jsonb, 'active')`,
        [kit.customerId, resourceId],
      );
    }
    await q("update operations set state = 'succeeded' where id = $1", [id]);
    await worker((tx) =>
      lifecycleHooks({ clock: kit.clock }).succeeded(tx, {
        operationId: id,
        resourceId,
        customerId: kit.customerId,
        kind: kind as never,
      }),
    );
    done.push(kind);
  }
}

beforeAll(async () => {
  kit = await makeKit(t);
  adminId = await newAdmin(t.pool, "ops");
  // R13 approval is on for the whole run: every destructive operation waits for an admin.
  await q(
    `update settings set value = '"2031-01-01T00:00:00.000Z"'::jsonb where key = 'r13_approval_until'`,
  );
  const placed = await placeOne(kit);
  resourceId = placed.resourceId;
  subscriptionId = String(
    (await q("select id from subscriptions where resource_id = $1", [resourceId]))[0]!.id,
  );
  // The provisioner finished the create.
  await q("update resources set state = 'active' where id = $1", [resourceId]);
  await q("update operations set state = 'succeeded' where resource_id = $1 and kind = 'create'", [
    resourceId,
  ]);
});

describe("one instance on the test clock (backlog row WP5-T4)", () => {
  let end1: Date;
  let end2: Date;
  let end3: Date;

  it("0. the clock starts at purchase: active, 30 days, nothing due", async () => {
    end1 = (await sub()).period_end as Date;
    expect(end1.getTime() - ((await sub()).period_start as Date).getTime()).toBe(30 * DAY);
    tick(new Date(end1.getTime() - 8 * DAY));
    expect(await run()).toMatchObject({ examined: 0, reminded: 0 });
    expect(await notes()).toEqual([]);
  });

  it("1. reminders at 7, 3 and 1 day (SMS only at 1); a second run sends nothing more (R7)", async () => {
    for (const days of [7, 3, 1]) {
      tick(new Date(end1.getTime() - days * DAY));
      expect(await run()).toMatchObject({ reminded: 1 });
      expect(await run()).toMatchObject({ reminded: 0 });
    }
    expect(await notes()).toEqual([
      "email:lifecycle_renewal_reminder",
      "email:lifecycle_renewal_reminder",
      "email:lifecycle_renewal_reminder",
      "sms:lifecycle_renewal_reminder",
    ]);
    const first = (
      await q(
        "select payload from notifications where customer_id = $1 order by created_at, id limit 1",
        [kit.customerId],
      )
    )[0]!;
    expect(first.payload).toMatchObject({ day: 7, renewalAmountMinor: PLAN_TOTAL.toString() });
  });

  it("2. renew: at the period end, auto-renew on, wallet funded: charged once, 30 days from the old end", async () => {
    await setSub(true);
    const before = await kit.balance();
    tick(end1);
    expect(await run()).toMatchObject({ renewed: 1, graced: 0 });
    const s = await sub();
    expect(s.status).toBe("active");
    expect((s.period_start as Date).toISOString()).toBe(end1.toISOString());
    end2 = s.period_end as Date;
    expect(end2.getTime() - end1.getTime()).toBe(30 * DAY);
    expect(before - (await kit.balance())).toBe(PLAN_TOTAL);
    // The same run again, and a run an hour later, charge nothing.
    expect(await run()).toMatchObject({ renewed: 0 });
    tick(new Date(end1.getTime() + HOUR));
    expect(await run()).toMatchObject({ renewed: 0 });
    expect(before - (await kit.balance())).toBe(PLAN_TOTAL);
    expect(
      (await q("select count(*)::int as n from ledger_transactions where kind = 'renewal'"))[0]!.n,
    ).toBe(1);
    expect(await notes()).toContain("email:lifecycle_renewed");
  });

  it("3. grace and suspend: period end, auto-renew off", async () => {
    await setSub(false);
    tick(end2);
    expect(await run()).toMatchObject({ graced: 1 });
    expect((await sub()).status).toBe("grace");
    expect((await ops("suspend")).map((o) => o.state)).toEqual(["queued"]);
    expect(await settle()).toEqual(["suspend"]);
    expect((await resourceState()).state).toBe("suspended");
    expect(await notes()).toEqual(
      expect.arrayContaining(["email:lifecycle_grace_started", "sms:lifecycle_grace_started"]),
    );
    // A second run in grace queues nothing new.
    expect(await run()).toMatchObject({ graced: 0 });
    expect(await ops("suspend")).toHaveLength(1);
  });

  it("4. paying in grace: the next run renews and resumes; the new period starts at the old end", async () => {
    tick(new Date(end2.getTime() + 5 * HOUR));
    await setSub(true);
    expect(await run()).toMatchObject({ renewed: 1 });
    const s = await sub();
    expect(s.status).toBe("active");
    expect((s.period_start as Date).toISOString()).toBe(end2.toISOString());
    end3 = s.period_end as Date;
    expect(end3.getTime() - end2.getTime()).toBe(30 * DAY);
    expect(await settle()).toEqual(["resume"]);
    expect((await resourceState()).state).toBe("active");
  });

  it("5. unpaid again: grace, then at +48 hours retained with a final snapshot and a destroy that waits for approval", async () => {
    await setSub(false);
    tick(end3);
    await run();
    expect(await settle()).toEqual(["suspend"]);
    tick(new Date(end3.getTime() + 48 * HOUR - 1000));
    expect(await run()).toMatchObject({ retained: 0 });
    tick(new Date(end3.getTime() + 48 * HOUR));
    expect(await run()).toMatchObject({ retained: 1 });
    expect((await sub()).status).toBe("retained");
    expect(await ops("final_snapshot")).toHaveLength(1);
    const destroy = await ops("destroy");
    expect(destroy).toHaveLength(1);
    expect(destroy[0]).toMatchObject({ state: "needs_approval", needs_approval: true });
    // R13: before the final snapshot exists the guard refuses the destroy.
    const refused = await worker(async (tx) => {
      const view = await loadRunView(tx, String(destroy[0]!.id));
      return view === null ? null : await destructiveGuard(tx, view);
    });
    expect(refused).toBe(false);
    expect(await run()).toMatchObject({ retained: 0 });
    expect(await ops("destroy")).toHaveLength(1);
  });

  it("6. final snapshot, then destroy (approved): the resource is destroyed and its capacity is back", async () => {
    const usedBefore = await kit.used();
    expect(Object.values(usedBefore).some((n) => n > 0)).toBe(true);
    expect(await settle()).toEqual(["final_snapshot", "destroy"]);
    const r = await resourceState();
    expect(r.state).toBe("destroyed");
    expect(Object.values(await kit.used()).every((n) => n === 0)).toBe(true);
    expect(await notes()).toContain("email:lifecycle_destroyed");
    expect(await run()).toMatchObject({ ended: 0 });
  });

  it("7. restore during retention: the new period starts at the restore time", async () => {
    tick(new Date(end3.getTime() + 48 * HOUR + 3 * DAY));
    // The restore flow (WP5-T1, WP5-T2) has charged, reserved and made the resource again.
    await q("update resources set state = 'active', deleted_at = null where id = $1", [resourceId]);
    const done = await worker((tx) => completeRestore(tx, { subscriptionId, clock: kit.clock }));
    expect(done).toEqual({
      ok: true,
      value: { periodEnd: new Date(kit.clock.now().getTime() + 30 * DAY) },
    });
    const s = await sub();
    expect(s.status).toBe("active");
    expect((s.period_start as Date).toISOString()).toBe(kit.clock.now().toISOString());
    // Not twice, and not for a subscription that is not retained.
    expect(
      await worker((tx) => completeRestore(tx, { subscriptionId, clock: kit.clock })),
    ).toMatchObject({
      ok: false,
      error: "conflict",
    });
  });

  it("8. unpaid once more: retained and destroyed; 14 days after the destroy it ends and the snapshots are purged", async () => {
    const end4 = (await sub()).period_end as Date;
    tick(end4);
    await run();
    expect(await settle()).toEqual(["suspend"]);
    tick(new Date(end4.getTime() + 48 * HOUR));
    await run();
    expect(await settle()).toEqual(["final_snapshot", "destroy"]);
    const destroyedAt = (await resourceState()).deleted_at as Date;
    expect(destroyedAt.toISOString()).toBe(kit.clock.now().toISOString());

    tick(new Date(destroyedAt.getTime() + 14 * DAY - 1000));
    expect(await run()).toMatchObject({ ended: 0 });
    expect((await sub()).status).toBe("retained");
    tick(new Date(destroyedAt.getTime() + 14 * DAY));
    expect(await run()).toMatchObject({ ended: 1 });
    expect((await sub()).status).toBe("ended");
    expect(await settle()).toEqual(["purge_snapshots"]);
    expect(
      await q("select state from resources where parent_resource_id = $1 and family = 'backup'", [
        resourceId,
      ]),
    ).toEqual([{ state: "destroyed" }, { state: "destroyed" }]);
    expect(await notes()).toContain("email:lifecycle_ended");
    // Nothing is left to do, today or in a year.
    expect(await run()).toMatchObject({ ended: 0, retained: 0, graced: 0, renewed: 0 });
    tick(new Date(kit.clock.now().getTime() + 365 * DAY));
    expect(await run()).toMatchObject({ examined: 0 });
  });

  it("every state change left only fixed event names in the log (R14)", () => {
    for (const e of logged) expect(e.event).toBe("lifecycle");
    expect(JSON.stringify(logged)).not.toMatch(/@|\+880/);
    expect(createManualClock).toBeDefined();
  });
});
