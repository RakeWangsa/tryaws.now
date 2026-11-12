import { planFitsImage } from "@tc/core";
import { describe, expect, it } from "vitest";
import { planFits } from "./plan-fit.ts";

describe("planFits is the rule of planFitsImage in the core", () => {
  const minimums = [0, 1, 500, 1000, 2000];
  const powers = [null, 0, 499, 500, 999, 1000, 1001, 2000, 4000];
  it.each(minimums.flatMap((m) => powers.map((p) => [m, p] as const)))(
    "minimum %i, plan power %s",
    (min, power) => {
      expect(planFits(min, power)).toBe(planFitsImage(min, power));
    },
  );
  it("an unknown minimum or power in the props reads as 0 and as unknown", () => {
    expect(planFits(undefined, undefined)).toBe(true);
    expect(planFits(1000, undefined)).toBe(false);
  });
});
