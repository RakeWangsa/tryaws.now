import type pg from "pg";
import { describe, expect, it } from "vitest";
import type { Tx } from "../client";
import {
  currentDatabaseUser,
  ledgerTotals,
  negativeWallets,
  oneSidedTransactions,
  unbalancedTransactions,
  walletAccountsWithoutWallet,
  walletMismatches,
} from "../ledger/audit";
import { attachErrorListeners, runTransaction, type DatabaseRole } from "../tx";
import { createTempDatabase, type TempDatabase } from "./temp-db";
import { inTransaction, insertRow } from "./sql";
import { newCustomer, newLedgerAccount, postLedger, systemAccount, uniqueSuffix } from "./fixtures";
import { withTriggersOff } from "./ledger-helpers";

// The queries read the whole ledger, so each case has a database of its own.
async function withLedger(body: (d: TempDatabase) => Promise<void>) {
  const d = await createTempDatabase();
  attachErrorListeners(d.pool);
  try {
    await body(d);
  } finally {
    await d.drop();
  }
}
const run = <T>(d: TempDatabase, fn: (tx: Tx) => Promise<T>, role?: DatabaseRole) =>
  runTransaction(d.db, fn, role === undefined ? {} : { role });

// A customer with a wallet row (cache `cached`) and a wallet account that was credited `credited`.
async function wallet(q: pg.Pool, credited: number | string, cached: number | string = credited) {
  const clearing = await systemAccount(q, "gateway_clearing");
  const customerId = await newCustomer(q);
  const accountId = await newLedgerAccount(q, "customer_wallet", customerId);
  const walletId = await insertRow(q, "wallets", {
    customer_id: customerId,
    currency: "BDT",
    balance_minor: cached,
  });
  await inTransaction(q, async (c) => {
    const id = await insertRow(c, "ledger_transactions", {
      kind: "test",
      reference_type: "test",
      reference_id: crypto.randomUUID(),
      idempotency_key: "w:" + uniqueSuffix(),
      actor_type: "system",
    });
    for (const [account_id, direction] of [
      [clearing, "debit"],
      [accountId, "credit"],
    ] as const) {
      await insertRow(c, "ledger_entries", {
        transaction_id: id,
        account_id,
        direction,
        amount_minor: credited,
      });
    }
  });
  return { customerId, accountId, walletId };
}
const empty = { total: 0, rows: [] };

describe("the queries of the nightly check, as worker_rw", () => {
  it("find nothing in a ledger that is right, and count what is there", async () => {
    await withLedger(async (d) => {
      await wallet(d.pool, 1000);
      const r = await run(
        d,
        async (tx) => ({
          totals: await ledgerTotals(tx),
          mismatches: await walletMismatches(tx, 10),
          negatives: await negativeWallets(tx, 10),
          orphans: await walletAccountsWithoutWallet(tx, 10),
          unbalanced: await unbalancedTransactions(tx, 10),
          oneSided: await oneSidedTransactions(tx, 10),
        }),
        "worker_rw",
      );
      expect(r).toEqual({
        totals: { wallets: 1, transactions: 1, entries: 2 },
        mismatches: empty,
        negatives: empty,
        orphans: empty,
        unbalanced: empty,
        oneSided: empty,
      });
    });
  });
  it("find a cache that is not the sum, with exact amounts above 2^53", async () => {
    await withLedger(async (d) => {
      const w = await wallet(d.pool, "9007199254740993", "9007199254740994");
      expect(await run(d, (tx) => walletMismatches(tx, 10), "worker_rw")).toEqual({
        total: 1,
        rows: [
          {
            walletId: w.walletId,
            customerId: w.customerId,
            cachedMinor: 9007199254740994n,
            entriesMinor: 9007199254740993n,
          },
        ],
      });
    });
  });
  it("find a wallet whose entries add up below 0", async () => {
    await withLedger(async (d) => {
      const clearing = await systemAccount(d.pool, "gateway_clearing");
      const customerId = await newCustomer(d.pool);
      const accountId = await newLedgerAccount(d.pool, "customer_wallet", customerId);
      const walletId = await insertRow(d.pool, "wallets", {
        customer_id: customerId,
        currency: "BDT",
        balance_minor: 0,
      });
      await inTransaction(d.pool, (c) =>
        postLedger(c, "neg:" + uniqueSuffix(), [
          [accountId, "debit", 50],
          [clearing, "credit", 50],
        ]),
      );
      expect(await run(d, (tx) => negativeWallets(tx, 10), "worker_rw")).toEqual({
        total: 1,
        rows: [{ walletId, customerId, cachedMinor: 0n, entriesMinor: -50n }],
      });
    });
  });
  it("find a wallet account with entries and no wallet of the same currency", async () => {
    await withLedger(async (d) => {
      const w = await wallet(d.pool, 70);
      await d.pool.query("update wallets set currency = 'USD' where id = $1", [w.walletId]);
      expect(await run(d, (tx) => walletAccountsWithoutWallet(tx, 10), "worker_rw")).toEqual({
        total: 1,
        rows: [{ accountId: w.accountId, customerId: w.customerId, entriesMinor: 70n }],
      });
    });
  });
  it("find a transaction that does not balance and a header with no lines", async () => {
    await withLedger(async (d) => {
      const clearing = await systemAccount(d.pool, "gateway_clearing");
      const revenue = await systemAccount(d.pool, "revenue_aws_base");
      let unbalanced = "";
      let none = "";
      await withTriggersOff(d.pool, async () => {
        unbalanced = await inTransaction(d.pool, (c) =>
          postLedger(c, "unbal:" + uniqueSuffix(), [
            [clearing, "debit", 90],
            [revenue, "credit", 80],
          ]),
        );
        none = await insertRow(d.pool, "ledger_transactions", {
          kind: "test",
          reference_type: "test",
          reference_id: crypto.randomUUID(),
          idempotency_key: "empty:" + uniqueSuffix(),
          actor_type: "system",
        });
      });
      expect(await run(d, (tx) => unbalancedTransactions(tx, 10), "worker_rw")).toEqual({
        total: 1,
        rows: [{ transactionId: unbalanced, currency: "BDT", netMinor: 10n }],
      });
      expect(await run(d, (tx) => oneSidedTransactions(tx, 10), "worker_rw")).toEqual({
        total: 1,
        rows: [{ transactionId: none, hasDebit: false, hasCredit: false }],
      });
    });
  });
});

describe("limit, total and roles", () => {
  it("rows are cut at the limit and total is the exact count", async () => {
    await withLedger(async (d) => {
      for (let i = 0; i < 3; i++) await wallet(d.pool, 10, 11);
      const r = await run(d, (tx) => walletMismatches(tx, 2), "worker_rw");
      expect(r.rows).toHaveLength(2);
      expect(r.total).toBe(3);
    });
  });
  it.each([0, 1001, 1.5, NaN])("refuses the limit %s", async (limit) => {
    await withLedger(async (d) => {
      await expect(run(d, (tx) => walletMismatches(tx, limit))).rejects.toThrow(
        new TypeError("ledger: the limit is not an integer from 1 to 1000"),
      );
    });
  });
  it("currentDatabaseUser tells the role the statements run under (SET LOCAL ROLE of runTransaction)", async () => {
    await withLedger(async (d) => {
      expect(await run(d, (tx) => currentDatabaseUser(tx), "worker_rw")).toBe("worker_rw");
      expect(await run(d, (tx) => currentDatabaseUser(tx), "web_rw")).toBe("web_rw");
    });
  });
  it("is refused to report_ro, which has no grant on the ledger", async () => {
    await withLedger(async (d) => {
      await expect(run(d, (tx) => walletMismatches(tx, 1), "report_ro")).rejects.toMatchObject({
        name: "DbError",
        code: "42501",
      });
    });
  });
});
