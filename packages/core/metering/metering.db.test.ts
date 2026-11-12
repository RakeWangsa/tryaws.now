// WP7-T5 against a real database: the repository statements as worker_rw, the ledger and the
// notification rows. Needs the local PostgreSQL (pnpm db:up); other tests of this package do not.
import type { Tx } from "@tc/db";
import { meteringRepo } from "@tc/db";
import { snapshotPrice } from "../products/snapshot-price";
import { runTransaction, useTempDatabase } from "@tc/db/testing";
import { beforeAll, expect, it } from "vitest";
import { makeKit, placeOne, START, type Kit } from "../test/orders-kit";
import { METERING_SETTING_KEYS, runMetering } from "./index";

const t = useTempDatabase();
let kit: Kit;
const worker = <T>(fn: (tx: Tx) => Promise<T>) => runTransaction(t.db, fn, { role: "worker_rw" });
const q = async (sql: string, params: unknown[] = []) =>
  (await t.pool.query(sql, params)).rows as Record<string, unknown>[];

beforeAll(async () => {
  kit = await makeKit(t);
});

it("charges 10 GB at 300 paisa a month as 100 paisa a day, once, and sends 80% and 100% notices", async () => {
  kit.clock.set(START); // 2026-11-11 06:00Z, 12:00 in Dhaka
  const buyer = await kit.newBuyer({ balanceMinor: 20_000_000n });
  const { resourceId } = await placeOne(kit, buyer);
  await q(
    'update resources set config = config || \'{"transferAllowanceGb": "1000"}\'::jsonb where id = $1',
    [resourceId],
  );
  // WPA-P2: the launch seed has the config price; this test exercises the old key of the transition.
  await q("delete from settings where key = 'config_price.snapshot_gb_month'");
  await q(
    "insert into settings (id, key, market, scope, value) values (gen_random_uuid(), $1, 'BD', 'market', '\"300\"'::jsonb)",
    [METERING_SETTING_KEYS.snapshotGbMonthMinor],
  );
  await worker((tx) => meteringRepo(tx).upsertUsage(resourceId, "snapshot_gb", "2026-11-10", "10"));
  await worker((tx) =>
    meteringRepo(tx).upsertUsage(resourceId, "transfer_gb", "2026-11-05T10", "500"),
  );
  await worker((tx) =>
    meteringRepo(tx).upsertUsage(resourceId, "transfer_gb", "2026-11-09T10", "350"),
  );

  const before = await kit.balance(buyer.customerId);
  const run = () => runMetering({ runTx: worker, clock: kit.clock, log: () => undefined });
  const first = await run();
  expect(first).toMatchObject({ charged: 1, failed: 0, notified80: 1, notified100: 0 });
  expect(before - (await kit.balance(buyer.customerId))).toBe(100n);
  const key = `meter:${resourceId}:snapshot_gb:2026-11-10`;
  expect(
    (await q("select kind from ledger_transactions where idempotency_key = $1", [key]))[0]?.kind,
  ).toBe("metered_charge");

  const second = await run();
  expect(second).toMatchObject({ charged: 0, replayed: 1, notified80: 0 });
  expect(
    await q("select 1 from ledger_transactions where idempotency_key = $1", [key]),
  ).toHaveLength(1);

  await worker((tx) =>
    meteringRepo(tx).upsertUsage(resourceId, "transfer_gb", "2026-11-10T10", "200"),
  );
  const third = await run();
  expect(third).toMatchObject({ notified80: 0, notified100: 1 });
  const templates = (
    await q(
      "select template from notifications where template like 'lifecycle_transfer_%' order by template",
    )
  ).map((r) => r.template);
  expect(templates).toEqual(["lifecycle_transfer_100", "lifecycle_transfer_80"]);
});

// WPA-P2. The charge reads the SAME price as the screens: `config_price.snapshot_gb_month` through the
// pricing engine (decimal text -> paisa, half-up, the FX rate and the margin in force).
async function chargeOf(
  usd: string | null,
  legacy: string | null,
): Promise<{
  charged: bigint;
  perGb: bigint;
  source: string;
}> {
  const buyer = await kit.newBuyer({ balanceMinor: 20_000_000n });
  const { resourceId } = await placeOne(kit, buyer);
  await q(
    "delete from settings where key in ('config_price.snapshot_gb_month', $1) and market = 'BD'",
    [METERING_SETTING_KEYS.snapshotGbMonthMinor],
  );
  if (usd !== null) {
    await q(
      `insert into settings (id, key, market, scope, value)
       values (gen_random_uuid(), 'config_price.snapshot_gb_month', 'BD', 'market', $1::jsonb)`,
      [JSON.stringify({ usd, unit: "gb_month" })],
    );
  }
  if (legacy !== null) {
    await q(
      "insert into settings (id, key, market, scope, value) values (gen_random_uuid(), $1, 'BD', 'market', $2::jsonb)",
      [METERING_SETTING_KEYS.snapshotGbMonthMinor, JSON.stringify(legacy)],
    );
  }
  await worker((tx) => meteringRepo(tx).upsertUsage(resourceId, "snapshot_gb", "2026-11-10", "30"));
  const perGb = await worker(async (tx) => {
    const p = await snapshotPrice(tx, "BD", null, kit.clock);
    return p.ok ? p.value.perGbMonthMinor : 0n;
  });
  const before = await kit.balance(buyer.customerId);
  const report = await runMetering({ runTx: worker, clock: kit.clock, log: () => undefined });
  const after = await kit.balance(buyer.customerId);
  return { charged: before - after, perGb, source: report.priceSource };
}

it("the daily charge follows the config price through the engine (30 GB: one GB-month price a day)", async () => {
  kit.clock.set(START);
  const r = await chargeOf("0.05", null);
  expect(r.source).toBe("config");
  expect(r.perGb).toBeGreaterThan(0n);
  expect(r.charged).toBe(r.perGb); // 30 GB x price / 30 days
});

it("an edited config price changes the charge; the old key no longer decides", async () => {
  kit.clock.set(START);
  const cheap = await chargeOf("0.05", "99999");
  const dear = await chargeOf("0.10", "99999");
  expect(cheap.source).toBe("config");
  expect(dear.charged).toBeGreaterThan(cheap.charged);
  expect(dear.charged).toBe(dear.perGb);
});

it("no config price: the old key still charges during the transition", async () => {
  kit.clock.set(START);
  const r = await chargeOf(null, "300");
  expect(r.source).toBe("legacy");
  expect(r.charged).toBe(300n); // 30 GB x 300 / 30
});

it("neither price: nothing is charged and the report says none (R16)", async () => {
  kit.clock.set(START);
  const r = await chargeOf(null, null);
  expect(r).toMatchObject({ charged: 0n, source: "none" });
});

it("the usage row is replaced by a newer measurement of the same period (R7)", async () => {
  const buyer = await kit.newBuyer();
  const { resourceId } = await placeOne(kit, buyer);
  await worker((tx) => meteringRepo(tx).upsertUsage(resourceId, "snapshot_gb", "2026-11-10", "1"));
  await worker((tx) =>
    meteringRepo(tx).upsertUsage(resourceId, "snapshot_gb", "2026-11-10", "2.5"),
  );
  const rows = await q(
    "select quantity::text as quantity from usage_records where resource_id = $1",
    [resourceId],
  );
  expect(rows).toEqual([{ quantity: "2.500000" }]);
});
