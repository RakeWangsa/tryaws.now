import { describe, expect, it } from "vitest";
import { decide } from "../decide";
import type { Action, StoredPayment, PaymentState } from "../state";
import { PAYMENT_STATES } from "../state";
import type { EpsStatus, VerifyReading } from "../status";

const ID = "TCP" + "a".repeat(32);
const OTHER = "TCP" + "b".repeat(32);

function pay(over: Partial<StoredPayment> = {}): StoredPayment {
  return {
    id: "p-1",
    customerId: "c-1",
    amountMinor: 150000n,
    currency: "BDT",
    status: "redirected",
    merchantTransactionId: ID,
    gatewayTransactionId: null,
    createdAt: new Date("2030-01-01T00:00:00Z"),
    ...over,
  };
}

function read(over: Partial<VerifyReading> = {}): VerifyReading {
  return {
    status: "success",
    merchantTransactionId: ID,
    epsTransactionId: "E1",
    totalAmountMinor: 150000n,
    errorCode: null,
    ...over,
  };
}

type Case = [
  name: string,
  payment: Partial<StoredPayment>,
  reading: Partial<VerifyReading>,
  expected: Action,
  elsewhere?: boolean,
];

const CASES: Case[] = [
  [
    "success, same id, same amount, redirected",
    {},
    {},
    { type: "credit", gatewayTransactionId: "E1" },
  ],
  [
    "success, same id, same amount, initiated",
    { status: "initiated" },
    {},
    { type: "credit", gatewayTransactionId: "E1" },
  ],
  [
    "success without an eps id still credits (id null)",
    {},
    { epsTransactionId: null },
    { type: "credit", gatewayTransactionId: null },
  ],
  [
    "success, smaller amount",
    {},
    { totalAmountMinor: 15000n },
    { type: "review", reason: "amount_mismatch" },
  ],
  [
    "success, larger amount",
    {},
    { totalAmountMinor: 150001n },
    { type: "review", reason: "amount_mismatch" },
  ],
  [
    "success, zero amount",
    {},
    { totalAmountMinor: 0n },
    { type: "review", reason: "amount_mismatch" },
  ],
  [
    "success, absent amount",
    {},
    { totalAmountMinor: null },
    { type: "review", reason: "amount_mismatch" },
  ],
  [
    "success, another id",
    {},
    { merchantTransactionId: OTHER },
    { type: "review", reason: "id_mismatch" },
  ],
  [
    "success, absent id",
    {},
    { merchantTransactionId: null },
    { type: "review", reason: "id_mismatch" },
  ],
  [
    "success, another id and another amount: id wins",
    {},
    { merchantTransactionId: OTHER, totalAmountMinor: 1n },
    { type: "review", reason: "id_mismatch" },
  ],
  [
    "success, gateway id used by another payment",
    {},
    {},
    { type: "review", reason: "gateway_id_reused" },
    true,
  ],
  [
    "success, wrong amount and reused gateway id: amount wins",
    {},
    { totalAmountMinor: 1n },
    { type: "review", reason: "amount_mismatch" },
    true,
  ],
  ["success on expired", { status: "expired" }, {}, { type: "review", reason: "late_success" }],
  ["success on failed", { status: "failed" }, {}, { type: "review", reason: "late_success" }],
  ["success on cancelled", { status: "cancelled" }, {}, { type: "review", reason: "late_success" }],
  [
    "success on expired with a wrong amount",
    { status: "expired" },
    { totalAmountMinor: 1n },
    { type: "review", reason: "amount_mismatch" },
  ],
  [
    "success twice on credited",
    { status: "credited" },
    {},
    { type: "noop", reason: "already_credited" },
  ],
  [
    "a wrong amount on credited changes nothing",
    { status: "credited" },
    { totalAmountMinor: 1n },
    { type: "noop", reason: "already_credited" },
  ],
  ["anything on review", { status: "review" }, {}, { type: "noop", reason: "in_review" }],
  [
    "success with a currency other than BDT",
    { currency: "USD" },
    {},
    { type: "review", reason: "currency" },
  ],
  ["failed on redirected", {}, { status: "failed" }, { type: "move", to: "failed" }],
  [
    "failed on initiated",
    { status: "initiated" },
    { status: "failed" },
    { type: "move", to: "failed" },
  ],
  ["cancelled on redirected", {}, { status: "cancelled" }, { type: "move", to: "cancelled" }],
  [
    "failed on a closed state",
    { status: "expired" },
    { status: "failed" },
    { type: "noop", reason: "closed" },
  ],
  [
    "cancelled on a closed state",
    { status: "failed" },
    { status: "cancelled" },
    { type: "noop", reason: "closed" },
  ],
  [
    "failed with another id",
    {},
    { status: "failed", merchantTransactionId: OTHER },
    { type: "noop", reason: "unknown" },
  ],
  [
    "failed with an absent id",
    {},
    { status: "failed", merchantTransactionId: null },
    { type: "noop", reason: "unknown" },
  ],
  ["pending", {}, { status: "pending" }, { type: "noop", reason: "pending" }],
  ["unknown (never credit)", {}, { status: "unknown" }, { type: "noop", reason: "unknown" }],
  [
    "unknown with all the fields of a success",
    {},
    { status: "unknown", totalAmountMinor: 150000n },
    { type: "noop", reason: "unknown" },
  ],
  [
    "pending on a closed state",
    { status: "failed" },
    { status: "pending" },
    { type: "noop", reason: "pending" },
  ],
];

describe("decide", () => {
  for (const [name, payment, reading, expected, elsewhere] of CASES) {
    it(name, () => {
      expect(
        decide({
          payment: pay(payment),
          reading: read(reading),
          gatewayIdUsedElsewhere: elsewhere ?? false,
        }),
      ).toEqual(expected);
    });
  }

  it("has at least 30 cases", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(30);
  });

  it("never reads the clock and never throws on a hostile row", () => {
    const hostile = pay({ createdAt: new Date(NaN), amountMinor: -5n, gatewayTransactionId: "x" });
    expect(() =>
      decide({ payment: hostile, reading: read(), gatewayIdUsedElsewhere: false }),
    ).not.toThrow();
    expect(
      decide({ payment: hostile, reading: read(), gatewayIdUsedElsewhere: false }).type,
    ).not.toBe("credit");
  });

  it("does not mutate its input", () => {
    const payment = pay();
    const reading = read();
    const before = JSON.stringify({ payment, reading }, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    decide({ payment, reading, gatewayIdUsedElsewhere: false });
    expect(
      JSON.stringify({ payment, reading }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    ).toBe(before);
  });

  it("credits only for a success with the same id and amount on an open payment (5000 random readings)", () => {
    let seed = 987654321n;
    const next = (n: number): number => {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n;
      return Number((seed >> 33n) % BigInt(n));
    };
    const statuses: EpsStatus[] = ["success", "failed", "cancelled", "pending", "unknown"];
    const amounts = [150000n, 15000n, 150001n, 0n, null];
    const ids = [ID, OTHER, null];
    const currencies = ["BDT", "USD"];
    let credits = 0;
    for (let i = 0; i < 5000; i++) {
      const payment = pay({
        status: PAYMENT_STATES[next(PAYMENT_STATES.length)] as PaymentState,
        currency: currencies[next(2)] as string,
      });
      const reading = read({
        status: statuses[next(statuses.length)] as EpsStatus,
        merchantTransactionId: ids[next(ids.length)] ?? null,
        totalAmountMinor: amounts[next(amounts.length)] ?? null,
      });
      const elsewhere = next(4) === 0;
      const action = decide({ payment, reading, gatewayIdUsedElsewhere: elsewhere });
      const mayCredit =
        reading.status === "success" &&
        reading.merchantTransactionId === payment.merchantTransactionId &&
        reading.totalAmountMinor === payment.amountMinor &&
        (payment.status === "initiated" || payment.status === "redirected") &&
        payment.currency === "BDT" &&
        !elsewhere;
      expect(
        action.type === "credit",
        JSON.stringify([payment.status, reading.status, elsewhere], (_k, v) =>
          typeof v === "bigint" ? v.toString() : v,
        ),
      ).toBe(mayCredit);
      if (action.type === "credit") credits += 1;
    }
    expect(credits).toBeGreaterThan(0);
  });
});
