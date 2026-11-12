import type { Locale, Minor } from "../types";

export interface PricingStep {
  code: string;
  rate: string;
  base: "aws" | "subtotal";
  label: Record<Locale, string>;
}
export interface PriceQuote {
  currency: "BDT";
  fxRate: string;
  ruleVersion: string;
  baseMinor: Minor;
  /**
   * `rate` is the rate that priced the step, as the text of the rule (WPU-I2: the tax invoice prints it).
   * It is only reported: no amount is computed from it here, and a snapshot stored before has none.
   */
  steps: { code: string; amountMinor: Minor; rate?: string }[];
  totalMinor: Minor;
}
export interface PricingRule {
  version: string;
  steps: PricingStep[];
}
export interface QuoteInput {
  awsPriceUsd: string;
  quantity?: string;
  fxRate: string;
  rule: PricingRule;
}
