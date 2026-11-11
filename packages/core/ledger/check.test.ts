import { describe, expect, it } from "vitest";
import { freshLedgerKit, inputs, type LedgerKit } from "../test/ledger-fixtures";
import { checkLedger } from "./check";
import { postTransaction } from "./post";

type Kit = LedgerKit & { drop(): Promise<void> };
// Each case has a database of its own: the check reads the whole ledger.
async function withLedger(body: (K: Kit) => Promise<void>) {
  const K = await freshLedgerKit();
  try {
    await body(K);
  } finally {
    await K.drop();
  }
}
const check = (K: Kit, options?: { maxFindings?: number }, role?: "worker_rw" | "report_ro") =>
  K.run((tx) => checkLedger(tx, options), role);

describe("a ledger that is right", () => {
  it("passes, as worker_rw (the role of the nightly job), and counts what it looked at", async () => {
    await withLedger(async (K) => {
      const a = await K.newWallet();
      const b = await K.newWallet();
      await K.fund(a, 150000n);
      await K.fund(b, 1000n);
      await K.run((tx) => postTransaction(tx, inputs.purchase(a.customerId)));
      expect(await check(K, undefined, "worker_rw")).toEqual({
        ok: true,
        wallets: 2,
        transactions: 3,
        entries: 9,
        findingCount: 0,
        findings: [],
        truncated: false,
      });
    });
  });
  it("is refused to report_ro, which has no grant on the ledger", async () => {
    await withLedger(async (K) => {
      await expect(check(K, undefined, "report_ro")).rejects.toMatchObject({
        name: "DbError",
        code: "42501",
      });
    });
  });
  it("keeps sums above 2^53 exact", async () => {
    await withLedger(async (K) => {
      const w = await K.newWallet();
      await K.fund(w, 9007199254740993n);
      expect((await check(K)).ok).toBe(true);
      await K.pool.query(
        "update wallets set balance_minor = 9007199254740994 where customer_id = $1",
        [w.customerId],
      );
      const r = await check(K);
      expect(r.findings).toEqual([
        {
          kind: "wallet_mismatch",
          walletId: w.walletId,
          customerId: w.customerId,
          cachedMinor: 9007199254740994n,
          entriesMinor: 9007199254740993n,
        },
      ]);
    });
  });
});

describe("what the check finds", () => {
  it("a cache that is not the sum of the entries", async () => {
    await withLedger(async (K) => {
      const w = await K.newWallet();
      await K.fund(w, 1000n);
      await K.pool.query("update wallets set balance_minor = 1001 where customer_id = $1", [
        w.customerId,
      ]);
      expect(await check(K)).toMatchObject({
        ok: false,
        findingCount: 1,
        truncated: false,
        findings: [
          {
            kind: "wallet_mismatch",
            walletId: w.walletId,
            customerId: w.customerId,
            cachedMinor: 1001n,
            entriesMinor: 1000n,
          },
        ],
      });
    });
  });
  it("a wallet whose entries add up below 0", async () => {
    await withLedger(async (K) => {
      const w = await K.newWallet();
      const revenue = await K.platformAccount("revenue_aws_base");
      const txId = crypto.randomUUID();
      // one query string with no parameters: both statements run in one implicit transaction
      await K.pool.query(
        `insert into ledger_transactions (id, kind, reference_type, reference_id, idempotency_key, actor_type)
           values ('${txId}', 'purchase', 'order', gen_random_uuid(), 'neg:${txId}', 'system');
         insert into ledger_entries (id, transaction_id, account_id, direction, amount_minor) values
           (gen_random_uuid(), '${txId}', '${w.accountId}', 'debit', 50),
           (gen_random_uuid(), '${txId}', '${revenue}', 'credit', 50)`,
      );
      const r = await check(K);
      expect(r.findings.map((f) => f.kind).sort()).toEqual(["wallet_mismatch", "wallet_negative"]);
      expect(r.findings).toContainEqual({
        kind: "wallet_negative",
        walletId: w.walletId,
        customerId: w.customerId,
        cachedMinor: 0n,
        entriesMinor: -50n,
      });
    });
  });
  it("a wallet in another currency than its ledger account", async () => {
    await withLedger(async (K) => {
      const w = await K.newWallet();
      await K.fund(w, 500n);
      await K.pool.query("update wallets set currency = 'USD' where customer_id = $1", [
        w.customerId,
      ]);
      const r = await check(K);
      expect(r.findings).toEqual([
        {
          kind: "wallet_mismatch",
          walletId: w.walletId,
          customerId: w.customerId,
          cachedMinor: 500n,
          entriesMinor: 0n,
        },
        {
          kind: "account_without_wallet",
          accountId: w.accountId,
          customerId: w.customerId,
          entriesMinor: 500n,
        },
      ]);
    });
  });
  it("a transaction that does not balance, and a header with no lines (the deferred triggers are switched off)", async () => {
    await withLedger(async (K) => {
      const clearing = await K.platformAccount("gateway_clearing");
      const revenue = await K.platformAccount("revenue_aws_base");
      const unbalanced = crypto.randomUUID();
      const empty = crypto.randomUUID();
      await K.withTriggersOff(async () => {
        for (const id of [unbalanced, empty]) {
          await K.pool.query(
            `insert into ledger_transactions (id, kind, reference_type, reference_id, idempotency_key, actor_type)
             values ($1, 'test', 'test', gen_random_uuid(), $2, 'system')`,
            [id, "k:" + id],
          );
        }
        await K.pool.query(
          `insert into ledger_entries (id, transaction_id, account_id, direction, amount_minor) values
           (gen_random_uuid(), $1, $2, 'debit', 90), (gen_random_uuid(), $1, $3, 'credit', 80)`,
          [unbalanced, clearing, revenue],
        );
      });
      const r = await check(K);
      expect(r.ok).toBe(false);
      expect(r.findings).toContainEqual({
        kind: "transaction_unbalanced",
        transactionId: unbalanced,
        currency: "BDT",
        netMinor: 10n,
      });
      expect(r.findings).toContainEqual({
        kind: "transaction_one_sided",
        transactionId: empty,
        hasDebit: false,
        hasCredit: false,
      });
      expect(r.findingCount).toBe(2);
    });
  });
});

describe("a long list", () => {
  it("keeps the exact count and cuts the list at maxFindings", async () => {
    await withLedger(async (K) => {
      for (let i = 0; i < 3; i++) {
        const w = await K.newWallet();
        await K.pool.query("update wallets set balance_minor = 7 where customer_id = $1", [
          w.customerId,
        ]);
      }
      const r = await check(K, { maxFindings: 2 });
      expect(r).toMatchObject({ ok: false, findingCount: 3, truncated: true });
      expect(r.findings).toHaveLength(2);
    });
  });
  it.each([0, 1001, 1.5, NaN])("refuses maxFindings %s", async (max) => {
    await withLedger(async (K) => {
      await expect(check(K, { maxFindings: max })).rejects.toThrow(TypeError);
    });
  });
});
