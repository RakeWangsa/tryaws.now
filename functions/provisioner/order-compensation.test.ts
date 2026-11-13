import { randomUUID } from "node:crypto";
import { AwsError } from "@tc/aws";
import {
  buildChargeSnapshot,
  createManualClock,
  ensureSystemAccounts,
  openWallet,
  postTransaction,
  quote,
} from "@tc/core";
import { rejectOperation, runTransaction } from "@tc/db/testing";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAdapterRegistry } from "./adapters";
import { composeHooks } from "./hooks";
import { orderHooks } from "./order-hooks";
import { runStep } from "./step";
import { createFakeCloud, fakeInstanceAdapter } from "./test/fakes";
import { NOW, useHarness } from "./test/harness";
import { operationRow } from "./test/seed";

// The failed create of the second proof of WP4-T4, through the real provisioner path: the refund and
// the move to `failed` are one transaction. The paid order is made here with the public ledger
// functions and the owner's inserts (the order flow itself is proved in packages/core/orders).
const { t, world, setup, message, create } = useHarness();
const REGION = "ap-southeast-1";
const PRICE = 1000n;

beforeAll(async () => {
  await runTransaction(t.db, (tx) => ensureSystemAccounts(tx));
  await runTransaction(t.db, (tx) => openWallet(tx, world.customerId), { role: "web_rw" });
  const topup = randomUUID();
  await runTransaction(
    t.db,
    (tx) =>
      postTransaction(tx, {
        kind: "topup",
        reference: { type: "payment", id: topup },
        idempotencyKey: `topup:${topup}`,
        actor: { type: "system" },
        postings: [
          { account: { type: "gateway_clearing" }, direction: "debit", amountMinor: 1_000_000n },
          {
            account: { type: "customer_wallet", customerId: world.customerId },
            direction: "credit",
            amountMinor: 1_000_000n,
          },
        ],
      }),
    { role: "worker_rw" },
  );
});
beforeEach(async () => {
  await t.pool.query("delete from operations");
});

const one = async (sql: string, params: unknown[] = []) =>
  (await t.pool.query(sql, params)).rows[0] as Record<string, unknown>;
const balance = async () =>
  BigInt(
    (
      await one("select balance_minor::text as b from wallets where customer_id = $1", [
        world.customerId,
      ])
    ).b as string,
  );
const usedCells = async () =>
  (
    await t.pool.query(
      "select quota_code, used from pool_capacity where pool_account_id = $1 order by quota_code",
      [world.poolAccountId],
    )
  ).rows;
const reversalsOf = async (orderId: string) =>
  (
    await one(
      `select count(*)::int as n from ledger_transactions
        where kind = 'reversal' and idempotency_key = $1`,
      ["order-reversal:" + orderId],
    )
  ).n;

/** A paid order for the resource: wallet debited, order, subscription, reservation recorded. */
async function seedPaid(resourceId: string): Promise<string> {
  const orderId = randomUUID();
  const posted = await runTransaction(
    t.db,
    (tx) =>
      postTransaction(tx, {
        kind: "purchase",
        reference: { type: "order", id: orderId },
        idempotencyKey: `order:${randomUUID().replaceAll("-", "")}`,
        actor: { type: "customer", id: world.customerId },
        priceSnapshot: buildChargeSnapshot(
          "purchase",
          {
            pricedAt: NOW,
            awsPriceUsd: "5",
            quantity: "1",
            fx: { id: "fx-1", rate: "127", effectiveFrom: NOW },
            rule: { id: "rule-id-1", version: "rule-1" },
            book: null,
            quote: quote({
              awsPriceUsd: "5",
              fxRate: "127",
              rule: { version: "rule-1", steps: [] },
            }),
          },
          { charge: { baseMinor: PRICE, steps: [], totalMinor: PRICE } },
        ),
        postings: [
          {
            account: { type: "customer_wallet", customerId: world.customerId },
            direction: "debit",
            amountMinor: PRICE,
          },
          { account: { type: "revenue_aws_base" }, direction: "credit", amountMinor: PRICE },
        ],
      }),
    { role: "web_rw" },
  );
  if (!posted.ok) throw new Error("the purchase was refused");
  await t.pool.query(
    `insert into orders (id, customer_id, kind, items, price_snapshot, total_minor,
                         ledger_transaction_id, idempotency_key)
     values ($1, $2, 'new', $3::jsonb, '{}'::jsonb, $4, $5, $6)`,
    [
      orderId,
      world.customerId,
      JSON.stringify([{ resourceId }]),
      PRICE.toString(),
      posted.value.transactionId,
      "o-" + randomUUID().replaceAll("-", ""),
    ],
  );
  await t.pool.query(
    `insert into subscriptions (id, resource_id, customer_id, term_days, price_snapshot,
                                period_start, period_end)
     values (gen_random_uuid(), $1, $2, 30, '{}'::jsonb, now(), now() + interval '30 days')`,
    [resourceId, world.customerId],
  );
  for (const [code, used] of [
    ["instance_vcpu", 2],
    ["static_ip", 1],
  ] as const) {
    await t.pool.query(
      `insert into pool_capacity (id, pool_account_id, region, quota_code, quota_limit, used)
       values (gen_random_uuid(), $1, $2, $3, 10, $4)
       on conflict (pool_account_id, region, quota_code) do update set used = excluded.used`,
      [world.poolAccountId, REGION, code, used],
    );
  }
  await t.pool.query("update resources set config = $2::jsonb where id = $1", [
    resourceId,
    JSON.stringify({
      capacityReservation: {
        v: 1,
        poolAccountId: world.poolAccountId,
        cells: [
          { quotaCode: "instance_vcpu", region: REGION, amount: 2 },
          { quotaCode: "static_ip", region: REGION, amount: 1 },
        ],
      },
    }),
  ]);
  return orderId;
}

const failing = () => {
  const bad = new AwsError({
    code: "validation",
    retryable: false,
    awsErrorName: "InvalidInputException",
    operation: "CreateInstances",
  });
  const adapter = fakeInstanceAdapter(createFakeCloud());
  adapter.aws.create = async () => {
    throw bad;
  };
  return adapter;
};

describe("a create that can never succeed", () => {
  it("(e) reaches failed and posts the refund in the same transaction", async () => {
    const clock = createManualClock(NOW);
    const { deps } = setup({
      clock,
      adapters: createAdapterRegistry([failing()]),
      hooks: composeHooks(orderHooks({ clock })),
    });
    const c = await create();
    const orderId = await seedPaid(c.resourceId);
    const start = await balance(); // after the purchase

    expect(await runStep(deps, message(c.id, c.resourceId))).toEqual({
      outcome: "advanced",
      to: "failed",
      sent: false,
    });

    expect(await operationRow(t.pool, c.id)).toMatchObject({ state: "failed" });
    expect(await reversalsOf(orderId)).toBe(1);
    expect(await balance()).toBe(start + PRICE);
    expect(await one("select status from orders where id = $1", [orderId])).toEqual({
      status: "reversed",
    });
    expect(
      await one("select status from subscriptions where resource_id = $1", [c.resourceId]),
    ).toEqual({ status: "ended" });
    expect(await one("select state from resources where id = $1", [c.resourceId])).toEqual({
      state: "failed",
    });
    expect(await usedCells()).toEqual([
      { quota_code: "instance_vcpu", used: 0 },
      { quota_code: "static_ip", used: 0 },
    ]);
  });

  it("(e) a hook that throws after the reversal rolls the move to failed back, refund included", async () => {
    const clock = createManualClock(NOW);
    const { deps } = setup({
      clock,
      adapters: createAdapterRegistry([failing()]),
      hooks: composeHooks(orderHooks({ clock }), {
        failed: async () => {
          throw new Error("a later hook failed");
        },
      }),
    });
    const c = await create();
    const orderId = await seedPaid(c.resourceId);
    const start = await balance();

    await expect(runStep(deps, message(c.id, c.resourceId))).rejects.toThrow("a later hook failed");

    expect(await operationRow(t.pool, c.id)).toMatchObject({ state: "running", attempts: 0 });
    expect(await reversalsOf(orderId)).toBe(0);
    expect(await balance()).toBe(start);
    expect(await one("select status from orders where id = $1", [orderId])).toEqual({
      status: "paid",
    });
    expect(await usedCells()).toEqual([
      { quota_code: "instance_vcpu", used: 2 },
      { quota_code: "static_ip", used: 1 },
    ]);
  });

  it("(e) a create whose order is missing does not reach failed: the hook throws and the move rolls back", async () => {
    const clock = createManualClock(NOW);
    const { deps } = setup({
      clock,
      adapters: createAdapterRegistry([failing()]),
      hooks: composeHooks(orderHooks({ clock })),
    });
    const c = await create();
    await expect(runStep(deps, message(c.id, c.resourceId))).rejects.toThrow(
      "orders: a failed create has no order",
    );
    expect(await operationRow(t.pool, c.id)).toMatchObject({ state: "running" });
  });
});

describe("a rejected create", () => {
  it("(f) reaches failed through the same hook and refunds once", async () => {
    const clock = createManualClock(NOW);
    const { deps } = setup({ clock, hooks: composeHooks(orderHooks({ clock })) });
    const target = await create({
      state: "needs_attention",
      attempts: 5,
      last_error: "upstream_unavailable:ServiceException",
    });
    const orderId = await seedPaid(target.resourceId);
    const start = await balance();
    const out = await runTransaction(
      t.db,
      (tx) => rejectOperation(tx, { operationId: target.id, at: NOW }),
      { role: "admin_rw" },
    );
    if (!out.ok || !out.message) throw new Error("reject did not queue an operation");

    expect(await runStep(deps, out.message)).toMatchObject({
      outcome: "advanced",
      to: "succeeded",
    });

    expect(await operationRow(t.pool, target.id)).toMatchObject({
      state: "failed",
      last_error: "rejected",
    });
    expect(await reversalsOf(orderId)).toBe(1);
    expect(await balance()).toBe(start + PRICE);
    expect(await one("select status from orders where id = $1", [orderId])).toEqual({
      status: "reversed",
    });
  });
});
