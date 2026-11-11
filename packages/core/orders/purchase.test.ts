import { randomUUID } from "node:crypto";
import { insertRow, useTempDatabase } from "@tc/db/testing";
import { describe, expect, it } from "vitest";
import {
  makeKit,
  PLAN_TOTAL,
  REGION,
  snapshotRows,
  type Buyer,
  type Kit,
} from "../test/orders-kit";
import { childId, draftHash, orderIdFor } from "./ids";
import { runPurchase, type Purchased } from "./purchase";
import { signDraft, verifyDraft } from "./token";
import type { DraftClaims, OrderDraft } from "./types";

const t = useTempDatabase();

const newKey = () => "k" + randomUUID().replaceAll("-", "");
const claimsOf = (kit: Kit, token: string): DraftClaims => {
  const verdict = verifyDraft(kit.secrets, token, kit.clock.now());
  if (!verdict.ok) throw new Error("the token does not verify");
  return verdict.claims;
};
/** One call of runPurchase in its own transaction, like the placeOrder transaction. */
const purchase = (kit: Kit, draft: OrderDraft, clientKey = newKey(), buyer: Buyer = kit) =>
  kit.run((tx) =>
    runPurchase(tx, kit.deps, {
      claims: claimsOf(kit, draft.token),
      tokenHash: draftHash(draft.token),
      clientKey,
      customerId: buyer.customerId,
    }),
  );
const bought = async (kit: Kit, draft: OrderDraft, clientKey?: string): Promise<Purchased> => {
  const r = await purchase(kit, draft, clientKey);
  if (!r.ok) throw new Error("the purchase was refused: " + r.error);
  return r.value;
};
const rows = async (sql: string, params: unknown[] = []) =>
  (await t.pool.query(sql, params)).rows as Record<string, unknown>[];

// Two live instances of the customer, written as the owner.
async function liveInstances(kit: Kit, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await t.pool.query(
      `insert into resources (id, customer_id, family, product_id, pool_account_id, region, config)
       values (gen_random_uuid(), $1, 'linux_instance', $2, $3, $4, '{}'::jsonb)`,
      [kit.customerId, kit.productId, kit.poolAccountId, REGION],
    );
  }
}

describe("runPurchase: the happy path", () => {
  it("debits the wallet once and writes the ledger, the order, the resource, the subscription and the operation", async () => {
    const kit = await makeKit(t);
    const start = await kit.balance();
    const usedBefore = await kit.used();
    const draft = await kit.draft();
    const key = newKey();
    const done = await bought(kit, draft, key);
    expect(done.replayed).toBe(false);
    expect(done.orderId).toBe(orderIdFor(kit.customerId, draftHash(draft.token)));
    expect(done.resourceId).toBe(childId(done.orderId, "resource"));

    expect(await kit.balance()).toBe(start - PLAN_TOTAL);

    // the ledger: kind, reference, key, and one credit line per step above 0
    const [txn] = await rows(
      "select id, kind, reference_type, reference_id, idempotency_key, actor_type from ledger_transactions where idempotency_key = $1",
      ["order:" + draftHash(draft.token)],
    );
    expect(txn).toMatchObject({
      kind: "purchase",
      reference_type: "order",
      reference_id: done.orderId,
      actor_type: "customer",
    });
    const lines = await rows(
      `select a.type, e.direction, e.amount_minor::text as amount
         from ledger_entries e join ledger_accounts a on a.id = e.account_id
        where e.transaction_id = $1 order by a.type`,
      [txn?.id],
    );
    expect(lines).toEqual([
      { type: "customer_wallet", direction: "debit", amount: "74295" },
      { type: "processing_fee_income", direction: "credit", amount: "1270" },
      { type: "revenue_aws_base", direction: "credit", amount: "63500" },
      { type: "vat_bd_payable", direction: "credit", amount: "3175" },
      { type: "vat_korea_payable", direction: "credit", amount: "6350" },
    ]);

    // the order
    const [order] = await rows(
      "select status, total_minor::text as total, price_snapshot, idempotency_key, ledger_transaction_id from orders where id = $1",
      [done.orderId],
    );
    expect(order).toMatchObject({
      status: "paid",
      total: "74295",
      idempotency_key: key,
      ledger_transaction_id: txn?.id,
    });
    expect(order?.price_snapshot).toEqual(claimsOf(kit, draft.token).snap);

    // the resource: creating, no AWS name (R11), the reservation recorded in the config
    const [resource] = await rows(
      "select state, aws_name, pool_account_id, region, config from resources where id = $1",
      [done.resourceId],
    );
    expect(resource).toMatchObject({
      state: "creating",
      aws_name: null,
      pool_account_id: kit.poolAccountId,
      region: REGION,
    });
    expect((resource?.config as Record<string, unknown>).capacityReservation).toEqual({
      v: 1,
      poolAccountId: kit.poolAccountId,
      cells: [
        { quotaCode: "instance_vcpu", region: REGION, amount: 2 },
        { quotaCode: "static_ip", region: REGION, amount: 1 },
      ],
    });

    // the subscription: 30 days
    const [sub] = await rows(
      `select term_days, extract(epoch from (period_end - period_start))::int as seconds
         from subscriptions where resource_id = $1`,
      [done.resourceId],
    );
    expect(sub).toEqual({ term_days: 30, seconds: 30 * 86_400 });

    // the operation: create, queued, no approval, the order in the payload
    const [op] = await rows(
      "select id, kind, state, needs_approval, payload, idempotency_key from operations where resource_id = $1",
      [done.resourceId],
    );
    expect(op).toMatchObject({
      id: done.operationId,
      kind: "create",
      state: "queued",
      needs_approval: false,
      payload: { orderId: done.orderId },
      idempotency_key: "order-create:" + done.orderId,
    });

    // the capacity
    const usedAfter = await kit.used();
    expect(usedAfter[`${REGION}/instance_vcpu`]).toBe(
      (usedBefore[`${REGION}/instance_vcpu`] ?? 0) + 2,
    );
    expect(usedAfter[`${REGION}/static_ip`]).toBe((usedBefore[`${REGION}/static_ip`] ?? 0) + 1);

    // the audit entry holds no token and no client key (R14)
    const audit = await rows(
      "select to_jsonb(a)::text as row, actor_id, action, target_id from audit_log a where target_id = $1",
      [done.orderId],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_id: kit.customerId,
      action: "order.placed",
      target_id: done.orderId,
    });
    expect(String(audit[0]?.row)).not.toContain(draft.token);
    expect(String(audit[0]?.row)).not.toContain(key);
  });

  it("posts no line for a step of 0 (the markup of the staging rule)", async () => {
    const kit = await makeKit(t);
    const draft = await kit.draft();
    const done = await bought(kit, draft);
    const [{ n } = { n: -1 }] = await rows(
      `select count(*)::int as n from ledger_entries e
         join ledger_transactions x on x.id = e.transaction_id
        where x.reference_id = $1 and e.amount_minor = 0`,
      [done.orderId],
    );
    expect(n).toBe(0);
  });

  it("answers the same token again with the first order and writes nothing", async () => {
    const kit = await makeKit(t);
    const draft = await kit.draft();
    const first = await bought(kit, draft, "same-client-key-0001");
    const after = await snapshotRows(t);
    const again = await purchase(kit, draft, "same-client-key-0001");
    expect(again).toEqual({ ok: true, value: { ...first, replayed: true } });
    // another client key, the same token: the first order as well
    const other = await purchase(kit, draft, "another-client-key-01");
    expect(other).toEqual({ ok: true, value: { ...first, replayed: true } });
    expect(await snapshotRows(t)).toEqual(after);
  });
});

describe("runPurchase: a refusal returns before the reservation and writes nothing", () => {
  const unchanged = async (act: () => Promise<unknown>) => {
    const before = await snapshotRows(t);
    const result = await act();
    expect(await snapshotRows(t)).toEqual(before);
    return result;
  };

  it("price_changed: a new rate returns claims at the new total, and the old token is not an order", async () => {
    const kit = await makeKit(t);
    const draft = await kit.draft();
    await kit.changeFxRate("130");
    const result = await unchanged(() => purchase(kit, draft));
    expect(result).toMatchObject({ ok: false, error: "price_changed" });
    if ((result as { ok: boolean }).ok) return;
    const data = (result as { data: { claims: DraftClaims } }).data;
    expect(data.claims.snap.fxRate).toBe("130");
    expect(BigInt(data.claims.snap.totalMinor)).not.toBe(PLAN_TOTAL);
    expect(data.claims.c).toBe(kit.customerId);
    expect(data.claims.pid).toBe(kit.productId);
    expect(data.claims.cfg).toEqual(claimsOf(kit, draft.token).cfg);
    // the old token is still refused
    expect(await unchanged(() => purchase(kit, draft))).toMatchObject({
      ok: false,
      error: "price_changed",
    });
    // the new claims, signed, buy at the new price
    const token = signDraft(kit.secrets, data.claims);
    const done = await kit.run((tx) =>
      runPurchase(tx, kit.deps, {
        claims: data.claims,
        tokenHash: draftHash(token),
        clientKey: newKey(),
        customerId: kit.customerId,
      }),
    );
    expect(done.ok).toBe(true);
  });

  it("insufficient_balance: the shortfall is exact and no unit is taken", async () => {
    const kit = await makeKit(t, { balanceMinor: PLAN_TOTAL - 1n });
    const draft = await kit.draft();
    expect(await unchanged(() => purchase(kit, draft))).toMatchObject({
      ok: false,
      error: "insufficient_balance",
      data: { shortfallMinor: "1" },
    });
  });

  it("buys with exactly the balance of the total and leaves 0", async () => {
    const kit = await makeKit(t, { balanceMinor: PLAN_TOTAL });
    expect((await purchase(kit, await kit.draft())).ok).toBe(true);
    expect(await kit.balance()).toBe(0n);
  });

  it("capacity_full: a full pool refuses with the waitlist offer", async () => {
    const kit = await makeKit(t);
    const draft = await kit.draft();
    await t.pool.query("update pool_capacity set used = quota_limit");
    expect(await unchanged(() => purchase(kit, draft))).toMatchObject({
      ok: false,
      error: "capacity_full",
      data: { reason: "full", waitlist: "offered" },
    });
  });

  it("flag_off: the flag is read again at purchase time", async () => {
    const kit = await makeKit(t);
    const draft = await kit.draft();
    await kit.setFlag("off");
    expect(await unchanged(() => purchase(kit, draft))).toMatchObject({
      ok: false,
      error: "flag_off",
    });
  });

  it("limit_reached: the limit is counted again at purchase time", async () => {
    const kit = await makeKit(t);
    const draft = await kit.draft();
    await liveInstances(kit, 2);
    expect(await unchanged(() => purchase(kit, draft))).toMatchObject({
      ok: false,
      error: "limit_reached",
      fields: { limit: "instances" },
    });
  });

  it("validation: a product id that is not the one of the configuration", async () => {
    const kit = await makeKit(t);
    const draft = await kit.draft();
    const other = await kit.newProduct();
    const claims = { ...claimsOf(kit, draft.token), pid: other };
    const result = await unchanged(() =>
      kit.run((tx) =>
        runPurchase(tx, kit.deps, {
          claims,
          tokenHash: draftHash(draft.token),
          clientKey: newKey(),
          customerId: kit.customerId,
        }),
      ),
    );
    expect(result).toMatchObject({ ok: false, error: "validation" });
  });

  it("conflict: a client key that already belongs to another purchase", async () => {
    const kit = await makeKit(t);
    const key = newKey();
    await bought(kit, await kit.draft(), key);
    const second = await kit.draft();
    expect(await unchanged(() => purchase(kit, second, key))).toMatchObject({
      ok: false,
      error: "conflict",
    });
  });

  it("forbidden: a token that names another customer is refused before any query", async () => {
    const kit = await makeKit(t);
    const draft = await kit.draft();
    const stranger = await kit.newBuyer();
    expect(await unchanged(() => purchase(kit, draft, newKey(), stranger))).toMatchObject({
      ok: false,
      error: "forbidden",
    });
  });
});

describe("runPurchase: from the reservation on, a failure throws and rolls everything back", () => {
  it("a create operation key taken by another operation throws and leaves every row, used included", async () => {
    const kit = await makeKit(t);
    const draft = await kit.draft();
    const orderId = orderIdFor(kit.customerId, draftHash(draft.token));
    // an unrelated resource and an operation that owns the key of this order's create operation
    const [other] = await rows(
      `insert into resources (id, customer_id, family, product_id, pool_account_id, region, config)
       values (gen_random_uuid(), $1, 'linux_instance', $2, $3, $4, '{}'::jsonb) returning id`,
      [kit.customerId, kit.productId, kit.poolAccountId, REGION],
    );
    await insertRow(t.pool, "operations", {
      resource_id: other?.id,
      kind: "reboot",
      state: "queued",
      idempotency_key: "order-create:" + orderId,
    });
    const before = await snapshotRows(t);
    await expect(purchase(kit, draft)).rejects.toThrow();
    expect(await snapshotRows(t)).toEqual(before);
    expect(kit.queue.depth).toBe(0);
  });

  it("a unique violation of the writes is a conflict, never a second charge, and rolls the reservation back", async () => {
    const kit = await makeKit(t);
    const draft = await kit.draft();
    const orderId = orderIdFor(kit.customerId, draftHash(draft.token));
    // a resource that already has the id this order would insert
    await t.pool.query(
      `insert into resources (id, customer_id, family, product_id, pool_account_id, region, config)
       values ($1, $2, 'linux_instance', $3, $4, $5, '{}'::jsonb)`,
      [childId(orderId, "resource"), kit.customerId, kit.productId, kit.poolAccountId, REGION],
    );
    const before = await snapshotRows(t);
    expect(await purchase(kit, draft)).toMatchObject({ ok: false, error: "conflict" });
    expect(await snapshotRows(t)).toEqual(before);
  });
});

describe("runPurchase: the lock order", () => {
  it("locks the wallet row first and the capacity cells after it", async () => {
    const kit = await makeKit(t);
    const draft = await kit.draft();
    // record the text of every statement the driver sends while the purchase runs
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
      if (/for update/i.test(text)) seen.push(text);
      return original.apply(this, args);
    };
    try {
      await bought(kit, draft);
    } finally {
      proto.query = original;
    }
    const wallet = seen.findIndex((s) => /wallets/i.test(s));
    const capacity = seen.findIndex((s) => /pool_capacity/i.test(s));
    expect(wallet).toBeGreaterThanOrEqual(0);
    expect(capacity).toBeGreaterThan(wallet);
  });
});
