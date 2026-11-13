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
}

/**
 * A domain bought through the order flow at START, then registered as the provisioner leaves it: the resource
 * active with the adapter's `expiresAt`, the domain row registered, the create succeeded. Auto-renew on.
 */
async function boughtDomain(options: { expiry?: string | null } = {}): Promise<Bought> {
  kit.clock.set(START);
  const buyer = await kit.newBuyer({ balanceMinor: 20_000_000n });
  const tld = "t" + uniqueSuffix();
  const tldId = await insertRow(t.pool, "tlds", {
    tld,
    registration_price_usd: "13.0000",
    renewal_price_usd: "15.0000",
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
    expect((ops[0]!.payload as { maxPriceUsd?: unknown }).maxPriceUsd).toMatch(/^13(\.0+)?$/);
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

describe("a registry renewal that failed gives the charge back once", () => {
  it("one reversal, the wallet as before the charge, the subscription ended at the period that was paid, a credit note", async () => {
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
    expect(first.ended).toBe(true);
    expect(second).toEqual({ reversalId: first.reversalId, ended: false });

    const reversals = await reversalsOf(String(charge!.id));
    expect(reversals).toEqual([
      { id: first.reversalId, idempotency_key: `reversal:${charge!.id}` },
    ]);
    expect(await kit.balance(d.customerId)).toBe(before);
    const s = await subRow(d.subscriptionId);
    expect(s.status).toBe("ended");
    expect((s.period_start as Date).getTime()).toBe(d.end.getTime() - 365 * DAY);
    expect((s.period_end as Date).toISOString()).toBe(d.end.toISOString());
    // The renewal is over: the next run renews nothing (no period for nothing under the reversed key).
    await run();
    expect(await renewals(d.subscriptionId)).toHaveLength(1);
    expect((await subRow(d.subscriptionId)).status).toBe("ended");
    expect(await kit.balance(d.customerId)).toBe(before);

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
