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
  steps: { code: string; amountMinor: Minor }[];
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
