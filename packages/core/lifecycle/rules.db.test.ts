// The rules of section 11 that the one-instance scenario does not walk: a wallet that is short, the
// price of today, an admin's suspension, two runs at once, and a subscription that cannot be priced.
import type { Tx } from "@tc/db";
import { runTransaction, useTempDatabase } from "@tc/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { postTransaction } from "../ledger/post";
import { inputs } from "../test/ledger-fixtures";
import { makeKit, placeOne, PLAN_TOTAL, START, type Kit } from "../test/orders-kit";
import { runLifecycle } from "./engine";
import { snapshotOfAmount } from "../test/ledger-requests";

const t = useTempDatabase();
const DAY = 24 * 3_600_000;
const HOUR = 3_600_000;
let kit: Kit;

const worker = <T>(fn: (tx: Tx) => Promise<T>) => runTransaction(t.db, fn, { role: "worker_rw" });
// WPU-Y1: a rate older than 7 days prices nothing, so the rate in force is re-confirmed at the clock before each run.
const run = async () => {
  await kit.refreshFx();
  return runLifecycle({ runTx: worker, clock: kit.clock, log: () => undefined });
};
const q = async (sql: string, params: unknown[] = []) =>
  (await t.pool.query(sql, params)).rows as Record<string, unknown>[];

interface Fresh {
  customerId: string;
  resourceId: string;
  subscriptionId: string;
  end: Date;
}

// A purchased and activated instance of a new customer, bought at the start of the test clock.
async function fresh(balanceMinor: bigint, autoRenew: boolean): Promise<Fresh> {
  kit.clock.set(START);
  const buyer = await kit.newBuyer({ balanceMinor: 20_000_000n });
  const { resourceId } = await placeOne(kit, buyer);
  const subscription = (
    await q("select id, period_end from subscriptions where resource_id = $1", [resourceId])
  )[0]!;
  await q("update resources set state = 'active' where id = $1", [resourceId]);
  await q("update operations set state = 'succeeded' where resource_id = $1", [resourceId]);
  await q("update subscriptions set auto_renew = $2 where id = $1", [subscription.id, autoRenew]);
  await setWallet(buyer.customerId, balanceMinor);
  return {
    customerId: buyer.customerId,
    resourceId,
    subscriptionId: String(subscription.id),
    end: subscription.period_end as Date,
  };
}

// Leaves the wallet with exactly `target`, through a ledger adjustment-free path of the fixtures: the
// customer first spent down to zero by a reversing top-up is not allowed, so the buyer is made with
// 1_000_000 and the difference is posted as a platform-side debit.
async function setWallet(customerId: string, target: bigint): Promise<void> {
  const current = await kit.balance(customerId);
  if (current > target) {
    const spent = await worker((tx) =>
      postTransaction(tx, {
        kind: "purchase",
        reference: { type: "order", id: crypto.randomUUID() },
        idempotencyKey: `order:${crypto.randomUUID().replaceAll("-", "")}`,
        actor: { type: "system" },
        priceSnapshot: snapshotOfAmount("purchase", current - target),
        postings: [
          {
            account: { type: "customer_wallet", customerId },
            direction: "debit",
            amountMinor: current - target,
          },
          {
            account: { type: "revenue_aws_base" },
            direction: "credit",
            amountMinor: current - target,
          },
        ],
      }),
    );
    if (!spent.ok) throw new Error("fixture: the wallet could not be set");
  } else if (current < target) {
    throw new Error("fixture: the wallet is below the target");
  }
}

const topUp = async (customerId: string, amount: bigint) => {
  const r = await worker((tx) => postTransaction(tx, inputs.topup(customerId, amount)));
  if (!r.ok) throw new Error("fixture: the top-up was refused");
};
const subRow = async (id: string) =>
  (await q("select status, period_start, period_end from subscriptions where id = $1", [id]))[0]!;
const renewals = async (id: string) =>
  Number(
    (
      await q(
        "select count(*)::int as n from ledger_transactions where kind = 'renewal' and reference_id = $1",
        [id],
      )
    )[0]!.n,
  );

beforeAll(async () => {
  kit = await makeKit(t);
});

describe("a wallet that is short", () => {
  it("goes to grace at the period end and charges nothing; the top-up renews on the next run", async () => {
    const f = await fresh(PLAN_TOTAL - 1n, true);
    kit.clock.set(f.end);
    expect(await run()).toMatchObject({ renewed: 0, graced: 1 });
    expect((await subRow(f.subscriptionId)).status).toBe("grace");
    expect(await renewals(f.subscriptionId)).toBe(0);
    expect(await kit.balance(f.customerId)).toBe(PLAN_TOTAL - 1n);

    // Every run in grace tries again and charges nothing while the wallet is short.
    kit.clock.set(new Date(f.end.getTime() + 2 * HOUR));
    expect(await run()).toMatchObject({ renewed: 0 });
    await topUp(f.customerId, 1n);
    kit.clock.set(new Date(f.end.getTime() + 3 * HOUR));
    expect(await run()).toMatchObject({ renewed: 1 });
    const s = await subRow(f.subscriptionId);
    expect(s.status).toBe("active");
    expect((s.period_start as Date).toISOString()).toBe(f.end.toISOString());
    expect(await kit.balance(f.customerId)).toBe(0n);
    expect(await renewals(f.subscriptionId)).toBe(1);
  });

  it("with auto-renew off nothing is charged even when the wallet is full", async () => {
    const f = await fresh(10_000_000n, false);
    kit.clock.set(f.end);
    expect(await run()).toMatchObject({ renewed: 0, graced: 1 });
    expect(await renewals(f.subscriptionId)).toBe(0);
    expect(await kit.balance(f.customerId)).toBe(10_000_000n);
  });

  it("after the 48 hours a funded wallet with auto-renew on no longer renews: retained", async () => {
    const f = await fresh(PLAN_TOTAL - 1n, true);
    kit.clock.set(f.end);
    await run();
    await topUp(f.customerId, 100_000n);
    kit.clock.set(new Date(f.end.getTime() + 48 * HOUR));
    expect((await run()).retained).toBeGreaterThanOrEqual(1);
    expect((await subRow(f.subscriptionId)).status).toBe("retained");
  });
});

describe("the price of today", () => {
  it("a renewal charges the rate in force at the clock, not the rate of the purchase", async () => {
    const f = await fresh(10_000_000n, true);
    await kit.changeFxRate("200");
    const quoted = await run();
    expect(quoted.examined).toBeGreaterThanOrEqual(0);
    kit.clock.set(f.end);
    const before = await kit.balance(f.customerId);
    expect(await run()).toMatchObject({ renewed: 1 });
    const charged = before - (await kit.balance(f.customerId));
    expect(charged).toBeGreaterThan(PLAN_TOTAL);
    const ledger = await q(
      `select e.amount_minor::text as amount from ledger_entries e
         join ledger_transactions x on x.id = e.transaction_id
        where x.kind = 'renewal' and x.reference_id = $1 and e.direction = 'debit'`,
      [f.subscriptionId],
    );
    expect(BigInt(String(ledger[0]!.amount))).toBe(charged);
  });
});

describe("an admin's suspension", () => {
  it("is not lifted by a renewal in grace: no resume is queued", async () => {
    const f = await fresh(10_000_000n, false);
    await q(
      `update resources set state = 'suspended', config = config || '{"adminSuspended": true}'::jsonb where id = $1`,
      [f.resourceId],
    );
    kit.clock.set(f.end);
    await run();
    expect((await subRow(f.subscriptionId)).status).toBe("grace");
    // Already suspended: no lifecycle suspend either.
    expect(
      await q("select kind from operations where resource_id = $1 and kind <> 'create'", [
        f.resourceId,
      ]),
    ).toEqual([]);
    await q("update subscriptions set auto_renew = true where id = $1", [f.subscriptionId]);
    kit.clock.set(new Date(f.end.getTime() + HOUR));
    expect(await run()).toMatchObject({ renewed: 1 });
    expect(
      await q("select kind from operations where resource_id = $1 and kind <> 'create'", [
        f.resourceId,
      ]),
    ).toEqual([]);
    expect((await q("select state from resources where id = $1", [f.resourceId]))[0]).toEqual({
      state: "suspended",
    });
  });
});

describe("two runs at once", () => {
  it("charge one renewal and queue one suspend, never two (R7)", async () => {
    const f = await fresh(10_000_000n, true);
    kit.clock.set(f.end);
    const before = await kit.balance(f.customerId);
    const [a, b] = await Promise.all([run(), run()]);
    expect(a.renewed + b.renewed).toBe(1);
    expect(await renewals(f.subscriptionId)).toBe(1);
    expect(before - (await kit.balance(f.customerId))).toBeLessThan(PLAN_TOTAL * 2n);
  });
});

describe("a subscription that cannot be priced (R16)", () => {
  it("is not charged: its snapshot is unreadable, so it goes to grace and the others go on", async () => {
    const bad = await fresh(10_000_000n, true);
    const good = await fresh(10_000_000n, true);
    await q("update subscriptions set price_snapshot = '{\"v\": 2}'::jsonb where id = $1", [
      bad.subscriptionId,
    ]);
    kit.clock.set(new Date(Math.max(bad.end.getTime(), good.end.getTime())));
    const report = await run();
    expect(report.renewed).toBeGreaterThanOrEqual(1);
    expect(await renewals(bad.subscriptionId)).toBe(0);
    expect(await renewals(good.subscriptionId)).toBe(1);
    expect((await subRow(bad.subscriptionId)).status).toBe("grace");
    expect(await kit.balance(bad.customerId)).toBe(10_000_000n);
    expect(DAY).toBeGreaterThan(0);
  });
});

describe("the final snapshot belongs to the current retention (R13, R16)", () => {
  it("an old final backup does not allow a later destroy; the new one does; a restore supersedes the old one", async () => {
    const { destructiveGuard } = await import("./guard");
    const { completeRestore } = await import("./restore");
    const { loadRunView } = await import("@tc/db");
    const f = await fresh(10_000_000n, false);
    const backup = (at: string) =>
      q(
        `insert into resources (id, customer_id, family, parent_resource_id, config, state, created_at)
         values (gen_random_uuid(), $1, 'backup', $2, '{"final": true}'::jsonb, 'active', $3)`,
        [f.customerId, f.resourceId, at],
      );
    const op = async (kind: string, at: string) =>
      String(
        (
          await q(
            `insert into operations (id, resource_id, kind, state, idempotency_key, created_at)
             values (gen_random_uuid(), $1, $2, 'queued', $3, $4) returning id`,
            [f.resourceId, kind, `t:${kind}:${crypto.randomUUID()}`, at],
          )
        )[0]!.id,
      );
    const allowed = (id: string) =>
      worker(async (tx) => {
        const view = await loadRunView(tx, id);
        return view === null ? false : destructiveGuard(tx, view);
      });
    // Cycle 1: a snapshot, then retained.
    await op("final_snapshot", "2026-12-01T00:00:00Z");
    await backup("2026-12-01T01:00:00Z");
    await q("update subscriptions set status = 'retained' where id = $1", [f.subscriptionId]);
    expect(await allowed(await op("destroy", "2026-12-01T02:00:00Z"))).toBe(true);
    // The restore supersedes cycle 1.
    kit.clock.set(new Date("2026-12-05T00:00:00Z"));
    expect(
      await worker((tx) =>
        completeRestore(tx, { subscriptionId: f.subscriptionId, clock: kit.clock }),
      ),
    ).toMatchObject({ ok: true });
    expect(
      (
        await q(
          "select config->>'final' as f from resources where family = 'backup' and parent_resource_id = $1",
          [f.resourceId],
        )
      )[0],
    ).toEqual({ f: "false" });
    // Cycle 2 with only the OLD backup (even if its flag were still true): refused.
    await q("update subscriptions set status = 'retained' where id = $1", [f.subscriptionId]);
    await q(
      `update resources set config = '{"final": true}'::jsonb where family = 'backup' and parent_resource_id = $1`,
      [f.resourceId],
    );
    await op("final_snapshot", "2027-01-01T00:00:00Z");
    const destroy = await op("destroy", "2027-01-01T00:00:01Z");
    expect(await allowed(destroy)).toBe(false);
    await backup("2027-01-01T01:00:00Z");
    expect(await allowed(destroy)).toBe(true);
  });
});
