// WPU-Y10 (written without a database in the sandbox: it needs PostgreSQL, see JOURNEY). A subscription WITHOUT
// auto-renew is not charged by the scheduler, but while our USD to BDT rate is stale the customer cannot pay by hand
// either. So its period end must not start the grace and its grace must not end in retention until a rate is back.
// This file has its own database: the cases do not share rates with fx-hold.db.test.ts.
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

async function fresh() {
  kit.clock.set(START);
  const buyer = await kit.newBuyer({ balanceMinor: 50_000_000n });
  const { resourceId } = await placeOne(kit, buyer);
  const s = (
    await q("select id, period_end from subscriptions where resource_id = $1", [resourceId])
  )[0]!;
  await q("update resources set state = 'active' where id = $1", [resourceId]);
  await q("update operations set state = 'succeeded' where resource_id = $1", [resourceId]);
  // auto_renew stays false (the purchase default): that is the case under test.
  await q("update subscriptions set auto_renew = false where id = $1", [s.id]);
  return {
    resourceId,
    subscriptionId: String(s.id),
    customerId: buyer.customerId,
    end: s.period_end as Date,
  };
}
const status = async (id: string) =>
  String((await q("select status from subscriptions where id = $1", [id]))[0]!.status);
const state = async (id: string) =>
  String((await q("select state from resources where id = $1", [id]))[0]!.state);
const charges = async (id: string) =>
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

describe("a subscription without auto-renew while the rate is stale", () => {
  it("does not enter grace or get suspended at the period end; with a fresh rate the grace starts then, and nothing is charged", async () => {
    const f = await fresh();
    kit.clock.set(new Date(f.end.getTime() + 60_000)); // the only rate is the seed from START: 30 days old
    for (let i = 0; i < 3; i += 1) await sweep();
    expect(await status(f.subscriptionId)).toBe("active");
    expect(await state(f.resourceId)).toBe("active");
    await kit.refreshFx();
    await sweep();
    expect(await status(f.subscriptionId)).toBe("grace");
    expect(await charges(f.subscriptionId)).toBe(0);
    const graceFrom = (
      await q("select config->>'graceFrom' as g from resources where id = $1", [f.resourceId])
    )[0]!.g;
    expect(graceFrom).toBe(kit.clock.now().toISOString());
  });

  it("is not retained while the rate is stale; the grace then runs from the moment a rate is back, with no charge", async () => {
    const f = await fresh();
    await kit.refreshFx(); // fresh at the period end, so the grace starts normally
    kit.clock.set(new Date(f.end.getTime() + 60_000));
    await sweep();
    expect(await status(f.subscriptionId)).toBe("grace");
    // 20 days later the rate is stale again and far beyond the grace hours
    kit.clock.set(new Date(f.end.getTime() + 20 * DAY));
    await sweep();
    await sweep();
    expect(await status(f.subscriptionId)).toBe("grace");
    await kit.refreshFx();
    await sweep(); // the hold is released: the grace runs from now
    expect(await status(f.subscriptionId)).toBe("grace");
    expect(await charges(f.subscriptionId)).toBe(0);
    kit.clock.set(new Date(kit.clock.now().getTime() + 49 * 3_600_000));
    await sweep();
    expect(await status(f.subscriptionId)).toBe("retained");
  });
});
