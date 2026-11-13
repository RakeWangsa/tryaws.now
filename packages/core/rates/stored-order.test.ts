// Proof of WP1-T4, first half: "A new rate never changes a stored order" (section 8).
import { LAUNCH_PRICING_STEPS, readFxRateInForce, seedLaunchData, type AdminActor } from "@tc/db";
import { inTransaction, insertRow, newCustomer, useTempDatabase } from "@tc/db/testing";
import { beforeAll, expect, it } from "vitest";
import { parseSnapshot, snapshotToQuote, type PricingStep } from "../pricing/index";
import { quoteInForce, savePricingRule, setFxRate } from "./index";
import { adminActor, asOwner, asRole, clockAt, settleFxEntries } from "../test/rates-support";

const t = useTempDatabase();
const T0 = new Date("2026-11-11T06:00:00.000Z");
const T1 = new Date("2026-11-12T06:00:00.000Z");
const clock = (d: Date) => clockAt(d.toISOString());

let actor: AdminActor;
let second: AdminActor;
let orderId: string;
beforeAll(async () => {
  actor = await adminActor(t, "finance");
  second = await adminActor(t, "superadmin");
  await asOwner(t, (tx) => seedLaunchData(tx, { environment: "staging", at: T0 }));
});

// One order, paid from a wallet: the ledger transaction that orders.ledger_transaction_id needs.
async function storeOrder(snapshot: unknown, totalMinor: bigint): Promise<string> {
  const customer = await newCustomer(t.pool);
  const clearing = await insertRow(t.pool, "ledger_accounts", {
    type: "gateway_clearing",
    currency: "BDT",
  });
  const wallet = await insertRow(t.pool, "ledger_accounts", {
    type: "customer_wallet",
    customer_id: customer,
    currency: "BDT",
  });
  const ledger = await inTransaction(t.pool, async (c) => {
    const id = await insertRow(c, "ledger_transactions", {
      kind: "test",
      reference_type: "test",
      reference_id: "00000000-0000-4000-8000-000000000001",
      idempotency_key: "stored-order-1",
      actor_type: "system",
    });
    for (const [account_id, direction] of [
      [clearing, "debit"],
      [wallet, "credit"],
    ]) {
      await insertRow(c, "ledger_entries", {
        transaction_id: id,
        account_id,
        direction,
        amount_minor: totalMinor.toString(),
      });
    }
    return id;
  });
  return insertRow(t.pool, "orders", {
    customer_id: customer,
    kind: "new",
    items: JSON.stringify([{ family: "linux_instance", awsId: "nano", region: "ap-southeast-1" }]),
    price_snapshot: JSON.stringify(snapshot),
    total_minor: totalMinor.toString(),
    ledger_transaction_id: ledger,
    idempotency_key: "stored-order-1",
  });
}
const stored = async () =>
  (
    await t.pool.query(
      "select price_snapshot::text as snapshot, price_snapshot as json, total_minor::text as total from orders where id = $1",
      [orderId],
    )
  ).rows[0];

it("an order stores the rate, the rule version, every step amount and the total, as values", async () => {
  const first = await asRole(t, "web_rw", (tx) =>
    quoteInForce(
      tx,
      { market: "BD", productFamily: "linux_instance", awsPriceUsd: "5" },
      clock(T0),
    ),
  );
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  expect(first.value.quote.totalMinor).toBe(74295n);
  orderId = await storeOrder(first.value.snapshot, first.value.quote.totalMinor);
  const row = await stored();
  expect(row.total).toBe("74295");
  expect(row.json).toMatchObject({
    fxRate: "127",
    ruleVersion: first.value.quote.ruleVersion,
    totalMinor: "74295",
  });
  expect(snapshotToQuote(parseSnapshot(row.json))).toEqual(first.value.quote);
});

it("a new rate and a new rule are saved, new quotes use them, and the stored order is exactly as it was", async () => {
  const before = await stored();
  const oldQuote = snapshotToQuote(parseSnapshot(before.json));
  const markup: PricingStep[] = LAUNCH_PRICING_STEPS.map((s) => ({
    ...s,
    label: { ...s.label },
    rate: s.code === "markup" ? "0.03" : s.rate,
  }));

  const fx = await asRole(t, "admin_rw", (tx) =>
    setFxRate(
      tx,
      actor,
      { market: "BD", rate: "130", reason: "weekly rate", requestedBy: second.adminId },
      clock(T1),
    ),
  );
  const rule = await asRole(t, "admin_rw", (tx) =>
    savePricingRule(
      tx,
      actor,
      { market: "BD", productFamily: null, steps: markup, reason: "service charge 3 percent" },
      clock(T1),
    ),
  );
  // the database stamps the entry time itself; align it with the fake clock of this test
  await settleFxEntries(t);
  expect(fx.ok && rule.ok).toBe(true);

  // the positive control: a quote made after the change uses the new rate and the new rule
  const fresh = await asRole(t, "web_rw", (tx) =>
    quoteInForce(
      tx,
      { market: "BD", productFamily: "linux_instance", awsPriceUsd: "5" },
      clock(T1),
    ),
  );
  expect(fresh.ok && [fresh.value.quote.fxRate, fresh.value.quote.totalMinor]).toEqual([
    "130",
    78000n,
  ]);

  // the stored order: the same text, the same total, the same quote
  const after = await stored();
  expect(after).toEqual(before);
  expect(snapshotToQuote(parseSnapshot(after.json))).toEqual(oldQuote);
  expect(oldQuote).toMatchObject({ fxRate: "127", totalMinor: 74295n });
});

it("history keeps the old rate and the old rule: at the instant of the order they are still the ones in force", async () => {
  const old = await asRole(t, "web_rw", (tx) =>
    quoteInForce(
      tx,
      { market: "BD", productFamily: "linux_instance", awsPriceUsd: "5" },
      clock(T0),
    ),
  );
  expect(old.ok && old.value.quote.totalMinor).toBe(74295n);
  expect((await asRole(t, "web_rw", (tx) => readFxRateInForce(tx, "BD", T0)))?.rate).toBe("127");
  expect((await t.pool.query("select count(*)::int as n from fx_rates")).rows[0].n).toBe(2);
  const ruleId = (await stored()).json.ruleVersion;
  expect(
    (await t.pool.query("select count(*)::int as n from pricing_rules where id = $1", [ruleId]))
      .rows[0].n,
  ).toBe(1);
});

it("no role can rewrite a rate, a rule or the price of an order", async () => {
  for (const sql of ["update fx_rates set rate = 1", "update pricing_rules set steps = '[]'"]) {
    await expect(t.pool.query(sql), sql + " (owner)").rejects.toMatchObject({ code: "23001" });
    for (const role of ["web_rw", "admin_rw", "worker_rw"] as const) {
      await expect(
        asRole(t, role, (tx) => tx.execute(sql)),
        `${sql} (${role})`,
      ).rejects.toMatchObject({ code: "42501" });
    }
  }
  for (const role of ["web_rw", "admin_rw", "worker_rw"] as const) {
    await expect(
      asRole(t, role, (tx) =>
        tx.execute(`update orders set price_snapshot = '{}'::jsonb where id = '${orderId}'`),
      ),
      `orders (${role})`,
    ).rejects.toMatchObject({ code: "42501" });
  }
});
