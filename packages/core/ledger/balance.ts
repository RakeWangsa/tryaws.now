import { lockWalletRow, readWalletRow, sumWalletEntries, type Tx } from "@tc/db";
import type { Minor } from "../types";
import { LedgerError } from "./errors";
import { isUuid } from "./uuid";

// None of these checks who asks: the caller passes the customer id of the session (Conventions,
// "Layers"). A customer without a wallet is an error, not a 0: a 0 would hide a broken sign-up (R16).

function customerKey(customerId: string): string {
  if (!isUuid(customerId)) throw new TypeError("ledger: the customer id is not a UUID");
  return customerId.toLowerCase();
}

/** The cache `wallets.balance_minor` (F). */
export async function walletBalance(tx: Tx, customerId: string): Promise<Minor> {
  const wallet = await readWalletRow(tx, customerKey(customerId));
  if (wallet === null) throw new LedgerError("no_wallet");
  return wallet.balanceMinor;
}

/** The cache, with the wallet row locked until the transaction ends (3.4). */
export async function lockWallet(tx: Tx, customerId: string): Promise<Minor> {
  const wallet = await lockWalletRow(tx, customerKey(customerId));
  if (wallet === null) throw new LedgerError("no_wallet");
  return wallet.balanceMinor;
}

/** Credits minus debits on the wallet account: what the cache must equal. */
export async function walletEntriesSum(tx: Tx, customerId: string): Promise<Minor> {
  const wallet = await readWalletRow(tx, customerKey(customerId));
  if (wallet === null) throw new LedgerError("no_wallet");
  const sum = await sumWalletEntries(tx, wallet.id);
  if (sum === null) throw new LedgerError("no_wallet");
  return sum;
}
