import { randomUUID } from "node:crypto";
import { runTransaction, useTempDatabase } from "@tc/db/testing";
import { describe, expect, it } from "vitest";
import { walletEntriesSum } from "../ledger/balance";
import { makeKit, placeOne, REGION, snapshotRows, type Kit } from "../test/orders-kit";
import { compensateFailedCreate } from "./compensate";

const t = useTempDatabase();

/** The failed hook runs as worker_rw, inside the transaction that moves the operation to failed. */
const compensate = (
  kit: Kit,
  resourceId: string,
  customerId = kit.customerId,
  code = "step_failed",
) =>
  runTransaction(
    t.db,
    (tx) => compensateFailedCreate(tx, kit.deps, { resourceId, customerId, code }),
    {
      role: "worker_rw",
    },
  );
const rows = async (sql: string, params: unknown[] = []) =>
  (await t.pool.query(sql, params)).rows as Record<string, unknown>[];

describe("compensateFailedCreate", () => {
  it("reverses the purchase once and gives the wallet, the order, the subscription, the resource and the capacity back", async () => {
    const kit = await makeKit(t);
    const start = await kit.balance();
    const usedStart = await kit.used();
    const { orderId, resourceId } = await placeOne(kit);
    const [purchase] = await rows("select ledger_transaction_id as id from orders where id = $1", [
      orderId,
    ]);

    expect(
      await compensate(kit, resourceId, kit.customerId, "validation:InvalidInputException"),
    ).toEqual({
      reversed: true,
      released: true,
      replayed: false,
    });

    // one reversal, keyed by the order, that mirrors the purchase
    const reversals = await rows(
      `select id, kind, reference_type, reference_id, actor_type, memo
         from ledger_transactions where idempotency_key = $1`,
      ["order-reversal:" + orderId],
    );
    expect(reversals).toHaveLength(1);
    expect(reversals[0]).toMatchObject({
      kind: "reversal",
      reference_type: "ledger_transaction",
      reference_id: purchase?.id,
      actor_type: "system",
      memo: "automatic reversal of a failed create: validation:InvalidInputException",
    });
    const mirror = await rows(
      `select a.type, e.direction, e.amount_minor::text as amount
         from ledger_entries e join ledger_accounts a on a.id = e.account_id
        where e.transaction_id = $1 order by a.type`,
      [reversals[0]?.id],
    );
    expect(mirror).toEqual([
      { type: "customer_wallet", direction: "credit", amount: "74295" },
      { type: "processing_fee_income", direction: "debit", amount: "1270" },
      { type: "revenue_aws_base", direction: "debit", amount: "63500" },
      { type: "vat_bd_payable", direction: "debit", amount: "3175" },
      { type: "vat_korea_payable", direction: "debit", amount: "6350" },
    ]);

    // the wallet is back and the cache equals the ledger
    expect(await kit.balance()).toBe(start);
    expect(await kit.run((tx) => walletEntriesSum(tx, kit.customerId))).toBe(start);

    expect((await rows("select status from orders where id = $1", [orderId]))[0]).toEqual({
      status: "reversed",
    });
    expect(
      (await rows("select status from subscriptions where resource_id = $1", [resourceId]))[0],
    ).toEqual({ status: "ended" });
    expect((await rows("select state from resources where id = $1", [resourceId]))[0]).toEqual({
      state: "failed",
    });
    expect(await kit.used()).toEqual(usedStart);
  });

  it("puts a code that is no engine word into the memo as `unknown`, never as text (R14)", async () => {
    const kit = await makeKit(t);
    const { orderId, resourceId } = await placeOne(kit);
    await compensate(kit, resourceId, kit.customerId, "someone@example.test says hello");
    const [txn] = await rows("select memo from ledger_transactions where idempotency_key = $1", [
      "order-reversal:" + orderId,
    ]);
    expect(txn?.memo).toBe("automatic reversal of a failed create: unknown");
  });

  it.each(["arn:aws:iam::123456789012:role", "validation:Account123456789012", "ARN:x"])(
    "puts a code that holds an ARN or a 12-digit account id into the memo as `unknown` (%s)",
    async (code) => {
      const kit = await makeKit(t);
      const { orderId, resourceId } = await placeOne(kit);
      await compensate(kit, resourceId, kit.customerId, code);
      const [txn] = await rows("select memo from ledger_transactions where idempotency_key = $1", [
        "order-reversal:" + orderId,
      ]);
      expect(txn?.memo).toBe("automatic reversal of a failed create: unknown");
    },
  );

  it("gives the refund to a customer whose KYC was revoked after the order", async () => {
    const kit = await makeKit(t);
    const start = await kit.balance();
    const { resourceId } = await placeOne(kit);
    await kit.setCustomer(kit.customerId, { kyc_status: "rejected" });
    await compensate(kit, resourceId);
    expect(await kit.balance()).toBe(start);
  });

  it("refuses to refund a resource that became active: it throws a fixed text and leaves every row as it was", async () => {
    const kit = await makeKit(t);
    const { orderId, resourceId } = await placeOne(kit);
    await t.pool.query("update resources set state = 'active' where id = $1", [resourceId]);
    const before = await snapshotRows(t);
    const failure = await compensate(kit, resourceId).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(failure?.message).toBe("orders: a failed create cannot be reversed in this state");
    expect(failure?.message).not.toContain(orderId);
    expect(failure?.message).not.toContain(resourceId);
    expect(await snapshotRows(t)).toEqual(before);
    expect(
      (
        await rows(
          "select count(*)::int as n from ledger_transactions where idempotency_key = $1",
          ["order-reversal:" + orderId],
        )
      )[0],
    ).toEqual({ n: 0 });
  });

  it("refuses to refund a fulfilled order and leaves every row as it was", async () => {
    const kit = await makeKit(t);
    const { resourceId } = await placeOne(kit);
    await t.pool.query("update orders set status = 'fulfilled' where customer_id = $1", [
      kit.customerId,
    ]);
    const before = await snapshotRows(t);
    await expect(compensate(kit, resourceId)).rejects.toThrow(
      "orders: a failed create cannot be reversed in this state",
    );
    expect(await snapshotRows(t)).toEqual(before);
  });

  it("throws for a resource that has no order and leaves every row as it was", async () => {
    const kit = await makeKit(t);
    await placeOne(kit);
    const [orphan] = await rows(
      `insert into resources (id, customer_id, family, product_id, pool_account_id, region, config)
       values (gen_random_uuid(), $1, 'linux_instance', $2, $3, $4, '{}'::jsonb) returning id`,
      [kit.customerId, kit.productId, kit.poolAccountId, REGION],
    );
    const before = await snapshotRows(t);
    await expect(compensate(kit, String(orphan?.id))).rejects.toThrow(
      "orders: a failed create has no order",
    );
    expect(await snapshotRows(t)).toEqual(before);
  });

  it("throws for the resource of another customer and leaves every row as it was", async () => {
    const kit = await makeKit(t);
    const other = await kit.newBuyer();
    const { resourceId } = await placeOne(kit);
    const before = await snapshotRows(t);
    await expect(compensate(kit, resourceId, other.customerId)).rejects.toThrow(
      "orders: a failed create has no order",
    );
    expect(await snapshotRows(t)).toEqual(before);
  });

  it("throws for an unknown resource id, and for an id that is no UUID, before any change", async () => {
    const kit = await makeKit(t);
    const before = await snapshotRows(t);
    await expect(compensate(kit, randomUUID())).rejects.toThrow();
    await expect(compensate(kit, "not-a-uuid")).rejects.toThrow(TypeError);
    expect(await snapshotRows(t)).toEqual(before);
  });

  it("locks the wallet row before it writes the resource, as the purchase does (the lock order)", async () => {
    const kit = await makeKit(t);
    const { resourceId } = await placeOne(kit);
    // record the text of every locking or updating statement the driver sends during the hook
    const probe = await t.pool.connect();
    const proto = Object.getPrototypeOf(probe) as { query: (...args: unknown[]) => unknown };
    probe.release();
    const original = proto.query;
    const seen: string[] = [];
    proto.query = function (this: unknown, ...args: unknown[]) {
      const first = args[0];
      const text =
        typeof first === "string"
          ? first
          : typeof first === "object" && first !== null && "text" in first
            ? String((first as { text: unknown }).text)
            : "";
      if (/for update|^\s*update\s/i.test(text)) seen.push(text);
      return original.apply(this, args);
    };
    try {
      await compensate(kit, resourceId);
    } finally {
      proto.query = original;
    }
    const wallet = seen.findIndex((s) => /wallets/i.test(s) && /for update/i.test(s));
    const resource = seen.findIndex((s) => /resources/i.test(s) && /^\s*update\s/i.test(s));
    expect(wallet).toBeGreaterThanOrEqual(0);
    expect(resource).toBeGreaterThanOrEqual(0);
    expect(wallet).toBeLessThan(resource);
  });

  // WPU-B3 (10.1): the removal of what the create made in AWS, and the message to the customer.
  it("queues one cleanup operation and one refund message (email and in_app) for the order, once", async () => {
    const kit = await makeKit(t);
    const { orderId, resourceId } = await placeOne(kit);
    await compensate(kit, resourceId);
    await compensate(kit, resourceId);
    const ops = await rows(
      "select kind, state, needs_approval, idempotency_key, payload from operations where resource_id = $1 and kind = 'cleanup_failed_create'",
      [resourceId],
    );
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      idempotency_key: "create-cleanup:" + resourceId,
      payload: { reason: "failed_create" },
    });
    const notices = await rows(
      "select channel, payload from notifications where customer_id = $1 and template = 'order_failed_refunded' order by channel",
      [kit.customerId],
    );
    expect(notices.map((n) => n.channel)).toEqual(["email", "in_app"]);
    expect(notices[0]?.payload).toMatchObject({
      orderId,
      product: "instance",
      failure: "create_failed",
      refundMinor: "74295",
    });
  });
});
