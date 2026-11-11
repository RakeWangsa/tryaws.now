import { v7 as uuidv7 } from "uuid";
import { expect, it } from "vitest";
import type { CustomerRepos } from "../repositories/customer/index";
import type { NewPayment } from "../repositories/customer/payments";
import { waitForLockWait } from "../testing/lock-wait";
import { withCustomerRepos } from "../testing/repos";
import { newCustomer, newLedgerAccount, postLedger, systemAccount } from "./fixtures";
import { inTransaction, insertRow } from "./sql";
import { useTempDatabase } from "./temp-db";

const t = useTempDatabase();
const as = <T>(c: string, fn: (r: CustomerRepos) => Promise<T>) => withCustomerRepos(t.db, c, fn);

let counter = 0;
const input = (over: Partial<NewPayment> = {}): NewPayment => ({
  id: uuidv7(),
  merchantTransactionId: `MTX-${process.pid}-${++counter}-${uuidv7()}`,
  idempotencyKey: uuidv7(),
  amountMinor: 15_000n,
  currency: "BDT",
  gateway: "eps",
  ...over,
});
const stored = async (id: string) =>
  (
    await t.pool.query(
      "select status, gateway_transaction_id, idempotency_key, amount_minor::text as amount from payments where id = $1",
      [id],
    )
  ).rows[0];
const count = async (customerId: string) =>
  Number(
    (await t.pool.query("select count(*) as n from payments where customer_id = $1", [customerId]))
      .rows[0].n,
  );

// A payment of the customer in the state `credited`: a balanced ledger transaction and the link.
async function creditedPayment(customerId: string): Promise<string> {
  const clearing = await systemAccount(t.pool, "gateway_clearing");
  const wallet = await newLedgerAccount(t.pool, "customer_wallet", customerId);
  const ledger = await inTransaction(t.pool, (c) =>
    postLedger(c, "test-" + uuidv7(), [
      [clearing, "debit", 100],
      [wallet, "credit", 100],
    ]),
  );
  return insertRow(t.pool, "payments", {
    customer_id: customerId,
    gateway: "eps",
    merchant_transaction_id: "MTX-" + uuidv7(),
    idempotency_key: uuidv7(),
    amount_minor: 100,
    currency: "BDT",
    status: "credited",
    ledger_transaction_id: ledger,
  });
}

it("insert creates an initiated payment and stores exactly what it was given", async () => {
  const c = await newCustomer(t.pool);
  const p = input();
  const result = await as(c, (r) => r.payments.insert(p));
  expect(result).toEqual({
    ok: true,
    replayed: false,
    value: {
      id: p.id,
      customerId: c,
      gateway: "eps",
      merchantTransactionId: p.merchantTransactionId,
      amountMinor: 15_000n,
      currency: "BDT",
      status: "initiated",
      gatewayTransactionId: null,
      verifiedAt: null,
      ledgerTransactionId: null,
      createdAt: expect.any(Date),
    },
  });
  expect(await stored(p.id)).toEqual({
    status: "initiated",
    gateway_transaction_id: null,
    idempotency_key: p.idempotencyKey,
    amount: "15000",
  });
});

it("insert reads an amount beyond 2^53 back without a loss (R4)", async () => {
  const c = await newCustomer(t.pool);
  const big = 9_007_199_254_740_993n;
  const result = await as(c, (r) => r.payments.insert(input({ amountMinor: big })));
  expect(result.ok && result.value.amountMinor).toBe(big);
});

it("the same key with the same amount is a replay of the stored row; another amount or currency is a conflict", async () => {
  const c = await newCustomer(t.pool);
  const p = input();
  const first = await as(c, (r) => r.payments.insert(p));
  const again = await as(c, (r) =>
    r.payments.insert({ ...p, id: uuidv7(), merchantTransactionId: "MTX-" + uuidv7() }),
  );
  expect(again).toEqual({ ok: true, replayed: true, value: first.ok ? first.value : null });
  expect(
    await as(c, (r) =>
      r.payments.insert({
        ...p,
        id: uuidv7(),
        merchantTransactionId: "MTX-" + uuidv7(),
        amountMinor: 15_001n,
      }),
    ),
  ).toEqual({ ok: false, error: "conflict" });
  expect(
    await as(c, (r) =>
      r.payments.insert({
        ...p,
        id: uuidv7(),
        merchantTransactionId: "MTX-" + uuidv7(),
        currency: "USD",
      }),
    ),
  ).toEqual({ ok: false, error: "conflict" });
  expect(await count(c)).toBe(1);
});

it("the same key for another customer is a new payment", async () => {
  const a = await newCustomer(t.pool);
  const b = await newCustomer(t.pool);
  const key = uuidv7();
  const first = await as(a, (r) => r.payments.insert(input({ idempotencyKey: key })));
  const second = await as(b, (r) => r.payments.insert(input({ idempotencyKey: key })));
  expect(first).toMatchObject({ ok: true, replayed: false });
  expect(second).toMatchObject({ ok: true, replayed: false });
});

it("two connections inserting the same key at the same moment give one row and one created", async () => {
  const c = await newCustomer(t.pool);
  const key = uuidv7();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let done!: () => void;
  const firstInserted = new Promise<void>((resolve) => (done = resolve));
  const first = as(c, async (r) => {
    const w = await r.payments.insert(input({ idempotencyKey: key }));
    done();
    await gate; // the first transaction keeps the unique index entry uncommitted
    return w;
  });
  await firstInserted;
  const second = as(c, (r) => r.payments.insert(input({ idempotencyKey: key })));
  await waitForLockWait(t.pool, t.name); // throws when the second insert never blocks
  release();
  const results = [await first, await second];
  expect(results.filter((w) => w.ok && !w.replayed)).toHaveLength(1);
  expect(results.filter((w) => w.ok && w.replayed)).toHaveLength(1);
  expect(await count(c)).toBe(1);
  const [a, b] = results;
  expect(a?.ok && b?.ok && a.value.id === b.value.id).toBe(true);
});

it.each([
  ["an id that is no UUID", { id: "not-a-uuid" }],
  ["a merchant transaction id of 9 characters", { merchantTransactionId: "123456789" }],
  ["a merchant transaction id with a space", { merchantTransactionId: "MTX 1234567890" }],
  ["an empty idempotency key", { idempotencyKey: "" }],
  ["an idempotency key of 129 characters", { idempotencyKey: "k".repeat(129) }],
  ["an amount of 0", { amountMinor: 0n }],
  ["a negative amount", { amountMinor: -1n }],
  ["an amount past the int8 range", { amountMinor: 9_223_372_036_854_775_808n }],
  ["an amount that is a number", { amountMinor: 100 as unknown as bigint }],
  ["a lowercase currency", { currency: "bdt" }],
  ["another gateway", { gateway: "bkash" as "eps" }],
])("insert refuses %s as validation and writes nothing", async (_, over) => {
  const c = await newCustomer(t.pool);
  expect(await as(c, (r) => r.payments.insert(input(over)))).toEqual({
    ok: false,
    error: "validation",
  });
  expect(await count(c)).toBe(0);
});

it("get returns a payment of the customer; the payment of another customer, a missing id and a non-UUID are null", async () => {
  const a = await newCustomer(t.pool);
  const b = await newCustomer(t.pool);
  const p = input();
  await as(a, (r) => r.payments.insert(p));
  expect(await as(a, (r) => r.payments.get(p.id))).toMatchObject({ id: p.id, customerId: a });
  expect(await as(b, (r) => r.payments.get(p.id))).toBeNull();
  expect(await as(a, (r) => r.payments.get(uuidv7()))).toBeNull();
  expect(await as(a, (r) => r.payments.get("x"))).toBeNull();
});

it("list returns the payments of the customer only, newest first, and honours the limit", async () => {
  const a = await newCustomer(t.pool);
  const b = await newCustomer(t.pool);
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const p = input();
    ids.push(p.id);
    await as(a, (r) => r.payments.insert(p));
    await t.pool.query("select pg_sleep(0.01)");
  }
  await as(b, (r) => r.payments.insert(input()));
  const listed = await as(a, (r) => r.payments.list(100));
  expect(listed.map((p) => p.id)).toEqual([...ids].reverse());
  expect(listed.every((p) => p.customerId === a)).toBe(true);
  expect((await as(a, (r) => r.payments.list(2))).map((p) => p.id)).toEqual([ids[2], ids[1]]);
  for (const bad of [0, 101, 1.5, Number.NaN]) {
    await expect(as(a, (r) => r.payments.list(bad))).rejects.toThrow(TypeError);
  }
});

it("markRedirected moves initiated to redirected once, with the gateway id", async () => {
  const c = await newCustomer(t.pool);
  const p = input();
  await as(c, (r) => r.payments.insert(p));
  expect(await as(c, (r) => r.payments.markRedirected(p.id, "EPS-GW-1"))).toBe(true);
  expect(await stored(p.id)).toMatchObject({
    status: "redirected",
    gateway_transaction_id: "EPS-GW-1",
  });
  expect(await as(c, (r) => r.payments.markRedirected(p.id, "EPS-GW-2"))).toBe(false);
  expect(await stored(p.id)).toMatchObject({ gateway_transaction_id: "EPS-GW-1" });
});

it("markRedirected accepts no gateway id, and refuses an unusable one", async () => {
  const c = await newCustomer(t.pool);
  const p = input();
  await as(c, (r) => r.payments.insert(p));
  await expect(as(c, (r) => r.payments.markRedirected(p.id, ""))).rejects.toThrow(TypeError);
  expect(await as(c, (r) => r.payments.markRedirected(p.id, null))).toBe(true);
  expect(await stored(p.id)).toMatchObject({ status: "redirected", gateway_transaction_id: null });
});

it("markRedirected and markFailed return false after the payment was credited, and leave it as it was", async () => {
  const c = await newCustomer(t.pool);
  const id = await creditedPayment(c);
  expect(await as(c, (r) => r.payments.markRedirected(id, "EPS-GW-1"))).toBe(false);
  expect(await as(c, (r) => r.payments.markFailed(id))).toBe(false);
  expect(await stored(id)).toMatchObject({ status: "credited", gateway_transaction_id: null });
});

it("markFailed moves initiated to failed; a redirected or failed payment answers false", async () => {
  const c = await newCustomer(t.pool);
  const a = input();
  const b = input();
  await as(c, (r) => r.payments.insert(a));
  await as(c, (r) => r.payments.insert(b));
  expect(await as(c, (r) => r.payments.markFailed(a.id))).toBe(true);
  expect(await as(c, (r) => r.payments.markFailed(a.id))).toBe(false);
  await as(c, (r) => r.payments.markRedirected(b.id, null));
  expect(await as(c, (r) => r.payments.markFailed(b.id))).toBe(false);
  expect((await stored(a.id)).status).toBe("failed");
  expect((await stored(b.id)).status).toBe("redirected");
});

it("markRedirected and markFailed of another customer's payment change nothing; a non-UUID is false", async () => {
  const a = await newCustomer(t.pool);
  const b = await newCustomer(t.pool);
  const p = input();
  await as(a, (r) => r.payments.insert(p));
  expect(await as(b, (r) => r.payments.markRedirected(p.id, "EPS-GW-1"))).toBe(false);
  expect(await as(b, (r) => r.payments.markFailed(p.id))).toBe(false);
  expect(await as(a, (r) => r.payments.markFailed("x"))).toBe(false);
  expect(await stored(p.id)).toMatchObject({ status: "initiated", gateway_transaction_id: null });
});
