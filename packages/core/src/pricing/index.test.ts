import { expect, it } from "vitest";
import * as pricing from "./index";

it("exports exactly the public API of the pricing engine", () => {
  expect(Object.keys(pricing).sort()).toEqual([
    "PricingInputError",
    "STEP_ACCOUNTS",
    "accountFor",
    "isPlainDecimal",
    "isPositiveDecimal",
    "isPricingRule",
    "quote",
    "validateRule",
  ]);
});
