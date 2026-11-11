import { adminRepos, type AdminActor, type Tx } from "@tc/db";
import { problemFields, validateRule, type PricingStep } from "../pricing/index";
import type { Clock, Result } from "../types";
import { marketProblem, reasonProblem, resolveStart, scopeProblems } from "./common";

export interface SavePricingRuleInput {
  market: string;
  /** A product family (a feature flag key), or null for the rule of the whole market. */
  productFamily: string | null;
  steps: PricingStep[];
  /** Defaults to the instant of the call. Never in the past, at most 90 days ahead. */
  effectiveFrom?: Date;
  reason: string;
}

export interface SavedPricingRule {
  /** The version of the rule: `PriceQuote.ruleVersion` carries it. */
  ruleId: string;
  productFamily: string | null;
  effectiveFrom: Date;
  replayed: boolean;
}

/**
 * Saves a pricing rule. The only way for an application to do it (open point 7): the engine's own
 * checks run first, so a rule it refuses never reaches the table (spec section 8). R10: the write is
 * audited by the repository. No role check (open point 8). Fails closed (R16).
 */
export async function savePricingRule(
  tx: Tx,
  actor: AdminActor,
  input: SavePricingRuleInput,
  clock: Clock,
): Promise<Result<SavedPricingRule>> {
  const at = clock.now();
  const { market, productFamily, steps, effectiveFrom, reason } = input;
  const fields: Record<string, string> = scopeProblems({ market, productFamily });
  const why = reasonProblem(reason);
  if (why !== null) fields.reason = why;
  const start = resolveStart(effectiveFrom, at);
  if (!start.ok) fields.effectiveFrom = start.problem;
  // The version does not exist before the save; the engine only needs some text there.
  Object.assign(fields, problemFields(validateRule({ version: "new", steps })));
  if (!start.ok || Object.keys(fields).length > 0) {
    return { ok: false, error: "validation", fields };
  }

  const unknown = await marketProblem(tx, market);
  if (unknown !== null) return { ok: false, error: "validation", fields: { market: unknown } };

  const written = await adminRepos(tx, actor).pricingRules.save(
    { market, productFamily, steps, effectiveFrom: start.value, at },
    reason,
  );
  if (written.ok) {
    return {
      ok: true,
      value: {
        ruleId: written.value.id,
        productFamily,
        effectiveFrom: written.value.effectiveFrom,
        replayed: written.replayed,
      },
    };
  }
  if (written.error === "conflict") {
    return { ok: false, error: "conflict", fields: { effectiveFrom: "taken_by_other_steps" } };
  }
  return { ok: false, error: "validation", fields: { steps: "invalid" } };
}
