import { and, asc, desc, eq, gt, isNull, lte, sql, type SQL } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { pricingRules } from "../../schema/index";
import { isFlagKeyText, isMarketCode } from "../config/args";
import { lockPricingRuleWrites } from "../config/locks";
import type { PricingRuleRow } from "../config/pricing-rules";
import { refused, type Written } from "../result";
import { audited, isActiveAdmin } from "./audited";
import type { AdminScope } from "./index";

// The step codes that have a ledger account. @tc/db cannot import the engine, so this is a copy; a
// test of core pins it to Object.keys(STEP_ACCOUNTS) (WP1-T4 Task 12), so it cannot drift.
export const STEP_CODES: readonly string[] = Object.freeze([
  "korea_vat",
  "bd_vat",
  "processing_fee",
  "markup",
]);

// The shape of a stored step; PricingStep of core is assignable to it.
export interface PricingStepInput {
  code: string;
  rate: string;
  base: "aws" | "subtotal";
  label: { bn: string; en: string };
}

export interface PricingRuleInput {
  market: string;
  productFamily: string | null;
  steps: readonly PricingStepInput[];
  effectiveFrom: Date;
  at: Date; // the caller's clock reading
}

export type PricingRuleSaved = PricingRuleRow & { laterChangePending: Date | null };

export interface PricingRulesAdminRepo {
  save(input: PricingRuleInput, reason: string): Promise<Written<PricingRuleSaved>>;
}

// Thrown inside the audited write, so that a refusal writes no audit row.
class Conflict extends Error {}

const isInstant = (value: unknown): value is Date =>
  value instanceof Date && !Number.isNaN(value.getTime());

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// The steps in plain form, or null when the shape is wrong. Any field outside code, rate, base and
// label.bn / label.en is dropped. Checks the two rules of the engine that a copy can hold safely: a
// code with an account, and a subtotal step last. The rest is savePricingRule's (open point 7).
function plainSteps(steps: unknown): PricingStepInput[] | null {
  if (!Array.isArray(steps)) return null;
  const plain: PricingStepInput[] = [];
  for (const [index, step] of steps.entries()) {
    if (!isRecord(step)) return null;
    const { code, rate, base, label } = step;
    if (typeof code !== "string" || !STEP_CODES.includes(code)) return null;
    if (typeof rate !== "string") return null;
    if (base !== "aws" && base !== "subtotal") return null;
    if (base === "subtotal" && index !== steps.length - 1) return null;
    if (!isRecord(label) || typeof label.bn !== "string" || typeof label.en !== "string") {
      return null;
    }
    plain.push({ code, rate, base, label: { bn: label.bn, en: label.en } });
  }
  return plain;
}

export function pricingRulesAdminRepo(scope: AdminScope): PricingRulesAdminRepo {
  return {
    async save(input, reason) {
      // Read once into locals, so a getter cannot answer differently on the second read.
      const { market, productFamily, steps, effectiveFrom, at } = input;
      if (!(await isActiveAdmin(scope))) return refused("forbidden");
      const plain = plainSteps(steps);
      if (
        !isMarketCode(market) ||
        (productFamily !== null && !isFlagKeyText(productFamily)) ||
        plain === null ||
        !isInstant(effectiveFrom) ||
        !isInstant(at) ||
        effectiveFrom.getTime() < at.getTime()
      ) {
        return refused("validation");
      }
      const json = JSON.stringify(plain);
      const { tx, actor } = scope;
      const target = `${market}/${productFamily ?? "*"}@${effectiveFrom.toISOString()}`;
      try {
        return await audited(
          scope,
          {
            action: "pricing_rule.save",
            targetType: "pricing_rule",
            targetId: target,
            reason,
          },
          async () => {
            // Serializes the saves of one market: the reads below see every committed row.
            await lockPricingRuleWrites(tx, market);
            // The scope of the family only: a family rule with the steps of the market rule is still
            // a new override.
            const inScope: SQL =
              productFamily === null
                ? isNull(pricingRules.productFamily)
                : eq(pricingRules.productFamily, productFamily);
            const columns = {
              id: pricingRules.id,
              productFamily: pricingRules.productFamily,
              steps: pricingRules.steps,
              effectiveFrom: pricingRules.effectiveFrom,
              same: sql<boolean>`(${pricingRules.steps} = ${json}::jsonb)`,
            };
            const [atStart] = await tx
              .select(columns)
              .from(pricingRules)
              .where(
                and(
                  eq(pricingRules.market, market),
                  inScope,
                  eq(pricingRules.effectiveFrom, effectiveFrom),
                ),
              )
              .limit(1);
            const [inForce] = await tx
              .select(columns)
              .from(pricingRules)
              .where(
                and(eq(pricingRules.market, market), inScope, lte(pricingRules.effectiveFrom, at)),
              )
              .orderBy(desc(pricingRules.effectiveFrom))
              .limit(1);
            const before = inForce
              ? {
                  id: inForce.id,
                  productFamily: inForce.productFamily,
                  effectiveFrom: inForce.effectiveFrom.toISOString(),
                }
              : null;
            const saved = (
              row: { id: string; steps: unknown; effectiveFrom: Date },
              laterChangePending: Date | null,
            ): PricingRuleSaved => ({
              id: row.id,
              market,
              productFamily,
              steps: row.steps as unknown[],
              effectiveFrom: row.effectiveFrom,
              laterChangePending,
            });
            const after = (value: PricingRuleSaved) => ({
              id: value.id,
              productFamily: value.productFamily,
              effectiveFrom: value.effectiveFrom.toISOString(),
              steps: value.steps,
            });
            if (atStart) {
              if (!atStart.same) throw new Conflict();
              const value = saved(atStart, null);
              return { value, replayed: true, before, after: after(value) };
            }
            if (inForce?.same && effectiveFrom.getTime() === at.getTime()) {
              // Saving the steps in force does not withdraw a scheduled change: it reports it.
              const [later] = await tx
                .select({ effectiveFrom: pricingRules.effectiveFrom })
                .from(pricingRules)
                .where(
                  and(eq(pricingRules.market, market), inScope, gt(pricingRules.effectiveFrom, at)),
                )
                .orderBy(asc(pricingRules.effectiveFrom))
                .limit(1);
              const value = saved(inForce, later?.effectiveFrom ?? null);
              return { value, replayed: true, before, after: after(value) };
            }
            // Only the granted columns: a Drizzle insert() would name created_at (42501).
            const result = await tx.execute(
              sql`insert into pricing_rules (id, market, product_family, steps, effective_from, set_by)
                  values (${uuidv7()}, ${market}, ${productFamily}, ${json}::jsonb, ${effectiveFrom}, ${actor.adminId})
                  on conflict (market, product_family, effective_from) do nothing
                  returning id`,
            );
            const inserted = result.rows[0] as unknown as { id: string } | undefined;
            // Cannot happen while the lock is held (every other saver of the market waits or has
            // finished); a guard only (open point 20).
            if (!inserted) {
              throw new Error("pricing_rules: a rule for this start was saved at the same moment");
            }
            const value = saved({ id: inserted.id, steps: plain, effectiveFrom }, null);
            return { value, replayed: false, before, after: after(value) };
          },
        );
      } catch (error) {
        if (error instanceof Conflict) return refused("conflict");
        throw error;
      }
    },
  };
}
