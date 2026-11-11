"use server";

import { guardAction } from "../../../../../server/action-deps.ts";
import { pick } from "../../../../../server/action-state.ts";
import type { FormState } from "../../../../../server/action-state.ts";
import type { FamilyResult } from "../../../../../server/family-actions.ts";
import { familyActionDeps } from "../../../../../server/family-deps.ts";
import {
  destroyLoadBalancerCore,
  setLoadBalancerTargetsCore,
} from "../../../../../server/load-balancers-actions.ts";

// The thin Server Actions of the load balancer page (16.10). Each one checks the origin, calls its
// core (which follows R9) and turns the result into a FormState with a fixed key (U6).

function stateOf(result: FamilyResult): FormState {
  if (!result.ok) {
    return { error: result.error, ...(result.fields ? { fields: result.fields } : {}) };
  }
  return { done: result.approval === true ? `${result.done}:approval` : result.done };
}

export async function destroyLoadBalancerAction(
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  if (!(await guardAction())) return { error: "unauthenticated" };
  return stateOf(
    await destroyLoadBalancerCore(
      familyActionDeps("load_balancer"),
      pick(form, ["loadBalancerId", "requestId", "confirmName"]),
    ),
  );
}

// `setTargets` (16.10). The core re-checks every target through the scoped repository (R8). The change
// itself is an operation kind that does not exist yet (the adapter has no action for it), so `changeTargets`
// is null and the core refuses after the checks (R16). The page does not offer the form until it is
// wired (JOURNEY.md, Needs decision).
export async function setLoadBalancerTargetsAction(
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  if (!(await guardAction())) return { error: "unauthenticated" };
  const targetIds = form.getAll("targetIds").filter((v): v is string => typeof v === "string");
  return stateOf(
    await setLoadBalancerTargetsCore(
      { ...familyActionDeps("load_balancer"), changeTargets: null },
      { ...pick(form, ["loadBalancerId", "requestId"]), targetIds: targetIds.slice(0, 64) },
    ),
  );
}
