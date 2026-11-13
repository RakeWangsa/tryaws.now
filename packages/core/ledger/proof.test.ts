import { describe, expect, it } from "vitest";
import { quote } from "../pricing/quote";
import { accountFor } from "../pricing/validate";
import { inputs, transactionIdOf, useLedgerDatabase, type Wallet } from "../test/ledger-fixtures";
import { snapshotOfAmount } from "../test/ledger-requests";
import { walletBalance, walletEntriesSum } from "./balance";
import { checkLedger } from "./check";
import { postTransaction } from "./post";
import { reverseTransaction } from "./reverse";
import type { PostTransactionInput, Posting } from "./types";

// The proof of WP3-T1: "Balance equals the sum of entries; a wallet cannot go negative".
const L = useLedgerDatabase();
const balance = (w: Wallet) => L.run((tx) => walletBalance(tx, w.customerId));
const entries = (w: Wallet) => L.run((tx) => walletEntriesSum(tx, w.customerId));
const post = (input: PostTransactionInput) => L.run((tx) => postTransaction(tx, input));

// Section 8, launch rule for market BD.
const RULE = {
  version: "launch-1",
  steps: (["korea_vat:0.10", "bd_vat:0.05", "processing_fee:0.02", "markup:0"] as const).map(
    (s) => ({
      code: s.split(":")[0]!,
      rate: s.split(":")[1]!,
      base: "aws" as const,
      label: { bn: "x", en: "x" },
    }),
  ),
};
const VECTORS: [string, bigint][] = [
  ["5", 74295n],
  ["7", 104013n],
  ["12", 178308n],
  ["24", 356616n],
  ["44", 653796n],
  ["84", 1248156n],
  ["9.50", 141161n],
  ["15", 222885n],
  ["10", 148590n],
  ["18", 267462n],
  ["1", 14859n],
  ["2.50", 37148n],
  ["0.50", 7430n],
  ["3.50", 52007n],
];
/** The purchase that spec 9.1 describes for a quote: the total from the wallet, one line per step above 0. */
function purchaseOf(customerId: string, awsPriceUsd: string, rule = RULE): PostTransactionInput {
  const q = quote({ awsPriceUsd, fxRate: "127", rule });
  const credits: Posting[] = [
    { account: { type: "revenue_aws_base" }, direction: "credit", amountMinor: q.baseMinor },
    ...q.steps
      .filter((s) => s.amountMinor > 0n)
      .map((s): Posting => ({
        account: { type: accountFor(s.code)! },
        direction: "credit",
        amountMinor: s.amountMinor,
      })),
  ];
  return {
    ...inputs.spend(customerId, 1n),
    // WPU-Y2: the snapshot of the sale; its total is the wallet debit of the quote
    priceSnapshot: snapshotOfAmount("purchase", q.totalMinor),
    postings: [
      {
        account: { type: "customer_wallet", customerId },
        direction: "debit",
        amountMinor: q.totalMinor,
      },
      ...credits,
    ],
  };
}

describe("balance equals the sum of the entries", () => {
  it("for each of the 14 price vectors of section 8, posted as a purchase from the pricing engine", async () => {
    const w = await L.newWallet();
    await L.fund(w, 5_000_000n);
    let spent = 0n;
    for (const [usd, total] of VECTORS) {
      expect(await post(purchaseOf(w.customerId, usd)), usd).toMatchObject({ ok: true });
      spent += total;
      expect(await balance(w)).toBe(5_000_000n - spent);
      expect(await entries(w)).toBe(5_000_000n - spent);
    }
    expect((await L.run((tx) => checkLedger(tx))).ok).toBe(true);
  });

  it("a purchase with a markup posts one markup_income line next to the base and the three other steps (spec 9.1)", async () => {
    const rule = {
      ...RULE,
      version: "markup-1",
      steps: RULE.steps.map((s) => (s.code === "markup" ? { ...s, rate: "0.03" } : s)),
    };
    const q = quote({ awsPriceUsd: "5", fxRate: "127", rule });
    const markup = q.steps.find((s) => s.code === "markup")!.amountMinor;
    expect(markup > 0n).toBe(true);
    const w = await L.newWallet();
    await L.fund(w, 1_000_000n);
    const id = transactionIdOf(await post(purchaseOf(w.customerId, "5", rule)));
    const lines = await L.pool.query(
      `select a.type, e.direction, e.amount_minor::text as amount from ledger_entries e
         join ledger_accounts a on a.id = e.account_id where e.transaction_id = $1 order by a.type`,
      [id],
    );
    expect(lines.rows).toHaveLength(6); // the wallet, the base, and one line for each of the four steps above 0
    expect(lines.rows.find((r) => r.type === "markup_income")).toEqual({
      type: "markup_income",
      direction: "credit",
      amount: markup.toString(),
    });
    expect(await balance(w)).toBe(1_000_000n - q.totalMinor);
    expect(await entries(w)).toBe(1_000_000n - q.totalMinor);
  });

  it("after five fixed steps and 295 seeded random operations on three wallets, against a model kept by the test", async () => {
    // mulberry32: a fixed 32-bit generator, so that a failure repeats. (A linear congruential generator in doubles
    // loses its low bits above 2^53 and then `% 6` only gives 0, 2 and 4: the replay branch never ran.)
    let seed = 20261111;
    const next = (n: number) => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) % n;
    };
    const counts = { topups: 0, spends: 0, refused: 0, reversals: 0, replays: 0 };
    // The first five steps are fixed, so every branch runs whatever the generator does: [wallet, operation, amount].
    // Operation 0 or 1 is a top-up, 2 or 3 a spend, 4 a reversal, 5 a replay.
    const PREFIX: [number, number, bigint?][] = [
      [0, 0, 100_000n], // top-up of 100000
      [0, 2, 40_000n], // a spend that is posted (balance 60000 after it)
      [0, 2, 100_000n], // a spend that is refused (more than 60000)
      [0, 4], // reverses the open spend
      [0, 5], // replays a posting
    ];
    const wallets = [await L.newWallet(), await L.newWallet(), await L.newWallet()];
    const model = new Map(wallets.map((w) => [w.customerId, 0n]));
    const bought: { w: Wallet; id: string; total: bigint; reversed: boolean }[] = [];
    const replayable: { w: Wallet; input: PostTransactionInput; id: string }[] = [];
    for (let i = 0; i < 300; i++) {
      const step: [number, number, bigint?] = i < PREFIX.length ? PREFIX[i]! : [next(3), next(6)];
      const w = wallets[step[0]]!;
      const op = step[1];
      const before = await balance(w);
      if (op <= 1) {
        const input = inputs.topup(w.customerId, step[2] ?? BigInt(1 + next(200000)));
        const id = transactionIdOf(await post(input));
        counts.topups++;
        model.set(w.customerId, model.get(w.customerId)! + input.postings[0]!.amountMinor);
        replayable.push({ w, input, id });
      } else if (op <= 3) {
        const total = step[2] ?? BigInt(1 + next(120000));
        const input = inputs.spend(w.customerId, total);
        const r = await post(input);
        expect(r.ok, `balance ${before}, price ${total}`).toBe(before >= total); // it is posted exactly when the money is there
        if (r.ok) {
          counts.spends++;
          model.set(w.customerId, model.get(w.customerId)! - total);
          bought.push({ w, id: r.value.transactionId, total, reversed: false });
          replayable.push({ w, input, id: r.value.transactionId });
        } else {
          counts.refused++;
          expect(r).toMatchObject({ error: "insufficient_balance" });
        }
      } else if (op === 4) {
        const open = bought.filter((b) => !b.reversed);
        const b = open[next(Math.max(open.length, 1))];
        if (b) {
          expect(
            await L.run((tx) =>
              reverseTransaction(tx, { transactionId: b.id, actor: { type: "system" } }),
            ),
          ).toMatchObject({
            ok: true,
          });
          b.reversed = true;
          counts.reversals++;
          model.set(b.w.customerId, model.get(b.w.customerId)! + b.total);
        }
      } else {
        const r = replayable[next(Math.max(replayable.length, 1))];
        if (r) {
          counts.replays++;
          expect(transactionIdOf(await post(r.input))).toBe(r.id); // a replay: the same id, nothing new
        }
      }
      expect(await balance(w)).toBeGreaterThanOrEqual(0n); // never below 0
      expect(await balance(w)).toBe(await entries(w)); // the cache is the sum, at every step
    }
    // the fixed prefix makes every branch run; this stays as a check that the branches really ran
    for (const [name, n] of Object.entries(counts))
      expect(n, `the branch ${name} never ran`).toBeGreaterThanOrEqual(1);
    for (const w of wallets) {
      expect(await balance(w)).toBe(model.get(w.customerId));
      expect(await entries(w)).toBe(model.get(w.customerId));
    }
    expect(await L.run((tx) => checkLedger(tx))).toMatchObject({
      ok: true,
      findingCount: 0,
      wallets: expect.any(Number),
    });
  }, 120_000);
});

describe("a wallet cannot go negative", () => {
  it("an overdraft is refused with the shortfall, whatever the amount", async () => {
    const w = await L.newWallet();
    await L.fund(w, 100n);
    for (const price of [101n, 5_000n, 9223372036854775807n]) {
      expect(await post(inputs.spend(w.customerId, price))).toEqual({
        ok: false,
        error: "insufficient_balance",
        data: { shortfallMinor: price - 100n },
      });
    }
    expect(await balance(w)).toBe(100n);
  });
  // The CHECK wallets_balance_minor_check is tested in WP1-T1 (packages/db/test); a raw UPDATE here would test no code of this work package.
});
