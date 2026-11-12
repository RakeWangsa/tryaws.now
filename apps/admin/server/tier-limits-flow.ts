import {
  TIER_LIMIT_MAX_COUNT,
  isRiskTierName,
  type AdminActor,
  type AdminRole,
  type RiskTierName,
  type Tx,
} from "@tc/db";
import {
  FLAG_ROLES,
  fail,
  readReason,
  repoRefusal,
  type Authorized,
  type FlowAnswer,
  type PricingFlowDeps,
} from "./pricing-flow.ts";

// The action of /catalog/limits (WPU-G10): the limits of a risk tier for a market. In the order of R9:
// authenticate and authorize (ops and superadmin, the roles of the catalog area), validate, rate limit,
// execute in one transaction (the repository write stores actor, reason, IP and target through `audited`,
// R10), and a fixed answer. No next/* import. Answers are fixed codes and the NAMES of fields (R14, R16).
// A lower limit does not touch what a customer already has; it stops new orders past the limit.

const MARKET = /^[A-Z]{2}$/;
const COUNT = new RegExp(`^[0-9]{1,${String(TIER_LIMIT_MAX_COUNT).length}}$`);
const BUNDLE_USD = /^(0|[1-9]\d{0,5})(\.\d{1,4})?$/;

export interface SaveTierLimitsRequest {
  readonly market: unknown;
  readonly tier: unknown;
  // Digits.
  readonly maxInstances: unknown;
  // Plain decimal text, USD for one month of the dearest bundle.
  readonly maxBundleUsd: unknown;
  // A checkbox: "on" or "" (absent).
  readonly windows: unknown;
  readonly containers: unknown;
  readonly maxStaticIps: unknown;
  readonly reason: unknown;
}

export interface TierLimitsFlow {
  saveTierLimits(
    request: SaveTierLimitsRequest,
  ): Promise<FlowAnswer<{ market: string; tier: RiskTierName }>>;
}

const count = (value: unknown, min: number): number | null => {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!COUNT.test(text)) return null;
  const n = Number(text);
  return n >= min && n <= TIER_LIMIT_MAX_COUNT ? n : null;
};

const checkbox = (value: unknown): boolean | null =>
  value === "on" ? true : value === "" || value === undefined || value === null ? false : null;

export function makeTierLimitsFlow(deps: PricingFlowDeps): TierLimitsFlow {
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
    work: (tx: Tx) => Promise<FlowAnswer<T>>,
  ): Promise<FlowAnswer<T>> => {
    try {
      if (!(await deps.limiter(actor, deps.clock.now()))) return fail("rate_limited");
      return await deps.run(actor, work);
    } catch {
      return fail("unavailable");
    }
  };

  return {
    async saveTierLimits(request) {
      // Read once into locals, so a getter cannot answer differently on the second read.
      const {
        market,
        tier,
        maxInstances,
        maxBundleUsd,
        windows,
        containers,
        maxStaticIps,
        reason,
      } = request;
      const auth = await authorize(FLAG_ROLES);
      if (!auth.ok) return auth.answer;
      // 3. Validate.
      const bad: string[] = [];
      if (typeof market !== "string" || !MARKET.test(market)) bad.push("market");
      if (!isRiskTierName(tier)) bad.push("tier");
      const instances = count(maxInstances, 1);
      if (instances === null) bad.push("maxInstances");
      const bundle = typeof maxBundleUsd === "string" ? maxBundleUsd.trim() : "";
      if (!BUNDLE_USD.test(bundle) || !/[1-9]/.test(bundle)) bad.push("maxBundleUsd");
      const win = checkbox(windows);
      if (win === null) bad.push("windows");
      const con = checkbox(containers);
      if (con === null) bad.push("containers");
      const statics = count(maxStaticIps, 0);
      if (statics === null) bad.push("maxStaticIps");
      const why = readReason(reason);
      if (!why.ok) bad.push("reason");
      if (
        bad.length > 0 ||
        typeof market !== "string" ||
        !isRiskTierName(tier) ||
        instances === null ||
        win === null ||
        con === null ||
        statics === null
      ) {
        return fail("invalid", bad);
      }
      const actor = auth.actor;
      return execute<{ market: string; tier: RiskTierName }>(actor, async (tx) => {
        const saved = await deps.repos(tx, actor).tierLimits.save(
          {
            market,
            tier,
            limits: {
              maxInstances: instances,
              maxBundleUsd: bundle,
              windows: win,
              containers: con,
              maxStaticIps: statics,
            },
          },
          why.text,
        );
        if (!saved.ok) return repoRefusal(saved.error);
        return {
          ok: true,
          replayed: saved.replayed,
          value: { market: saved.value.market, tier: saved.value.tier },
        };
      });
    },
  };
}
