import type { PriceSnapshot } from "../pricing/index";

export type PriceDifference =
  "fx_rate" | "rule_version" | "aws_price" | "quantity" | "base" | "steps" | "total";

/**
 * Compares the snapshot of a draft token with a fresh one, field by field. Money is compared as
 * BigInt, never as text and never with a tolerance (R4). `pricedAt` is never compared: the two
 * instants differ by definition. Both snapshots must already have passed parseSnapshot.
 */
export function comparePrice(
  token: PriceSnapshot,
  fresh: PriceSnapshot,
): { same: true } | { same: false; differences: PriceDifference[] } {
  const differences: PriceDifference[] = [];
  if (token.fxRate !== fresh.fxRate) differences.push("fx_rate");
  if (token.ruleVersion !== fresh.ruleVersion) differences.push("rule_version");
  if (token.awsPriceUsd !== fresh.awsPriceUsd) differences.push("aws_price");
  if (token.quantity !== fresh.quantity) differences.push("quantity");
  if (BigInt(token.baseMinor) !== BigInt(fresh.baseMinor)) differences.push("base");
  const stepsDiffer =
    token.steps.length !== fresh.steps.length ||
    token.steps.some((s, i) => {
      const other = fresh.steps[i];
      return (
        other === undefined ||
        s.code !== other.code ||
        BigInt(s.amountMinor) !== BigInt(other.amountMinor)
      );
    });
  if (stepsDiffer) differences.push("steps");
  if (BigInt(token.totalMinor) !== BigInt(fresh.totalMinor)) differences.push("total");
  return differences.length === 0 ? { same: true } : { same: false, differences };
}
