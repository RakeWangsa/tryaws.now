import { expect, it } from "vitest";
import * as pricing from "./index";

it("exports exactly the public API of the pricing engine", () => {
  expect(Object.keys(pricing).sort()).toEqual([
    "FX_SECOND_ADMIN_PERCENT",
    "PricingInputError",
    "STEP_ACCOUNTS",
    "accountFor",
    "fxChangeNeedsSecondAdmin",
    "isFxRateText",
    "isPlainDecimal",
    "isPositiveDecimal",
    "isPricingRule",
    "quote",
    "validateRule",
  ]);
});
