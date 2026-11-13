import { describe, expect, it } from "vitest";
import { inputs, transactionIdOf, useLedgerDatabase, type Wallet } from "../test/ledger-fixtures";
import { snapshotOfAmount } from "../test/ledger-requests";
import { walletBalance, walletEntriesSum } from "./balance";
import { LedgerError } from "./errors";
import { postTransaction, writePosting } from "./post";
import { checkPosting } from "./rules";
import type { PostTransactionInput } from "./types";

const L = useLedgerDatabase();
const post = (input: unknown, role?: "web_rw" | "admin_rw" | "worker_rw") =>
  L.run((tx) => postTransaction(tx, input as PostTransactionInput), role);
const state = async (w: Wallet) => ({
  counts: await L.counts(),
  cache: await L.cache(w.customerId),
});

describe("a ledger that balances", () => {
  it("posts the top-up and the purchase of section 8; balance, cache and entries agree", async () => {
    const w = await L.newWallet();
    await L.fund(w, 150000n);
    const bought = transactionIdOf(await post(inputs.purchase(w.customerId)));
    expect(await L.run((tx) => walletBalance(tx, w.customerId))).toBe(75705n);
    expect(await L.run((tx) => walletEntriesSum(tx, w.customerId))).toBe(75705n);
    expect(await L.cache(w.customerId)).toEqual({ balance: 75705n, version: 2 });
    const lines = await L.pool.query(
      "select direction, amount_minor::text as amount from ledger_entries where transaction_id = $1 order by amount_minor desc",
      [bought],
    );
    expect(lines.rows).toEqual([
      { direction: "debit", amount: "74295" },
      { direction: "credit", amount: "63500" },
      { direction: "credit", amount: "6350" },
      { direction: "credit", amount: "3175" },
      { direction: "credit", amount: "1270" },
    ]);
  });

  it("spends exactly the balance, down to 0, and never below", async () => {
    const w = await L.newWallet();
    await L.fund(w, 100000n);
    expect(await post(inputs.spend(w.customerId, 100001n))).toEqual({
      ok: false,
      error: "insufficient_balance",
      data: { shortfallMinor: 1n },
    });
    expect(await post(inputs.spend(w.customerId, 100000n))).toMatchObject({ ok: true });
    expect((await L.cache(w.customerId)).balance).toBe(0n);
    expect(await post(inputs.spend(w.customerId, 1n))).toMatchObject({
      ok: false,
      error: "insufficient_balance",
      data: { shortfallMinor: 1n },
    });
  });
});

describe("the same key", () => {
  it("a replay returns the first result and writes nothing", async () => {
    const w = await L.newWallet();
    const top = inputs.topup(w.customerId, 5000n);
    const first = transactionIdOf(await post(top));
    const before = await state(w);
    expect(transactionIdOf(await post(top))).toBe(first);
    expect(await state(w)).toEqual(before);
  });

  it("a replay still succeeds when the balance would no longer allow the purchase", async () => {
    const w = await L.newWallet();
    await L.fund(w, 1000n);
    const buy = inputs.spend(w.customerId, 1000n);
    const first = transactionIdOf(await post(buy));
    expect(transactionIdOf(await post(buy))).toBe(first);
    expect((await L.cache(w.customerId)).balance).toBe(0n);
  });

  it.each([
    [
      "another amount",
      (i: PostTransactionInput) => ({
        ...i,
        // WPU-Y2: a sale carries a snapshot whose total is the wallet debit, so the other amount carries its own
        priceSnapshot: snapshotOfAmount("purchase", 99n),
        postings: i.postings.map((p) => ({ ...p, amountMinor: 99n })),
      }),
    ],
    [
      "another reference",
      (i: PostTransactionInput) => ({
        ...i,
        reference: { ...i.reference, id: crypto.randomUUID() },
      }),
    ],
    // another kind under one key cannot reach the store: the key families are bound to the kinds (Task 3; kinds.test.ts has the rows)
  ])("with %s it is a conflict, and nothing changes", async (_name, change) => {
    const w = await L.newWallet();
    await L.fund(w, 1000n);
    const buy = inputs.spend(w.customerId, 100n);
    await post(buy);
    const before = await state(w);
    expect(await post(change(buy))).toEqual({ ok: false, error: "conflict" });
    expect(await state(w)).toEqual(before);
  });

  it("another customer's wallet under the same key is a conflict", async () => {
    const a = await L.newWallet();
    const b = await L.newWallet();
    const paymentId = crypto.randomUUID();
    await post(inputs.topup(a.customerId, 700n, paymentId));
    const before = await state(b);
    expect(await post(inputs.topup(b.customerId, 700n, paymentId))).toEqual({
      ok: false,
      error: "conflict",
    });
    expect(await state(b)).toEqual(before);
  });

  it("a key of another family is refused, so it cannot use up the key of the later top-up or reversal", async () => {
    const w = await L.newWallet();
    await L.fund(w, 1000n);
    const paymentId = crypto.randomUUID();
    const before = await state(w);
    const underTopupKey = {
      ...inputs.spend(w.customerId, 10n),
      idempotencyKey: `topup:${paymentId}`,
    };
    expect(await post(underTopupKey)).toMatchObject({
      ok: false,
      error: "validation",
      fields: { idempotencyKey: expect.any(String) },
    });
    expect(await state(w)).toEqual(before);
    expect(await post(inputs.topup(w.customerId, 700n, paymentId))).toMatchObject({ ok: true }); // the real top-up still posts
    const bought = transactionIdOf(await post(inputs.spend(w.customerId, 10n)));
    const underReversalKey = {
      ...inputs.spend(w.customerId, 10n),
      idempotencyKey: `reversal:${bought}`,
    };
    expect(await post(underReversalKey)).toMatchObject({ ok: false, error: "validation" });
  });
});

describe("a refusal writes nothing", () => {
  async function refused(w: Wallet, input: unknown, expected: object) {
    const before = await state(w);
    expect(await post(input)).toMatchObject(expected);
    expect(await state(w)).toEqual(before);
  }
  it.each([
    ["an amount of 0", 0n],
    ["a negative amount", -5n],
    ["an amount above the bigint range", 2n ** 63n],
    ["an amount as a string", "9223372036854775808"],
    ["an amount as a number", 5],
  ])("%s", async (_name, amount) => {
    const w = await L.newWallet();
    await L.fund(w, 1000n);
    const input = inputs.spend(w.customerId, 10n);
    await refused(
      w,
      { ...input, postings: input.postings.map((p) => ({ ...p, amountMinor: amount })) },
      { ok: false, error: "validation" },
    );
  });
  it("lines in two currencies", async () => {
    const w = await L.newWallet();
    const input = inputs.spend(w.customerId, 10n);
    await refused(
      w,
      {
        ...input,
        postings: [
          input.postings[0],
          { ...input.postings[1], account: { type: "revenue_aws_base", currency: "USD" } },
        ],
      },
      { ok: false, error: "validation" },
    );
  });
  it("a customer on the wallet of another customer", async () => {
    const a = await L.newWallet();
    const b = await L.newWallet();
    await L.fund(b, 1000n);
    await refused(
      b,
      { ...inputs.spend(b.customerId, 10n), actor: { type: "customer", id: a.customerId } },
      { ok: false, error: "forbidden" },
    );
  });
  it("a customer who tries to top up", async () => {
    const w = await L.newWallet();
    await refused(
      w,
      { ...inputs.topup(w.customerId, 10n), actor: { type: "customer", id: w.customerId } },
      { ok: false, error: "forbidden" },
    );
  });
  it("a customer with no wallet", async () => {
    const w = await L.newWallet();
    const stranger = crypto.randomUUID();
    await refused(w, inputs.topup(stranger, 10n), { ok: false, error: "not_found" });
  });
  it("a wallet in another currency than the lines", async () => {
    const usd = await L.newWallet({ currency: "USD" });
    await refused(usd, inputs.topup(usd.customerId, 10n), { ok: false, error: "conflict" });
  });
  it("a currency without platform accounts", async () => {
    const usd = await L.newWallet({ currency: "USD" });
    const top = inputs.topup(usd.customerId, 10n);
    const usdTop = {
      ...top,
      postings: top.postings.map((p) => ({ ...p, account: { ...p.account, currency: "USD" } })),
    };
    await refused(usd, usdTop, { ok: false, error: "internal" });
  });
});

describe("the end of the range", () => {
  it("a credit that would pass the bigint range aborts the transaction and leaves nothing", async () => {
    const w = await L.newWallet();
    await L.pool.query(
      "update wallets set balance_minor = 9223372036854775800 where customer_id = $1",
      [w.customerId],
    );
    const before = await state(w);
    await expect(post(inputs.topup(w.customerId, 100n))).rejects.toThrow(LedgerError);
    await expect(post(inputs.topup(w.customerId, 100n))).rejects.toMatchObject({
      code: "invariant",
    });
    expect(await state(w)).toEqual(before);
  });
});

describe.each(["web_rw", "admin_rw", "worker_rw"] as const)("as %s (migration 0006)", (role) => {
  it("posts, replays and refuses with the grants of the role", async () => {
    const w = await L.newWallet();
    const top = inputs.topup(w.customerId, 20000n);
    const id = transactionIdOf(await post(top, role));
    expect(transactionIdOf(await post(top, role))).toBe(id);
    expect(await post(inputs.spend(w.customerId, 20001n), role)).toMatchObject({
      ok: false,
      error: "insufficient_balance",
    });
    expect(await post(inputs.spend(w.customerId, 20000n), role)).toMatchObject({ ok: true });
    expect(await L.cache(w.customerId)).toEqual({ balance: 0n, version: 2 });
    expect(await L.run((tx) => walletEntriesSum(tx, w.customerId), role)).toBe(0n);
  });
});

describe("one ledger transaction for one reference (M1)", () => {
  it("a second purchase of the same order under another key is a conflict, and nothing changes", async () => {
    const w = await L.newWallet();
    await L.fund(w, 1000n);
    const first = inputs.spend(w.customerId, 100n);
    const firstId = transactionIdOf(await post(first));
    const before = await state(w);
    const again = { ...first, idempotencyKey: `order:${crypto.randomUUID().replaceAll("-", "")}` };
    expect(await post(again)).toEqual({ ok: false, error: "conflict" });
    expect(await state(w)).toEqual(before);
    // the same key still replays the first answer
    expect(transactionIdOf(await post(first))).toBe(firstId);
    expect(await state(w)).toEqual(before);
  });

  it("a conflict does not depend on the wallet: the other customer's purchase of the same order is refused too", async () => {
    const a = await L.newWallet();
    const b = await L.newWallet();
    await L.fund(a, 1000n);
    await L.fund(b, 1000n);
    const first = inputs.spend(a.customerId, 100n);
    await post(first);
    const other = {
      ...inputs.spend(b.customerId, 100n),
      reference: first.reference,
    };
    expect(await post(other)).toEqual({ ok: false, error: "conflict" });
    expect((await L.cache(b.customerId)).balance).toBe(1000n);
  });

  it("a renewal of another period of the same subscription is another request, not a duplicate", async () => {
    const w = await L.newWallet();
    await L.fund(w, 1000n);
    const sub = crypto.randomUUID();
    const renew = (at: string): PostTransactionInput => ({
      ...inputs.spend(w.customerId, 100n),
      kind: "renewal",
      priceSnapshot: snapshotOfAmount("renewal", 100n),
      reference: { type: "subscription", id: sub },
      idempotencyKey: `renew:${sub}:${at}`,
    });
    const a = transactionIdOf(await post(renew("2026-12-01T00:00:00.000Z")));
    const b = transactionIdOf(await post(renew("2027-01-01T00:00:00.000Z")));
    expect(b).not.toBe(a);
    expect((await L.cache(w.customerId)).balance).toBe(800n);
  });

  it.each([
    ["an adjustment", "adjustments", "adjustment"],
    ["a refund", "refunds", "refund"],
  ] as const)(
    "%s of a reference that already has one is a conflict also under another key (writePosting called directly)",
    async (_name, platform, kind) => {
      const w = await L.newWallet();
      await L.fund(w, 1000n);
      const requestId = crypto.randomUUID();
      const input = {
        kind,
        reference: { type: kind === "adjustment" ? "wallet_adjustment" : "payment", id: requestId },
        idempotencyKey: `${kind}:${requestId}`,
        actor: { type: "system" },
        memo: "test",
        postings: [
          {
            account: { type: "customer_wallet", customerId: w.customerId },
            direction: "debit",
            amountMinor: 10n,
          },
          { account: { type: platform }, direction: "credit", amountMinor: 10n },
        ],
      } as PostTransactionInput;
      const checked = checkPosting(input);
      if (!checked.ok) throw new Error(JSON.stringify(checked.fields));
      expect(await L.run((tx) => writePosting(tx, checked.value))).toMatchObject({ ok: true });
      const before = await state(w);
      const elsewhere = { ...checked.value, idempotencyKey: `${kind}:${crypto.randomUUID()}` };
      expect(await L.run((tx) => writePosting(tx, elsewhere))).toEqual({
        ok: false,
        error: "conflict",
      });
      expect(await state(w)).toEqual(before);
    },
  );
});

describe("an invariant that fails after the lines were written (m1)", () => {
  it("a caller that swallows the error cannot commit the lines: the savepoint rolled them back", async () => {
    const w = await L.newWallet();
    // 100 paisa from the top of the range of the cache: the update of the cache is refused
    await L.fund(w, 9223372036854775800n);
    const before = await state(w);
    const thrown = await L.run(async (tx) => {
      try {
        await postTransaction(tx, inputs.topup(w.customerId, 100n));
        return null;
      } catch (error) {
        return error; // swallowed: the surrounding transaction goes on and commits
      }
    });
    expect(thrown).toBeInstanceOf(LedgerError);
    expect(await state(w)).toEqual(before);
    expect(await L.run((tx) => walletEntriesSum(tx, w.customerId))).toBe(9223372036854775800n);
  });
});
