import type {
  previewChange as PreviewChange,
  savePricingRule as SavePricingRule,
  setFeatureFlag as SetFeatureFlag,
  setFxRate as SetFxRate,
} from "@tc/core";
import { isFeatureFlag, isFxRateText } from "@tc/core";
import type { AdminActor, AdminRole, Tx } from "@tc/db";
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
  readonly savePricingRule: typeof SavePricingRule;
  readonly setFxRate: typeof SetFxRate;
  readonly setFeatureFlag: typeof SetFeatureFlag;
}

export interface PricingFlowDeps {
  // requireAdmin(roles): rejects when there is no admin session or the role is wrong.
  readonly authorize: (roles: readonly AdminRole[]) => Promise<AdminActor>;
  // True when the hit was counted, false over the limit.
  readonly limiter: (actor: AdminActor, now: Date) => Promise<boolean>;
  // One transaction as admin_rw.
  readonly run: <T>(actor: AdminActor, fn: (tx: Tx) => Promise<T>) => Promise<T>;
  readonly clock: { now(): Date };
  readonly core: CorePorts;
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
  // The id of the second admin ("" when none).
  readonly requestedBy: unknown;
}

export interface SetFlagRequest {
  readonly key: unknown;
  readonly market: unknown;
  readonly enabled: unknown;
  readonly reason: unknown;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MARKET = /^[A-Z]{2}$/;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_.[\]]{0,39}$/;
const SECOND_ADMIN_TOKENS: readonly FlowCode[] = [
  "second_admin_required",
  "must_differ_from_actor",
  "not_an_approver",
];

const fail = (code: FlowCode, fields: readonly string[] = []): FlowAnswer<never> => ({
  ok: false,
  code,
  fields,
});

interface Reason {
  readonly ok: boolean;
  readonly text: string;
}

function readReason(value: unknown): Reason {
  if (typeof value !== "string") return { ok: false, text: "" };
  const text = value.trim();
  return { ok: text !== "" && text.length <= MAX_REASON, text };
}

// What the core engines answered, as a fixed code and the names of the fields they refused.
function refusal(result: {
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

type Authorized = { ok: true; actor: AdminActor } | { ok: false; answer: FlowAnswer<never> };

export interface PricingFlow {
  saveRule(request: SaveRuleRequest): Promise<FlowAnswer<{ ruleId: string; effectiveFrom: Date }>>;
  setFx(request: SetFxRequest): Promise<FlowAnswer<{ rate: string; effectiveFrom: Date }>>;
  setFlag(request: SetFlagRequest): Promise<FlowAnswer<{ key: string; enabled: boolean }>>;
}

export function makePricingFlow(deps: PricingFlowDeps): PricingFlow {
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
    } catch {
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
      if (typeof market !== "string" || !MARKET.test(market)) bad.push("market");
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
      return execute(actor, async (tx, at) => {
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
      const { market, rate, from, reason, requestedBy } = request;
      const auth = await authorize(PRICING_ROLES);
      if (!auth.ok) return auth.answer;
      const bad: string[] = [];
      if (typeof market !== "string" || !MARKET.test(market)) bad.push("market");
      // The engine's own test of a storable rate (plain decimal text, never a number).
      if (typeof rate !== "string" || !isFxRateText(rate.trim())) bad.push("rate");
      const start = typeof from === "string" ? startOf(from) : null;
      if (start === null) bad.push("from");
      const why = readReason(reason);
      if (!why.ok) bad.push("reason");
      let second: string | undefined;
      if (requestedBy !== undefined && requestedBy !== null && requestedBy !== "") {
        if (typeof requestedBy !== "string" || !UUID.test(requestedBy.trim())) {
          bad.push("requestedBy");
        } else second = requestedBy.trim();
      }
      if (bad.length > 0 || typeof market !== "string" || typeof rate !== "string") {
        return fail("invalid", bad);
      }
      const actor = auth.actor;
      return execute(actor, async (tx, at) => {
        const saved = await deps.core.setFxRate(
          tx,
          actor,
          {
            market,
            rate: rate.trim(),
            ...(start === undefined || start === null ? {} : { effectiveFrom: start }),
            reason: why.text,
            ...(second === undefined ? {} : { requestedBy: second }),
          },
          { now: () => at },
        );
        if (!saved.ok) return refusal(saved);
        return {
          ok: true,
          replayed: saved.value.replayed,
          value: { rate: saved.value.fx.rate, effectiveFrom: saved.value.fx.effectiveFrom },
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
      if (typeof market !== "string" || !MARKET.test(market)) bad.push("market");
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
      return execute(actor, async (tx) => {
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
