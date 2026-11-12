import { describe, expect, it } from "vitest";
import { planCreditMinor, type PlanCreditInput } from "./plan-credit";

// WPU-M3: the amount a customer is owed when a paid plan change was not delivered. Pure: the prices
// come from the pricing engine (quoteInForce) and are passed in as paisa.
const DAY = 24 * 3_600_000;
const START = new Date("2026-11-01T00:00:00.000Z");
const END = new Date(START.getTime() + 30 * DAY);

const base: PlanCreditInput = {
  rule: "difference",
  chargedMinor: 4000n,
  deliveredMinor: 1000n,
  periodStart: START,
  periodEnd: END,
};
const at = (days: number, extraMs = 0) => new Date(START.getTime() + days * DAY + extraMs);

describe("planCreditMinor", () => {
  it("failed upgrade: the FULL difference between the charge and the plan that was delivered", () => {
    expect(planCreditMinor(base)).toEqual({
      ok: true,
      value: { creditMinor: 3000n, expressibleByReversal: false },
    });
  });

  it("complete: the whole charge, and only this one the existing reversal can post", () => {
    expect(planCreditMinor({ ...base, rule: "complete", deliveredMinor: null })).toEqual({
      ok: true,
      value: { creditMinor: 4000n, expressibleByReversal: true },
    });
  });

  it("late downgrade: the difference pro rata by the days that remain from the apply", () => {
    const late: PlanCreditInput = {
      ...base,
      rule: "prorata",
      chargedMinor: 3000n,
      deliveredMinor: 1200n,
      effectiveFrom: at(10),
    };
    // 1800 paisa of difference × 20 days left of 30 = 1200
    expect(planCreditMinor(late)).toEqual({
      ok: true,
      value: { creditMinor: 1200n, expressibleByReversal: false },
    });
    // a part of a day counts as a whole day left: 19.75 days left is 20
    expect(planCreditMinor({ ...late, effectiveFrom: at(10, 6 * 3_600_000) })).toMatchObject({
      ok: true,
      value: { creditMinor: 1200n },
    });
    // applied at the start: the whole difference; applied at the end: nothing is left to credit
    expect(planCreditMinor({ ...late, effectiveFrom: START })).toMatchObject({
      value: { creditMinor: 1800n },
    });
    expect(planCreditMinor({ ...late, effectiveFrom: END })).toMatchObject({
      value: { creditMinor: 0n },
    });
  });

  it("rounds half-up, never with a float", () => {
    // difference 1 paisa × 15 of 30 days = 0.5 -> 1
    expect(
      planCreditMinor({
        ...base,
        rule: "prorata",
        chargedMinor: 1001n,
        deliveredMinor: 1000n,
        effectiveFrom: at(15),
      }),
    ).toMatchObject({ value: { creditMinor: 1n } });
    // difference 1 paisa × 14 of 30 days = 0.47 -> 0
    expect(
      planCreditMinor({
        ...base,
        rule: "prorata",
        chargedMinor: 1001n,
        deliveredMinor: 1000n,
        effectiveFrom: at(16),
      }),
    ).toMatchObject({ value: { creditMinor: 0n } });
  });

  it("refuses a missing, zero or negative price (R16)", () => {
    expect(planCreditMinor({ ...base, deliveredMinor: null })).toMatchObject({
      ok: false,
      error: "validation",
    });
    expect(planCreditMinor({ ...base, deliveredMinor: 0n })).toMatchObject({
      ok: false,
      error: "validation",
    });
    expect(planCreditMinor({ ...base, chargedMinor: null })).toMatchObject({
      ok: false,
      error: "validation",
    });
    expect(planCreditMinor({ ...base, chargedMinor: 0n })).toMatchObject({ ok: false });
    expect(planCreditMinor({ ...base, deliveredMinor: -1n })).toMatchObject({ ok: false });
    expect(planCreditMinor({ ...base, chargedMinor: 4000 as never })).toMatchObject({ ok: false });
  });

  it("owes nothing when the delivered plan is not cheaper than the charge", () => {
    expect(planCreditMinor({ ...base, deliveredMinor: 4000n })).toMatchObject({
      ok: false,
      error: "conflict",
    });
    expect(planCreditMinor({ ...base, deliveredMinor: 5000n })).toMatchObject({
      ok: false,
      error: "conflict",
    });
  });

  it("refuses a period that is not whole days, or a start outside the period (R16)", () => {
    const p: PlanCreditInput = { ...base, rule: "prorata", effectiveFrom: at(1) };
    expect(planCreditMinor({ ...p, periodEnd: new Date(END.getTime() + 1) })).toMatchObject({
      ok: false,
      error: "validation",
    });
    expect(planCreditMinor({ ...p, periodEnd: START })).toMatchObject({ ok: false });
    expect(planCreditMinor({ ...p, periodStart: new Date("x") })).toMatchObject({ ok: false });
    const late: PlanCreditInput = { ...p, effectiveFrom: at(-1) };
    expect(planCreditMinor(late)).toMatchObject({ ok: false, error: "validation" });
    expect(planCreditMinor({ ...late, effectiveFrom: at(31) })).toMatchObject({ ok: false });
    expect(planCreditMinor({ ...late, effectiveFrom: undefined })).toMatchObject({ ok: false });
  });

  it("does not change its input", () => {
    const frozen = Object.freeze({ ...base });
    expect(() => planCreditMinor(frozen)).not.toThrow();
  });
});
