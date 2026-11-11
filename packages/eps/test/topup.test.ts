import { describe, expect, it } from "vitest";
import type { EpsGateway, InitializeRequest } from "../gateway";
import { MERCHANT_TRANSACTION_ID } from "../ids";
import { startTopUp } from "../topup";
import { freshIp, PLANTED_SECRET, useEpsKit } from "./kit";

const k = useEpsKit();
const key = () => "key-" + crypto.randomUUID();
const start = async (
  customerId: string,
  over: { amountMinor?: bigint; idempotencyKey?: string; ip?: string } = {},
) =>
  startTopUp(
    k.deps(),
    { customerId },
    {
      amountMinor: over.amountMinor ?? 150000n,
      idempotencyKey: over.idempotencyKey ?? key(),
    },
    { clientIp: over.ip ?? freshIp() },
  );
const rowsOf = async (customerId: string) =>
  (await k.pool.query("select id from payments where customer_id = $1", [customerId])).rows;

describe("happy path", () => {
  it("stores the row, calls EPS once with the stored amount and returns the redirect", async () => {
    k.reset();
    const c = await k.newCustomer();
    const r = await start(c);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.redirectUrl).toBe("https://pg.eps.test/PG?data=1");
    const p = await k.payment(r.value.paymentId);
    expect(p).toMatchObject({ status: "redirected", amount: 150000n, customerId: c });
    expect(p.merchantTransactionId).toMatch(MERCHANT_TRANSACTION_ID);
    expect(p.gatewayTransactionId).toBe("eps-1");
    expect(k.eps.initialized).toHaveLength(1);
    expect(k.eps.initialized[0]).toMatchObject({
      merchantTransactionId: p.merchantTransactionId,
      totalAmountMinor: 150000n,
      successUrl: "https://example.test/pay/eps/success",
    });
  });

  it("writes the audit row payment.start without the URL", async () => {
    const c = await k.newCustomer();
    const r = await start(c);
    expect(r.ok).toBe(true);
    const a = await k.pool.query(
      "select action, target_id, metadata from audit_log where actor_id = $1",
      [c],
    );
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0].action).toBe("payment.start");
    expect(JSON.stringify(a.rows[0])).not.toContain("pg.eps.test");
  });

  it("stores the row before initialize is called", async () => {
    k.reset();
    const c = await k.newCustomer();
    let seen = -1;
    const spy: EpsGateway = {
      initialize: async (req: InitializeRequest) => {
        const r = await k.pool.query(
          "select count(*)::int as n from payments where merchant_transaction_id = $1 and status = 'initiated'",
          [req.merchantTransactionId],
        );
        seen = r.rows[0].n as number;
        return k.eps.initialize(req);
      },
      verify: (id) => k.eps.verify(id),
    };
    const r = await startTopUp(
      k.deps("web_rw", { gateway: spy }),
      { customerId: c },
      { amountMinor: 20000n, idempotencyKey: key() },
      { clientIp: freshIp() },
    );
    expect(r.ok).toBe(true);
    expect(seen).toBe(1);
  });
});

describe("idempotency (R7)", () => {
  it("a repeat with the same key makes no second EPS call and answers conflict with the payment id", async () => {
    k.reset();
    const c = await k.newCustomer();
    const idempotencyKey = key();
    const first = await start(c, { idempotencyKey });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const again = await start(c, { idempotencyKey });
    expect(again).toEqual({ ok: false, error: "conflict", ref: first.value.paymentId });
    expect(k.eps.initialized).toHaveLength(1);
    expect(await rowsOf(c)).toHaveLength(1);
  });

  it("the same key with another amount is a conflict without a payment id", async () => {
    k.reset();
    const c = await k.newCustomer();
    const idempotencyKey = key();
    await start(c, { idempotencyKey });
    const other = await start(c, { idempotencyKey, amountMinor: 160000n });
    expect(other).toMatchObject({ ok: false, error: "conflict" });
    expect(other.ok ? undefined : other.ref).toBeUndefined();
    expect(k.eps.initialized).toHaveLength(1);
  });

  it("two concurrent starts with the same key make one row and one EPS call", async () => {
    k.reset();
    const c = await k.newCustomer();
    const idempotencyKey = key();
    const ip = freshIp();
    const [a, b] = await Promise.all([
      start(c, { idempotencyKey, ip }),
      start(c, { idempotencyKey, ip }),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(await rowsOf(c)).toHaveLength(1);
    expect(k.eps.initialized).toHaveLength(1);
  });
});

describe("validation (R9)", () => {
  const fields = async (over: Parameters<typeof start>[1]) => {
    const c = await k.newCustomer();
    const r = await start(c, over);
    return { r, rows: await rowsOf(c) };
  };

  it.each([
    ["below the market minimum", 9999n],
    ["above the market maximum", 5_000_001n],
    ["zero", 0n],
    ["negative", -5n],
  ])("an amount %s is a validation error on amount and stores nothing", async (_n, amountMinor) => {
    k.reset();
    const { r, rows } = await fields({ amountMinor });
    expect(r).toEqual({ ok: false, error: "validation", fields: { amount: expect.any(String) } });
    expect(rows).toHaveLength(0);
    expect(k.eps.initialized).toHaveLength(0);
  });

  it("the market minimum and maximum themselves are accepted", async () => {
    const c = await k.newCustomer();
    expect((await start(c, { amountMinor: 10000n })).ok).toBe(true);
    expect((await start(c, { amountMinor: 5_000_000n })).ok).toBe(true);
  });

  it("a number or a fraction is not an amount", async () => {
    const c = await k.newCustomer();
    const bad = [150000, 1.5, "150000", null, undefined] as unknown[];
    for (const amountMinor of bad) {
      const r = await startTopUp(
        k.deps(),
        { customerId: c },
        { amountMinor: amountMinor as bigint, idempotencyKey: key() },
        { clientIp: freshIp() },
      );
      expect(r).toMatchObject({ ok: false, error: "validation" });
    }
    expect(await rowsOf(c)).toHaveLength(0);
  });

  it.each([
    ["a newline", "abcdefgh\n"],
    ["too short", "abc"],
    ["too long", "a".repeat(129)],
    ["a space", "abcd efgh"],
    ["a quote", "abcdefg'h"],
  ])("an idempotency key with %s is refused", async (_n, idempotencyKey) => {
    const { r, rows } = await fields({ idempotencyKey });
    expect(r).toEqual({
      ok: false,
      error: "validation",
      fields: { idempotencyKey: expect.any(String) },
    });
    expect(rows).toHaveLength(0);
  });

  it("an address that is not an address is refused", async () => {
    const { r } = await fields({ ip: "999.1.1.1, 1.1.1.1" });
    expect(r).toMatchObject({ ok: false, error: "validation", fields: { clientIp: "invalid" } });
  });

  it("a session without a usable customer id is unauthenticated, with no query", async () => {
    const r = await startTopUp(
      k.deps(),
      { customerId: "not-a-uuid" },
      { amountMinor: 20000n, idempotencyKey: key() },
      { clientIp: freshIp() },
    );
    expect(r).toEqual({ ok: false, error: "unauthenticated" });
  });

  it("the customer id of the row is the session's even if the input carries another", async () => {
    const mine = await k.newCustomer();
    const other = await k.newCustomer();
    const r = await startTopUp(
      k.deps(),
      { customerId: mine },
      {
        amountMinor: 20000n,
        idempotencyKey: key(),
        customerId: other,
      } as unknown as Parameters<typeof startTopUp>[2],
      { clientIp: freshIp() },
    );
    expect(r.ok).toBe(true);
    expect(await rowsOf(mine)).toHaveLength(1);
    expect(await rowsOf(other)).toHaveLength(0);
  });

  it("the input type has no customerId (type test)", () => {
    type Input = Parameters<typeof startTopUp>[2];
    const noCustomerId: "customerId" extends keyof Input ? false : true = true;
    expect(noCustomerId).toBe(true);
  });
});

describe("rate limits", () => {
  it("the sixth start of a customer in ten minutes is rate_limited and stores no row", async () => {
    k.reset();
    const c = await k.newCustomer();
    for (let i = 0; i < 5; i++) expect((await start(c)).ok).toBe(true);
    const sixth = await start(c);
    expect(sixth).toMatchObject({ ok: false, error: "rate_limited" });
    expect(await rowsOf(c)).toHaveLength(5);
    expect(k.eps.initialized).toHaveLength(5);
  });

  it("the twenty-first start from one address is rate_limited across customers", async () => {
    k.reset();
    const ip = freshIp();
    for (let i = 0; i < 20; i++) {
      const c = await k.newCustomer();
      expect((await start(c, { ip })).ok).toBe(true);
    }
    const c = await k.newCustomer();
    expect(await start(c, { ip })).toMatchObject({ ok: false, error: "rate_limited" });
    expect(await rowsOf(c)).toHaveLength(0);
  });

  it("the limiter table holds a hash of the address, never the address (R14)", async () => {
    const ip = freshIp();
    const c = await k.newCustomer();
    await start(c, { ip });
    const r = await k.pool.query("select scope_key from rate_limits where scope_key like 'ip:%'");
    expect(JSON.stringify(r.rows)).not.toContain(ip);
  });
});

describe("EPS failure", () => {
  it("rejected: the row is failed and the result is upstream_unavailable", async () => {
    k.reset();
    const c = await k.newCustomer();
    const rejecting: EpsGateway = {
      initialize: async () => ({ ok: false, reason: "rejected" }),
      verify: (id) => k.eps.verify(id),
    };
    const r = await startTopUp(
      k.deps("web_rw", { gateway: rejecting }),
      { customerId: c },
      { amountMinor: 20000n, idempotencyKey: key() },
      { clientIp: freshIp() },
    );
    expect(r).toEqual({ ok: false, error: "upstream_unavailable" });
    const [row] = await rowsOf(c);
    expect((await k.payment(row.id)).status).toBe("failed");
  });

  it("unavailable: the row stays initiated for the sweeper", async () => {
    k.reset();
    const c = await k.newCustomer();
    k.eps.failNext("unavailable");
    const r = await start(c);
    expect(r).toEqual({ ok: false, error: "upstream_unavailable" });
    const [row] = await rowsOf(c);
    expect((await k.payment(row.id)).status).toBe("initiated");
  });

  it("a throwing gateway with a planted secret: no secret in the result or the log (R14)", async () => {
    k.reset();
    const c = await k.newCustomer();
    k.eps.failNext("throw");
    const r = await start(c);
    expect(r).toEqual({ ok: false, error: "upstream_unavailable" });
    expect(JSON.stringify(r)).not.toContain(PLANTED_SECRET);
    expect(JSON.stringify(k.logs)).not.toContain(PLANTED_SECRET);
    const [row] = await rowsOf(c);
    expect((await k.payment(row.id)).status).toBe("initiated");
  });

  it("logs carry only the allowed keys and never the redirect URL or the transaction id", async () => {
    k.reset();
    const c = await k.newCustomer();
    const r = await start(c);
    expect(r.ok).toBe(true);
    const text = JSON.stringify(k.logs);
    expect(text).not.toContain("pg.eps.test");
    expect(text).not.toMatch(/TCP[0-9a-f]{32}/);
    for (const l of k.logs) {
      for (const key of Object.keys(l.fields)) {
        expect(["paymentId", "state", "reason", "count", "ok"]).toContain(key);
      }
    }
  });
});
