// WPU-M1 against a real database: the price through the pricing engine, the repository list as
// worker_rw and the charge through the real ledger. Needs the local PostgreSQL (pnpm db:up).
import type { Tx } from "@tc/db";
import { runTransaction, useTempDatabase } from "@tc/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { staticIpHourPrice } from "../products/static-ip-price";
import { makeKit, placeOne, START, type Kit } from "../test/orders-kit";
import { runStaticIpMetering } from "./index";

const t = useTempDatabase();
let kit: Kit;
const worker = <T>(fn: (tx: Tx) => Promise<T>) => runTransaction(t.db, fn, { role: "worker_rw" });
const q = async (sql: string, params: unknown[] = []) =>
  (await t.pool.query(sql, params)).rows as Record<string, unknown>[];
const KEY = "config_price.static_ip_unattached_hour";
const DETACHED = new Date("2026-11-11T06:00:00.000Z");
const at = (hhmm: string): Date => new Date(`2026-11-11T${hhmm}:00.000Z`);

beforeAll(async () => {
  kit = await makeKit(t);
});

const detach = async (resourceId: string, when: Date | null): Promise<void> => {
  await q(
    `update resources set state = 'active',
       config = config || jsonb_build_object('staticIpAttached', false, 'detachedAt', $2::text)
     where id = $1`,
    [resourceId, when === null ? null : when.toISOString()],
  );
};
const run = async (now: Date) => {
  kit.clock.set(now);
  await kit.refreshFx(); // WPU-Y1: a rate older than 7 days prices nothing
  return runStaticIpMetering({ runTx: worker, clock: kit.clock, log: () => undefined });
};

describe("the price of one unattached hour", () => {
  it("is USD 0.005 at the rate in force through the engine, half-up: 63.5 paisa is 64, plus the rule's steps", async () => {
    kit.clock.set(START);
    const r = await worker((tx) => staticIpHourPrice(tx, "BD", kit.clock));
    // 0.005 x 127 x 100 = 63.5 -> 64 (a float or a floor would give 63); 10% = 6, 5% = 3, 2% = 1.
    expect(r).toMatchObject({ ok: true, value: { unit: "hour", perHourMinor: 74n } });
    if (r.ok) expect(r.value.breakdown).toMatchObject({ totalMinor: 74n, baseMinor: 64n });
  });

  it("follows the FX rate in force: at 121.5 the base is 60.75 -> 61 and the hour costs 71", async () => {
    await kit.changeFxRate("121.5");
    const r = await worker((tx) => staticIpHourPrice(tx, "BD", kit.clock));
    expect(r).toMatchObject({ ok: true, value: { unit: "hour", perHourMinor: 71n } });
    await kit.changeFxRate("127");
  });

  it("an edited price (admin) is used: USD 0.01 is a base of 127 and 149 with the steps", async () => {
    await q(`update settings set value = '{"usd":"0.01","unit":"hour"}'::jsonb where key = $1`, [
      KEY,
    ]);
    const r = await worker((tx) => staticIpHourPrice(tx, "BD", kit.clock));
    expect(r).toMatchObject({ ok: true, value: { perHourMinor: 149n } });
    await q(`update settings set value = '{"usd":"0.005","unit":"hour"}'::jsonb where key = $1`, [
      KEY,
    ]);
  });

  it("a row with the wrong unit or no row is no price (R16)", async () => {
    await q(`update settings set value = '{"usd":"0.005","unit":"month"}'::jsonb where key = $1`, [
      KEY,
    ]);
    expect(await worker((tx) => staticIpHourPrice(tx, "BD", kit.clock))).toMatchObject({
      ok: false,
      error: "not_found",
    });
    await q(`update settings set value = '{"usd":"0.005","unit":"hour"}'::jsonb where key = $1`, [
      KEY,
    ]);
  });
});

describe("the hourly charge against the real ledger", () => {
  it("boundary, start, repeat, attach, all through the wallet", async () => {
    const buyer = await kit.newBuyer({ balanceMinor: 20_000_000n });
    const { resourceId } = await placeOne(kit, buyer);
    await detach(resourceId, DETACHED);
    const before = await kit.balance(buyer.customerId);

    expect(await run(at("07:00"))).toMatchObject({ charged: 0, notDue: 1 });
    expect(await kit.balance(buyer.customerId)).toBe(before);

    expect(await run(at("07:01"))).toMatchObject({ charged: 1, failed: 0, priceMissing: false });
    expect(before - (await kit.balance(buyer.customerId))).toBe(74n);
    const key = `meter:${resourceId}:static_ip_hour:2026-11-11T13`;
    const rows = await q("select kind, memo from ledger_transactions where idempotency_key = $1", [
      key,
    ]);
    expect(rows).toEqual([{ kind: "metered_charge", memo: "static_ip_unattached" }]);

    // WPU-M2: the hour is split like a purchase (spec 9.1): the base to revenue_aws_base, each VAT and
    // the fee to its payable or income account; the lines add up to the wallet debit (the ledger's
    // trigger refuses an unbalanced transaction).
    const lines = await q(
      `select a.type, e.direction, e.amount_minor::text as amount
         from ledger_entries e join ledger_accounts a on a.id = e.account_id
         join ledger_transactions x on x.id = e.transaction_id
        where x.idempotency_key = $1 order by a.type`,
      [key],
    );
    expect(lines).toEqual([
      { type: "customer_wallet", direction: "debit", amount: "74" },
      { type: "processing_fee_income", direction: "credit", amount: "1" },
      { type: "revenue_aws_base", direction: "credit", amount: "64" },
      { type: "vat_bd_payable", direction: "credit", amount: "3" },
      { type: "vat_korea_payable", direction: "credit", amount: "6" },
    ]);

    expect(await run(at("07:40"))).toMatchObject({ charged: 0, replayed: 1 });
    expect(before - (await kit.balance(buyer.customerId))).toBe(74n);

    // Attached again: detachedAt is cleared, the IP is no longer listed, nothing more is charged.
    await q(
      `update resources set config = config || '{"staticIpAttached": true, "detachedAt": null}'::jsonb where id = $1`,
      [resourceId],
    );
    expect(await run(at("09:30"))).toMatchObject({ charged: 0, replayed: 0, notDue: 0 });
    expect(before - (await kit.balance(buyer.customerId))).toBe(74n);
  });

  it("an empty wallet is not charged, gets one notice a day and is never negative", async () => {
    const buyer = await kit.newBuyer({ balanceMinor: 20_000_000n });
    const { resourceId } = await placeOne(kit, buyer);
    await q("update wallets set balance_minor = 0 where customer_id = $1", [buyer.customerId]);
    await detach(resourceId, DETACHED);
    expect(await run(at("07:01"))).toMatchObject({ unpaid: 1, charged: 0 });
    await run(at("07:20"));
    expect(await kit.balance(buyer.customerId)).toBe(0n);
    const notes = await q(
      "select 1 from notifications where customer_id = $1 and template = 'lifecycle_metered_unpaid'",
      [buyer.customerId],
    );
    expect(notes).toHaveLength(1);
  });

  it("a detached server without a time, or a destroyed one, is not charged", async () => {
    const a = await kit.newBuyer({ balanceMinor: 20_000_000n });
    const noTime = (await placeOne(kit, a)).resourceId;
    await detach(noTime, null);
    const b = await kit.newBuyer({ balanceMinor: 20_000_000n });
    const gone = (await placeOne(kit, b)).resourceId;
    await detach(gone, DETACHED);
    await q("update resources set state = 'destroyed', deleted_at = now() where id = $1", [gone]);
    const balA = await kit.balance(a.customerId);
    const balB = await kit.balance(b.customerId);
    const report = await run(at("07:01"));
    expect(report.noTimestamp).toBeGreaterThanOrEqual(1);
    expect(await kit.balance(a.customerId)).toBe(balA);
    expect(await kit.balance(b.customerId)).toBe(balB);
  });

  it("no price row: nothing is charged and the run says so (R16)", async () => {
    const buyer = await kit.newBuyer({ balanceMinor: 20_000_000n });
    const { resourceId } = await placeOne(kit, buyer);
    await detach(resourceId, DETACHED);
    await q("delete from settings where key = $1", [KEY]);
    const bal = await kit.balance(buyer.customerId);
    expect(await run(at("10:00"))).toMatchObject({ charged: 0, priceMissing: true });
    expect(await kit.balance(buyer.customerId)).toBe(bal);
  });
});
