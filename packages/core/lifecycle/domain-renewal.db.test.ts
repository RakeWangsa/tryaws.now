// WPU-Z13: a domain's renewal charge queues the one registry renewal of its period in the same transaction, and a
// registry renewal that ends failed gives the charge back once. Run as worker_rw (the scheduler, the provisioner)
// and web_rw (renewNow), so a missing grant shows here and not in production.
// The pass runs over every subscription of the database, and the cases of this file share one clock line (every
// domain is bought at START), so a case asserts on its own subscription and resource, never on the pass's totals.
import { lifecycleRepo, type Tx } from "@tc/db";
import { insertRow, runTransaction, uniqueSuffix, useTempDatabase } from "@tc/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { runInvoiceBacklog } from "../invoices/backlog";
import type { OperationQueue, QueueMessage } from "../operations/queue";
import { createDraft } from "../orders/draft";
import { childId } from "../orders/ids";
import { makeOrders } from "../orders/place";
import { makeKit, placeOne, START, type Kit } from "../test/orders-kit";
import { domainRenewalKey, queueDomainRenewal, reverseFailedDomainRenewal } from "./domain-renewal";
import { renewalQuote } from "./renew";
import { runLifecycle } from "./engine";
import { renewNow } from "./renew-now";

const t = useTempDatabase();
const DAY = 24 * 3_600_000;
const SEALED = Buffer.from("sealed-envelope-bytes").toString("base64");
let kit: Kit;

const worker = <T>(fn: (tx: Tx) => Promise<T>) => runTransaction(t.db, fn, { role: "worker_rw" });
const web = <T>(fn: (tx: Tx) => Promise<T>) => runTransaction(t.db, fn, { role: "web_rw" });
const q = async (sql: string, params: unknown[] = []) =>
  (await t.pool.query(sql, params)).rows as Record<string, unknown>[];

// The messages the lifecycle sends after its commit.
let sent: QueueMessage[] = [];
const queue: OperationQueue = {
  async send(message) {
    sent.push(message);
  },
};
// WPU-Y1: a rate older than 7 days prices nothing, so the rate in force is confirmed again at the clock.
const run = async () => {
  await kit.refreshFx();
  return runLifecycle({ runTx: worker, clock: kit.clock, log: () => undefined, queue });
};

const SELLER = {
  v: 1,
  version: 1,
  legalNameBn: "পরীক্ষা লিমিটেড",
  legalNameEn: "Test Limited",
  bin: "0000000000000",
  addressBn: "ঢাকা",
  addressEn: "Dhaka",
  signatoryName: "Test Signatory",
  signatoryDesignation: "Director",
};

interface Bought {
  customerId: string;
  resourceId: string;
  subscriptionId: string;
  end: Date;
  /** The registry expiry the row holds (a day after the period end, as a registration finishes after the order). */
  expiry: Date;
  tldId: string;
}

/**
 * A domain bought through the order flow at START, then registered as the provisioner leaves it: the resource
 * active with the adapter's `expiresAt`, the domain row registered, the create succeeded. Auto-renew on.
 */
async function boughtDomain(
  options: { expiry?: string | null; renewal?: string; balanceMinor?: bigint } = {},
): Promise<Bought> {
  kit.clock.set(START);
  const buyer = await kit.newBuyer({ balanceMinor: options.balanceMinor ?? 20_000_000n });
  const tld = "t" + uniqueSuffix();
  const tldId = await insertRow(t.pool, "tlds", {
    tld,
    registration_price_usd: "13.0000",
    renewal_price_usd: options.renewal ?? "15.0000",
    needs_extra_params: false,
    synced_at: "2026-11-11T00:00:00Z",
  });
  const draft = await createDraft(kit.deps, buyer.session, {
    family: "domain",
    config: { productId: tldId, name: `shop${uniqueSuffix()}.${tld}`, contactSealed: SEALED },
  });
  if (!draft.ok) throw new Error(`fixture: the draft was refused (${draft.error})`);
  const placed = await makeOrders(kit.deps).placeOrder(buyer.session, {
    token: draft.value.token,
    idempotencyKey: "z13-" + uniqueSuffix() + "a".repeat(16),
  });
  if (!placed.ok) throw new Error(`fixture: the order was refused (${placed.error})`);
  const resourceId = childId(placed.value.orderId, "resource");
  const sub = (
    await q("select id, period_end from subscriptions where resource_id = $1", [resourceId])
  )[0]!;
  const end = sub.period_end as Date;
  const expiry = new Date(end.getTime() + DAY);
  const stored = options.expiry === undefined ? expiry.toISOString() : options.expiry;
  await q(
    `update resources set state = 'active',
       config = config || jsonb_build_object('expiresAt', $2::text, 'domainStatus', 'registered')
     where id = $1`,
    [resourceId, stored],
  );
  await q("update domains set status = 'registered', expires_at = $2 where resource_id = $1", [
    resourceId,
    expiry.toISOString(),
  ]);
  await q("update operations set state = 'succeeded' where resource_id = $1", [resourceId]);
  await q("update subscriptions set auto_renew = true where id = $1", [sub.id]);
  return {
    customerId: buyer.customerId,
    resourceId,
    subscriptionId: String(sub.id),
    end,
    expiry,
    tldId,
  };
}

const renewOps = async (resourceId: string) =>
  q(
    `select id, state, needs_approval, idempotency_key, payload from operations
      where resource_id = $1 and kind = 'renew_domain' order by created_at, id`,
    [resourceId],
  );
const renewals = async (subscriptionId: string) =>
  q(`select id from ledger_transactions where kind = 'renewal' and reference_id = $1 order by id`, [
    subscriptionId,
  ]);
const reversalsOf = async (ledgerTransactionId: string) =>
  q(
    `select id, idempotency_key from ledger_transactions
      where kind = 'reversal' and reference_type = 'ledger_transaction' and reference_id = $1`,
    [ledgerTransactionId],
  );
const subRow = async (id: string) =>
  (
    await q(
      "select status, auto_renew, period_start, period_end from subscriptions where id = $1",
      [id],
    )
  )[0]!;

beforeAll(async () => {
  kit = await makeKit(t);
  await t.pool.query(
    `insert into feature_flags (id, key, market, enabled) values (gen_random_uuid(), 'domain', 'BD', true)
     on conflict (key, market) do update set enabled = excluded.enabled`,
  );
  // The seller is in place before the first charge of the file. A charge without it is queued to the invoice
  // backlog, and a queued charge holds every later charge of the market behind it (WPU-I5,
  // invoice_backlog_blocked): the renewal of the reversal case would get no invoice of its own.
  await t.pool.query("delete from settings where key = 'invoice_seller' and market = 'BD'");
  await t.pool.query(
    `insert into settings (id, key, market, scope, value)
     values (gen_random_uuid(), 'invoice_seller', 'BD', 'market', $1::jsonb)`,
    [JSON.stringify(SELLER)],
  );
});

describe("one charge, one registry renewal", () => {
  it("the renewal at the period end queues one renew_domain of the period, with the expiry year, and sends it", async () => {
    const d = await boughtDomain();
    sent = [];
    kit.clock.set(d.end);
    expect((await run()).renewed).toBeGreaterThanOrEqual(1);

    expect(await renewals(d.subscriptionId)).toHaveLength(1);
    const ops = await renewOps(d.resourceId);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      state: "queued",
      // R13: nothing here is destructive; no admin approval, even before 2026-12-01.
      needs_approval: false,
      idempotency_key: domainRenewalKey(d.subscriptionId, d.end),
      payload: {
        subscriptionId: d.subscriptionId,
        periodStart: d.end.toISOString(),
        currentExpiryYear: d.expiry.getUTCFullYear(),
        years: 1,
      },
    });
    // R1: an operation row, and its message after the commit.
    expect(sent.filter((m) => m.operationId === ops[0]!.id)).toHaveLength(1);
    const s = await subRow(d.subscriptionId);
    expect(s.status).toBe("active");
    expect((s.period_start as Date).toISOString()).toBe(d.end.toISOString());
  });

  it("a replay queues no second operation: another run, and the hook again for the same period (R7)", async () => {
    const d = await boughtDomain();
    kit.clock.set(d.end);
    await run();
    const [op] = await renewOps(d.resourceId);
    sent = [];
    await run();
    const again = await worker(async (tx) => {
      const locked = await lifecycleRepo(tx).lock(d.subscriptionId);
      if (locked === null) throw new Error("fixture: no subscription");
      return queueDomainRenewal(tx, locked, d.end, kit.clock.now(), "13.0000");
    });
    expect(again).toBeNull();
    expect(await renewOps(d.resourceId)).toEqual([op]);
    expect(await renewals(d.subscriptionId)).toHaveLength(1);
    expect(sent.filter((m) => m.resourceId === d.resourceId)).toEqual([]);
  });

  it("renewNow of a domain queues the same one operation, under the engine's key", async () => {
    const d = await boughtDomain();
    kit.clock.set(new Date(d.end.getTime() - 2 * DAY));
    await kit.refreshFx();
    const first = await web((tx) =>
      renewNow(tx, { customerId: d.customerId, resourceId: d.resourceId, clock: kit.clock }),
    );
    expect(first.ok).toBe(true);
    const ops = await renewOps(d.resourceId);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      state: "queued",
      idempotency_key: domainRenewalKey(d.subscriptionId, d.end),
    });
    // WPU-Z19: the USD price this renewal charged (its price snapshot) is RenewDomain's Consent.MaxPrice.
    // WPU-Y2: that price is the TLD's renewal price (15), not the registration price of the order (13).
    expect((ops[0]!.payload as { maxPriceUsd?: unknown }).maxPriceUsd).toMatch(/^15(\.0+)?$/);
    // A second click is refused (the period moved) and the engine at the old end has nothing to renew.
    const second = await web((tx) =>
      renewNow(tx, { customerId: d.customerId, resourceId: d.resourceId, clock: kit.clock }),
    );
    expect(second).toMatchObject({ ok: false, error: "conflict" });
    kit.clock.set(d.end);
    await run();
    expect(await renewOps(d.resourceId)).toHaveLength(1);
    expect(await renewals(d.subscriptionId)).toHaveLength(1);
  });

  it("a server's renewal queues no registry renewal", async () => {
    kit.clock.set(START);
    const buyer = await kit.newBuyer({ balanceMinor: 20_000_000n });
    const { resourceId } = await placeOne(kit, buyer);
    const s = (
      await q("select id, period_end from subscriptions where resource_id = $1", [resourceId])
    )[0]!;
    await q("update resources set state = 'active' where id = $1", [resourceId]);
    await q("update operations set state = 'succeeded' where resource_id = $1", [resourceId]);
    await q("update subscriptions set auto_renew = true where id = $1", [s.id]);
    kit.clock.set(s.period_end as Date);
    await run();
    expect(await renewals(String(s.id))).toHaveLength(1);
    expect(await renewOps(resourceId)).toEqual([]);
  });

  it("a domain whose registry expiry is not known is not charged at all: it is held for price_unavailable (R16, final review M2)", async () => {
    const d = await boughtDomain({ expiry: null });
    const before = await kit.balance(d.customerId);
    kit.clock.set(d.end);
    const logged: Record<string, unknown>[] = [];
    await kit.refreshFx();
    await runLifecycle({
      runTx: worker,
      clock: kit.clock,
      log: (e) => logged.push(e as Record<string, unknown>),
      queue,
    });
    // the charge rolled back with its savepoint: no renewal, no registry operation, the wallet untouched
    expect(await renewals(d.subscriptionId)).toEqual([]);
    expect(await renewOps(d.resourceId)).toEqual([]);
    expect(await kit.balance(d.customerId)).toBe(before);
    const s = await subRow(d.subscriptionId);
    expect(s.status).toBe("active");
    expect((s.period_end as Date).toISOString()).toBe(d.end.toISOString());
    // the hold marker is written once and its log line (the alarm) names the subscription
    const [marker] = await q("select config->'fxRateHold' as hold from resources where id = $1", [
      d.resourceId,
    ]);
    expect(marker!.hold).toMatchObject({ reason: "price_unavailable", error: "conflict" });
    expect(logged).toContainEqual(
      expect.objectContaining({
        event: "lifecycle_renewal_held",
        reason: "price_unavailable",
        error: "conflict",
        subscriptionId: d.subscriptionId,
      }),
    );
    // no grace and no suspension while held: the next sweep holds again and charges nothing
    await run();
    expect(await renewals(d.subscriptionId)).toEqual([]);
    expect((await subRow(d.subscriptionId)).status).toBe("active");
  });
});

// WPU-Y2 (owner rule a): the renewal is priced from tlds.renewal_price_usd at the rate of the renewal day.
describe("the price of a domain renewal (WPU-Y2)", () => {
  it("a TLD whose renewal costs more than its registration renews at the renewal price, through the normal pricing", async () => {
    const d = await boughtDomain({ renewal: "48.0000" });
    const afterPurchase = await kit.balance(d.customerId);
    const paidForPurchase = 20_000_000n - afterPurchase;
    kit.clock.set(new Date(d.end.getTime() - 30 * DAY));
    await kit.refreshFx();
    const quote = await worker(async (tx) => {
      const locked = await lifecycleRepo(tx).lock(d.subscriptionId);
      if (locked === null) throw new Error("fixture: no subscription");
      return renewalQuote(tx, locked, kit.clock);
    });
    if (!quote.ok) throw new Error(`fixture: the quote was refused (${quote.error})`);
    expect(quote.value.awsPriceUsd).toMatch(/^48(\.0+)?$/);
    await run();
    const paidForRenewal = afterPurchase - (await kit.balance(d.customerId));
    expect(paidForRenewal).toBe(BigInt(quote.value.totalMinor));
    expect(paidForRenewal).toBeGreaterThan(paidForPurchase);
    const [op] = await renewOps(d.resourceId);
    // Consent.MaxPrice is the renewal USD price that was charged
    expect((op!.payload as { maxPriceUsd?: unknown }).maxPriceUsd).toBe(quote.value.awsPriceUsd);
  });

  it("a renewal price that is missing is not charged: held for price_unavailable (R16)", async () => {
    const d = await boughtDomain();
    await q("update tlds set renewal_price_usd = null where id = $1", [d.tldId]);
    kit.clock.set(d.end);
    const before = await kit.balance(d.customerId);
    await run();
    expect(await renewals(d.subscriptionId)).toEqual([]);
    expect(await kit.balance(d.customerId)).toBe(before);
    const [marker] = await q("select config->'fxRateHold' as hold from resources where id = $1", [
      d.resourceId,
    ]);
    expect(marker!.hold).toMatchObject({ reason: "price_unavailable", error: "internal" });
    expect((await subRow(d.subscriptionId)).status).toBe("active");
  });
});

// WPU-Y2 (owner rule b): the charge and RenewDomain 30 days before the period end; the new period still starts at the
// old period end; a short wallet has the 30 days of retries before the grace of the period end.
describe("the lead time of a domain renewal (WPU-Y2)", () => {
  it("is charged 30 days before the period end, not a millisecond earlier, and the new period starts at the old end", async () => {
    const d = await boughtDomain();
    kit.clock.set(new Date(d.end.getTime() - 30 * DAY - 1));
    await run();
    expect(await renewals(d.subscriptionId)).toEqual([]);
    expect(await renewOps(d.resourceId)).toEqual([]);

    kit.clock.set(new Date(d.end.getTime() - 30 * DAY));
    await run();
    expect(await renewals(d.subscriptionId)).toHaveLength(1);
    const ops = await renewOps(d.resourceId);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ idempotency_key: domainRenewalKey(d.subscriptionId, d.end) });
    const s = await subRow(d.subscriptionId);
    expect(s.status).toBe("active");
    expect((s.period_start as Date).toISOString()).toBe(d.end.toISOString());
    expect((s.period_end as Date).getTime()).toBe(d.end.getTime() + 365 * DAY);
    // one year per year: the period end comes again and nothing more is charged
    kit.clock.set(d.end);
    await run();
    expect(await renewals(d.subscriptionId)).toHaveLength(1);
  });

  it("a short wallet is retried on every sweep of the 30 days, with no grace and no suspension", async () => {
    const d = await boughtDomain({ renewal: "900000.0000" });
    kit.clock.set(new Date(d.end.getTime() - 30 * DAY));
    await run();
    expect(await renewals(d.subscriptionId)).toEqual([]);
    expect((await subRow(d.subscriptionId)).status).toBe("active");
    expect(
      await q("select id from operations where resource_id = $1 and kind = 'suspend'", [
        d.resourceId,
      ]),
    ).toEqual([]);
    // the price comes back within reach (the wallet would be topped up the same way): the next sweep renews
    await q("update tlds set renewal_price_usd = '15.0000' where id = $1", [d.tldId]);
    kit.clock.set(new Date(d.end.getTime() - 10 * DAY));
    await run();
    expect(await renewals(d.subscriptionId)).toHaveLength(1);
    expect((await subRow(d.subscriptionId)).status).toBe("active");
  });
});

describe("a registry renewal that failed gives the charge back once", () => {
  // WPU-Y2 (owner rule c): the refund no longer ends the subscription for good. It goes back, active, to the period
  // that was paid; the lifecycle does not charge that period again by itself (held, with the alarm); the customer can
  // renew again, under the next attempt's ledger key, and that queues a registry renewal of its own.
  it("one reversal, the wallet as before the charge, the subscription active at the period that was paid, a credit note, and a retry by hand", async () => {
    const d = await boughtDomain();
    const before = await kit.balance(d.customerId);
    kit.clock.set(d.end);
    await run();
    const [charge] = await renewals(d.subscriptionId);
    const [op] = await renewOps(d.resourceId);
    expect(await kit.balance(d.customerId)).toBeLessThan(before);
    // The renewal had its tax invoice, issued with the charge.
    expect(
      await q("select id from invoices where ledger_transaction_id = $1", [charge!.id]),
    ).toHaveLength(1);

    // The provisioner moved the operation to failed (the registry refused); its failed hook runs, twice here.
    await q("update operations set state = 'failed', last_error = 'conflict' where id = $1", [
      op!.id,
    ]);
    const event = {
      operationId: String(op!.id),
      resourceId: d.resourceId,
      customerId: d.customerId,
    };
    const first = await worker((tx) => reverseFailedDomainRenewal(tx, {}, event));
    const second = await worker((tx) => reverseFailedDomainRenewal(tx, {}, event));
    expect(first.rolledBack).toBe(true);
    expect(second).toEqual({ reversalId: first.reversalId, rolledBack: false });

    const reversals = await reversalsOf(String(charge!.id));
    expect(reversals).toEqual([
      { id: first.reversalId, idempotency_key: `reversal:${charge!.id}` },
    ]);
    expect(await kit.balance(d.customerId)).toBe(before);
    const s = await subRow(d.subscriptionId);
    expect(s.status).toBe("active");
    expect((s.period_start as Date).getTime()).toBe(d.end.getTime() - 365 * DAY);
    expect((s.period_end as Date).toISOString()).toBe(d.end.toISOString());
    const [marker] = await q(
      "select config->'domainRenewalRefused' as refused from resources where id = $1",
      [d.resourceId],
    );
    expect(marker!.refused).toEqual({ periodStart: d.end.toISOString() });

    // The lifecycle does not charge the refused period again by itself: held, with the alarm line, no grace.
    const logged: Record<string, unknown>[] = [];
    await kit.refreshFx();
    await runLifecycle({
      runTx: worker,
      clock: kit.clock,
      log: (e) => logged.push(e as Record<string, unknown>),
      queue,
    });
    expect(await renewals(d.subscriptionId)).toHaveLength(1);
    expect((await subRow(d.subscriptionId)).status).toBe("active");
    expect(await kit.balance(d.customerId)).toBe(before);
    expect(logged).toContainEqual(
      expect.objectContaining({
        event: "lifecycle_renewal_held",
        reason: "price_unavailable",
        error: "conflict",
        subscriptionId: d.subscriptionId,
      }),
    );

    // The customer renews again by hand: charged under attempt 1, with a registry renewal of its own (R7 keys).
    const again = await web((tx) =>
      renewNow(tx, { customerId: d.customerId, resourceId: d.resourceId, clock: kit.clock }),
    );
    expect(again).toMatchObject({ ok: true, value: { attempt: 1 } });
    const charges = await q(
      `select idempotency_key from ledger_transactions where kind = 'renewal' and reference_id = $1
        order by created_at, id`,
      [d.subscriptionId],
    );
    expect(charges.map((c) => c.idempotency_key)).toEqual([
      `renew:${d.subscriptionId}:${d.end.toISOString()}`,
      `renew:${d.subscriptionId}:${d.end.toISOString()}:a1`,
    ]);
    const ops = await renewOps(d.resourceId);
    expect(ops.map((o) => o.idempotency_key)).toEqual([
      domainRenewalKey(d.subscriptionId, d.end),
      domainRenewalKey(d.subscriptionId, d.end, 1),
    ]);
    expect(ops[1]).toMatchObject({ state: "queued", payload: { attempt: 1 } });
    const renewed = await subRow(d.subscriptionId);
    expect((renewed.period_start as Date).toISOString()).toBe(d.end.toISOString());
    // A late repeat of the first hook is a replay: it never moves the period of the retry back.
    expect(await worker((tx) => reverseFailedDomainRenewal(tx, {}, event))).toEqual({
      reversalId: first.reversalId,
      rolledBack: false,
    });
    expect((await subRow(d.subscriptionId)).period_start).toEqual(renewed.period_start);

    // The invoice stays (a legal document); the scheduler issues the credit note of the reversal (WPU-C1).
    await runInvoiceBacklog({ runTx: worker, clock: kit.clock, log: () => undefined });
    const credit = await q(
      `select c.total_minor::text as total from invoices c join invoices o on o.id = c.original_invoice_id
        where c.kind = 'credit_note' and o.ledger_transaction_id = $1`,
      [charge!.id],
    );
    expect(credit).toHaveLength(1);
  });

  it("an operation that is not a renewal of this resource is refused and moves no money", async () => {
    const d = await boughtDomain();
    kit.clock.set(d.end);
    await run();
    const before = await kit.balance(d.customerId);
    const other = await boughtDomain();
    const [op] = await renewOps(d.resourceId);
    await expect(
      worker((tx) =>
        reverseFailedDomainRenewal(
          tx,
          {},
          { operationId: String(op!.id), resourceId: other.resourceId, customerId: d.customerId },
        ),
      ),
    ).rejects.toThrow("cannot be reversed");
    expect(await kit.balance(d.customerId)).toBe(before);
    expect((await subRow(d.subscriptionId)).status).toBe("active");
  });
});
