import type { CustomerSession } from "@tc/auth";
import { quickAmountMinors } from "@tc/core";
import type { TopUpRange } from "@tc/core";
import { customerRepos, readMarket, withTx } from "@tc/db";
import type { Market, PaymentRow } from "@tc/db";
import { isWaiting } from "./payment-state.ts";

// What /wallet/topup and /wallet/topup/[paymentId] show, read through the repositories of the
// session's customer only (R8). A database error is thrown, never answered with an empty page (R16).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_RANGE: TopUpRange = { minMinor: 0n, maxMinor: 0n };

export interface TopUpScreen {
  /** null = the customer's market is missing or inactive: the screen says "not open yet". */
  market: Market | null;
  range: TopUpRange;
  quick: bigint[];
  /** Payments the gateway has not answered yet, newest first. */
  open: PaymentRow[];
}

export async function loadTopUp(session: CustomerSession): Promise<TopUpScreen> {
  return withTx(async (tx) => {
    const repos = customerRepos(tx, session.customerId);
    const [profile, payments] = await Promise.all([repos.profile.get(), repos.payments.list(100)]);
    const found = profile === null ? null : await readMarket(tx, profile.market);
    const market = found !== null && found.active ? found : null;
    const open = payments.filter((payment) => isWaiting(payment.status));
    if (market === null) return { market: null, range: NO_RANGE, quick: [], open };
    const range: TopUpRange = { minMinor: market.topupMinMinor, maxMinor: market.topupMaxMinor };
    return { market, range, quick: quickAmountMinors(market.quickAmounts, range), open };
  });
}

/** The market range of the session's customer for the Server Action; null = top-up is not open (R16). */
export async function loadRange(session: CustomerSession): Promise<TopUpRange | null> {
  const screen = await loadTopUp(session);
  return screen.market === null ? null : screen.range;
}

export interface PaymentScreen {
  payment: PaymentRow;
  /** The live wallet balance of the same customer, never a figure from the URL (R6). */
  balanceMinor: bigint;
}

/** null = not found for this customer (a payment of someone else is the same answer, R8). */
export async function loadPayment(
  session: CustomerSession,
  paymentId: string,
): Promise<PaymentScreen | null> {
  if (typeof paymentId !== "string" || !UUID.test(paymentId)) return null;
  return withTx(async (tx) => {
    const repos = customerRepos(tx, session.customerId);
    const payment = await repos.payments.get(paymentId);
    if (payment === null) return null;
    const wallet = await repos.wallet.view();
    return { payment, balanceMinor: wallet?.balanceMinor ?? 0n };
  });
}
