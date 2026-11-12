// renewNow (16.10 Billing): the customer pays a renewal at once from the wallet. Run as web_rw, the
// role of the customer panel, so a missing grant shows here and not in production.
import { runTransaction, useTempDatabase } from "@tc/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { makeKit, placeOne, PLAN_TOTAL, START, type Kit } from "../test/orders-kit";
import { renewNow } from "./renew-now";

const t = useTempDatabase();
const DAY = 24 * 3_600_000;
const HOUR = 3_600_000;
let kit: Kit;

const q = async (sql: string, params: unknown[] = []) =>
  (await t.pool.query(sql, params)).rows as Record<string, unknown>[];
const asWeb = <T>(fn: Parameters<typeof runTransaction<T>>[1]) =>
  runTransaction(t.db, fn, { role: "web_rw" });

interface Fresh {
  customerId: string;
  resourceId: string;
  subscriptionId: string;
  end: Date;
}

async function fresh(): Promise<Fresh> {
  kit.clock.set(START);
  const buyer = await kit.newBuyer({ balanceMinor: 20_000_000n });
  const { resourceId } = await placeOne(kit, buyer);
  const s = (
    await q("select id, period_end from subscriptions where resource_id = $1", [resourceId])
  )[0]!;
  await q("update resources set state = 'active' where id = $1", [resourceId]);
  await q("update operations set state = 'succeeded' where resource_id = $1", [resourceId]);
  return {
    customerId: buyer.customerId,
    resourceId,
    subscriptionId: String(s.id),
    end: s.period_end as Date,
  };
}

const sub = async (id: string) =>
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
const run = (f: Fresh, resourceId = f.resourceId, customerId = f.customerId) =>
  asWeb((tx) => renewNow(tx, { customerId, resourceId, clock: kit.clock }));

beforeAll(async () => {
  kit = await makeKit(t);
});

describe("renewNow", () => {
  it("is refused far from the period end: nothing is charged, no period is stacked", async () => {
    const f = await fresh();
    const before = await kit.balance(f.customerId);
    const r = await run(f);
    expect(r).toMatchObject({ ok: false, error: "conflict" });
    expect(await kit.balance(f.customerId)).toBe(before);
    expect(await renewals(f.subscriptionId)).toBe(0);
  });

  it("charges the renewal once inside the 7 days; the new period starts at the old end", async () => {
    const f = await fresh();
    kit.clock.set(new Date(f.end.getTime() - 6 * DAY));
    const before = await kit.balance(f.customerId);
    const r = await run(f);
    expect(r.ok).toBe(true);
    const s = await sub(f.subscriptionId);
    expect(s.status).toBe("active");
    expect((s.period_start as Date).toISOString()).toBe(f.end.toISOString());
    expect((s.period_end as Date).getTime()).toBe(f.end.getTime() + 30 * DAY);
    expect(await kit.balance(f.customerId)).toBeLessThan(before);
    expect(await renewals(f.subscriptionId)).toBe(1);
  });

  it("a second click, or a double submit, never charges twice (R7)", async () => {
    const f = await fresh();
    kit.clock.set(new Date(f.end.getTime() - 2 * DAY));
    const [a, b] = await Promise.all([run(f), run(f)]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const again = await run(f);
    expect(again).toMatchObject({ ok: false, error: "conflict" });
    expect(await renewals(f.subscriptionId)).toBe(1);
  });

  it("from grace it resumes a suspended resource once and keeps an admin suspension", async () => {
    const f = await fresh();
    await q("update subscriptions set status = 'grace' where id = $1", [f.subscriptionId]);
    await q("update resources set state = 'suspended' where id = $1", [f.resourceId]);
    kit.clock.set(new Date(f.end.getTime() + HOUR));
    expect((await run(f)).ok).toBe(true);
    const ops = await q("select kind, state from operations where resource_id = $1", [
      f.resourceId,
    ]);
    expect(ops.filter((o) => o.kind === "resume")).toHaveLength(1);
    expect((await sub(f.subscriptionId)).status).toBe("active");

    const g = await fresh();
    await q("update subscriptions set status = 'grace' where id = $1", [g.subscriptionId]);
    await q(
      `update resources set state = 'suspended', config = config || '{"adminSuspended": true}'::jsonb where id = $1`,
      [g.resourceId],
    );
    kit.clock.set(new Date(g.end.getTime() + HOUR));
    expect((await run(g)).ok).toBe(true);
    const gOps = await q("select kind from operations where resource_id = $1", [g.resourceId]);
    expect(gOps.filter((o) => o.kind === "resume")).toHaveLength(0);
  });

  it("a short wallet is insufficient_balance with the shortfall, and writes nothing", async () => {
    kit.clock.set(START);
    const poor = await kit.newBuyer({ balanceMinor: PLAN_TOTAL + 100n });
    const { resourceId } = await placeOne(kit, poor);
    const s = (
      await q("select id, period_end from subscriptions where resource_id = $1", [resourceId])
    )[0]!;
    await q("update resources set state = 'active' where id = $1", [resourceId]);
    kit.clock.set(new Date((s.period_end as Date).getTime() - DAY));
    const r = await asWeb((tx) =>
      renewNow(tx, { customerId: poor.customerId, resourceId, clock: kit.clock }),
    );
    expect(r).toMatchObject({
      ok: false,
      error: "insufficient_balance",
      data: { shortfallMinor: (PLAN_TOTAL - 100n).toString() },
    });
    expect(await renewals(String(s.id))).toBe(0);
    expect(await kit.balance(poor.customerId)).toBe(100n);
  });

  it("another customer's server answers not_found, like a missing one (R8)", async () => {
    const mine = await fresh();
    const other = await fresh();
    kit.clock.set(new Date(other.end.getTime() - DAY));
    const stolen = await run(mine, other.resourceId, mine.customerId);
    const missing = await run(mine, crypto.randomUUID(), mine.customerId);
    expect(stolen).toEqual(missing);
    expect(stolen).toMatchObject({ ok: false, error: "not_found" });
    expect(await renewals(other.subscriptionId)).toBe(0);
  });

  it("a retained or ended subscription is refused", async () => {
    const f = await fresh();
    await q("update subscriptions set status = 'retained' where id = $1", [f.subscriptionId]);
    kit.clock.set(new Date(f.end.getTime() - DAY));
    expect(await run(f)).toMatchObject({ ok: false, error: "conflict" });
  });
});
