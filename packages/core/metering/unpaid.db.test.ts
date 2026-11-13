// WPU-Y3 against a real database: the first failure is recorded, the daily job retries every hour back
// to it (no 3-hour window), suspends after 1 day, stays off until the setting says true, and ends the
// episode when the wallet pays. Needs the local PostgreSQL (pnpm db:up).
import { meteringRepo, type Tx } from "@tc/db";
import { runTransaction, useTempDatabase } from "@tc/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import type { Notice } from "../lifecycle/notice";
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

describe("the unpaid static IP charge", () => {
  it("is retried for every hour, suspends at 1 day, and ends when it is paid", async () => {
    const buyer = await kit.newBuyer({ balanceMinor: 20_000_000n });
    const { resourceId } = await placeOne(kit, buyer);
    await q("update wallets set balance_minor = 0 where customer_id = $1", [buyer.customerId]);
    await q(
      `update resources set state = 'active',
         config = config || jsonb_build_object('staticIpAttached', false, 'detachedAt', $2::text)
       where id = $1`,
      [resourceId, DETACHED.toISOString()],
    );
    const notices: Notice[] = [];
    const unpaid = (now: Date) => {
      kit.clock.set(now);
      return runUnpaid({
        runTx: worker,
        clock: kit.clock,
        log: () => undefined,
        notice: async (_tx, n) => {
          notices.push(n);
        },
      });
    };

    // The normal pass fails on the empty wallet and records the first failure.
    kit.clock.set(T0);
    await runStaticIpMetering({ runTx: worker, clock: kit.clock, log: () => undefined });
    const marked = await q("select config ->> 'unpaidSince' as s from resources where id = $1", [
      resourceId,
    ]);
    expect(marked[0]!.s).toBe(T0.toISOString());

    // Off by default (R12): the job does nothing and says so.
    expect(await unpaid(T0)).toMatchObject({ enabled: false, examined: 0 });

    await q(
      `insert into settings (id, key, market, scope, scope_id, value, created_at)
       values (gen_random_uuid(), 'lifecycle_unpaid_enabled', 'BD', 'market', null, 'true'::jsonb, now())`,
    );
    // Day 0: a warning, no suspension.
    expect(await unpaid(T0)).toMatchObject({
      enabled: true,
      examined: 1,
      stillUnpaid: 1,
      suspended: 0,
    });
    expect(notices.map((n) => n.template)).toEqual(["unpaid_warning"]);
    // Replay on the same day: one warning only (R7).
    await unpaid(new Date(T0.getTime() + 3_600_000));
    expect(notices.map((n) => n.template)).toEqual(["unpaid_warning"]);

    // Exactly 1 day: suspended, with a suspend operation.
    const day1 = new Date(T0.getTime() + DAY);
    expect(await unpaid(day1)).toMatchObject({ suspended: 1 });
    const ops = await q("select kind from operations where resource_id = $1", [resourceId]);
    expect(ops.map((o) => o.kind)).toContain("suspend");
    expect(notices.at(-1)?.template).toBe("unpaid_suspended");

    // The wallet pays: every hour since the first failure is charged, not only the last three.
    await q("update wallets set balance_minor = 20000000 where customer_id = $1", [
      buyer.customerId,
    ]);
    const paid = await unpaid(new Date(day1.getTime() + 2 * 3_600_000));
    expect(paid).toMatchObject({ paid: 1, stillUnpaid: 0 });
    expect(paid.charged).toBeGreaterThan(24);
    const gone = await q("select config ? 'unpaidSince' as has from resources where id = $1", [
      resourceId,
    ]);
    expect(gone[0]!.has).toBe(false);
    // A second run charges nothing again.
    expect(await unpaid(new Date(day1.getTime() + 3 * 3_600_000))).toMatchObject({
      charged: 0,
      examined: 0,
    });
  });
});

// WPU-Y3b. The new statements (written without a database in this session; NOT RUN here, run with pnpm db:up).
describe("the marks and the range read of WPU-Y3b", () => {
  it("keeps the first and last failed static IP hour, and clears them with the episode", async () => {
    const buyer = await kit.newBuyer({ balanceMinor: 1_000n });
    const { resourceId } = await placeOne(kit, buyer);
    const at = (ms: number) => new Date(T0.getTime() + ms);
    await worker((tx) => meteringRepo(tx).markUnpaid(resourceId, T0, "2026-11-11T13"));
    await worker((tx) => meteringRepo(tx).markUnpaid(resourceId, at(3_600_000), "2026-11-11T15"));
    await worker((tx) => meteringRepo(tx).markUnpaid(resourceId, at(7_200_000), "2026-11-11T14"));
    const rows = await q("select config from resources where id = $1", [resourceId]);
    const config = rows[0]!.config as Record<string, string>;
    expect(config.unpaidSince).toBe(T0.toISOString());
    expect(config.unpaidIpFrom).toBe("2026-11-11T13");
    expect(config.unpaidIpTo).toBe("2026-11-11T15");
    await worker((tx) => meteringRepo(tx).clearUnpaid(resourceId));
    const after = await q("select config from resources where id = $1", [resourceId]);
    const left = Object.keys(after[0]!.config as object).filter((k) => k.startsWith("unpaid"));
    expect(left).toEqual([]);
  });

  // WPU-Y9 finding 4 (NOT RUN here, no database).
  it("keeps the oldest failed snapshot day and clears it with the episode", async () => {
    const buyer = await kit.newBuyer({ balanceMinor: 1_000n });
    const { resourceId } = await placeOne(kit, buyer);
    const repo = (tx: Parameters<typeof meteringRepo>[0]) => meteringRepo(tx);
    await worker((tx) => repo(tx).markUnpaid(resourceId, T0, undefined, "2026-11-10"));
    await worker((tx) => repo(tx).markUnpaid(resourceId, T0, undefined, "2026-11-08"));
    await worker((tx) => repo(tx).markUnpaid(resourceId, T0, undefined, "2026-11-09"));
    const rows = await q("select config from resources where id = $1", [resourceId]);
    const config = rows[0]!.config as Record<string, string>;
    expect(config.unpaidSince).toBe(T0.toISOString());
    expect(config.unpaidDayFrom).toBe("2026-11-08");
    await worker((tx) => repo(tx).clearUnpaid(resourceId));
    const after = await q("select config from resources where id = $1", [resourceId]);
    expect(Object.keys(after[0]!.config as object).filter((k) => k.startsWith("unpaid"))).toEqual(
      [],
    );
  });

  it("reads the charged keys of a range in one statement", async () => {
    const buyer = await kit.newBuyer({ balanceMinor: 1_000n });
    const { resourceId } = await placeOne(kit, buyer);
    const prefix = `meter:${resourceId}:static_ip_hour:`;
    const keys = await worker((tx) =>
      meteringRepo(tx).chargedKeys(prefix, `${prefix}2026-11-11T00`, `${prefix}2026-11-11T23`, 100),
    );
    expect(keys).toEqual([]);
  });
});
