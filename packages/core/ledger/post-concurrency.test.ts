import { describe, expect, it } from "vitest";
import { freshLedgerKit, inputs, useLedgerDatabase, type Wallet } from "../test/ledger-fixtures";
import { walletEntriesSum } from "./balance";
import { postTransaction } from "./post";
import type { PostTransactionInput } from "./types";

const L = useLedgerDatabase();
const post = (input: PostTransactionInput) => L.run((tx) => postTransaction(tx, input), "web_rw");

// The first request posts in a transaction that the kit keeps open until release(); `reached` resolves when it has posted.
const holdOpen = (input: PostTransactionInput) =>
  L.holdOpen((tx) => postTransaction(tx, input), "web_rw");

describe("two requests at once", () => {
  it("the pool of the test database has room for the eight connections of the last case", () => {
    // a smaller pool would make the cases below wait for a connection and fail late and unclearly
    expect(L.poolSize()).toBeGreaterThanOrEqual(10);
  });

  it("two debits that together exceed the balance: one is posted, one is refused, the balance never goes below 0", async () => {
    const w = await L.newWallet();
    await L.fund(w, 1000n);
    const first = holdOpen(inputs.spend(w.customerId, 700n));
    await first.reached;
    const second = post(inputs.spend(w.customerId, 700n));
    await L.waitForLockWaiter(); // the second request waits for the wallet row of the first
    first.release();
    const results = await Promise.all([first.result, second]);
    expect(results[0]).toMatchObject({ ok: true });
    expect(results[1]).toEqual({
      ok: false,
      error: "insufficient_balance",
      data: { shortfallMinor: 400n },
    });
    expect(await L.cache(w.customerId)).toEqual({ balance: 300n, version: 2 });
    expect(await L.run((tx) => walletEntriesSum(tx, w.customerId))).toBe(300n);
  }, 20_000);

  it("the same request twice: one posting, and the second gets the id of the first", async () => {
    const w = await L.newWallet();
    await L.fund(w, 1000n);
    const before = await L.counts();
    const buy = inputs.spend(w.customerId, 700n);
    const first = holdOpen(buy);
    await first.reached;
    const second = post(buy);
    await L.waitForLockWaiter();
    first.release();
    const [a, b] = await Promise.all([first.result, second]);
    expect(a).toMatchObject({ ok: true });
    expect(b).toEqual(a);
    expect(await L.counts()).toEqual({
      transactions: before.transactions + 1,
      entries: before.entries + 2,
    });
    expect((await L.cache(w.customerId)).balance).toBe(300n);
  }, 20_000);

  it("one key for two wallets: the second request is a conflict and writes nothing", async () => {
    const a = await L.newWallet();
    const b = await L.newWallet();
    await L.fund(a, 1000n);
    await L.fund(b, 1000n);
    const key = "order:" + crypto.randomUUID().replaceAll("-", "");
    const first = holdOpen(inputs.spend(a.customerId, 100n, key));
    await first.reached;
    const second = post(inputs.spend(b.customerId, 100n, key));
    await L.waitForLockWaiter(); // the second waits for the unique key of the first
    first.release();
    const [ra, rb] = await Promise.all([first.result, second]);
    expect(ra).toMatchObject({ ok: true });
    expect(rb).toEqual({ ok: false, error: "conflict" });
    expect(await L.cache(b.customerId)).toEqual({ balance: 1000n, version: 1 });
  }, 20_000);

  it("eight debits of 150 against 1000: six are posted, two are refused, 100 is left", async () => {
    const w: Wallet = await L.newWallet();
    await L.fund(w, 1000n);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => post(inputs.spend(w.customerId, 150n))),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(6);
    expect(results.filter((r) => !r.ok)).toEqual(
      Array.from({ length: 2 }, () =>
        expect.objectContaining({ ok: false, error: "insufficient_balance" }),
      ),
    );
    expect(await L.cache(w.customerId)).toEqual({ balance: 100n, version: 7 });
    expect(await L.run((tx) => walletEntriesSum(tx, w.customerId))).toBe(100n);
  }, 30_000);
});

describe("a request interrupted half-way", () => {
  it("an error after the lines were written leaves nothing, and the key can be used again", async () => {
    const w = await L.newWallet();
    await L.fund(w, 1000n);
    const before = { counts: await L.counts(), cache: await L.cache(w.customerId) };
    const buy = inputs.spend(w.customerId, 400n);
    await expect(
      L.run(async (tx) => {
        await postTransaction(tx, buy);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect({ counts: await L.counts(), cache: await L.cache(w.customerId) }).toEqual(before);
    expect(await post(buy)).toMatchObject({ ok: true });
    expect((await L.cache(w.customerId)).balance).toBe(600n);
  });

  it("a connection killed after the lines were written leaves nothing", async () => {
    const K = await freshLedgerKit();
    try {
      const w = await K.newWallet();
      await K.fund(w, 1000n);
      const before = { counts: await K.counts(), cache: await K.cache(w.customerId) };
      const error = await K.run(async (tx) => {
        await postTransaction(tx, inputs.spend(w.customerId, 400n));
        const victim = await K.pool.query(
          `select pid from pg_stat_activity
            where datname = current_database() and state = 'idle in transaction' and pid <> pg_backend_pid()`,
        );
        await K.pool.query("select pg_terminate_backend($1)", [victim.rows[0]!.pid]);
        return "returned";
      }).catch((e: unknown) => e);
      expect(error).toMatchObject({ name: "DbError", code: "unknown" });
      expect({ counts: await K.counts(), cache: await K.cache(w.customerId) }).toEqual(before);
    } finally {
      await K.drop();
    }
  }, 30_000);
});
