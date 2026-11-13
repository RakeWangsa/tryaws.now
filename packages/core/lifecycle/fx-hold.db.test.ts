// WPU-Y1 (written without a database in the sandbox: it needs PostgreSQL, see JOURNEY). A renewal that cannot be priced
// because the USD to BDT rate is older than 7 days is NOT charged, NOT graced, NOT suspended and NOT retained: it is
// held and tried again on every sweep. When a new rate is set it is charged once, from the OLD period end.
import type { Tx } from "@tc/db";
import { runTransaction, useTempDatabase } from "@tc/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { makeKit, placeOne, START, type Kit } from "../test/orders-kit";
import { runLifecycle } from "./engine";

const t = useTempDatabase();
const DAY = 24 * 3_600_000;
let kit: Kit;

const worker = <T>(fn: (tx: Tx) => Promise<T>) => runTransaction(t.db, fn, { role: "worker_rw" });
const sweep = () => runLifecycle({ runTx: worker, clock: kit.clock, log: () => undefined });
const q = async (sql: string, params: unknown[] = []) =>
  (await t.pool.query(sql, params)).rows as Record<string, unknown>[];

interface Fresh {
  resourceId: string;
  subscriptionId: string;
  end: Date;
}

async function fresh(): Promise<Fresh> {
  kit.clock.set(START);
  const buyer = await kit.newBuyer({ balanceMinor: 50_000_000n });
  const { resourceId } = await placeOne(kit, buyer);
  const s = (
    await q("select id, period_end from subscriptions where resource_id = $1", [resourceId])
  )[0]!;
  await q("update resources set state = 'active' where id = $1", [resourceId]);
  await q("update operations set state = 'succeeded' where resource_id = $1", [resourceId]);
  return { resourceId, subscriptionId: String(s.id), end: s.period_end as Date };
}

const status = async (id: string) =>
  String((await q("select status from subscriptions where id = $1", [id]))[0]!.status);
const renewals = async (id: string) =>
  Number(
    (
      await q(
        "select count(*)::int as n from ledger_transactions where kind = 'renewal' and reference_id = $1",
        [id],
      )
    )[0]!.n,
  );
const state = async (resourceId: string) =>
  String((await q("select state from resources where id = $1", [resourceId]))[0]!.state);

beforeAll(async () => {
  kit = await makeKit(t);
});

describe("a renewal that cannot be priced because the rate is stale", () => {
  it("is held at the period end: no grace, no suspension, no charge, and the sweep repeats it without harm", async () => {
    const f = await fresh();
    // the period ends 30 days after START; the only rate is the staging seed from START: 30 days old, stale
    kit.clock.set(new Date(f.end.getTime() + 60_000));
    const before = await kit.balance();
    for (let i = 0; i < 3; i += 1) await sweep();
    expect(await status(f.subscriptionId)).toBe("active");
    expect(await state(f.resourceId)).toBe("active");
    expect(await renewals(f.subscriptionId)).toBe(0);
    expect(await kit.balance()).toBe(before);
    const held = (
      await q("select config->'fxRateHold' as h from resources where id = $1", [f.resourceId])
    )[0]!;
    expect(held.h).not.toBeNull();
  });

  it("is charged once when a new rate is set, from the OLD period end, and a repeat is a replay (R7)", async () => {
    const f = await fresh();
    kit.clock.set(new Date(f.end.getTime() + 60_000));
    await sweep();
    expect(await renewals(f.subscriptionId)).toBe(0);
    await kit.refreshFx(); // an admin sets the rate again
    await sweep();
    expect(await renewals(f.subscriptionId)).toBe(1);
    expect(await status(f.subscriptionId)).toBe("active");
    const sub = (
      await q("select period_start from subscriptions where id = $1", [f.subscriptionId])
    )[0]!;
    expect((sub.period_start as Date).getTime()).toBe(f.end.getTime());
    await sweep();
    await sweep();
    expect(await renewals(f.subscriptionId)).toBe(1);
    const held = (
      await q("select config->'fxRateHold' as h from resources where id = $1", [f.resourceId])
    )[0]!;
    expect(held.h).toBeNull();
  });

  it("is never retained or destroyed while it cannot be priced; once the rate is back it renews first", async () => {
    const f = await fresh();
    await q("update subscriptions set status = 'grace' where id = $1", [f.subscriptionId]);
    await q(
      'update resources set config = config || \'{"fxRateHold": {"since": "x"}}\'::jsonb where id = $1',
      [f.resourceId],
    );
    // far beyond the grace hours
    kit.clock.set(new Date(f.end.getTime() + 10 * DAY));
    await sweep();
    expect(await status(f.subscriptionId)).toBe("grace");
    await kit.refreshFx();
    await sweep();
    expect(await status(f.subscriptionId)).toBe("active");
    expect(await renewals(f.subscriptionId)).toBe(1);
  });
});
