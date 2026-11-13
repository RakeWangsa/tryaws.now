import type { Minor } from "../types";

export const LEDGER_ACCOUNT_TYPES = [
  "customer_wallet",
  "gateway_clearing",
  "revenue_aws_base",
  "vat_korea_payable",
  "vat_bd_payable",
  "processing_fee_income",
  "markup_income",
  "refunds",
  "adjustments",
] as const;
export type LedgerAccountType = (typeof LEDGER_ACCOUNT_TYPES)[number];
export type PlatformAccountType = Exclude<LedgerAccountType, "customer_wallet">;

export const LEDGER_KINDS = [
  "topup",
  "purchase",
  "renewal",
  "metered_charge",
  "reversal",
  "adjustment",
  "refund",
] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

export const LEDGER_CURRENCY = "BDT";
export const MAX_POSTINGS = 20;
export const MAX_KEY_LENGTH = 200;
export const MAX_MEMO_LENGTH = 500;
export const MAX_MINOR = 9223372036854775807n;

export type Actor =
  { readonly type: "customer" | "admin"; readonly id: string } | { readonly type: "system" };

export type LedgerAccountRef =
  | { readonly type: "customer_wallet"; readonly customerId: string; readonly currency?: string }
  | { readonly type: PlatformAccountType; readonly currency?: string };

export interface Posting {
  account: LedgerAccountRef;
  direction: "debit" | "credit";
  amountMinor: Minor;
}

export interface PostTransactionInput {
  kind: LedgerKind;
  reference: { type: string; id: string };
  idempotencyKey: string;
  actor: Actor;
  memo?: string;
  /**
   * WPU-Y2: the ChargeSnapshot (pricing/charge-snapshot.ts) of a purchase, renewal or metered charge. Saved
   * on the ledger transaction in the same statement group as the postings. Its total must be the debit.
   */
  priceSnapshot?: unknown;
  postings: Posting[];
}
