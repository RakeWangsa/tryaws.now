import { describe, expect, it } from "vitest";
import { checkLedger, ledgerKey, postTransaction } from "@tc/core";
import {
  createEps,
  createEpsGateway,
  epsCredentials,
  handleEpsReturn,
  startTopUp,
  sweepPayments,
  verifyPayment,
} from "../index";
import type { EpsDeps, EpsGateway } from "../index";
import { readVerifyResponse } from "../status";
import { freshIp, startPayment, useEpsKit, type Started } from "./kit";

// WP3-T2 proof: replay, forged success URL, amount mismatch and double callback credit nothing extra.
// One describe per sentence of the backlog row. Every test ends in expectCreditedExactly.

const k = useEpsKit();
const MIN = 60_000;
const HOUR = 60 * MIN;
const AMOUNT = 150000n; // 1500.00 BDT, the amount startPayment asks for
const REDIRECTS = /^\/wallet\?topup=(credited|pending|failed|cancelled|expired|unknown)$/;
const credited = { ok: true, value: { state: "credited" } } as const;
const pending = { ok: true, value: { state: "pending" } } as const;

/**
 * The four assertions every proof test ends with: the wallet balance, the count of topup ledger
 * transactions of the customer (all of them keyed topup:), wallets.balance_minor equal to the sum of
 * the entries of the wallet account, and a clean checkLedger.
 */
async function expectCreditedExactly(customerId: string, amountMinor: bigint): Promise<void> {
  expect(await k.balance(customerId)).toBe(amountMinor);

  const expectedTransactions = amountMinor === 0n ? 0 : 1;
  const topups = await k.pool.query<{ total: number; keyed: number }>(
    `select count(distinct t.id)::int as total,
            (count(distinct t.id) filter (where t.idempotency_key like 'topup:%'))::int as keyed
       from ledger_transactions t
       join ledger_entries e on e.transaction_id = t.id
       join ledger_accounts a on a.id = e.account_id
      where a.customer_id = $1 and a.type = 'customer_wallet' and t.kind = 'topup'`,
    [customerId],
  );
  expect(topups.rows[0]).toEqual({ total: expectedTransactions, keyed: expectedTransactions });

  const sums = await k.pool.query<{ entries: string; wallet: string }>(
    `select coalesce(sum(case e.direction when 'credit' then e.amount_minor else -e.amount_minor end), 0)::text as entries,
            (select balance_minor::text from wallets where customer_id = $1) as wallet
       from ledger_entries e
       join ledger_accounts a on a.id = e.account_id
      where a.customer_id = $1 and a.type = 'customer_wallet'`,
    [customerId],
  );
  expect(BigInt(sums.rows[0]?.wallet ?? "-1")).toBe(BigInt(sums.rows[0]?.entries ?? "-2"));
  expect(BigInt(sums.rows[0]?.wallet ?? "-1")).toBe(amountMinor);

  expect((await k.run((tx) => checkLedger(tx))).ok).toBe(true);
}

const settle = (s: Started, outcome: Parameters<typeof k.eps.settle>[1]) =>
  k.eps.settle(s.merchantTransactionId, outcome);

/** The browser comes back. Six seconds pass first, so the per-payment limit of one verify per 5 seconds never hides the answer. */
async function comeBack(
  deps: EpsDeps,
  outcome: "success" | "fail" | "cancel",
  s: Started,
  extra: Record<string, string> = {},
) {
  k.clock.advance(6000);
  return handleEpsReturn(deps, {
    outcome,
    query: { MerchantTransactionId: s.merchantTransactionId, ...extra },
    clientIp: freshIp(),
  });
}

/** Puts the clock `ms` after the payment was created (the sweeper compares created_at with the clock). */
async function clockAfter(s: Started, ms: number): Promise<void> {
  const r = await k.pool.query<{ created_at: Date }>(
    "select created_at from payments where id = $1",
    [s.paymentId],
  );
  k.clock.set(new Date((r.rows[0]?.created_at.getTime() ?? 0) + ms));
}

/** Closes every open payment except `keep`, so a sweep sees only the test's own rows. */
async function isolate(...keep: Started[]): Promise<void> {
  await k.pool.query(
    "update payments set status = 'cancelled' where status in ('initiated','redirected') and id <> all($1::uuid[])",
    [keep.map((s) => s.paymentId)],
  );
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const r = await k.pool.query<{ n: number }>(sql, params);
  return r.rows[0]?.n ?? -1;
}

/** A gateway whose verify answers the given raw body, so absent and typed fields reach the real reader. */
function answering(
  body: (id: string) => Record<string, unknown>,
): EpsGateway & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    initialize: (req) => k.eps.initialize(req),
    verify: async (id) => {
      calls.push(id);
      return { ok: true, reading: readVerifyResponse(body(id)) };
    },
  };
}

describe("replay: the same success callback credits nothing extra", () => {
  it("five callbacks in sequence: EPS is asked once, later calls hit the credited short-cut", async () => {
    const s = await startPayment(k);
    k.reset();
    settle(s, { status: "Success" });
    const deps = k.deps();
    for (let i = 0; i < 5; i++) {
      expect(await comeBack(deps, "success", s)).toEqual({
        redirectTo: "/wallet?topup=credited",
        state: "credited",
      });
    }
    expect(k.eps.verifyCalls).toHaveLength(1);
    expect(await k.ledgerRows(ledgerKey.topup(s.paymentId))).toBe(1);
    await expectCreditedExactly(s.customerId, AMOUNT);
  });

  it("five callbacks with Promise.all, then five more through the return handler", async () => {
    const s = await startPayment(k);
    k.reset();
    settle(s, { status: "Success" });
    const deps = k.deps();
    const all = await Promise.all(
      Array.from({ length: 5 }, () => verifyPayment(deps, s.merchantTransactionId)),
    );
    for (const r of all) expect(r).toEqual(credited);
    k.clock.advance(6000);
    const again = await Promise.all(
      Array.from({ length: 5 }, () =>
        handleEpsReturn(deps, {
          outcome: "success",
          query: { MerchantTransactionId: s.merchantTransactionId },
          clientIp: freshIp(),
        }),
      ),
    );
    // the per-payment limit lets one through; the rest are told "pending" and nothing else
    for (const r of again) expect(["credited", "pending"]).toContain(r.state);
    expect(again.some((r) => r.state === "credited")).toBe(true);
    expect(await k.ledgerRows(ledgerKey.topup(s.paymentId))).toBe(1);
    await expectCreditedExactly(s.customerId, AMOUNT);
  });

  it("the same verifyPayment after the sweeper ran", async () => {
    const s = await startPayment(k);
    await isolate(s);
    k.reset();
    await clockAfter(s, 3 * MIN);
    settle(s, { status: "Success" });
    expect(await sweepPayments(k.deps("worker_rw"))).toMatchObject({ checked: 1, credited: 1 });
    expect(k.eps.verifyCalls).toHaveLength(1);
    expect(await verifyPayment(k.deps(), s.merchantTransactionId)).toEqual(credited);
    expect(k.eps.verifyCalls).toHaveLength(1);
    expect(await sweepPayments(k.deps("worker_rw"))).toMatchObject({ checked: 0 });
    await expectCreditedExactly(s.customerId, AMOUNT);
  });

  it("a callback after a restart: a new createEps over the same database", async () => {
    const s = await startPayment(k);
    settle(s, { status: "Success" });
    expect((await comeBack(k.deps(), "success", s)).state).toBe("credited");
    k.reset();
    const restarted = createEps(k.deps());
    k.clock.advance(6000);
    expect(
      await restarted.handleReturn({
        outcome: "success",
        query: { MerchantTransactionId: s.merchantTransactionId },
        clientIp: freshIp(),
      }),
    ).toEqual({ redirectTo: "/wallet?topup=credited", state: "credited" });
    expect(k.eps.verifyCalls).toHaveLength(0);
    await expectCreditedExactly(s.customerId, AMOUNT);
  });
});

describe("forged success URL: a browser claim credits nothing", () => {
  it("(a) Status=Success and the amount in the URL while EPS says Pending", async () => {
    const s = await startPayment(k);
    settle(s, { status: "Pending" });
    const r = await comeBack(k.deps(), "success", s, {
      Status: "Success",
      status: "Success",
      TotalAmount: "1500.00",
      amount: "1500.00",
    });
    expect(r).toEqual({ redirectTo: "/wallet?topup=pending", state: "pending" });
    expect((await k.payment(s.paymentId)).status).toBe("redirected");
    await expectCreditedExactly(s.customerId, 0n);
  });

  it("(b) the same while EPS says Failed", async () => {
    const s = await startPayment(k);
    settle(s, { status: "Failed" });
    const r = await comeBack(k.deps(), "success", s, { Status: "Success", TotalAmount: "1500.00" });
    expect(r).toEqual({ redirectTo: "/wallet?topup=failed", state: "failed" });
    expect((await k.payment(s.paymentId)).status).toBe("failed");
    await expectCreditedExactly(s.customerId, 0n);
  });

  it("(c) an id never issued: no EPS call, no row change", async () => {
    const before = {
      payments: await count("select count(*)::int as n from payments"),
      ledger: await count("select count(*)::int as n from ledger_transactions"),
      discrepancies: await count("select count(*)::int as n from discrepancies"),
    };
    k.reset();
    const unknown = "TCP" + "0".repeat(32);
    for (const id of [unknown, "TCP123", "x' or 1=1 --", ""]) {
      k.clock.advance(6000);
      const r = await handleEpsReturn(k.deps(), {
        outcome: "success",
        query: { MerchantTransactionId: id, Status: "Success", TotalAmount: "1500.00" },
        clientIp: freshIp(),
      });
      expect(r).toEqual({ redirectTo: "/wallet?topup=unknown", state: "unknown" });
    }
    expect(k.eps.verifyCalls).toHaveLength(0);
    expect(await count("select count(*)::int as n from payments")).toBe(before.payments);
    expect(await count("select count(*)::int as n from ledger_transactions")).toBe(before.ledger);
    expect(await count("select count(*)::int as n from discrepancies")).toBe(before.discrepancies);
  });

  it("(d) the id of another customer's pending payment, EPS says Pending: nothing changes for anyone", async () => {
    const victim = await startPayment(k);
    const attacker = await startPayment(k);
    settle(victim, { status: "Pending" });
    settle(attacker, { status: "Pending" });
    const r = await handleEpsReturn(k.deps(), {
      outcome: "success",
      query: { MerchantTransactionId: victim.merchantTransactionId, Status: "Success" },
      clientIp: freshIp(),
    });
    expect(r.state).toBe("pending");
    expect((await k.payment(victim.paymentId)).status).toBe("redirected");
    expect((await k.payment(attacker.paymentId)).status).toBe("redirected");
    await expectCreditedExactly(victim.customerId, 0n);
    await expectCreditedExactly(attacker.customerId, 0n);
  });

  it("(e) the route name decides nothing: cancel with EPS Success credits once, success with EPS Cancelled cancels", async () => {
    const paid = await startPayment(k);
    settle(paid, { status: "Success" });
    expect(await comeBack(k.deps(), "cancel", paid)).toEqual({
      redirectTo: "/wallet?topup=credited",
      state: "credited",
    });
    expect(await comeBack(k.deps(), "cancel", paid)).toMatchObject({ state: "credited" });
    await expectCreditedExactly(paid.customerId, AMOUNT);

    const dropped = await startPayment(k);
    settle(dropped, { status: "Cancelled" });
    expect(await comeBack(k.deps(), "success", dropped)).toEqual({
      redirectTo: "/wallet?topup=cancelled",
      state: "cancelled",
    });
    expect((await k.payment(dropped.paymentId)).status).toBe("cancelled");
    await expectCreditedExactly(dropped.customerId, 0n);
  });

  it("(f) a hostile redirect parameter is never echoed", async () => {
    const s = await startPayment(k);
    settle(s, { status: "Pending" });
    const hostile = {
      redirect: "https://evil.example/steal",
      redirect_uri: "//evil.example",
      next: "https://evil.example",
      returnUrl: "javascript:alert(1)",
      RedirectURL: "https://evil.example/pg",
    };
    const r = await comeBack(k.deps(), "success", s, hostile);
    expect(r.redirectTo).toMatch(REDIRECTS);
    expect(JSON.stringify(r)).not.toMatch(/evil|javascript/);

    // the id itself as a hostile value, and two ids at once: both are "unknown", with no EPS call
    k.reset();
    for (const query of [
      { MerchantTransactionId: "https://evil.example/" },
      { MerchantTransactionId: [s.merchantTransactionId, s.merchantTransactionId] },
      {
        MerchantTransactionId: s.merchantTransactionId,
        merchantTransactionId: "TCP" + "1".repeat(32),
      },
    ]) {
      const hit = await handleEpsReturn(k.deps(), {
        outcome: "success",
        query,
        clientIp: freshIp(),
      });
      expect(hit).toEqual({ redirectTo: "/wallet?topup=unknown", state: "unknown" });
    }
    expect(k.eps.verifyCalls).toHaveLength(0);
    await expectCreditedExactly(s.customerId, 0n);
  });
});

describe("amount mismatch: EPS says success for another amount or id", () => {
  const OTHER_ID = "TCP" + "b".repeat(32);
  // [label, TotalAmount as EPS sends it (undefined = absent), MerchantTransactionId override, paisa the alert reports]
  const cases: Array<[string, unknown, string | undefined, bigint | null]> = [
    ["15.00", "15.00", undefined, 1500n],
    ["1500.01", "1500.01", undefined, 150001n],
    ["15000.00", "15000.00", undefined, 1500000n],
    ["1500.001", "1500.001", undefined, null],
    ["1,500.00", "1,500.00", undefined, null],
    ["1.5e3", "1.5e3", undefined, null],
    ["absent", undefined, undefined, null],
    ["a number type", 1500, undefined, null],
    ["another MerchantTransactionId", "1500.00", OTHER_ID, AMOUNT],
  ];

  it.each(cases)(
    "TotalAmount %s goes to review with one discrepancy and one alert",
    async (_label, total, otherId, gotMinor) => {
      const s = await startPayment(k);
      k.reset();
      const gateway = answering((id) => {
        const body: Record<string, unknown> = {
          Status: "Success",
          MerchantTransactionId: otherId ?? id,
          EpsTransactionId: "EPS-" + id.slice(3, 15),
        };
        if (total !== undefined) body.TotalAmount = total;
        return body;
      });
      const deps = k.deps("web_rw", { gateway });

      expect(await verifyPayment(deps, s.merchantTransactionId)).toEqual(pending);
      expect((await k.payment(s.paymentId)).status).toBe("review");
      const found = await k.discrepancies(s.paymentId);
      expect(found).toHaveLength(1);
      expect(found[0]?.details).toMatchObject({ paymentId: s.paymentId, expectedMinor: "150000" });
      const mine = k.alerts.filter((a) => a.paymentId === s.paymentId);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ kind: "payment_review", expectedMinor: AMOUNT, gotMinor });

      // more callbacks, the sweeper and 25 hours of clock change leave it in review
      for (let i = 0; i < 3; i++) {
        expect((await comeBack(deps, "success", s)).state).toBe("pending");
      }
      await isolate();
      k.clock.advance(25 * HOUR);
      expect(await sweepPayments(k.deps("worker_rw", { gateway }))).toMatchObject({ checked: 0 });
      expect((await comeBack(deps, "fail", s)).state).toBe("pending");
      const row = await k.payment(s.paymentId);
      expect(row.status).toBe("review");
      expect(row.status).not.toBe("expired");
      expect(await k.discrepancies(s.paymentId)).toHaveLength(1);
      expect(k.alerts.filter((a) => a.paymentId === s.paymentId)).toHaveLength(1);
      await expectCreditedExactly(s.customerId, 0n);
    },
  );
});

describe("double callback: the success and fail callbacks at once credit once", () => {
  it("Promise.all of both route names and direct verifies", async () => {
    const s = await startPayment(k);
    k.reset();
    settle(s, { status: "Success" });
    const depsA = k.deps();
    const depsB = k.deps();
    const query = { MerchantTransactionId: s.merchantTransactionId };
    const results = await Promise.all([
      handleEpsReturn(depsA, { outcome: "success", query, clientIp: freshIp() }),
      handleEpsReturn(depsB, { outcome: "fail", query, clientIp: freshIp() }),
      verifyPayment(depsA, s.merchantTransactionId),
      verifyPayment(depsB, s.merchantTransactionId),
      verifyPayment(depsA, s.merchantTransactionId),
    ]);
    expect(results[2]).toEqual(credited);
    expect(results[3]).toEqual(credited);
    expect(results[4]).toEqual(credited);
    // the per-payment limit lets one browser callback through; the other is told "pending"
    for (const r of results.slice(0, 2)) {
      expect(["credited", "pending"]).toContain((r as { state: string }).state);
    }
    expect(await k.ledgerRows(ledgerKey.topup(s.paymentId))).toBe(1);
    await expectCreditedExactly(s.customerId, AMOUNT);
  });

  it("two createEps instances (two sets of deps over the pool) and the sweeper at the same time", async () => {
    const s = await startPayment(k);
    await isolate(s);
    k.reset();
    await clockAfter(s, 3 * MIN);
    settle(s, { status: "Success" });
    const one = createEps(k.deps());
    const two = createEps(k.deps());
    const results = await Promise.all([
      one.verifyPayment(s.merchantTransactionId),
      two.verifyPayment(s.merchantTransactionId),
      one.sweep(),
      createEps(k.deps("worker_rw")).sweep(),
    ]);
    expect(results[0]).toEqual(credited);
    expect(results[1]).toEqual(credited);
    const counts = [results[2], results[3]] as Array<{ credited: number }>;
    expect(counts[0]!.credited + counts[1]!.credited).toBeLessThanOrEqual(1);
    expect(await k.ledgerRows(ledgerKey.topup(s.paymentId))).toBe(1);
    await expectCreditedExactly(s.customerId, AMOUNT);
  });

  it("a retried transaction (as withTx does after a deadlock) posts the same key and does not post twice", async () => {
    const s = await startPayment(k);
    settle(s, { status: "Success" });
    expect(await verifyPayment(k.deps(), s.merchantTransactionId)).toEqual(credited);
    const first = (await k.payment(s.paymentId)).ledgerTransactionId;
    expect(first).not.toBeNull();
    // withTx reruns the whole closure; the credit closure posts with the key topup:<id> again
    const replay = await k.run(
      (tx) =>
        postTransaction(tx, {
          kind: "topup",
          reference: { type: "payment", id: s.paymentId },
          idempotencyKey: ledgerKey.topup(s.paymentId),
          actor: { type: "system" },
          postings: [
            { account: { type: "gateway_clearing" }, direction: "debit", amountMinor: AMOUNT },
            {
              account: { type: "customer_wallet", customerId: s.customerId },
              direction: "credit",
              amountMinor: AMOUNT,
            },
          ],
        }),
      "web_rw",
    );
    if (replay.ok) expect(replay.value.transactionId).toBe(first);
    expect(await k.ledgerRows(ledgerKey.topup(s.paymentId))).toBe(1);
    await expectCreditedExactly(s.customerId, AMOUNT);
  });
});

describe("closed rows: a late success after expired, failed or cancelled goes to review", () => {
  async function close(how: "expired" | "failed" | "cancelled"): Promise<Started> {
    const s = await startPayment(k);
    await isolate(s);
    if (how === "expired") {
      await clockAfter(s, 25 * HOUR);
      settle(s, { status: "Pending" });
      expect(await sweepPayments(k.deps("worker_rw"))).toMatchObject({ checked: 1, expired: 1 });
    } else {
      settle(s, { status: how === "failed" ? "Failed" : "Cancelled" });
      await verifyPayment(k.deps(), s.merchantTransactionId);
    }
    expect((await k.payment(s.paymentId)).status).toBe(how);
    return s;
  }

  it.each(["expired", "failed", "cancelled"] as const)(
    "success after %s gives review and credits nothing",
    async (how) => {
      const s = await close(how);
      k.reset();
      settle(s, { status: "Success" });
      expect(await verifyPayment(k.deps(), s.merchantTransactionId)).toEqual(pending);
      expect((await k.payment(s.paymentId)).status).toBe("review");
      expect(await k.discrepancies(s.paymentId)).toHaveLength(1);
      expect(k.alerts.filter((a) => a.paymentId === s.paymentId)).toHaveLength(1);
      expect((await comeBack(k.deps(), "success", s)).state).toBe("pending");
      await expectCreditedExactly(s.customerId, 0n);
    },
  );
});

describe("fail closed: when EPS cannot be asked nothing changes", () => {
  async function expectUntouched(s: Started): Promise<void> {
    expect((await k.payment(s.paymentId)).status).toBe("redirected");
    expect(await k.discrepancies(s.paymentId)).toHaveLength(0);
    await expectCreditedExactly(s.customerId, 0n);
  }

  it("unavailable and a throwing gateway leave the row unchanged, and the next answer still credits once", async () => {
    for (const mode of ["unavailable", "throw"] as const) {
      const s = await startPayment(k);
      k.reset();
      settle(s, { status: "Success" });
      k.eps.failNext(mode);
      expect(await verifyPayment(k.deps(), s.merchantTransactionId)).toEqual({
        ok: false,
        error: "upstream_unavailable",
      });
      await expectUntouched(s);
      expect(await comeBack(k.deps(), "success", s)).toMatchObject({ state: "credited" });
      await expectCreditedExactly(s.customerId, AMOUNT);
    }
  });

  it("a hang is cut off by the 20 ms timeout of the HTTP client, over a scripted fetch", async () => {
    const s = await startPayment(k);
    k.reset();
    let verifyAttempts = 0;
    const fetchStub = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("/Auth/GetToken")) {
        return new Response(JSON.stringify({ token: "t", expireDate: "2099-01-01T00:00:00" }), {
          status: 200,
        });
      }
      verifyAttempts += 1;
      return new Promise<Response>(() => {}); // never answers
    }) as typeof fetch;
    const gateway = createEpsGateway(
      epsCredentials({
        mode: "sandbox",
        merchantId: "m-id",
        storeId: "s-id",
        username: "user-name",
        password: "pass-word",
        hashKey: "hash-key-value",
      }),
      { fetch: fetchStub, clock: k.clock, timeoutMs: 20 },
    );
    const deps = k.deps("web_rw", { gateway });
    expect(await verifyPayment(deps, s.merchantTransactionId)).toEqual({
      ok: false,
      error: "upstream_unavailable",
    });
    expect(verifyAttempts).toBeGreaterThanOrEqual(1);
    await expectUntouched(s);
  });

  it("an unreadable answer (HTML, not JSON) changes nothing", async () => {
    const s = await startPayment(k);
    const fetchStub = (async (input: unknown) => {
      if (String(input).includes("/Auth/GetToken")) {
        return new Response(JSON.stringify({ token: "t", expireDate: "2099-01-01T00:00:00" }), {
          status: 200,
        });
      }
      return new Response("<html>gateway error</html>", { status: 200 });
    }) as typeof fetch;
    const gateway = createEpsGateway(
      epsCredentials({
        mode: "sandbox",
        merchantId: "m-id",
        storeId: "s-id",
        username: "user-name",
        password: "pass-word",
        hashKey: "hash-key-value",
      }),
      { fetch: fetchStub, clock: k.clock, timeoutMs: 20 },
    );
    expect(await verifyPayment(k.deps("web_rw", { gateway }), s.merchantTransactionId)).toEqual(
      pending,
    );
    await expectUntouched(s);
  });
});

describe("idempotent start under the proof: the same key twice is one payment and one credit", () => {
  it("returns the first payment's id on the repeat, calls EPS once and credits once", async () => {
    const customerId = await k.newCustomer();
    k.reset();
    const deps = k.deps();
    const input = { amountMinor: AMOUNT, idempotencyKey: "proof-key-" + crypto.randomUUID() };
    const first = await startTopUp(deps, { customerId }, input, { clientIp: freshIp() });
    const second = await startTopUp(deps, { customerId }, input, { clientIp: freshIp() });
    if (!first.ok) throw new Error("first start failed: " + first.error);
    expect(second).toEqual({ ok: false, error: "conflict", ref: first.value.paymentId });
    expect(k.eps.initialized).toHaveLength(1);
    expect(
      await count("select count(*)::int as n from payments where customer_id = $1", [customerId]),
    ).toBe(1);

    const row = await k.payment(first.value.paymentId);
    k.eps.settle(row.merchantTransactionId, { status: "Success" });
    const s: Started = {
      customerId,
      paymentId: first.value.paymentId,
      merchantTransactionId: row.merchantTransactionId,
    };
    expect((await comeBack(deps, "success", s)).state).toBe("credited");
    expect((await comeBack(deps, "success", s)).state).toBe("credited");
    await expectCreditedExactly(customerId, AMOUNT);
  });
});
