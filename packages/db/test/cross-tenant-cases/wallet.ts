import { randomInt } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { newLedgerAccount, systemAccount } from "../fixtures";
import { inTransaction, insertRow } from "../sql";
import { defineCaseSet, type CaseSet } from "./define";

interface WalletSeed {
  customerId: string;
  transactionId: string;
  balanceMinor: string;
}

// Both methods are reads of the scope's own wallet: they name no row. The owner gets a wallet row,
// a wallet account and one posting so that its own read is not empty (an empty answer would prove
// nothing). The statement names the transaction id of the seed; view() names no id, so its case
// compares the balance with the one of the seed and the ghost expects another balance.
export const walletCases: CaseSet = defineCaseSet<WalletSeed>({
  repo: "wallet",
  seed: async (pool, customerId) => {
    // A balance of its own for every customer: the harness seeds A and B alike, so only a balance
    // that differs between them tells B's answer from A's.
    const amount = 10_000 + randomInt(1, 9_000_000);
    await insertRow(pool, "wallets", {
      customer_id: customerId,
      currency: "BDT",
      balance_minor: amount,
    });
    const wallet = await newLedgerAccount(pool, "customer_wallet", customerId);
    const clearing = await systemAccount(pool, "gateway_clearing");
    const transactionId = await inTransaction(pool, async (c) => {
      const tx = await insertRow(c, "ledger_transactions", {
        kind: "topup",
        reference_type: "payment",
        reference_id: uuidv7(),
        idempotency_key: "seed-" + uuidv7(),
        actor_type: "system",
      });
      for (const [account_id, direction] of [
        [clearing, "debit"],
        [wallet, "credit"],
      ] as const) {
        await insertRow(c, "ledger_entries", {
          transaction_id: tx,
          account_id,
          direction,
          amount_minor: amount,
        });
      }
      return tx;
    });
    return { customerId, transactionId, balanceMinor: String(amount) };
  },
  cases: ({ asCustomer }) => ({
    "wallet.view": {
      kind: "read",
      run: (c, s) =>
        asCustomer(c, async (r) => {
          const view = await r.wallet.view();
          return {
            view,
            isSeedBalance: view !== null && view.balanceMinor.toString() === s.balanceMinor,
          };
        }),
      // The same request about a wallet that does not exist: it expects another balance.
      ghost: (s) => ({ ...s, customerId: uuidv7(), transactionId: uuidv7(), balanceMinor: "0" }),
    },
    "wallet.statement": {
      kind: "read",
      run: (c, s) =>
        asCustomer(c, async (r) => {
          const page = await r.wallet.statement({ limit: 100 });
          return { page, names: page.lines.some((l) => l.transactionId === s.transactionId) };
        }),
    },
  }),
});
