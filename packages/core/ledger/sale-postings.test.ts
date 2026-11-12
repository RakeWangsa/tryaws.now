import { describe, expect, it } from "vitest";
import { salePostings } from "./sale-postings";

const CUST = "0190b000-0000-7000-8000-000000000001";

describe("salePostings: the split of a purchase, a renewal and a metered charge (spec 9.1)", () => {
  it("debits the wallet with the total and credits the base and each step above 0", () => {
    const lines = salePostings(CUST, {
      totalMinor: 77n,
      baseMinor: 64n,
      steps: [
        { code: "korea_vat", amountMinor: 6n },
        { code: "bd_vat", amountMinor: 4n },
        { code: "processing_fee", amountMinor: 3n },
        { code: "markup", amountMinor: 0n },
      ],
    });
    expect(lines).toEqual([
      {
        account: { type: "customer_wallet", customerId: CUST },
        direction: "debit",
        amountMinor: 77n,
      },
      { account: { type: "revenue_aws_base" }, direction: "credit", amountMinor: 64n },
      { account: { type: "vat_korea_payable" }, direction: "credit", amountMinor: 6n },
      { account: { type: "vat_bd_payable" }, direction: "credit", amountMinor: 4n },
      { account: { type: "processing_fee_income" }, direction: "credit", amountMinor: 3n },
    ]);
  });

  it("the margin posts to markup_income", () => {
    const lines = salePostings(CUST, {
      totalMinor: 100n,
      baseMinor: 80n,
      steps: [{ code: "markup", amountMinor: 20n }],
    });
    expect(lines[2]).toEqual({
      account: { type: "markup_income" },
      direction: "credit",
      amountMinor: 20n,
    });
  });

  it("a step with no ledger account stops the posting", () => {
    expect(() =>
      salePostings(CUST, {
        totalMinor: 5n,
        baseMinor: 3n,
        steps: [{ code: "toString", amountMinor: 2n }],
      }),
    ).toThrow();
  });
});
