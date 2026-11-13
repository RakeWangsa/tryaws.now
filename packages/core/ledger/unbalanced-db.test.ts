import { describe, expect, it } from "vitest";
import { insertLedgerEntries, insertLedgerTransaction } from "@tc/db";
import { inputs, transactionIdOf, useLedgerDatabase, type Wallet } from "../test/ledger-fixtures";
import { postTransaction, writePosting } from "./post";
import { reverseTransaction } from "./reverse";
import type { NormalizedLine, NormalizedPosting } from "./rules";
import type { PostTransactionInput } from "./types";

// R5 at the database. checkPosting (application code) refuses an unbalanced request before any query;
// these cases skip it on purpose: they hand writePosting, or the repository functions, a posting that
// checkPosting would never let through, and expect the DATABASE to refuse it (deferred balance trigger
// 23514 at COMMIT, check constraint on amount_minor 23514 at INSERT). A change that weakens only the
// application check is then caught by the cases that go through postTransaction, and a change that
// weakens only the database is caught by the cases that skip it.

const ROLES = ["web_rw", "worker_rw", "admin_rw"] as const;
type Role = (typeof ROLES)[number];
const L = useLedgerDatabase();

const line = (
  wallet: Wallet | null,
  type: "gateway_clearing" | "customer_wallet",
  direction: "debit" | "credit",
  amountMinor: bigint,
): NormalizedLine => ({
  account: {
    type,
    customerId: type === "customer_wallet" ? (wallet?.customerId ?? null) : null,
    currency: "BDT",
  },
  direction,
  amountMinor,
});

/** A top-up the way checkPosting would normalise it, but with lines of the test's choosing. */
function posting(
  wallet: Wallet,
  lines: readonly NormalizedLine[],
  delta: bigint,
): NormalizedPosting {
  const paymentId = crypto.randomUUID();
  return {
    kind: "topup",
    referenceType: "payment",
    referenceId: paymentId,
    idempotencyKey: `topup:${paymentId}`,
    actor: { type: "system", id: null },
    memo: null,
    priceSnapshot: null,
    currency: "BDT",
    lines,
    walletCustomerId: wallet.customerId,
    walletDelta: delta,
  };
}

const credit = (w: Wallet, n: bigint) => line(w, "customer_wallet", "credit", n);
const debit = (n: bigint) => line(null, "gateway_clearing", "debit", n);

/** Runs the write as `role` and asserts the database refused it and kept nothing. */
async function refused(role: Role, w: Wallet, p: NormalizedPosting, code = "23514") {
  const before = { counts: await L.counts(), cache: await L.cache(w.customerId) };
  await expect(L.run((tx) => writePosting(tx, p), role)).rejects.toMatchObject({
    name: "DbError",
    code,
  });
  expect(await L.counts()).toEqual(before.counts);
  expect(await L.cache(w.customerId)).toEqual(before.cache);
}

describe.each(ROLES)("as %s, the database refuses what does not balance", (role) => {
  it("a single-sided post (a credit and no debit)", async () => {
    const w = await L.newWallet();
    await refused(role, w, posting(w, [credit(w, 100n)], 100n));
  });

  it("a single-sided post (a debit and no credit)", async () => {
    const w = await L.newWallet();
    await refused(role, w, posting(w, [debit(100n)], 0n));
  });

  it("debit differs from credit by 1 paisa, in both directions", async () => {
    const w = await L.newWallet();
    await refused(role, w, posting(w, [debit(100n), credit(w, 99n)], 99n));
    await refused(role, w, posting(w, [debit(99n), credit(w, 100n)], 100n));
  });

  it("a difference of 1 paisa above 2^53 (no float rounding in the check)", async () => {
    const w = await L.newWallet();
    const big = 9007199254740993n;
    await refused(role, w, posting(w, [debit(big), credit(w, big + 1n)], big + 1n));
  });

  it("a zero amount", async () => {
    const w = await L.newWallet();
    await refused(role, w, posting(w, [debit(0n), credit(w, 0n)], 0n));
  });

  it("a negative amount, also when the two sides cancel out", async () => {
    const w = await L.newWallet();
    await L.fund(w, 1000n);
    await refused(role, w, posting(w, [debit(-5n), credit(w, -5n)], -5n));
    await refused(role, w, posting(w, [debit(100n), credit(w, 105n), debit(-5n)], 105n));
  });

  it("the same amounts in two currencies (100 BDT debit against 100 USD credit)", async () => {
    const usd = await L.newWallet({ currency: "USD" });
    const clearing = await L.platformAccount("gateway_clearing");
    const before = await L.counts();
    await expect(
      L.run(async (tx) => {
        const id = await insertLedgerTransaction(tx, {
          kind: "topup",
          referenceType: "payment",
          referenceId: crypto.randomUUID(),
          idempotencyKey: `topup:${crypto.randomUUID()}`,
          actorType: "system",
          actorId: null,
          memo: null,
        });
        await insertLedgerEntries(tx, id!, [
          { accountId: clearing, direction: "debit", amountMinor: 100n },
          { accountId: usd.accountId, direction: "credit", amountMinor: 100n },
        ]);
      }, role),
    ).rejects.toMatchObject({ name: "DbError", code: "23514" });
    expect(await L.counts()).toEqual(before);
  });

  it("a balanced post of the same shape is accepted (the cases above fail for the imbalance only)", async () => {
    const w = await L.newWallet();
    const ok = await L.run(
      (tx) => writePosting(tx, posting(w, [debit(100n), credit(w, 100n)], 100n)),
      role,
    );
    expect(ok).toMatchObject({ ok: true });
    expect((await L.cache(w.customerId)).balance).toBe(100n);
  });

  it("the real post path refuses an unbalanced request before it writes, and writes nothing", async () => {
    const w = await L.newWallet();
    const before = await L.counts();
    const request = (creditAmount: bigint): PostTransactionInput => ({
      ...inputs.topup(w.customerId, 100n),
      postings: [
        { account: { type: "gateway_clearing" }, direction: "debit", amountMinor: 100n },
        {
          account: { type: "customer_wallet", customerId: w.customerId },
          direction: "credit",
          amountMinor: creditAmount,
        },
      ],
    });
    for (const amount of [99n, 101n, 0n, -100n]) {
      const result = await L.run((tx) => postTransaction(tx, request(amount)), role);
      expect(result).toMatchObject({ ok: false, error: "validation" });
    }
    expect(await L.counts()).toEqual(before);
  });
});

describe.each(ROLES)("as %s, a reversal", (role) => {
  it("is a new transaction that balances, and the original stays as it was", async () => {
    const w = await L.newWallet();
    await L.fund(w, 150000n);
    const bought = transactionIdOf(
      await L.run((tx) => postTransaction(tx, inputs.purchase(w.customerId)), "web_rw"),
    );
    const linesOf = (id: string) =>
      L.pool.query(
        "select direction, amount_minor::text as amount, account_id from ledger_entries where transaction_id = $1 order by id",
        [id],
      );
    const before = await linesOf(bought);
    const back = transactionIdOf(
      await L.run(
        (tx) =>
          reverseTransaction(tx, {
            transactionId: bought,
            actor:
              role === "admin_rw" ? { type: "admin", id: crypto.randomUUID() } : { type: "system" },
            memo: "test",
          }),
        role,
      ),
    );
    const sums = await L.pool.query<{ debit: string; credit: string }>(
      `select coalesce(sum(amount_minor) filter (where direction = 'debit'), 0)::text as debit,
              coalesce(sum(amount_minor) filter (where direction = 'credit'), 0)::text as credit
         from ledger_entries where transaction_id = $1`,
      [back],
    );
    expect(sums.rows[0]).toEqual({ debit: "74295", credit: "74295" });
    expect((await L.cache(w.customerId)).balance).toBe(150000n);
    expect((await linesOf(bought)).rows).toEqual(before.rows);
  });

  it("with lines that do not balance is refused by the database too", async () => {
    const w = await L.newWallet();
    const referenceId = crypto.randomUUID();
    const reversal: NormalizedPosting = {
      ...posting(w, [debit(100n), credit(w, 99n)], 99n),
      kind: "reversal",
      referenceType: "ledger_transaction",
      referenceId,
      idempotencyKey: `reversal:${referenceId}`,
    };
    await refused(role, w, reversal);
  });
});

describe.each(ROLES)("as %s, the ledger and the audit log are append-only", (role) => {
  const statements: [string, string][] = [
    ["update ledger_transactions", "update ledger_transactions set memo = 'x'"],
    ["delete ledger_transactions", "delete from ledger_transactions"],
    ["update ledger_entries", "update ledger_entries set amount_minor = amount_minor + 1"],
    ["delete ledger_entries", "delete from ledger_entries"],
    ["update audit_log", "update audit_log set action = 'x'"],
    ["delete audit_log", "delete from audit_log"],
    ["truncate ledger_entries", "truncate ledger_entries"],
    ["truncate ledger_transactions", "truncate ledger_transactions cascade"],
    ["truncate audit_log", "truncate audit_log"],
  ];
  it.each(statements)("%s is refused with 42501, with rows present", async (_name, sql) => {
    const w = await L.newWallet();
    await L.fund(w, 1000n);
    const before = await L.counts();
    await expect(
      L.run(async (tx) => {
        await tx.execute(sql);
      }, role),
    ).rejects.toMatchObject({ name: "DbError", code: "42501" });
    expect(await L.counts()).toEqual(before);
  });
});

describe("the table owner is stopped by the append-only trigger", () => {
  it.each([
    ["update ledger_entries", "update ledger_entries set amount_minor = amount_minor + 1"],
    ["delete ledger_entries", "delete from ledger_entries"],
    ["update ledger_transactions", "update ledger_transactions set memo = 'x'"],
    ["delete ledger_transactions", "delete from ledger_transactions"],
  ])("%s is refused with 23001", async (_name, sql) => {
    const w = await L.newWallet();
    await L.fund(w, 1000n);
    await expect(L.pool.query(sql)).rejects.toMatchObject({ code: "23001" });
  });
});
