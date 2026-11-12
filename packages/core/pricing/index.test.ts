import { expect, it } from "vitest";
import * as pricing from "./index";

it("exports exactly the public API of the pricing engine", () => {
  expect(Object.keys(pricing).sort()).toEqual([
    "BOOK_KINDS",
    "BOOK_MAX_COMMISSION_PERCENT",
    "BOOK_MAX_MARGIN_PERCENT",
    "FX_SECOND_ADMIN_PERCENT",
    "PREVIEW_SAMPLES",
    "PricingInputError",
    "SNAPSHOT_VERSION",
    "STEP_ACCOUNTS",
    "SnapshotError",
    "accountFor",
    "allowanceLevel",
    "dailyMeteredChargeMinor",
    "decimalAtMost",
    "fxChangeNeedsSecondAdmin",
    "isBookTerms",
    "isFxRateText",
    "isPlainDecimal",
    "isPositiveDecimal",
    "isPricingRule",
    "parseSnapshot",
    "previewPricing",
    "problemFields",
    "quote",
    "quoteWithBook",
    "snapshotToQuote",
    "toSnapshot",
    "validateBookTerms",
    "validateRule",
  ]);
});
