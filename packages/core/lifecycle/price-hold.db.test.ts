// WPU-Z1 (written without a database in the sandbox: it needs PostgreSQL, NOT RUN here; run with pnpm db:up). A
// renewal that cannot be priced or posted for a reason that is not the customer's wallet is held exactly like a stale
// rate (fx-hold.db.test.ts): nothing is charged, graced, suspended or retained, and the sweep repeats it without harm.
// The failure used here is a stored price snapshot that does not parse (`internal`). A wallet that is short still
// enters grace. Markers that a renewal by hand left behind are cleared, so the next period's grace starts at its own
// period end. Own database; the rate is kept fresh for the whole file (keepFxFresh), so no case here is held for the
// rate and every hold below is the new one.
import type { Tx } from "@tc/db";
import { runTransaction, useTempDatabase } from "@tc/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import type { LogEvent } from "../operations/types";
import { makeKit, placeOne, PLAN_TOTAL, START, type Kit } from "../test/orders-kit";
import { runLifecycle } from "./engine";
import { renewNow } from "./renew-now";

const t = useTempDatabase();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
let kit: Kit;

const worker = <T>(fn: (tx: Tx) => Promise<T>) => runTransaction(t.db, fn, { role: "worker_rw" });
const asWeb = <T>(fn: (tx: Tx) => Promise<T>) => runTransaction(t.db, fn, { role: "web_rw" });
const logged: LogEvent[] = [];
const sweep = () =>
  runLifecycle({ runTx: worker, clock: kit.clock, log: (e) => void logged.push(e) });
const q = async (sql: string, params: unknown[] = []) =>
  (await t.pool.query(sql, params)).rows as Record<string, unknown>[];

interface Fresh {
  resourceId: string;
  subscriptionId: string;
  customerId: string;
  end: Date;
}

// A purchased and activated instance of a new customer, bought at START: its period ends at START + 30 days.
async function fresh(autoRenew: boolean, balanceMinor = 50_000_000n): Promise<Fresh> {
  kit.clock.set(START);
  const buyer = await kit.newBuyer({ balanceMinor });
  const { resourceId } = await placeOne(kit, buyer);
  const s = (
    await q("select id, period_end from subscriptions where resource_id = $1", [resourceId])
  )[0]!;
  await q("update resources set state = 'active' where id = $1", [resourceId]);
  await q("update operations set state = 'succeeded' where resource_id = $1", [resourceId]);
  await q("update subscriptions set auto_renew = $2 where id = $1", [s.id, autoRenew]);
  return {
    resourceId,
    subscriptionId: String(s.id),
    customerId: buyer.customerId,
    end: s.period_end as Date,
  };
}

// The stored price snapshot stops parsing: renewalQuote and renewSubscription answer `internal`. A failure of the
// platform, not of the customer. Returns the good snapshot, for the repair.
async function breakPrice(f: Fresh): Promise<unknown> {
  const good = (
    await q("select price_snapshot as p from subscriptions where id = $1", [f.subscriptionId])
  )[0]!.p;
  await q(`update subscriptions set price_snapshot = '{"v": 0}'::jsonb where id = $1`, [
    f.subscriptionId,
  ]);
  return good;
}
const repairPrice = (f: Fresh, good: unknown) =>
  q("update subscriptions set price_snapshot = $2::jsonb where id = $1", [
    f.subscriptionId,
    JSON.stringify(good),
  ]);

const status = async (f: Fresh) =>
  String(
    (await q("select status from subscriptions where id = $1", [f.subscriptionId]))[0]!.status,
  );
const period = async (f: Fresh) => {
  const row = (
    await q("select period_start, period_end from subscriptions where id = $1", [f.subscriptionId])
  )[0]!;
  return { start: row.period_start as Date, end: row.period_end as Date };
};
const resourceState = async (f: Fresh) =>
  String((await q("select state from resources where id = $1", [f.resourceId]))[0]!.state);
const renewals = async (f: Fresh) =>
  Number(
    (
      await q(
        "select count(*)::int as n from ledger_transactions where kind = 'renewal' and reference_id = $1",
        [f.subscriptionId],
      )
    )[0]!.n,
  );
const opsOf = async (f: Fresh, kind: string) =>
  Number(
    (
      await q("select count(*)::int as n from operations where resource_id = $1 and kind = $2", [
        f.resourceId,
        kind,
      ])
    )[0]!.n,
  );
const graceNotices = async (f: Fresh) =>
  Number(
    (
      await q(
        "select count(*)::int as n from notifications where customer_id = $1 and template = 'lifecycle_grace_started'",
        [f.customerId],
      )
    )[0]!.n,
  );
// The markers as stored: an object, a string, or null (no key, or the JSON null a release writes).
const marker = async (f: Fresh) =>
  (await q("select config->'fxRateHold' as h from resources where id = $1", [f.resourceId]))[0]!.h;
const graceFrom = async (f: Fresh) =>
  (await q("select config->'graceFrom' as g from resources where id = $1", [f.resourceId]))[0]!.g;
const heldLines = (f: Fresh) =>
  logged.filter(
    (e) => e.event === "lifecycle_renewal_held" && e.subscriptionId === f.subscriptionId,
  );
const priceHold = (since: Date) => ({
  since: since.toISOString(),
  reason: "price_unavailable",
  error: "internal",
});

beforeAll(async () => {
  kit = await makeKit(t, { keepFxFresh: true });
});

describe("a renewal that cannot be priced for another reason than the rate (WPU-Z1)", () => {
  it("auto-renew on: held at the period end, nothing charged, graced or suspended; repeats change nothing; a repaired price renews once", async () => {
    const f = await fresh(true);
    const good = await breakPrice(f);
    const before = await kit.balance(f.customerId);
    const heldAt = new Date(f.end.getTime() + MINUTE);
    kit.clock.set(heldAt);
    await sweep();
    expect(await marker(f)).toEqual(priceHold(heldAt));
    for (const later of [HOUR, 3 * DAY]) {
      kit.clock.set(new Date(f.end.getTime() + later));
      await sweep();
    }
    expect(await status(f)).toBe("active");
    expect(await resourceState(f)).toBe("active");
    expect(await opsOf(f, "suspend")).toBe(0);
    expect(await renewals(f)).toBe(0);
    expect(await kit.balance(f.customerId)).toBe(before);
    expect(await graceNotices(f)).toBe(0);
    // `since` never moves and the same reason writes nothing new; no grace was started.
    expect(await marker(f)).toEqual(priceHold(heldAt));
    expect(await graceFrom(f)).toBeNull();
    // One line a sweep, with ids and fixed words only (R14).
    expect(heldLines(f)).toEqual(
      Array.from({ length: 3 }, () => ({
        event: "lifecycle_renewal_held",
        reason: "price_unavailable",
        error: "internal",
        where: "period_end",
        subscriptionId: f.subscriptionId,
        resourceId: f.resourceId,
      })),
    );

    // The release is unchanged: once the price is repaired the next sweep renews once, from the OLD period end, and
    // the marker is cleared; a repeat charges nothing (R7).
    await repairPrice(f, good);
    await sweep();
    expect(await renewals(f)).toBe(1);
    expect(await status(f)).toBe("active");
    expect((await period(f)).start.getTime()).toBe(f.end.getTime());
    expect(await marker(f)).toBeNull();
    await sweep();
    expect(await renewals(f)).toBe(1);
  });

  it("auto-renew off: the period end is held the same way (the customer could not pay by hand either)", async () => {
    const f = await fresh(false);
    await breakPrice(f);
    const heldAt = new Date(f.end.getTime() + MINUTE);
    kit.clock.set(heldAt);
    for (let i = 0; i < 3; i += 1) await sweep();
    expect(await status(f)).toBe("active");
    expect(await resourceState(f)).toBe("active");
    expect(await opsOf(f, "suspend")).toBe(0);
    expect(await renewals(f)).toBe(0);
    expect(await graceNotices(f)).toBe(0);
    expect(await marker(f)).toEqual(priceHold(heldAt));
    expect(heldLines(f).map((e) => e.where)).toEqual(["period_end", "period_end", "period_end"]);
  });

  it("a renewal retried in grace is held too: nothing charged and no new suspension", async () => {
    const f = await fresh(true);
    await breakPrice(f);
    await q("update subscriptions set status = 'grace' where id = $1", [f.subscriptionId]);
    kit.clock.set(new Date(f.end.getTime() + 2 * HOUR)); // inside the 48 grace hours: retry_renew
    await sweep();
    expect(await status(f)).toBe("grace");
    expect(await renewals(f)).toBe(0);
    expect(await opsOf(f, "suspend")).toBe(0);
    expect(heldLines(f).map((e) => e.where)).toEqual(["retry_renew"]);
    expect(await marker(f)).toEqual(priceHold(kit.clock.now()));
  });

  it("a subscription in grace far beyond the grace hours is not retained while its price cannot be had, with or without auto-renew", async () => {
    for (const autoRenew of [true, false]) {
      const f = await fresh(autoRenew);
      const good = await breakPrice(f);
      await q("update subscriptions set status = 'grace' where id = $1", [f.subscriptionId]);
      const at = new Date(f.end.getTime() + 10 * DAY);
      kit.clock.set(at);
      await sweep(); // auto-renew on: not held yet, the quote fails; off: the quote fails
      await sweep(); // auto-renew on: held, the one renewal fails; off: the quote fails again
      expect(await status(f)).toBe("grace");
      expect((await opsOf(f, "final_snapshot")) + (await opsOf(f, "destroy"))).toBe(0);
      expect(await renewals(f)).toBe(0);
      expect(await marker(f)).toEqual(priceHold(at));
      expect(heldLines(f).map((e) => e.where)).toEqual(["retain", "retain"]);

      // Once the price is back nothing is retained in that sweep either: with auto-renew the held subscription renews
      // first (from grace); without it the grace runs from the release (graceFrom), as after a rate hold.
      await repairPrice(f, good);
      await sweep();
      if (autoRenew) {
        expect(await status(f)).toBe("active");
        expect(await renewals(f)).toBe(1);
        expect(await graceFrom(f)).toBeNull();
      } else {
        expect(await status(f)).toBe("grace");
        expect(await renewals(f)).toBe(0);
        expect(await graceFrom(f)).toBe(at.toISOString());
      }
      expect(await marker(f)).toBeNull();
    }
  });

  it("a wallet that is short still enters grace at the period end: insufficient_balance is the customer's own reason", async () => {
    const f = await fresh(true, PLAN_TOTAL); // exactly the price of the plan: the wallet is empty for the renewal
    kit.clock.set(new Date(f.end.getTime() + MINUTE));
    await sweep();
    expect(await status(f)).toBe("grace");
    expect(await opsOf(f, "suspend")).toBe(1);
    expect(await renewals(f)).toBe(0);
    expect(await graceNotices(f)).toBe(1);
    expect(await marker(f)).toBeNull();
    expect(await graceFrom(f)).toBeNull();
    expect(heldLines(f)).toEqual([]);
  });

  it("markers left behind by a renewal by hand are cleared, and the next period's grace starts at its own period end", async () => {
    // Two periods' worth: the purchase pays one, the renewal by hand the other; the next renewal finds the wallet empty.
    const f = await fresh(true, 2n * PLAN_TOTAL);
    const good = await breakPrice(f);
    kit.clock.set(new Date(f.end.getTime() + MINUTE));
    await sweep();
    expect(await marker(f)).toEqual(priceHold(kit.clock.now()));

    // The price is repaired and the customer pays by hand before the next sweep. renewNow runs as web_rw, which
    // cannot write resources.config: the hold marker stays behind.
    await repairPrice(f, good);
    const paid = await asWeb((tx) =>
      renewNow(tx, { customerId: f.customerId, resourceId: f.resourceId, clock: kit.clock }),
    );
    expect(paid.ok).toBe(true);
    expect(await kit.balance(f.customerId)).toBe(0n);
    const next = (await period(f)).end;
    expect(next.getTime()).toBe(f.end.getTime() + 30 * DAY);
    expect(await status(f)).toBe("active");
    expect(await marker(f)).not.toBeNull();
    // And the graceFrom that a hold of the old period, released for the wallet, would have left behind the same way.
    await q(
      "update resources set config = config || jsonb_build_object('graceFrom', $2::text) where id = $1",
      [f.resourceId, new Date(f.end.getTime() + 2 * MINUTE).toISOString()],
    );

    // An active subscription is examined again from 7 days before its period end (the reminder horizon): that sweep
    // clears both markers before it decides anything.
    kit.clock.set(new Date(next.getTime() - 2 * DAY));
    await sweep();
    expect(await status(f)).toBe("active");
    expect(await marker(f)).toBeNull();
    expect(await graceFrom(f)).toBeNull();

    // The next period end, swept 10 hours late, with an empty wallet: the grace starts AT the period end (a stale
    // marker would have started it at this sweep), so 48 hours after the period end the subscription is retained.
    kit.clock.set(new Date(next.getTime() + 10 * HOUR));
    await sweep();
    expect(await status(f)).toBe("grace");
    expect(await graceFrom(f)).toBeNull();
    kit.clock.set(new Date(next.getTime() + 48 * HOUR + MINUTE));
    await sweep();
    expect(await status(f)).toBe("retained");
    expect(await renewals(f)).toBe(1); // the renewal by hand only
  });
});
