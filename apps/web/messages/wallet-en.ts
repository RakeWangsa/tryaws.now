import type { walletBn } from "./wallet-bn.ts";

type Same<T> = { [K in keyof T]: T[K] extends string ? string : Same<T[K]> };

export const walletEn: Same<typeof walletBn> = {
  Wallet: {
    meta: { title: "Wallet" },
    heading: "Wallet",
    balance: {
      label: "Current balance",
      hint: "You can use this balance to buy servers and other services.",
    },
    open: {
      label: "Payments waiting",
      hint: "They are added to your balance once confirmed.",
    },
    topUp: "Top up",
    ledger: {
      title: "Transactions",
      caption: "List of wallet transactions",
      date: "Date",
      description: "Description",
      in: "Money in",
      out: "Money out",
      balance: "Balance",
      kind: {
        topup: "Top-up",
        purchase: "Purchase",
        renewal: "Renewal",
        metered_charge: "Usage charge",
        reversal: "Automatic reversal",
        adjustment: "Adjustment",
        refund: "Refund",
        other: "Other",
      },
      empty: {
        title: "No transactions yet",
        body: "Your top-ups and purchases will appear here.",
      },
    },
    payments: {
      title: "Payments",
      caption: "List of top-up payments",
      amount: "Amount",
      state: "State",
      view: "View",
      empty: "No payments yet.",
    },
    state: {
      credited: "Paid",
      pending: "Pending",
      failed: "Failed",
      cancelled: "Cancelled",
      expired: "Expired",
    },
    banner: {
      checking: "We are checking your payment. Your balance changes once it is confirmed.",
      credited: "Your top-up is complete.",
      failed: "The payment did not go through. You were not charged.",
      cancelled: "You cancelled the payment.",
      expired: "The payment timed out.",
      unknown: "We could not find this payment.",
    },
    paging: { newer: "Newer", older: "Older" },
    error: {
      title: "The wallet could not be shown",
      body: "Try again in a moment. Your balance is unchanged.",
      retry: "Try again",
    },
  },
};
