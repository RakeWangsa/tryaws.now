import { describe, expect, it } from "vitest";
import { A, B, REF, keysOf, purchase, topup, wallet, withLine } from "../test/ledger-requests";
import { checkPosting } from "./rules";
import type { PostTransactionInput } from "./types";

describe("what is valid", () => {
  it("accepts the purchase of section 8 and reports the wallet and its change", () => {
    expect(checkPosting(purchase())).toMatchObject({
      ok: true,
      value: {
        kind: "purchase",
        referenceType: "order",
        referenceId: REF,
        currency: "BDT",
        walletCustomerId: A,
        walletDelta: -74295n,
        memo: "Cloud Server, 30 days",
        actor: { type: "customer", id: A },
      },
    });
  });
  it("writes ids in lower case, so that a replay compares equal", () => {
    const r = checkPosting(purchase({ reference: { type: "order", id: REF.toUpperCase() } }));
    expect(r).toMatchObject({ ok: true, value: { referenceId: REF } });
  });
  it("accepts the largest amount of the database", () => {
    const max = 9223372036854775807n;
    const r = checkPosting(
      topup({
        postings: [
          { account: { type: "gateway_clearing" }, direction: "debit", amountMinor: max },
          { account: wallet(), direction: "credit", amountMinor: max },
        ],
      }),
    );
    expect(r.ok).toBe(true);
  });
});

describe("what is refused as validation, with the path of the problem and no value in the text", () => {
  it.each([
    ["an amount of 0", 0n],
    ["a negative amount", -1n],
    ["an amount above the bigint range", 2n ** 63n],
    ["an amount as a string", "9223372036854775808"],
    ["an amount as a number", 100],
    ["an amount as a float", 1.5],
    ["a missing amount", undefined],
    ["a null amount", null],
  ])("%s", (_name, amount) => {
    const r = checkPosting(withLine(purchase(), 1, { amountMinor: amount as bigint }));
    expect(keysOf(r)).toContain("postings[1].amountMinor");
    expect(r).toMatchObject({ ok: false, error: "validation" });
    expect(JSON.stringify(r)).not.toContain("9223372036854775808");
  });
  it.each([
    [
      "debits and credits that differ",
      withLine(purchase(), 1, { amountMinor: 63499n }),
      "postings",
    ],
    ["one posting", purchase({ postings: purchase().postings.slice(0, 1) }), "postings"],
    [
      "21 postings",
      purchase({ postings: Array.from({ length: 21 }, () => purchase().postings[0]!) }),
      "postings",
    ],
    [
      "no credit",
      purchase({
        postings: [purchase().postings[0]!, { ...purchase().postings[0]!, account: wallet(B) }],
      }),
      "postings",
    ],
    [
      "lines in two currencies",
      withLine(purchase(), 2, { account: { type: "vat_korea_payable", currency: "USD" } }),
      "postings[2].account.currency",
    ],
    [
      "a currency in lower case",
      withLine(purchase(), 1, { account: { type: "revenue_aws_base", currency: "bdt" } }),
      "postings[1].account.currency",
    ],
    [
      "a wallet with no customer id",
      withLine(purchase(), 0, { account: { type: "customer_wallet" } as never }),
      "postings[0].account.customerId",
    ],
    [
      "a customer id on a platform account",
      withLine(purchase(), 1, { account: { type: "revenue_aws_base", customerId: A } as never }),
      "postings[1].account.customerId",
    ],
    [
      "an unknown account type",
      withLine(purchase(), 1, { account: { type: "cash" } as never }),
      "postings[1].account",
    ],
    [
      "a direction that is neither",
      withLine(purchase(), 1, { direction: "up" as never }),
      "postings[1].direction",
    ],
    [
      "the same account twice",
      withLine(purchase(), 3, { account: { type: "revenue_aws_base" } }),
      "postings[3]",
    ],
    [
      "two customer wallets",
      withLine(topup(), 0, { account: wallet(B), direction: "debit" }),
      "postings",
    ],
    ["an unknown kind", purchase({ kind: "gift" as never }), "kind"],
    ["a reversal posted directly", purchase({ kind: "reversal" }), "kind"],
    [
      "a reference id that is not a UUID",
      purchase({ reference: { type: "order", id: "42" } }),
      "reference.id",
    ],
    [
      "a reference type that is not a word",
      purchase({ reference: { type: "Order 1", id: REF } }),
      "reference.type",
    ],
    ["an empty key", purchase({ idempotencyKey: "" }), "idempotencyKey"],
    ["a key of 201 characters", purchase({ idempotencyKey: "k".repeat(201) }), "idempotencyKey"],
    ["a key with a space", purchase({ idempotencyKey: "order: 1" }), "idempotencyKey"],
    [
      "a key with a letter outside ASCII",
      purchase({ idempotencyKey: "order:é" }),
      "idempotencyKey",
    ],
    [
      "an actor that is a customer without an id",
      purchase({ actor: { type: "customer" } as never }),
      "actor",
    ],
    ["an actor id that is not a UUID", purchase({ actor: { type: "admin", id: "root" } }), "actor"],
    ["a memo of 501 characters", purchase({ memo: "m".repeat(501) }), "memo"],
    ["a blank memo", purchase({ memo: "   " }), "memo"],
  ] as [string, PostTransactionInput, string][])("%s", (_name, input, path) => {
    const r = checkPosting(input);
    expect(r).toMatchObject({ ok: false, error: "validation" });
    expect(keysOf(r)).toContain(path);
  });
  // Each item is wrapped in an array: Vitest's `each` spreads an array item into arguments, so a bare `[]` would arrive as no argument (`undefined`).
  it.each([
    [null],
    [undefined],
    ["x"],
    [5],
    [[]],
    [{}],
    [{ postings: null }],
    [{ postings: [null, 5] }],
  ])("never throws for the input %j", (input) => {
    expect(checkPosting(input)).toMatchObject({ ok: false, error: "validation" });
  });
  it("allows the kind reversal only when the caller says so", () => {
    const input = purchase({
      kind: "reversal",
      reference: { type: "ledger_transaction", id: REF },
      idempotencyKey: `reversal:${REF}`, // the key family of the kind (Task 3)
      actor: { type: "system" },
      priceSnapshot: null, // a reversal is no sale
    });
    expect(checkPosting(input, { allowReversal: true }).ok).toBe(true);
    expect(checkPosting(input).ok).toBe(false);
  });
});
