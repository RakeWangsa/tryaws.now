import type { Tx } from "@tc/db";
import {
  isFxRateText,
  previewPricing,
  type PreviewSample,
  type PricingBasis,
  type PricingPreview,
  type PricingStep,
} from "../pricing/index";
import type { Clock, Result } from "../types";
import { readInForce, ruleOf, scopeProblems } from "./common";

/**
 * The five samples under a candidate rate and/or candidate steps, next to what is in force now.
 * What is not given is taken from what is in force; with nothing given every change is 0.
 * The candidate rule is not saved, so its version is the text "preview". Nothing is written.
 */
export async function previewChange(
  tx: Tx,
  input: {
    market: string;
    productFamily: string | null;
    fxRate?: string;
    steps?: PricingStep[];
    samples?: readonly PreviewSample[];
  },
  clock: Clock,
): Promise<Result<PricingPreview>> {
  const at = clock.now();
  const problems = scopeProblems(input);
  if (input.fxRate !== undefined && !isFxRateText(input.fxRate)) problems.fxRate = "invalid";
  if (Object.keys(problems).length > 0) return { ok: false, error: "validation", fields: problems };

  const { fx, row } = await readInForce(tx, input, at);
  const currentRule = row === null ? null : ruleOf(row);
  const current: PricingBasis | null =
    fx !== null && currentRule !== null ? { fxRate: fx.rate, rule: currentRule } : null;

  const fxRate = input.fxRate ?? fx?.rate;
  const steps = input.steps ?? currentRule?.steps;
  const missing: Record<string, string> = {};
  if (fxRate === undefined) missing.fxRate = "not_in_force";
  if (steps === undefined) missing.steps = "not_in_force";
  if (fxRate === undefined || steps === undefined) {
    return { ok: false, error: "validation", fields: missing };
  }

  return previewPricing({
    candidate: { fxRate, rule: { version: "preview", steps } },
    current,
    ...(input.samples === undefined ? {} : { samples: input.samples }),
  });
}
