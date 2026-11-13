import { describe, expect, it } from "vitest";
import {
  A,
  B,
  REF,
  adjustment,
  keysOf,
  metered,
  purchase,
  refund,
  renewal,
  topup,
  wallet,
  withLine,
  withMarkup,
} from "../test/ledger-requests";
import { checkPosting, reversePostings, samePosting } from "./rules";
import type { PostTransactionInput } from "./types";

const OTHER = "01a1c982-80e4-717b-b74d-a57864819099"; // an id that is not REF

describe("the postings of spec 9.1, one row per kind", () => {
  it("accepts a renewal by a customer and by the system, and a metered charge by the system (spec 9.1, the same split as a purchase)", () => {
    expect(checkPosting(renewal())).toMatchObject({
      ok: true,
      value: { kind: "renewal", referenceType: "subscription", walletDelta: -74295n },
    });
    expect(checkPosting(renewal({ actor: { type: "system" } })).ok).toBe(true);
    expect(checkPosting(metered())).toMatchObject({
      ok: true,
      value: { kind: "metered_charge", referenceType: "resource", walletDelta: -74295n },
    });
  });
  it("accepts the exact keys of ledgerKey for a renewal and a metered charge, an hourly period too", () => {
    const at = "2026-12-01T00:00:00.000Z";
    expect(checkPosting(renewal({ idempotencyKey: `renew:${REF}:${at}` })).ok).toBe(true);
    // WPU-Y2: the retry of a domain renewal whose charge was reversed (attempt 1 and on), in the one exact form.
    expect(checkPosting(renewal({ idempotencyKey: `renew:${REF}:${at}:a1` })).ok).toBe(true);
    expect(checkPosting(renewal({ idempotencyKey: `renew:${REF}:${at}:a12` })).ok).toBe(true);
    for (const bad of [
      ":a0",
      ":a01",
      ":a",
      ":a-1",
      ":a1.5",
      ":b1",
      ":a1:a2",
      "a1",
      ":A1",
      ":a100",
    ]) {
      expect(checkPosting(renewal({ idempotencyKey: `renew:${REF}:${at}${bad}` })).ok, bad).toBe(
        false,
      );
    }
    for (const period of ["2026-11-11", "2026-11-11T07"]) {
      expect(
        checkPosting(metered({ idempotencyKey: `meter:${REF}:snapshot_gb:${period}` })).ok,
        period,
      ).toBe(true);
    }
  });
  it("accepts a purchase with a fifth credit line, markup_income, when the markup is above 0", () => {
    expect(checkPosting(withMarkup())).toMatchObject({ ok: true, value: { walletDelta: -74395n } });
    expect(checkPosting(withMarkup(renewal())).ok).toBe(true);
  });
  it("accepts a top-up, both adjustments and a refund, with the change of the wallet", () => {
    expect(checkPosting(topup())).toMatchObject({ ok: true, value: { walletDelta: 150000n } });
    expect(checkPosting(adjustment("credit"))).toMatchObject({
      ok: true,
      value: { walletDelta: 500n },
    });
    expect(checkPosting(adjustment("debit"))).toMatchObject({
      ok: true,
      value: { walletDelta: -500n },
    });
    expect(checkPosting(refund())).toMatchObject({
      ok: true,
      value: { walletDelta: -300n, memo: "paid out through the EPS dashboard" },
    });
  });
  it.each([
    [
      "a purchase that credits the refunds account",
      withLine(purchase(), 1, { account: { type: "refunds" } }),
      "postings[1]",
    ],
    [
      "a purchase with two debit lines that still balance",
      purchase({
        postings: [
          { account: wallet(), direction: "debit", amountMinor: 70000n },
          { account: { type: "revenue_aws_base" }, direction: "credit", amountMinor: 63500n },
          { account: { type: "vat_korea_payable" }, direction: "credit", amountMinor: 6350n },
          { account: { type: "vat_bd_payable" }, direction: "debit", amountMinor: 4295n },
          { account: { type: "processing_fee_income" }, direction: "credit", amountMinor: 4445n },
        ],
      }),
      "postings",
    ],
    [
      "a top-up that debits the wallet",
      topup({
        postings: [
          { account: wallet(), direction: "debit", amountMinor: 5n },
          { account: { type: "gateway_clearing" }, direction: "credit", amountMinor: 5n },
        ],
      }),
      "postings",
    ],
    [
      "a top-up with three lines",
      topup({
        postings: [
          ...topup().postings,
          { account: { type: "refunds" }, direction: "debit", amountMinor: 1n },
          { account: { type: "markup_income" }, direction: "credit", amountMinor: 1n },
        ],
      }),
      "postings",
    ],
    [
      "an adjustment between two platform accounts",
      {
        ...adjustment("credit"),
        postings: [
          { account: { type: "adjustments" }, direction: "debit", amountMinor: 5n },
          { account: { type: "refunds" }, direction: "credit", amountMinor: 5n },
        ],
      },
      "postings",
    ],
    [
      "a refund that credits adjustments",
      withLine(refund(), 1, { account: { type: "adjustments" } }),
      "postings",
    ],
    [
      "a reference type the kind does not use",
      purchase({ reference: { type: "payment", id: REF } }),
      "reference.type",
    ],
    [
      "a top-up with another key than topup:<payment id>",
      topup({ idempotencyKey: "sweeper:" + REF }),
      "idempotencyKey",
    ],
    // the key families (spec 9.1: a key is derived on the server; a client key is never used alone)
    [
      "a purchase under the key of a reversal",
      purchase({ idempotencyKey: `reversal:${REF}` }),
      "idempotencyKey",
    ],
    [
      "a refund under the key of a top-up",
      { ...refund(), idempotencyKey: `topup:${REF}` },
      "idempotencyKey",
    ],
    [
      "an adjustment under the key of another request",
      { ...adjustment("credit"), idempotencyKey: `adjustment:${OTHER}` },
      "idempotencyKey",
    ],
    [
      "a refund under the key of another request",
      { ...refund(), idempotencyKey: `refund:${OTHER}` },
      "idempotencyKey",
    ],
    [
      "a renewal whose key names another subscription",
      renewal({ idempotencyKey: `renew:${OTHER}:2026-12-01T00:00:00.000Z` }),
      "idempotencyKey",
    ],
    [
      "a metered charge whose key names another resource",
      metered({ idempotencyKey: `meter:${OTHER}:snapshot_gb:2026-11-11` }),
      "idempotencyKey",
    ],
    [
      "a renewal under an order key",
      renewal({ idempotencyKey: "order:" + "a".repeat(32) }),
      "idempotencyKey",
    ],
    // the key must have exactly the shape of ledgerKey, not only its prefix (M1): one request, one key
    [
      "a renewal key with a suffix after the period",
      renewal({ idempotencyKey: `renew:${REF}:2026-12-01T00:00:00.000Z:again` }),
      "idempotencyKey",
    ],
    [
      "a renewal key whose period is not an ISO timestamp with milliseconds",
      renewal({ idempotencyKey: `renew:${REF}:2026-12-01` }),
      "idempotencyKey",
    ],
    [
      "a renewal key whose period has no milliseconds",
      renewal({ idempotencyKey: `renew:${REF}:2026-12-01T00:00:00Z` }),
      "idempotencyKey",
    ],
    [
      "a renewal key with a period that is not a date",
      renewal({ idempotencyKey: `renew:${REF}:2026-13-45T00:00:00.000Z` }),
      "idempotencyKey",
    ],
    [
      "a renewal key with nothing after the subscription",
      renewal({ idempotencyKey: `renew:${REF}:` }),
      "idempotencyKey",
    ],
    [
      "a metered key with a suffix after the period",
      metered({ idempotencyKey: `meter:${REF}:snapshot_gb:2026-11-11:again` }),
      "idempotencyKey",
    ],
    [
      "a metered key with a metric of a wrong form",
      metered({ idempotencyKey: `meter:${REF}:Snapshot-GB:2026-11-11` }),
      "idempotencyKey",
    ],
    [
      "a metered key with a period of a wrong form",
      metered({ idempotencyKey: `meter:${REF}:snapshot_gb:november` }),
      "idempotencyKey",
    ],
    [
      "a metered key with no period",
      metered({ idempotencyKey: `meter:${REF}:snapshot_gb` }),
      "idempotencyKey",
    ],
    // the lines, the reference and the reason
    [
      "a purchase without its revenue_aws_base line",
      withLine(purchase(), 1, { account: { type: "markup_income" } }),
      "postings",
    ],
    [
      "a renewal that refers to an order",
      renewal({ reference: { type: "order", id: REF } }),
      "reference.type",
    ],
    ["an adjustment with a blank reason", { ...adjustment("credit"), memo: "" }, "memo"],
    ["a refund with a blank reason", { ...refund(), memo: "  " }, "memo"],
  ] as [string, PostTransactionInput, string][])("refuses %s", (_name, input, path) => {
    const r = checkPosting(input);
    expect(r).toMatchObject({ ok: false, error: "validation" });
    expect(keysOf(r)).toContain(path);
  });
});

describe("who may post what (R6, R8): forbidden, not validation", () => {
  it.each([
    ["a customer posting a top-up", topup({ actor: { type: "customer", id: A } }), "actor"],
    [
      "a customer posting an adjustment",
      { ...adjustment("credit"), actor: { type: "customer", id: A } } as PostTransactionInput,
      "actor",
    ],
    ["an admin posting a purchase", purchase({ actor: { type: "admin", id: B } }), "actor"],
    [
      "a customer posting to the wallet of another customer",
      purchase({ actor: { type: "customer", id: B } }),
      "postings[0].account.customerId",
    ],
    [
      "a customer posting a metered charge",
      metered({ actor: { type: "customer", id: A } }),
      "actor",
    ],
  ] as [string, PostTransactionInput, string][])("%s", (_name, input, path) => {
    const r = checkPosting(input);
    expect(r).toMatchObject({ ok: false, error: "forbidden" });
    expect(keysOf(r)).toEqual([path]);
  });
  it("lets the system post a purchase and an admin post a refund", () => {
    expect(checkPosting(purchase({ actor: { type: "system" } })).ok).toBe(true);
    expect(checkPosting(refund()).ok).toBe(true);
  });
  it("lets an admin post a top-up (reverifyPayment of /payments), under the same key as the system", () => {
    // R6 is the caller's: the ledger cannot verify the payment; it keeps one key per payment and records who posted
    expect(checkPosting(topup({ actor: { type: "admin", id: B } }))).toMatchObject({
      ok: true,
      value: { actor: { type: "admin", id: B } },
    });
    expect(
      checkPosting(topup({ actor: { type: "admin", id: B }, idempotencyKey: `topup:${OTHER}` })),
    ).toMatchObject({ ok: false, error: "validation" });
  });
  it("requires the reason of an admin posting: no memo at all is a validation problem at memo", () => {
    const noMemo: Partial<PostTransactionInput> = { ...refund() };
    delete noMemo.memo;
    expect(keysOf(checkPosting(noMemo))).toEqual(["memo"]);
    const noReason: Partial<PostTransactionInput> = { ...adjustment("debit") };
    delete noReason.memo;
    expect(keysOf(checkPosting(noReason))).toEqual(["memo"]);
  });
  it("the kind reversal (reverseTransaction only): key reversal:<original> or order-reversal:<order>, and the reason of an admin", () => {
    // purchase() carries a memo, so the base is built without one: the admin copy must lack the reason
    const base: Partial<PostTransactionInput> = purchase({
      kind: "reversal",
      reference: { type: "ledger_transaction", id: REF },
      actor: { type: "system" },
      idempotencyKey: `reversal:${REF}`,
    });
    delete base.memo;
    delete base.priceSnapshot; // a reversal is no sale
    const allow = { allowReversal: true };
    expect(checkPosting(base, allow).ok).toBe(true);
    expect(checkPosting({ ...base, idempotencyKey: `order-reversal:${OTHER}` }, allow).ok).toBe(
      true,
    );
    for (const key of [
      "order:" + "a".repeat(32),
      `reversal:${OTHER}`,
      "order-reversal:42",
      `topup:${REF}`,
    ]) {
      expect(keysOf(checkPosting({ ...base, idempotencyKey: key }, allow)), key).toContain(
        "idempotencyKey",
      );
    }
    const byAdmin = { ...base, actor: { type: "admin" as const, id: B } };
    expect(keysOf(checkPosting(byAdmin, allow))).toEqual(["memo"]);
    expect(checkPosting({ ...byAdmin, memo: "provisioning failed" }, allow).ok).toBe(true);
  });
  it("reports a problem of shape before a problem of permission", () => {
    expect(
      checkPosting(topup({ actor: { type: "customer", id: A }, idempotencyKey: "x y" })),
    ).toMatchObject({
      ok: false,
      error: "validation",
    });
  });
});

describe("reversePostings and samePosting", () => {
  it("reversePostings gives the same accounts, the other side, the same amounts, in the same order", () => {
    const r = checkPosting(purchase());
    if (!r.ok) throw new Error("setup");
    const back = reversePostings(r.value.lines);
    expect(back.map((p) => [p.account.type, p.direction, p.amountMinor])).toEqual([
      ["customer_wallet", "credit", 74295n],
      ["revenue_aws_base", "debit", 63500n],
      ["vat_korea_payable", "debit", 6350n],
      ["vat_bd_payable", "debit", 3175n],
      ["processing_fee_income", "debit", 1270n],
    ]);
    expect(back[0]!.account).toEqual({ type: "customer_wallet", customerId: A, currency: "BDT" });
  });
  const stored = {
    kind: "topup",
    referenceType: "payment",
    referenceId: REF,
    lines: [
      { accountId: "a1", direction: "debit" as const, amountMinor: 5n },
      { accountId: "a2", direction: "credit" as const, amountMinor: 5n },
    ],
  };
  // WPU-Y9 finding 7: the same key with another price snapshot is another request, not a replay.
  it("samePosting compares the snapshot of a sale (key order does not matter) and not of other kinds", () => {
    const sale = { ...stored, kind: "metered_charge", referenceType: "resource" };
    const snap = {
      schemaVersion: 1,
      kind: "metered",
      totalMinor: "5",
      fx: { id: "a", rate: "127" },
    };
    const reordered = {
      fx: { rate: "127", id: "a" },
      totalMinor: "5",
      kind: "metered",
      schemaVersion: 1,
    };
    expect(
      samePosting({ ...sale, priceSnapshot: snap }, { ...sale, priceSnapshot: reordered }),
    ).toBe(true);
    expect(
      samePosting(
        { ...sale, priceSnapshot: snap },
        { ...sale, priceSnapshot: { ...snap, fx: { id: "b", rate: "130" } } },
      ),
    ).toBe(false);
    expect(samePosting({ ...sale, priceSnapshot: snap }, { ...sale, priceSnapshot: null })).toBe(
      false,
    );
    // a row from before the snapshot existed (null) is still a replay of the same key
    expect(samePosting({ ...sale, priceSnapshot: null }, { ...sale, priceSnapshot: snap })).toBe(
      true,
    );
    // a kind that is no sale never compares it
    expect(
      samePosting({ ...stored, priceSnapshot: snap }, { ...stored, priceSnapshot: null }),
    ).toBe(true);
  });
  it("samePosting ignores the order of the lines and nothing else", () => {
    expect(samePosting(stored, { ...stored, lines: [...stored.lines].reverse() })).toBe(true);
    expect(samePosting(stored, { ...stored, kind: "refund" })).toBe(false);
    expect(samePosting(stored, { ...stored, referenceId: B })).toBe(false);
    expect(samePosting(stored, { ...stored, referenceType: "order" })).toBe(false);
    expect(
      samePosting(stored, {
        ...stored,
        lines: [{ ...stored.lines[0]!, amountMinor: 6n }, stored.lines[1]!],
      }),
    ).toBe(false);
    expect(
      samePosting(stored, {
        ...stored,
        lines: [{ ...stored.lines[0]!, accountId: "a3" }, stored.lines[1]!],
      }),
    ).toBe(false);
    expect(samePosting(stored, { ...stored, lines: [...stored.lines, stored.lines[0]!] })).toBe(
      false,
    );
  });
});
