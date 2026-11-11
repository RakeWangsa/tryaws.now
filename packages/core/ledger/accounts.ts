import {
  customerMarketCurrency,
  findWalletAccount,
  insertPlatformAccount,
  insertWallet,
  insertWalletAccount,
  readWalletRow,
  type Tx,
} from "@tc/db";
import type { Result } from "../types";
import { LedgerError } from "./errors";
import { LEDGER_ACCOUNT_TYPES, LEDGER_CURRENCY, type PlatformAccountType } from "./types";
import { isUuid } from "./uuid";

const CURRENCY = /^[A-Z]{3}$/;

const PLATFORM_ACCOUNT_TYPES: readonly PlatformAccountType[] = LEDGER_ACCOUNT_TYPES.filter(
  (type): type is PlatformAccountType => type !== "customer_wallet",
);

/**
 * Creates the platform accounts of a currency that do not exist yet, in the order of
 * LEDGER_ACCOUNT_TYPES, and returns the types it created. Idempotent. Run by the table owner at
 * deploy time and by test set-up; postTransaction never creates an account (open point 3).
 */
export async function ensureSystemAccounts(
  tx: Tx,
  currency: string = LEDGER_CURRENCY,
): Promise<{ created: PlatformAccountType[] }> {
  if (!CURRENCY.test(currency)) {
    throw new TypeError("ensureSystemAccounts: the currency is not three capital letters");
  }
  const created: PlatformAccountType[] = [];
  for (const type of PLATFORM_ACCOUNT_TYPES) {
    if ((await insertPlatformAccount(tx, type, currency)) !== null) created.push(type);
  }
  return { created };
}

/**
 * Opens the wallet row and the customer_wallet account of a customer in the currency of the
 * customer's market. Idempotent. The call of the sign-up; only web_rw may insert these rows.
 */
export async function openWallet(
  tx: Tx,
  customerId: string,
): Promise<Result<{ walletId: string; accountId: string; currency: string }>> {
  if (!isUuid(customerId))
    return { ok: false, error: "validation", fields: { customerId: "invalid" } };
  const id = customerId.toLowerCase();
  const currency = await customerMarketCurrency(tx, id);
  if (currency === null) return { ok: false, error: "not_found" };
  // A wallet of another currency is refused before anything is written (owner decision 57, path a).
  const existing = await readWalletRow(tx, id);
  if (existing !== null && existing.currency !== currency) return { ok: false, error: "conflict" };
  await insertWallet(tx, id, currency);
  await insertWalletAccount(tx, id, currency);
  const wallet = await readWalletRow(tx, id);
  const account = await findWalletAccount(tx, id, currency);
  if (wallet === null || account === null) throw new LedgerError("invariant");
  if (wallet.currency !== currency) return { ok: false, error: "conflict" };
  return { ok: true, value: { walletId: wallet.id, accountId: account.id, currency } };
}
