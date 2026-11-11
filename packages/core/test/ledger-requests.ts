import type { checkPosting } from "../ledger/rules";
import type { Posting, PostTransactionInput } from "../ledger/types";

// Requests in the shapes of spec 9.1 with fixed ids, for the tests that need no database.
export const A = "01a1c982-80df-7440-b4c6-9f7e1fb33ee5"; // a customer
export const B = "01a1c982-80e4-717b-b74d-a57864819067"; // another customer, or an admin
export const REF = "01a1c982-80f0-7000-8000-00000000abcd"; // a payment, an order, a request row
export const wallet = (customerId = A) => ({ type: "customer_wallet" as const, customerId });

// Section 8: 5 USD at FX 127 is 63500 + 6350 + 3175 + 1270 = 74295 paisa; the markup of 0 posts no line.
export const purchase = (over: Partial<PostTransactionInput> = {}): PostTransactionInput => ({
  kind: "purchase",
  reference: { type: "order", id: REF },
  idempotencyKey: "order:" + "a".repeat(32),
  actor: { type: "customer", id: A },
  memo: "Cloud Server, 30 days",
  postings: [
    { account: wallet(), direction: "debit", amountMinor: 74295n },
    { account: { type: "revenue_aws_base" }, direction: "credit", amountMinor: 63500n },
    { account: { type: "vat_korea_payable" }, direction: "credit", amountMinor: 6350n },
    { account: { type: "vat_bd_payable" }, direction: "credit", amountMinor: 3175n },
    { account: { type: "processing_fee_income" }, direction: "credit", amountMinor: 1270n },
  ],
  ...over,
});
export const topup = (over: Partial<PostTransactionInput> = {}): PostTransactionInput => ({
  kind: "topup",
  reference: { type: "payment", id: REF },
  idempotencyKey: `topup:${REF}`,
  actor: { type: "system" },
  postings: [
    { account: { type: "gateway_clearing" }, direction: "debit", amountMinor: 150000n },
    { account: wallet(), direction: "credit", amountMinor: 150000n },
  ],
  ...over,
});
export const adjustment = (direction: "credit" | "debit"): PostTransactionInput => ({
  kind: "adjustment",
  reference: { type: "wallet_adjustment", id: REF },
  idempotencyKey: `adjustment:${REF}`,
  actor: { type: "admin", id: B },
  memo: "goodwill",
  postings: [
    {
      account: { type: "adjustments" },
      direction: direction === "credit" ? "debit" : "credit",
      amountMinor: 500n,
    },
    { account: wallet(), direction, amountMinor: 500n },
  ],
});
export const refund = (): PostTransactionInput => ({
  kind: "refund",
  reference: { type: "refund", id: REF },
  idempotencyKey: `refund:${REF}`,
  actor: { type: "admin", id: B },
  memo: "paid out through the EPS dashboard",
  postings: [
    { account: wallet(), direction: "debit", amountMinor: 300n },
    { account: { type: "refunds" }, direction: "credit", amountMinor: 300n },
  ],
});
// The same split as the purchase; a renewal refers to a subscription, a metered charge to a resource (spec 9.1).
export const renewal = (over: Partial<PostTransactionInput> = {}): PostTransactionInput => ({
  ...purchase(),
  kind: "renewal",
  reference: { type: "subscription", id: REF },
  idempotencyKey: `renew:${REF}:2026-12-01T00:00:00.000Z`,
  ...over,
});
export const metered = (over: Partial<PostTransactionInput> = {}): PostTransactionInput => ({
  ...purchase(),
  kind: "metered_charge",
  reference: { type: "resource", id: REF },
  idempotencyKey: `meter:${REF}:snapshot_gb:2026-11-11`,
  actor: { type: "system" },
  memo: "snapshot_gb, 2026-11-11",
  ...over,
});
/** The purchase with a markup of 100 paisa: the wallet pays 74395 and `markup_income` gets a fifth credit line. */
export const withMarkup = (input: PostTransactionInput = purchase()): PostTransactionInput => ({
  ...input,
  postings: [
    ...input.postings.map((p, i) => (i === 0 ? { ...p, amountMinor: p.amountMinor + 100n } : p)),
    { account: { type: "markup_income" }, direction: "credit", amountMinor: 100n },
  ],
});
export const withLine = (
  input: PostTransactionInput,
  i: number,
  line: Partial<Posting>,
): PostTransactionInput => ({
  ...input,
  postings: input.postings.map((p, j) => (j === i ? ({ ...p, ...line } as Posting) : p)),
});
/** The paths of the problems of a refused request, sorted. */
export const keysOf = (r: ReturnType<typeof checkPosting>) =>
  r.ok ? [] : Object.keys(r.fields).sort();
