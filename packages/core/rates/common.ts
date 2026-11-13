import {
  isFeatureFlagKey,
  readFxRateInForce,
  readMarketBasics,
  readPricingRuleInForce,
  type FxRateRow,
  type PricingRuleRow,
  type Tx,
} from "@tc/db";
import { isPricingRule, type PricingRule } from "../pricing/index";

/** The longest reason an admin may give for a change. */
export const MAX_REASON_LENGTH = 500;
/** A change may start at most this many days after the call that saves it. */
export const MAX_SCHEDULE_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;
const MARKET_TEXT = /^[A-Z]{2}$/;
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isMarketText(v: unknown): v is string {
  return typeof v === "string" && MARKET_TEXT.test(v);
}

export function isUuidText(v: unknown): v is string {
  return typeof v === "string" && UUID_TEXT.test(v);
}

export function reasonProblem(reason: unknown): "required" | "too_long" | null {
  if (typeof reason !== "string" || reason.trim() === "") return "required";
  return reason.length > MAX_REASON_LENGTH ? "too_long" : null;
}

export async function marketProblem(
  tx: Tx,
  market: unknown,
): Promise<"invalid" | "unknown" | null> {
  if (!isMarketText(market)) return "invalid";
  return (await readMarketBasics(tx, market)) === null ? "unknown" : null;
}

export type Start =
  { ok: true; value: Date } | { ok: false; problem: "invalid" | "in_the_past" | "too_far_ahead" };

/** The start of a change: `given`, or `at` when not given. Never before `at`; at most `maxDays` (default 90) after. */
export function resolveStart(
  given: Date | undefined,
  at: Date,
  maxDays: number = MAX_SCHEDULE_DAYS,
): Start {
  const value = given ?? at;
  if (!(value instanceof Date) || Number.isNaN(value.getTime()))
    return { ok: false, problem: "invalid" };
  if (Number.isNaN(at.getTime())) return { ok: false, problem: "invalid" };
  if (value.getTime() < at.getTime()) return { ok: false, problem: "in_the_past" };
  if (value.getTime() - at.getTime() > maxDays * DAY_MS) {
    return { ok: false, problem: "too_far_ahead" };
  }
  return { ok: true, value };
}

export interface Scope {
  market: string;
  productFamily: string | null;
}

export function scopeProblems(scope: Scope): Record<string, string> {
  const problems: Record<string, string> = {};
  if (!isMarketText(scope.market)) problems.market = "invalid";
  if (scope.productFamily !== null && !isFeatureFlagKey(scope.productFamily)) {
    problems.productFamily = "unknown";
  }
  return problems;
}

/** The rate and the rule row in force for a scope at one instant. The family rule beats the market rule. */
export async function readInForce(
  tx: Tx,
  scope: Scope,
  at: Date,
): Promise<{ fx: FxRateRow | null; row: PricingRuleRow | null }> {
  const fx = await readFxRateInForce(tx, scope.market, at);
  const row = await readPricingRuleInForce(tx, scope.market, scope.productFamily, at);
  return { fx, row };
}

/** The rule of the engine for a stored row; null when the engine refuses what was stored. */
export function ruleOf(row: PricingRuleRow): PricingRule | null {
  const rule = { version: row.id, steps: row.steps };
  return isPricingRule(rule) ? rule : null;
}
