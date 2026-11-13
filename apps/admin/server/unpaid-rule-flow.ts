import { UNPAID_SETTING_KEY } from "@tc/core";
import type { AdminActor, AdminRole } from "@tc/db";
import { failureCode, type CaseActionCode, type CaseFlowDeps } from "./case-flow-common.ts";
import { check, unpaidRuleSwitch } from "./schemas.ts";

// The action of /operations/unpaid-rule (WPU-Z4): the switch of the daily unpaid-usage job of a market
// (settings `lifecycle_unpaid_enabled`). In the order of R9: authenticate and authorize (turning on:
// superadmin; turning off: ops or superadmin, the safe direction, R16), validate with the zod schema of
// schemas.ts (a reason; turning on also needs the confirm box), rate limit, execute in one transaction (the
// repository write stores actor, reason, IP, target and the before and after values through `audited`, R10),
// and a fixed answer. The admin is the one of the verified session: the request has no field for one, nor for
// the key. No next/* import: the Server Action wires the real pieces and every step is tested with fakes.

// Who reads the page, who turns the rule on and who turns it off. The repository checks the same again.
export const UNPAID_RULE_READ_ROLES: readonly AdminRole[] = [
  "support",
  "finance",
  "ops",
  "superadmin",
];
export const UNPAID_RULE_ON_ROLES: readonly AdminRole[] = ["superadmin"];
export const UNPAID_RULE_OFF_ROLES: readonly AdminRole[] = ["ops", "superadmin"];

export type UnpaidRuleFlowDeps = CaseFlowDeps;

export interface UnpaidRuleRequest {
  readonly market: unknown;
  /** "on" or "off". */
  readonly state: unknown;
  /** The confirm checkbox: "on" when it is ticked. Turning the rule on needs it. */
  readonly confirm: unknown;
  readonly reason: unknown;
}

export type UnpaidRuleAnswer =
  | {
      readonly ok: true;
      readonly replayed: boolean;
      readonly market: string;
      readonly enabled: boolean;
    }
  | { readonly ok: false; readonly code: CaseActionCode };

export function makeUnpaidRuleAction(
  deps: UnpaidRuleFlowDeps,
): (request: UnpaidRuleRequest) => Promise<UnpaidRuleAnswer> {
  return async (request) => {
    // Read once into locals, so a getter cannot answer differently on the second read.
    const { market, state, confirm, reason } = request;
    // 1 and 2. Authenticate and authorize. Anything that is not exactly "off" asks for the roles of turning
    // on (R16); the role the guard returns is looked at a second time.
    const roles = state === "off" ? UNPAID_RULE_OFF_ROLES : UNPAID_RULE_ON_ROLES;
    let actor: AdminActor;
    try {
      actor = await deps.authorize(roles);
    } catch {
      return { ok: false, code: "denied" };
    }
    if (!roles.includes(actor.role)) return { ok: false, code: "denied" };
    try {
      // 3. Validate.
      const valid = check(unpaidRuleSwitch, { market, state, confirm, reason });
      if (valid === null) return { ok: false, code: "invalid" };
      // 4. Rate limit.
      if (!(await deps.limiter(actor, deps.clock.now()))) {
        return { ok: false, code: "rate_limited" };
      }
      // 5 and 6. Execute and audit, in one transaction.
      const written = await deps.run(actor, (repos) =>
        repos.settings.setBoolean(
          { key: UNPAID_SETTING_KEY, market: valid.market },
          valid.enabled,
          valid.reason,
        ),
      );
      if (!written.ok) return { ok: false, code: failureCode(written) };
      return {
        ok: true,
        replayed: written.replayed,
        market: written.value.market,
        enabled: written.value.enabled,
      };
    } catch {
      // Fail closed (R16): a database or limiter error is not a success and tells nothing.
      return { ok: false, code: "unavailable" };
    }
  };
}
