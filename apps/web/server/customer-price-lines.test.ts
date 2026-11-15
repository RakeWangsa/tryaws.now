import { describe, expect, it } from "vitest";
import { customerPriceLines } from "./customer-price-lines.ts";

// WPU-X25 (owner decision 2026-11-15): the customer sees no line called Korea VAT, but its amount stays in the
// price. The helper folds it into the first (service price) line; the total is never changed (R4, R16).

const NANO = {
  baseMinor: 63500n,
  steps: [
    { code: "korea_vat", amountMinor: 6350n },
    { code: "bd_vat", amountMinor: 3175n },
    { code: "processing_fee", amountMinor: 1270n },
  ],
  totalMinor: 74295n,
};

describe("customerPriceLines", () => {
  it("folds korea_vat into the first line: the 742.95 BDT Nano example shows 698.50, 31.75, 12.70", () => {
    const lines = customerPriceLines(NANO.baseMinor, NANO.steps, NANO.totalMinor);
    expect(lines.baseMinor).toBe(69850n);
    expect(lines.steps).toEqual([
      { code: "bd_vat", amountMinor: 3175n },
      { code: "processing_fee", amountMinor: 1270n },
    ]);
    expect(lines.totalMinor).toBe(74295n);
  });

  it("leaves lines untouched when there is no korea_vat step (an older snapshot)", () => {
    const steps = [{ code: "bd_vat", amountMinor: 9000n }];
    const lines = customerPriceLines(60000n, steps, 69000n);
    expect(lines).toEqual({ baseMinor: 60000n, steps, totalMinor: 69000n });
  });

  it("folds korea_vat wherever it stands and keeps the other steps in their order", () => {
    const lines = customerPriceLines(
      63500n,
      [
        { code: "bd_vat", amountMinor: 3175n },
        { code: "korea_vat", amountMinor: 6350n },
        { code: "processing_fee", amountMinor: 1270n },
      ],
      74295n,
    );
    expect(lines.baseMinor).toBe(69850n);
    expect(lines.steps.map((s) => s.code)).toEqual(["bd_vat", "processing_fee"]);
  });

  it("the shown lines always add up to the total exactly", () => {
    const lines = customerPriceLines(NANO.baseMinor, NANO.steps, NANO.totalMinor);
    const sum = lines.steps.reduce((acc, s) => acc + s.amountMinor, lines.baseMinor);
    expect(sum).toBe(lines.totalMinor);
  });

  it("does not change its input", () => {
    const steps = [...NANO.steps];
    customerPriceLines(NANO.baseMinor, steps, NANO.totalMinor);
    expect(steps).toEqual(NANO.steps);
  });

  it("refuses lines that do not add up to the stored total (R16), with or without korea_vat", () => {
    expect(() => customerPriceLines(63500n, NANO.steps, 74296n)).toThrow(RangeError);
    expect(() => customerPriceLines(60000n, [], 60001n)).toThrow(RangeError);
  });

  it("refuses a non-bigint amount (R4)", () => {
    expect(() =>
      customerPriceLines(63500 as unknown as bigint, NANO.steps, NANO.totalMinor),
    ).toThrow(TypeError);
    expect(() =>
      customerPriceLines(1n, [{ code: "korea_vat", amountMinor: 1 as unknown as bigint }], 2n),
    ).toThrow(TypeError);
  });

  it("a total with only korea_vat on top of the base shows one line", () => {
    const lines = customerPriceLines(1000n, [{ code: "korea_vat", amountMinor: 100n }], 1100n);
    expect(lines).toEqual({ baseMinor: 1100n, steps: [], totalMinor: 1100n });
  });
});
