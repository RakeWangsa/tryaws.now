import { randomUUID } from "node:crypto";
import { AwsError, type ProductAdapter } from "@tc/aws";
import {
  buildChargeSnapshot,
  ensureSystemAccounts,
  ledgerKey,
  openWallet,
  postTransaction,
  quote,
  stepDone,
  type StepResult,
} from "@tc/core";
import { rejectOperation, runTransaction } from "@tc/db/testing";
import { notify } from "@tc/notify";
import { beforeAll, describe, expect, it } from "vitest";
import { createAdapterRegistry } from "./adapters";
import { composeHooks } from "./hooks";
import { orderHooks } from "./order-hooks";
import { renewalHooks } from "./renewal-hooks";
import { runStep } from "./step";
import { NOW, useHarness } from "./test/harness";
import { operationRow, seedOperation } from "./test/seed";

// WPU-Z13: a renew_domain through the real provisioner path. A registry that refuses moves it to failed and the
// renewal charge of its period goes back in the same transaction (one reversal, the subscription back, active, at the
// period that was paid: WPU-Y2); an error that passes waits and moves no money; a reversal that cannot be made rolls the
// move to failed back; an admin's rejection after the retries gives the money back too while the registry does
// not hold the renewal. Once it does (step poll, review round 1) nothing gives it back (WPU-Y2: the registry's own
// refusal too): every final error stops in needs_attention and a rejection is refused. At step submit (review round 2) only a
// failure that proves nothing was sent gives it back. The domain adapter is a fake here (its
// RenewDomain call and its errors are proved in packages/aws/test/domain-actions.test.ts).
const { t, world, setup, message } = useHarness();
const PRICE = 150_000n;
const DAY = 24 * 3_600_000;
const clock = { now: () => NOW };

beforeAll(async () => {
  await runTransaction(t.db, (tx) => ensureSystemAccounts(tx));
  await runTransaction(t.db, (tx) => openWallet(tx, world.customerId), { role: "web_rw" });
  const topup = randomUUID();
  const funded = await runTransaction(
    t.db,
    (tx) =>
      postTransaction(tx, {
        kind: "topup",
        reference: { type: "payment", id: topup },
        idempotencyKey: `topup:${topup}`,
        actor: { type: "system" },
        postings: [
          { account: { type: "gateway_clearing" }, direction: "debit", amountMinor: 10_000_000n },
          {
            account: { type: "customer_wallet", customerId: world.customerId },
            direction: "credit",
            amountMinor: 10_000_000n,
          },
        ],
      }),
    { role: "worker_rw" },
  );
  if (!funded.ok) throw new Error("fixture: the top-up was refused");
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
const reversalsOf = async (chargeId: string) =>
  (
    await one(
      `select count(*)::int as n from ledger_transactions
        where kind = 'reversal' and reference_type = 'ledger_transaction' and reference_id = $1`,
      [chargeId],
    )
  ).n;
const subscriptionOf = async (id: string) =>
  one("select status, period_start, period_end from subscriptions where id = $1", [id]);

/**
 * A registered domain of the world's customer whose subscription was renewed for the period from `periodStart`,
 * as the lifecycle leaves it: the charge under the renewal key, the period moved, the renew_domain queued.
 */
async function renewedDomain(periodStart: Date, options: { charged?: boolean } = {}) {
  const resourceId = String(
    (
      await one(
        `insert into resources (id, customer_id, family, region, state, config)
         values (gen_random_uuid(), $1, 'domain', 'us-east-1', 'active', $2::jsonb) returning id`,
        [
          world.customerId,
          JSON.stringify({ name: "shop.example", expiresAt: periodStart.toISOString() }),
        ],
      )
    ).id,
  );
  const subscriptionId = randomUUID();
  await t.pool.query(
    `insert into subscriptions (id, resource_id, customer_id, term_days, price_snapshot,
                                period_start, period_end)
     values ($1, $2, $3, 365, '{}'::jsonb, $4, $5)`,
    [
      subscriptionId,
      resourceId,
      world.customerId,
      periodStart.toISOString(),
      new Date(periodStart.getTime() + 365 * DAY).toISOString(),
    ],
  );
  let chargeId = "";
  if (options.charged !== false) {
    const posted = await runTransaction(
      t.db,
      (tx) =>
        postTransaction(tx, {
          kind: "renewal",
          reference: { type: "subscription", id: subscriptionId },
          idempotencyKey: ledgerKey.renewal(subscriptionId, periodStart),
          actor: { type: "system" },
          priceSnapshot: buildChargeSnapshot(
            "renewal",
            {
              pricedAt: periodStart,
              awsPriceUsd: "13",
              quantity: "1",
              fx: { id: "fx-1", rate: "127", effectiveFrom: periodStart },
              rule: { id: "rule-id-1", version: "rule-1" },
              book: null,
              quote: quote({
                awsPriceUsd: "13",
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
      { role: "worker_rw" },
    );
    if (!posted.ok) throw new Error("fixture: the renewal charge was refused");
    chargeId = posted.value.transactionId;
  }
  const operationId = await seedOperation(t.pool, resourceId, {
    kind: "renew_domain",
    payload: {
      subscriptionId,
      periodStart: periodStart.toISOString(),
      currentExpiryYear: periodStart.getUTCFullYear(),
      years: 1,
    },
    idempotency_key: `lifecycle:renew-domain:${subscriptionId}:${periodStart.toISOString()}`,
  });
  return { resourceId, subscriptionId, chargeId, operationId };
}

/** A domain adapter whose actions answer with `act` (no AWS). */
function domainRegistry(act: () => Promise<StepResult>) {
  const adapter: ProductAdapter<unknown> = {
    family: "domain",
    parseConfig: (input) => input,
    aws: {
      create: act,
      suspend: async () => stepDone(),
      resume: async () => stepDone(),
      finalSnapshot: async () => stepDone(),
      destroy: act,
      purgeSnapshots: async () => stepDone(),
      describe: async () => ({ state: "active" }),
      action: async () => act(),
    },
  };
  return createAdapterRegistry([adapter]);
}

const refusing = () =>
  domainRegistry(async () => {
    throw new AwsError({
      code: "conflict",
      retryable: false,
      awsErrorName: "TLDRulesViolation",
      operation: "RenewDomain",
    });
  });
// WPU-Y2 fix round 1: the refund message goes through @tc/notify, as in index.ts.
const hooks = () =>
  composeHooks(
    orderHooks({ clock }),
    renewalHooks({
      notice: (tx, n) =>
        notify(tx, {
          customerId: n.customerId,
          template: n.template,
          data: n.data,
          dedupeKey: n.dedupeKey,
        }),
    }),
  );

describe("a registry renewal that the registry refuses", () => {
  it("reaches failed and gives the renewal charge back in the same transaction", async () => {
    const at = new Date("2026-11-11T09:00:00.000Z");
    const d = await renewedDomain(at);
    const start = await balance();
    const { deps } = setup({ adapters: refusing(), hooks: hooks() });

    expect(await runStep(deps, message(d.operationId, d.resourceId))).toEqual({
      outcome: "advanced",
      to: "failed",
      sent: false,
    });
    expect(await operationRow(t.pool, d.operationId)).toMatchObject({
      state: "failed",
      last_error: "conflict:TLDRulesViolation",
    });
    expect(await reversalsOf(d.chargeId)).toBe(1);
    expect(await balance()).toBe(start + PRICE);
    // WPU-Y2 (owner rule c): back, active, at the period that was paid; the customer can renew again.
    const s = await subscriptionOf(d.subscriptionId);
    expect(s.status).toBe("active");
    expect((s.period_start as Date).getTime()).toBe(at.getTime() - 365 * DAY);
    expect((s.period_end as Date).toISOString()).toBe(at.toISOString());
  });

  it("an error that passes waits for its retry and moves no money", async () => {
    const d = await renewedDomain(new Date("2026-11-12T09:00:00.000Z"));
    const start = await balance();
    const { deps } = setup({
      adapters: domainRegistry(async () => {
        throw new AwsError({
          code: "upstream_unavailable",
          retryable: true,
          awsErrorName: "ServiceUnavailable",
          operation: "RenewDomain",
        });
      }),
      hooks: hooks(),
    });
    expect(await runStep(deps, message(d.operationId, d.resourceId))).toMatchObject({
      to: "waiting",
    });
    expect(await reversalsOf(d.chargeId)).toBe(0);
    expect(await balance()).toBe(start);
    expect((await subscriptionOf(d.subscriptionId)).status).toBe("active");
  });

  it("a renewal whose charge cannot be found is not failed: the move rolls back for a person (R16)", async () => {
    const d = await renewedDomain(new Date("2026-11-13T09:00:00.000Z"), { charged: false });
    const start = await balance();
    const { deps } = setup({ adapters: refusing(), hooks: hooks() });
    await expect(runStep(deps, message(d.operationId, d.resourceId))).rejects.toThrow(
      "cannot be reversed",
    );
    expect(await operationRow(t.pool, d.operationId)).toMatchObject({ state: "running" });
    expect(await balance()).toBe(start);
    expect((await subscriptionOf(d.subscriptionId)).status).toBe("active");
  });
});

// WPU-Z13 review round 1: once RenewDomain was accepted (step poll) the registry holds the renewal. TiCON pays for
// it and it may still complete, so only the registry's own refusal gives the charge back.
describe("a registry renewal that the registry holds (step poll)", () => {
  const held = async (at: Date) => {
    const d = await renewedDomain(at);
    await t.pool.query("update operations set step = 'poll' where id = $1", [d.operationId]);
    return d;
  };
  const throwing = (error: AwsError) =>
    domainRegistry(async () => {
      throw error;
    });

  it("still in progress after three days (the poll gives up): needs_attention, no money moves", async () => {
    const d = await held(new Date("2026-11-15T09:00:00.000Z"));
    const start = await balance();
    const { deps } = setup({
      adapters: throwing(new AwsError({ code: "upstream_unavailable", retryable: false })),
      hooks: hooks(),
    });
    expect(await runStep(deps, message(d.operationId, d.resourceId))).toEqual({
      outcome: "advanced",
      to: "needs_attention",
      sent: false,
    });
    expect(await operationRow(t.pool, d.operationId)).toMatchObject({
      state: "needs_attention",
      step: "poll",
      last_error: "upstream_unavailable",
    });
    expect(await reversalsOf(d.chargeId)).toBe(0);
    expect(await balance()).toBe(start);
    expect((await subscriptionOf(d.subscriptionId)).status).toBe("active");
  });

  // WPU-Y2 fix round 1: GetOperationDetail FAILED for the saved RenewDomain operation is final "not renewed": failed,
  // the charge back once, the subscription active at the paid period, the period marked with the refused price, the
  // customer told. ERROR (registry_unrenewed) stops for an admin, who may then reject it with the refund.
  it("the registry answers FAILED: failed, the charge back once, active at the paid period, marked, the customer told", async () => {
    const at = new Date("2026-11-16T09:00:00.000Z");
    const d = await held(at);
    await t.pool.query(
      `update operations set payload = payload || '{"maxPriceUsd":"13.0000"}'::jsonb where id = $1`,
      [d.operationId],
    );
    const start = await balance();
    const { deps } = setup({
      adapters: throwing(
        new AwsError({ code: "conflict", retryable: false, reason: "registry_failed" }),
      ),
      hooks: hooks(),
    });
    expect(await runStep(deps, message(d.operationId, d.resourceId))).toMatchObject({
      to: "failed",
    });
    expect(await operationRow(t.pool, d.operationId)).toMatchObject({
      state: "failed",
      last_error: "conflict:registry_failed",
    });
    expect(await reversalsOf(d.chargeId)).toBe(1);
    expect(await balance()).toBe(start + PRICE);
    const s = await subscriptionOf(d.subscriptionId);
    expect(s.status).toBe("active");
    expect((s.period_end as Date).toISOString()).toBe(at.toISOString());
    const marker = await one(
      "select config->'domainRenewalRefused' as m from resources where id = $1",
      [d.resourceId],
    );
    expect(marker.m).toEqual({ periodStart: at.toISOString(), maxPriceUsd: "13.0000" });
    const told = await t.pool.query(
      "select template from notifications where customer_id = $1 and template = 'domain_renewal_refunded'",
      [world.customerId],
    );
    expect(told.rows.length).toBeGreaterThanOrEqual(1);
  });

  it("the registry answers ERROR (expiry unchanged): needs_attention, no money moves; a fresh check lets an admin reject it with the refund", async () => {
    const at = new Date("2026-11-18T09:00:00.000Z");
    const d = await held(at);
    const start = await balance();
    const { deps } = setup({
      adapters: throwing(
        new AwsError({
          code: "upstream_unavailable",
          retryable: false,
          reason: "registry_unrenewed",
        }),
      ),
      hooks: hooks(),
    });
    expect(await runStep(deps, message(d.operationId, d.resourceId))).toMatchObject({
      to: "needs_attention",
    });
    expect(await operationRow(t.pool, d.operationId)).toMatchObject({
      state: "needs_attention",
      // WPU-Y2 fix round 2: with the time the provisioner recorded the check
      last_error: expect.stringMatching(/^upstream_unavailable:registry_unrenewed:\d{10}$/),
    });
    expect(await reversalsOf(d.chargeId)).toBe(0);
    expect(await balance()).toBe(start);
    // the admin rejects it within the hour of that check: failed, refunded
    const out = await runTransaction(
      t.db,
      (tx) => rejectOperation(tx, { operationId: d.operationId, at: NOW }),
      { role: "admin_rw" },
    );
    if (!out.ok || !out.message) throw new Error("reject did not queue an operation");
    const rejecting = setup({
      adapters: throwing(new AwsError({ code: "internal", retryable: false })),
      hooks: hooks(),
    });
    expect(await runStep(rejecting.deps, out.message)).toMatchObject({ to: "succeeded" });
    expect(await operationRow(t.pool, d.operationId)).toMatchObject({ state: "failed" });
    expect(await reversalsOf(d.chargeId)).toBe(1);
    expect(await balance()).toBe(start + PRICE);
    expect((await subscriptionOf(d.subscriptionId)).status).toBe("active");
  });

  it("an admin's rejection is refused (renewal_submitted): the renewal stays for a retry, no money moves", async () => {
    const d = await held(new Date("2026-11-17T09:00:00.000Z"));
    await t.pool.query(
      "update operations set state = 'needs_attention', attempts = 5, last_error = 'rate_limited:ThrottlingException' where id = $1",
      [d.operationId],
    );
    const start = await balance();
    const out = await runTransaction(
      t.db,
      (tx) => rejectOperation(tx, { operationId: d.operationId, at: NOW }),
      { role: "admin_rw" },
    );
    if (!out.ok || !out.message) throw new Error("reject did not queue an operation");
    const { deps } = setup({ adapters: refusing(), hooks: hooks() });

    expect(await runStep(deps, out.message)).toMatchObject({ to: "needs_attention" });
    expect(await operationRow(t.pool, out.message.operationId)).toMatchObject({
      state: "needs_attention",
      last_error: "renewal_submitted",
    });
    expect(await operationRow(t.pool, d.operationId)).toMatchObject({
      state: "needs_attention",
      step: "poll",
    });
    expect(await reversalsOf(d.chargeId)).toBe(0);
    expect(await balance()).toBe(start);
    expect((await subscriptionOf(d.subscriptionId)).status).toBe("active");
  });
});

// WPU-Z13 review round 2: RenewDomain is sent only at step submit, which the adapter records on its own before the
// call. A RenewDomain that may have reached the registry (a time-out, a reset connection, a 5xx after the request
// was sent) leaves the renewal at submit: it is held, and only a failure that proves nothing was sent gives back.
describe("a registry renewal at step submit (RenewDomain may have been sent)", () => {
  const submitting = async (at: Date, previous?: { attempts: number; lastError: string }) => {
    const d = await renewedDomain(at);
    await t.pool.query(
      "update operations set step = 'submit', attempts = $2, last_error = $3 where id = $1",
      [d.operationId, previous?.attempts ?? 0, previous?.lastError ?? null],
    );
    return d;
  };
  const throwing = (error: AwsError) =>
    domainRegistry(async () => {
      throw error;
    });
  const refusal = () =>
    new AwsError({
      code: "conflict",
      retryable: false,
      awsErrorName: "TLDRulesViolation",
      operation: "RenewDomain",
      mayHaveActed: false,
    });

  it("a final error of a RenewDomain that may have acted: needs_attention, no money moves", async () => {
    const d = await submitting(new Date("2026-11-18T09:00:00.000Z"));
    const start = await balance();
    const { deps } = setup({
      adapters: throwing(
        new AwsError({
          code: "internal",
          retryable: false,
          operation: "RenewDomain",
          mayHaveActed: true,
        }),
      ),
      hooks: hooks(),
    });
    expect(await runStep(deps, message(d.operationId, d.resourceId))).toEqual({
      outcome: "advanced",
      to: "needs_attention",
      sent: false,
    });
    expect(await operationRow(t.pool, d.operationId)).toMatchObject({
      state: "needs_attention",
      step: "submit",
      last_error: "internal",
    });
    expect(await reversalsOf(d.chargeId)).toBe(0);
    expect(await balance()).toBe(start);
    expect((await subscriptionOf(d.subscriptionId)).status).toBe("active");
  });

  it("a definite refusal at the first run of the step (nothing sent): failed, and the charge goes back once", async () => {
    const at = new Date("2026-11-19T09:00:00.000Z");
    const d = await submitting(at);
    const start = await balance();
    const { deps } = setup({ adapters: throwing(refusal()), hooks: hooks() });
    expect(await runStep(deps, message(d.operationId, d.resourceId))).toMatchObject({
      to: "failed",
    });
    expect(await operationRow(t.pool, d.operationId)).toMatchObject({
      state: "failed",
      last_error: "conflict:TLDRulesViolation",
    });
    expect(await reversalsOf(d.chargeId)).toBe(1);
    expect(await balance()).toBe(start + PRICE);
    const s = await subscriptionOf(d.subscriptionId);
    expect(s.status).toBe("active");
    expect((s.period_end as Date).toISOString()).toBe(at.toISOString());
  });

  it("the same refusal after an earlier run whose RenewDomain timed out: needs_attention, no money moves", async () => {
    const d = await submitting(new Date("2026-11-20T09:00:00.000Z"), {
      attempts: 1,
      lastError: "upstream_unavailable:TimeoutError",
    });
    const start = await balance();
    const { deps } = setup({ adapters: throwing(refusal()), hooks: hooks() });
    expect(await runStep(deps, message(d.operationId, d.resourceId))).toMatchObject({
      to: "needs_attention",
    });
    expect(await operationRow(t.pool, d.operationId)).toMatchObject({
      state: "needs_attention",
      step: "submit",
      attempts: 2,
    });
    expect(await reversalsOf(d.chargeId)).toBe(0);
    expect(await balance()).toBe(start);
    expect((await subscriptionOf(d.subscriptionId)).status).toBe("active");
  });

  it("an admin's rejection is refused (renewal_submitted): no money moves", async () => {
    const d = await submitting(new Date("2026-11-21T09:00:00.000Z"), {
      attempts: 5,
      lastError: "upstream_unavailable:TimeoutError",
    });
    await t.pool.query("update operations set state = 'needs_attention' where id = $1", [
      d.operationId,
    ]);
    const start = await balance();
    const out = await runTransaction(
      t.db,
      (tx) => rejectOperation(tx, { operationId: d.operationId, at: NOW }),
      { role: "admin_rw" },
    );
    if (!out.ok || !out.message) throw new Error("reject did not queue an operation");
    const { deps } = setup({ adapters: refusing(), hooks: hooks() });

    expect(await runStep(deps, out.message)).toMatchObject({ to: "needs_attention" });
    expect(await operationRow(t.pool, out.message.operationId)).toMatchObject({
      state: "needs_attention",
      last_error: "renewal_submitted",
    });
    expect(await operationRow(t.pool, d.operationId)).toMatchObject({
      state: "needs_attention",
      step: "submit",
    });
    expect(await reversalsOf(d.chargeId)).toBe(0);
    expect(await balance()).toBe(start);
    expect((await subscriptionOf(d.subscriptionId)).status).toBe("active");
  });
});

describe("a registry renewal that ran out of retries before RenewDomain was accepted (no step)", () => {
  it("is rejected by an admin: failed, and the charge goes back once", async () => {
    const at = new Date("2026-11-14T09:00:00.000Z");
    const d = await renewedDomain(at);
    await t.pool.query(
      "update operations set state = 'needs_attention', attempts = 5, last_error = 'upstream_unavailable' where id = $1",
      [d.operationId],
    );
    const start = await balance();
    const out = await runTransaction(
      t.db,
      (tx) => rejectOperation(tx, { operationId: d.operationId, at: NOW }),
      { role: "admin_rw" },
    );
    if (!out.ok || !out.message) throw new Error("reject did not queue an operation");
    const { deps } = setup({ adapters: refusing(), hooks: hooks() });

    expect(await runStep(deps, out.message)).toMatchObject({ to: "succeeded" });
    expect(await operationRow(t.pool, d.operationId)).toMatchObject({
      state: "failed",
      last_error: "rejected",
    });
    expect(await reversalsOf(d.chargeId)).toBe(1);
    expect(await balance()).toBe(start + PRICE);
    expect((await subscriptionOf(d.subscriptionId)).status).toBe("active");
  });
});
