import { accountFor } from "../pricing/index";
import type { Minor } from "../types";
import type { Posting } from "./types";

// Spec 9.1. The split of a sale: the wallet is debited with the total and credited to revenue_aws_base
// (the base) and to the account of each price step above 0 (VAT, fee, margin). A step of 0 posts no
// line. One builder for a purchase, a renewal and a metered charge (WPU-M2), so the three cannot drift.

export interface SaleSplit {
  readonly totalMinor: Minor;
  readonly baseMinor: Minor;
  readonly steps: readonly { readonly code: string; readonly amountMinor: Minor }[];
}

export function salePostings(customerId: string, split: SaleSplit): Posting[] {
  const postings: Posting[] = [
    {
      account: { type: "customer_wallet", customerId },
      direction: "debit",
      amountMinor: split.totalMinor,
    },
    { account: { type: "revenue_aws_base" }, direction: "credit", amountMinor: split.baseMinor },
  ];
  for (const step of split.steps) {
    if (step.amountMinor === 0n) continue; // a step of 0 posts no line
    const type = accountFor(step.code);
    if (type === undefined) throw new Error("ledger: a price step has no ledger account");
    postings.push({ account: { type }, direction: "credit", amountMinor: step.amountMinor });
  }
  return postings;
}
