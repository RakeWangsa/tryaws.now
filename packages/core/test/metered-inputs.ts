import { quote } from "../pricing/quote";
import type { ChargeInputs } from "../pricing/charge-snapshot";
import type { MeteredUnitPrice } from "../pricing/metering";
import type { PricingRule } from "../pricing/types";
import type { StaticIpPrice } from "../products/static-ip-price";

// WPU-Y9: a metered charge is refused without the price inputs of its unit (R16), so a test world's unit
// price carries some. The amounts of a charge come from the split of the unit, never from these inputs.
const label = { bn: "ক", en: "a" };
const RULE: PricingRule = {
  version: "rule-1",
  steps: [{ code: "bd_vat", rate: "0.05", base: "aws", label }],
};
export const FIXTURE_INPUTS: ChargeInputs = {
  pricedAt: new Date("2026-11-11T08:00:00.000Z"),
  awsPriceUsd: "5",
  quantity: "1",
  fx: { id: "fx-1", rate: "127", effectiveFrom: new Date("2026-11-10T00:00:00.000Z") },
  rule: { id: "rule-id-1", version: "rule-1" },
  book: null,
  quote: quote({ awsPriceUsd: "5", fxRate: "127", rule: RULE }),
};

export const withInputs = <T extends MeteredUnitPrice>(unit: T): T => ({
  ...unit,
  charge: FIXTURE_INPUTS,
});
export const ipWithInputs = (price: StaticIpPrice): StaticIpPrice => ({
  ...price,
  breakdown: withInputs(price.breakdown),
});
