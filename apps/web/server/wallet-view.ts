import type { CustomerSession } from "@tc/auth";
import { customerRepos, withTx } from "@tc/db";
import type { PaymentRow, StatementLine } from "@tc/db";
import { isWaiting, publicPaymentState } from "./payment-state.ts";

// What /wallet shows, read through the repositories of the session's customer only (R8). A database
// error is thrown, never answered with an empty wallet (R16).

export const LEDGER_PAGE = 20;
export const PAYMENTS_SHOWN = 10;

export interface WalletScreen {
  balanceMinor: bigint;
  lines: StatementLine[];
  nextCursor: string | null;
  payments: PaymentRow[];
  waitingCount: number;
  newest: PaymentRow | null;
}

export async function loadWallet(
  session: CustomerSession,
  opts: { cursor?: string } = {},
): Promise<WalletScreen> {
  return withTx(async (tx) => {
    const repos = customerRepos(tx, session.customerId);
    const [wallet, page, payments] = await Promise.all([
      repos.wallet.view(),
      repos.wallet.statement({
        limit: LEDGER_PAGE,
        ...(opts.cursor !== undefined ? { cursor: opts.cursor } : {}),
      }),
      repos.payments.list(100),
    ]);
    return {
      balanceMinor: wallet?.balanceMinor ?? 0n,
      lines: page.lines,
      nextCursor: page.nextCursor,
      payments: payments.slice(0, PAYMENTS_SHOWN),
      waitingCount: payments.filter((payment) => isWaiting(payment.status)).length,
      newest: payments[0] ?? null,
    };
  });
}

const TOPUP_HINTS = ["credited", "pending", "failed", "cancelled", "expired", "unknown"] as const;

export type BannerKind = "checking" | "credited" | "failed" | "cancelled" | "expired" | "unknown";

/**
 * The banner after a return from the gateway. `?topup=` is a hint that anybody can type, so it only
 * chooses among fixed texts: the success text needs the customer's own newest payment to be
 * credited (R6), and the value of the query is never rendered.
 */
export function bannerFor(hint: unknown, newest: PaymentRow | null): BannerKind | null {
  if (typeof hint !== "string") return null;
  const found = TOPUP_HINTS.find((candidate) => candidate === hint);
  if (found === undefined) return null;
  if (found === "credited") {
    return newest !== null && publicPaymentState(newest.status) === "credited"
      ? "credited"
      : "checking";
  }
  if (found === "pending") return "checking";
  return found;
}

const KNOWN_KINDS = [
  "topup",
  "purchase",
  "renewal",
  "metered_charge",
  "reversal",
  "adjustment",
  "refund",
] as const;
export type KnownKind = (typeof KNOWN_KINDS)[number];

/** The message key of a ledger kind; a kind this screen does not know is "other". */
export function kindKey(kind: string): KnownKind | "other" {
  return KNOWN_KINDS.find((candidate) => candidate === kind) ?? "other";
}
