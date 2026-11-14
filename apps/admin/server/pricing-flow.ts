import { isBlueprintId, isMarket } from "./schemas.ts";
import type {
  previewBook as PreviewBook,
  previewChange as PreviewChange,
  previewConfigPrice as PreviewConfigPrice,
  savePricingRule as SavePricingRule,
  setFeatureFlag as SetFeatureFlag,
  setFxRate as SetFxRate,
} from "@tc/core";
import {
  FX_CONFIRM_PERCENT,
  fxChangeNeedsConfirm,
  fxRateInSaneRange,
  isFeatureFlag,
  isFxRateText,
} from "@tc/core";
import {
  IMAGE_MIN_POWER_MAX,
  type AdminActor,
  type AdminRepos,
  type AdminRole,
  type Tx,
} from "@tc/db";
import { MAX_DRAFT_STEPS, startOf } from "./pricing-draft.ts";

// The actions of /pricing and /catalog in the order of R9: authenticate and authorize (the roles of the
// area), validate, rate limit, execute (one transaction; every write goes through the core engines, which
// write through `audited`, so actor, reason, IP and target are stored, R10), and a fixed answer. No next/*
// import here: the Server Actions wire the real pieces, so every step is tested with fakes. Answers are
// fixed codes and the NAMES of fields, never the text of an engine message or of an error (R14, R16).

export const PRICING_ROLES: readonly AdminRole[] = ["finance", "superadmin"];
export const FLAG_ROLES: readonly AdminRole[] = ["ops", "superadmin"];

export const MAX_REASON = 500;
// Switching a family ON in production needs a reason that says something (R12).
export const PRODUCTION_REASON_MIN = 10;

export interface CorePorts {
  readonly previewChange: typeof PreviewChange;
  // The live preview of the price list (WPA-P1).
  readonly previewBook: typeof PreviewBook;
  // The live preview of a config price (WPU-G10).
  readonly previewConfigPrice: typeof PreviewConfigPrice;
  readonly savePricingRule: typeof SavePricingRule;
  readonly setFxRate: typeof SetFxRate;
  readonly setFeatureFlag: typeof SetFeatureFlag;
  // The rate in force for a market at an instant (readFxRateInForce), or null.
  readonly fxInForce: (tx: Tx, market: string, at: Date) => Promise<{ rate: string } | null>;
}

// WPU-Y1. The sanity checks of a typed rate, configurable by the caller that wires the flow. A rate outside the range
// of its market is refused outright (a slipped decimal point); a change of more than `confirmPercent` percent from the
// rate in force needs the extra confirm field of BOTH the admin who asks and the admin who approves.
export interface FxPolicy {
  readonly confirmPercent: bigint;
  readonly ranges: Readonly<Record<string, { readonly min: string; readonly max: string }>>;
}

export const DEFAULT_FX_POLICY: FxPolicy = Object.freeze({
  confirmPercent: FX_CONFIRM_PERCENT,
  ranges: Object.freeze({ BD: Object.freeze({ min: "50", max: "500" }) }),
});

// How long a large FX change waits for the second admin.
export const FX_PENDING_HOURS = 24;

export interface PricingFlowDeps {
  // The admin repositories of the actor in this transaction (adminRepos), for the pending FX change.
  readonly repos: (
    tx: Tx,
    actor: AdminActor,
  ) => Pick<
    AdminRepos,
    "fxChanges" | "priceBook" | "blueprints" | "configPrices" | "tierLimits" | "invoiceSeller"
  >;
  // requireAdmin(roles): rejects when there is no admin session or the role is wrong.
  readonly authorize: (roles: readonly AdminRole[]) => Promise<AdminActor>;
  // True when the hit was counted, false over the limit.
  readonly limiter: (actor: AdminActor, now: Date) => Promise<boolean>;
  // One transaction as admin_rw.
  readonly run: <T>(actor: AdminActor, fn: (tx: Tx) => Promise<T>) => Promise<T>;
  readonly clock: { now(): Date };
  readonly core: CorePorts;
  // Sanity checks of a typed rate; DEFAULT_FX_POLICY when absent.
  readonly fxPolicy?: FxPolicy;
  // TC_STAGE. Anything that is not exactly "local", "test" or "staging" is production (R16).
  readonly stage: string;
}

export type FlowCode =
  | "invalid"
  | "denied"
  | "conflict"
  | "not_found"
  | "rate_limited"
  | "unavailable"
  | "confirm_required"
  | "second_admin_required"
  | "must_differ_from_actor"
  | "not_an_approver";

export type FlowAnswer<T> =
  | { readonly ok: true; readonly replayed: boolean; readonly value: T }
  | { readonly ok: false; readonly code: FlowCode; readonly fields: readonly string[] };

export interface SaveRuleRequest {
  readonly market: unknown;
  // null or "" is the rule of the whole market.
  readonly family: unknown;
  readonly steps: unknown;
  // Dhaka wall time "YYYY-MM-DDTHH:mm" or "" for now.
  readonly from: unknown;
  readonly reason: unknown;
}

export interface SetFxRequest {
  readonly market: unknown;
  readonly rate: unknown;
  readonly from: unknown;
  readonly reason: unknown;
  // The extra confirm of a change of more than the policy percent (true, "true", "on" or "1").
  readonly confirmLarge?: unknown;
  // There is deliberately no field for a second admin: an approver is never named by a request. A change of more
  // than 3 percent (WPU-X9; the first rate of a market excepted) waits until a different admin approves it from their
  // own session (approveFx), WPU-Y1.
}

export interface ApproveFxRequest {
  readonly market: unknown;
  readonly reason: unknown;
  // The approver's own extra confirm of a large change.
  readonly confirmLarge?: unknown;
}

const isConfirmed = (v: unknown): boolean => v === true || v === "true" || v === "on" || v === "1";

export interface FxResult {
  // "set": the rate is stored by this admin alone (WPU-X9). "pending": it waits for a different admin.
  // "approved": a different admin approved it and the rate is stored.
  readonly kind: "set" | "pending" | "approved";
  readonly rate: string;
  readonly effectiveFrom: Date | null;
}

export interface SetFlagRequest {
  readonly key: unknown;
  readonly market: unknown;
  readonly enabled: unknown;
  readonly reason: unknown;
}

export interface SetImageRequest {
  readonly blueprintId: unknown;
  readonly market: unknown;
  readonly enabled: unknown;
  readonly reason: unknown;
}

// WPU-G10. The admin's minimum bundle power for one image, typed as digits; "" removes the override.
export interface SetImageMinPowerRequest {
  readonly blueprintId: unknown;
  readonly market: unknown;
  readonly minPower: unknown;
  readonly reason: unknown;
}

const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_.[\]]{0,39}$/;
const SECOND_ADMIN_TOKENS: readonly FlowCode[] = [
  "second_admin_required",
  "must_differ_from_actor",
  "not_an_approver",
];

export const fail = (code: FlowCode, fields: readonly string[] = []): FlowAnswer<never> => ({
  ok: false,
  code,
  fields,
});

export interface Reason {
  readonly ok: boolean;
  readonly text: string;
}

export function readReason(value: unknown): Reason {
  if (typeof value !== "string") return { ok: false, text: "" };
  const text = value.trim();
  return { ok: text !== "" && text.length <= MAX_REASON, text };
}

// What the core engines answered, as a fixed code and the names of the fields they refused.
export function refusal(result: {
  error: string;
  fields?: Record<string, string> | undefined;
}): FlowAnswer<never> {
  const names = Object.keys(result.fields ?? {}).filter((n) => FIELD_NAME.test(n));
  switch (result.error) {
    case "validation":
      return fail("invalid", names);
    case "conflict":
      return fail("conflict");
    case "not_found":
      return fail("not_found");
    case "forbidden": {
      const token = result.fields?.["requestedBy"];
      const known = SECOND_ADMIN_TOKENS.find((t) => t === token);
      return known === undefined ? fail("denied") : fail(known);
    }
    default:
      return fail("unavailable");
  }
}

class Rollback extends Error {
  constructor(readonly answer: FlowAnswer<never>) {
    super("rolled back");
  }
}

// What a repository refused, as a fixed code.
export function repoRefusal(error: string): FlowAnswer<never> {
  switch (error) {
    case "forbidden":
      return fail("denied");
    case "validation":
      return fail("invalid");
    case "conflict":
      return fail("conflict");
    case "not_found":
      return fail("not_found");
    default:
      return fail("unavailable");
  }
}

export type Authorized = { ok: true; actor: AdminActor } | { ok: false; answer: FlowAnswer<never> };

export interface PricingFlow {
  saveRule(request: SaveRuleRequest): Promise<FlowAnswer<{ ruleId: string; effectiveFrom: Date }>>;
  setFx(request: SetFxRequest): Promise<FlowAnswer<FxResult>>;
  approveFx(request: ApproveFxRequest): Promise<FlowAnswer<FxResult>>;
  setFlag(request: SetFlagRequest): Promise<FlowAnswer<{ key: string; enabled: boolean }>>;
  // WPU-G3: the image allow-list of the Linux create wizard (ops and superadmin, as the flags).
  setImage(
    request: SetImageRequest,
  ): Promise<FlowAnswer<{ blueprintId: string; enabled: boolean }>>;
  // WPU-G10: the minimum plan power of an image (replaces what AWS reported).
  setImageMinPower(
    request: SetImageMinPowerRequest,
  ): Promise<FlowAnswer<{ blueprintId: string; minPower: number | null }>>;
}

export function makePricingFlow(deps: PricingFlowDeps): PricingFlow {
  const policy = deps.fxPolicy ?? DEFAULT_FX_POLICY;
  // 1 and 2. Authenticate and authorize: the dependency and then a second look at the role it returned.
  const authorize = async (roles: readonly AdminRole[]): Promise<Authorized> => {
    try {
      const actor = await deps.authorize(roles);
      if (!roles.includes(actor.role)) return { ok: false, answer: fail("denied") };
      return { ok: true, actor };
    } catch {
      return { ok: false, answer: fail("denied") };
    }
  };

  // 4 and 5. Rate limit, then execute in one transaction. Any error is a refusal (R16).
  const execute = async <T>(
    actor: AdminActor,
    work: (tx: Tx, at: Date) => Promise<FlowAnswer<T>>,
  ): Promise<FlowAnswer<T>> => {
    try {
      const at = deps.clock.now();
      if (!(await deps.limiter(actor, at))) return fail("rate_limited");
      return await deps.run(actor, (tx) => work(tx, at));
    } catch (error) {
      // A refusal after a write has to roll the transaction back: it is thrown with its answer.
      if (error instanceof Rollback) return error.answer;
      return fail("unavailable");
    }
  };

  return {
    async saveRule(request) {
      // Read once into locals, so a getter cannot answer differently on the second read.
      const { market, family, steps, from, reason } = request;
      const auth = await authorize(PRICING_ROLES);
      if (!auth.ok) return auth.answer;
      // 3. Validate.
      const bad: string[] = [];
      if (!isMarket(market)) bad.push("market");
      let productFamily: string | null = null;
      if (family !== null && family !== undefined && family !== "") {
        if (typeof family !== "string" || !isFeatureFlag(family)) {
          bad.push("family");
        } else productFamily = family;
      }
      const stepList = readSteps(steps);
      if (stepList === null) bad.push("steps");
      const start = typeof from === "string" ? startOf(from) : null;
      if (start === null) bad.push("from");
      const why = readReason(reason);
      if (!why.ok) bad.push("reason");
      if (bad.length > 0 || stepList === null || typeof market !== "string") {
        return fail("invalid", bad);
      }
      const actor = auth.actor;
      return execute<{ ruleId: string; effectiveFrom: Date }>(actor, async (tx, at) => {
        const once = { now: () => at };
        // The preview of this very draft runs in the same transaction; a draft the preview refuses is
        // not saved (R16). The screen shows the same preview before it offers the save.
        const shown = await deps.core.previewChange(
          tx,
          { market, productFamily, steps: stepList },
          once,
        );
        if (!shown.ok) return refusal(shown);
        const saved = await deps.core.savePricingRule(
          tx,
          actor,
          {
            market,
            productFamily,
            steps: stepList,
            ...(start === undefined || start === null ? {} : { effectiveFrom: start }),
            reason: why.text,
          },
          once,
        );
        if (!saved.ok) return refusal(saved);
        return {
          ok: true,
          replayed: saved.value.replayed,
          value: { ruleId: saved.value.ruleId, effectiveFrom: saved.value.effectiveFrom },
        };
      });
    },

    async setFx(request) {
      // Only these five are read; any other field of the request (a forged approver, say) is ignored.
      const { market, rate, from, reason, confirmLarge } = request;
      const auth = await authorize(PRICING_ROLES);
      if (!auth.ok) return auth.answer;
      const bad: string[] = [];
      if (!isMarket(market)) bad.push("market");
      // The engine's own test of a storable rate (plain decimal text, never a number).
      if (typeof rate !== "string" || !isFxRateText(rate.trim())) bad.push("rate");
      else if (typeof market === "string") {
        const range = policy.ranges[market];
        if (range !== undefined && !fxRateInSaneRange(rate.trim(), range)) bad.push("rate");
      }
      const start = typeof from === "string" ? startOf(from) : null;
      if (start === null) bad.push("from");
      const why = readReason(reason);
      if (!why.ok) bad.push("reason");
      if (bad.length > 0 || typeof market !== "string" || typeof rate !== "string") {
        return fail("invalid", bad);
      }
      const actor = auth.actor;
      const next = rate.trim();
      const effectiveFrom = start === undefined || start === null ? null : start;
      const confirmed = isConfirmed(confirmLarge);
      return execute<FxResult>(actor, async (tx, at) => {
        const current = await deps.core.fxInForce(tx, market, at);
        if (
          current !== null &&
          fxChangeNeedsConfirm(current.rate, next, policy.confirmPercent) &&
          !confirmed
        ) {
          // Nothing is written: the screen shows the change and asks again with the confirm field.
          return fail("confirm_required", ["confirmLarge"]);
        }
        // WPU-X9 (owner decision 2026-11-14, "alone, within ±3%"): the first rate of a market, and a change of at
        // most 3 percent from the rate in force, apply at once with this admin alone. The engine decides, under the
        // write lock of the market, and records the ground in the audit row (R10). A start that has passed is now.
        const own = effectiveFrom !== null && effectiveFrom.getTime() > at.getTime();
        const alone = await deps.core.setFxRate(
          tx,
          actor,
          { market, rate: next, ...(own ? { effectiveFrom } : {}), reason: why.text },
          { now: () => at },
        );
        if (alone.ok) {
          return {
            ok: true,
            replayed: alone.value.replayed,
            value: {
              kind: "set",
              rate: alone.value.fx.rate,
              effectiveFrom: alone.value.fx.effectiveFrom,
            },
          };
        }
        if (
          alone.error !== "forbidden" ||
          alone.fields?.["requestedBy"] !== "second_admin_required"
        ) {
          // The form names its start "from"; any other refusal is answered as it is (R16).
          const answer = refusal(alone);
          return answer.ok || answer.code !== "invalid"
            ? answer
            : fail(
                "invalid",
                answer.fields.map((f) => (f === "effectiveFrom" ? "from" : f)),
              );
        }
        // A larger change (WPU-Y1): a pending change. Nothing changes now; a different admin approves it from their
        // own session (approveFx), R10.
        const asked = await deps.repos(tx, actor).fxChanges.request(
          {
            market,
            rate: next,
            effectiveFrom,
            at,
            expiresAt: new Date(at.getTime() + FX_PENDING_HOURS * 3_600_000),
          },
          why.text,
        );
        if (!asked.ok) return repoRefusal(asked.error);
        return {
          ok: true,
          replayed: asked.replayed,
          value: { kind: "pending", rate: asked.value.rate, effectiveFrom },
        };
      });
    },

    async approveFx(request) {
      const { market, reason, confirmLarge } = request;
      const auth = await authorize(PRICING_ROLES);
      if (!auth.ok) return auth.answer;
      const bad: string[] = [];
      if (!isMarket(market)) bad.push("market");
      const why = readReason(reason);
      if (!why.ok) bad.push("reason");
      if (bad.length > 0 || typeof market !== "string") return fail("invalid", bad);
      // The approver is the actor of the verified session; the request cannot name anyone.
      const actor = auth.actor;
      const confirmed = isConfirmed(confirmLarge);
      return execute<FxResult>(actor, async (tx, at) => {
        // The approver sees the same sanity check as the requester: a large change needs their own confirm.
        const waiting = await deps.repos(tx, actor).fxChanges.read(market);
        if (waiting !== null && waiting !== undefined && waiting.status === "pending") {
          const current = await deps.core.fxInForce(tx, market, at);
          if (
            current !== null &&
            fxChangeNeedsConfirm(current.rate, waiting.rate, policy.confirmPercent) &&
            !confirmed
          ) {
            return fail("confirm_required", ["confirmLarge"]);
          }
        }
        const decided = await deps.repos(tx, actor).fxChanges.approve({ market, at }, why.text);
        if (!decided.ok) return repoRefusal(decided.error);
        const change = decided.value;
        if (decided.replayed) {
          return {
            ok: true,
            replayed: true,
            value: { kind: "approved", rate: change.rate, effectiveFrom: change.effectiveFrom },
          };
        }
        // Only now does the rate change. The requester is read from the stored change, never from the
        // request. A start that has passed in the meantime becomes "now".
        const start =
          change.effectiveFrom !== null && change.effectiveFrom.getTime() > at.getTime()
            ? { effectiveFrom: change.effectiveFrom }
            : {};
        const saved = await deps.core.setFxRate(
          tx,
          actor,
          {
            market,
            rate: change.rate,
            ...start,
            reason: change.reason,
            requestedBy: change.requestedBy,
          },
          { now: () => at },
        );
        // The approval and the rate are one transaction: a refusal undoes the approval too.
        if (!saved.ok) throw new Rollback(refusal(saved));
        return {
          ok: true,
          replayed: false,
          value: {
            kind: "approved",
            rate: saved.value.fx.rate,
            effectiveFrom: saved.value.fx.effectiveFrom,
          },
        };
      });
    },

    async setFlag(request) {
      const { key, market, enabled, reason } = request;
      const auth = await authorize(FLAG_ROLES);
      if (!auth.ok) return auth.answer;
      const bad: string[] = [];
      if (typeof key !== "string" || !isFeatureFlag(key)) {
        bad.push("key");
      }
      if (!isMarket(market)) bad.push("market");
      if (typeof enabled !== "boolean") bad.push("enabled");
      const why = readReason(reason);
      if (!why.ok) bad.push("reason");
      const production = !["local", "test", "staging"].includes(deps.stage);
      if (why.ok && production && enabled === true && why.text.length < PRODUCTION_REASON_MIN) {
        bad.push("reason");
      }
      if (
        bad.length > 0 ||
        typeof key !== "string" ||
        typeof market !== "string" ||
        typeof enabled !== "boolean"
      ) {
        return fail("invalid", bad);
      }
      const actor = auth.actor;
      return execute<{ key: string; enabled: boolean }>(actor, async (tx) => {
        const saved = await deps.core.setFeatureFlag(tx, actor, {
          key,
          market,
          enabled,
          reason: why.text,
        });
        if (!saved.ok) return refusal(saved);
        return {
          ok: true,
          replayed: saved.value.replayed,
          value: { key: saved.value.key, enabled: saved.value.enabled },
        };
      });
    },

    async setImage(request) {
      const { blueprintId, market, enabled, reason } = request;
      const auth = await authorize(FLAG_ROLES);
      if (!auth.ok) return auth.answer;
      const bad: string[] = [];
      if (!isBlueprintId(blueprintId)) {
        bad.push("blueprintId");
      }
      if (!isMarket(market)) bad.push("market");
      if (typeof enabled !== "boolean") bad.push("enabled");
      const why = readReason(reason);
      if (!why.ok) bad.push("reason");
      if (
        bad.length > 0 ||
        typeof blueprintId !== "string" ||
        typeof market !== "string" ||
        typeof enabled !== "boolean"
      ) {
        return fail("invalid", bad);
      }
      const actor = auth.actor;
      return execute<{ blueprintId: string; enabled: boolean }>(actor, async (tx) => {
        const saved = await deps
          .repos(tx, actor)
          .blueprints.setEnabled({ market, blueprintId, enabled }, why.text);
        if (!saved.ok) return repoRefusal(saved.error);
        return {
          ok: true,
          replayed: saved.replayed,
          value: { blueprintId: saved.value.blueprintId, enabled: saved.value.enabled },
        };
      });
    },

    async setImageMinPower(request) {
      const { blueprintId, market, minPower, reason } = request;
      const auth = await authorize(FLAG_ROLES);
      if (!auth.ok) return auth.answer;
      const bad: string[] = [];
      if (!isBlueprintId(blueprintId)) {
        bad.push("blueprintId");
      }
      if (!isMarket(market)) bad.push("market");
      // Plain digits only (a sign, a point, an exponent or a unit is refused); "" removes the override.
      const typed = typeof minPower === "string" ? minPower.trim() : null;
      const power =
        typed === ""
          ? null
          : typed !== null && /^[0-9]{1,6}$/.test(typed) && Number(typed) <= IMAGE_MIN_POWER_MAX
            ? Number(typed)
            : undefined;
      if (power === undefined) bad.push("minPower");
      const why = readReason(reason);
      if (!why.ok) bad.push("reason");
      if (
        bad.length > 0 ||
        typeof blueprintId !== "string" ||
        typeof market !== "string" ||
        power === undefined
      ) {
        return fail("invalid", bad);
      }
      const actor = auth.actor;
      return execute<{ blueprintId: string; minPower: number | null }>(actor, async (tx) => {
        const saved = await deps
          .repos(tx, actor)
          .blueprints.setMinPower({ market, blueprintId, minPower: power }, why.text);
        if (!saved.ok) return repoRefusal(saved.error);
        return {
          ok: true,
          replayed: saved.replayed,
          value: { blueprintId: saved.value.blueprintId, minPower: saved.value.minPower },
        };
      });
    },
  };
}

interface EngineStep {
  code: string;
  rate: string;
  base: "aws" | "subtotal";
  label: { bn: string; en: string };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// The steps of a request as the engine takes them, or null when the shape is wrong. Whether the codes,
// the rates and the labels are acceptable is the engine's call (validateRule through previewChange).
function readSteps(value: unknown): EngineStep[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_DRAFT_STEPS) return null;
  const out: EngineStep[] = [];
  for (const entry of value as unknown[]) {
    if (!isRecord(entry)) return null;
    const { code, rate, base, bn, en } = entry;
    if (typeof code !== "string" || code.length > 40) return null;
    if (typeof rate !== "string" || rate.length > 20) return null;
    if (base !== "aws" && base !== "subtotal") return null;
    if (typeof bn !== "string" || bn.length > 80 || typeof en !== "string" || en.length > 80) {
      return null;
    }
    out.push({ code, rate, base, label: { bn, en } });
  }
  return out;
}
