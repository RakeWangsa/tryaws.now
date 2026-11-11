import {
  ledgerTotals,
  negativeWallets,
  oneSidedTransactions,
  unbalancedTransactions,
  walletAccountsWithoutWallet,
  walletMismatches,
  type Tx,
} from "@tc/db";
import type { Minor } from "../types";

// The nightly balance check (spec 9.1, 15, K). It only reads. It corrects nothing: a cache that is
// wrong is a bug to find, not to hide. The job (Task 12) decides what a finding means (R16).

export type LedgerFinding =
  | {
      kind: "wallet_mismatch";
      walletId: string;
      customerId: string;
      cachedMinor: Minor;
      entriesMinor: Minor;
    }
  | {
      kind: "wallet_negative";
      walletId: string;
      customerId: string;
      cachedMinor: Minor;
      entriesMinor: Minor;
    }
  | { kind: "account_without_wallet"; accountId: string; customerId: string; entriesMinor: Minor }
  | { kind: "transaction_unbalanced"; transactionId: string; currency: string; netMinor: Minor }
  | { kind: "transaction_one_sided"; transactionId: string; hasDebit: boolean; hasCredit: boolean };

export interface LedgerCheckResult {
  readonly ok: boolean; // findingCount === 0
  readonly wallets: number; // what was looked at
  readonly transactions: number;
  readonly entries: number;
  readonly findingCount: number; // exact, also when findings is cut
  readonly findings: readonly LedgerFinding[];
  readonly truncated: boolean; // findingCount > findings.length
}

export interface LedgerCheckOptions {
  readonly maxFindings?: number; // 1 to 1000, default 50
}

const DEFAULT_MAX_FINDINGS = 50;
const MAX_FINDINGS_LIMIT = 1000;

export async function checkLedger(
  tx: Tx,
  options: LedgerCheckOptions = {},
): Promise<LedgerCheckResult> {
  const maxFindings = options.maxFindings ?? DEFAULT_MAX_FINDINGS;
  if (!Number.isInteger(maxFindings) || maxFindings < 1 || maxFindings > MAX_FINDINGS_LIMIT) {
    throw new TypeError("checkLedger: maxFindings is not an integer from 1 to 1000");
  }
  // One after another on the one tx (never Promise.all on a tx).
  const totals = await ledgerTotals(tx);
  const mismatches = await walletMismatches(tx, maxFindings);
  const negatives = await negativeWallets(tx, maxFindings);
  const orphans = await walletAccountsWithoutWallet(tx, maxFindings);
  const unbalanced = await unbalancedTransactions(tx, maxFindings);
  const oneSided = await oneSidedTransactions(tx, maxFindings);

  const all: LedgerFinding[] = [
    ...mismatches.rows.map((r) => ({ kind: "wallet_mismatch" as const, ...r })),
    ...negatives.rows.map((r) => ({ kind: "wallet_negative" as const, ...r })),
    ...orphans.rows.map((r) => ({ kind: "account_without_wallet" as const, ...r })),
    ...unbalanced.rows.map((r) => ({ kind: "transaction_unbalanced" as const, ...r })),
    ...oneSided.rows.map((r) => ({ kind: "transaction_one_sided" as const, ...r })),
  ];
  const findingCount =
    mismatches.total + negatives.total + orphans.total + unbalanced.total + oneSided.total;
  const findings = all.slice(0, maxFindings);
  return {
    ok: findingCount === 0,
    wallets: totals.wallets,
    transactions: totals.transactions,
    entries: totals.entries,
    findingCount,
    findings,
    truncated: findingCount > findings.length,
  };
}
