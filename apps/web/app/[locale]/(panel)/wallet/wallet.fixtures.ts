import type { PaymentRow, StatementLine } from "@tc/db";
import type { WalletScreen } from "../../../../server/wallet-view.ts";

// Rows for the render tests of the wallet screens (never imported by a page).

export const CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";

export function payment(over: Partial<PaymentRow> = {}): PaymentRow {
  return {
    id: "0190aaaa-0000-7000-8000-000000000001",
    customerId: CUSTOMER_ID,
    gateway: "eps",
    merchantTransactionId: "MTID-SECRET-0001",
    amountMinor: 150000n,
    currency: "BDT",
    status: "credited",
    gatewayTransactionId: null,
    verifiedAt: new Date("2026-11-10T06:00:00Z"),
    ledgerTransactionId: null,
    createdAt: new Date("2026-11-10T05:55:00Z"),
    ...over,
  };
}

export function line(over: Partial<StatementLine> = {}): StatementLine {
  return {
    entryId: "0190bbbb-0000-7000-8000-000000000001",
    transactionId: "0190cccc-0000-7000-8000-000000000001",
    createdAt: new Date("2026-11-10T06:00:00Z"),
    kind: "topup",
    referenceType: "payment",
    direction: "credit",
    amountMinor: 150000n,
    balanceAfterMinor: 150000n,
    ...over,
  };
}

export function screen(over: Partial<WalletScreen> = {}): WalletScreen {
  return {
    balanceMinor: 150000n,
    lines: [
      line(),
      line({
        entryId: "0190bbbb-0000-7000-8000-000000000002",
        kind: "purchase",
        direction: "debit",
        amountMinor: 30000n,
        balanceAfterMinor: 120000n,
        createdAt: new Date("2026-11-10T07:00:00Z"),
      }),
    ],
    nextCursor: null,
    payments: [payment()],
    waitingCount: 0,
    newest: payment(),
    ...over,
  };
}
