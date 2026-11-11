// WP7-T5 against a real database: the repository statements as worker_rw, the ledger and the
// notification rows. Needs the local PostgreSQL (pnpm db:up); other tests of this package do not.
import type { Tx } from "@tc/db";
import { meteringRepo } from "@tc/db";
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
