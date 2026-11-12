"use server";

import { guardAction } from "../../../../../server/action-deps.ts";
import { pick } from "../../../../../server/action-state.ts";
import type { FormState } from "../../../../../server/action-state.ts";
import type { FamilyResult } from "../../../../../server/family-actions.ts";
import { familyActionDeps } from "../../../../../server/family-deps.ts";
import {
  LB_ATTRIBUTES,
  LB_REFRESH_CERTIFICATE,
  LB_REQUEST_CERTIFICATE,
  consoleCore,
} from "../../../../../server/console-actions.ts";
import {
  destroyLoadBalancerCore,
  queueTargets,
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

// `setTargets` (16.10). The core re-checks every target through the scoped repository (R8), then
// `queueTargets` writes one set_targets operation (WPU-G7).
export async function setLoadBalancerTargetsAction(
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  if (!(await guardAction())) return { error: "unauthenticated" };
  const targetIds = form.getAll("targetIds").filter((v): v is string => typeof v === "string");
  return stateOf(
    await setLoadBalancerTargetsCore(
      { ...familyActionDeps("load_balancer"), changeTargets: queueTargets },
      { ...pick(form, ["loadBalancerId", "requestId"]), targetIds: targetIds.slice(0, 64) },
    ),
  );
}

// WPU-G7: health check path and HTTPS redirect, certificate request and refresh.
const consoleAction =
  (core: ReturnType<typeof consoleCore>, names: readonly string[]) =>
  async (_previous: FormState, form: FormData): Promise<FormState> => {
    if (!(await guardAction())) return { error: "unauthenticated" };
    return stateOf(await core(familyActionDeps("load_balancer"), pick(form, names)));
  };

export const setLoadBalancerAttributesAction = consoleAction(consoleCore(LB_ATTRIBUTES), [
  "loadBalancerId",
  "requestId",
  "healthCheckPath",
  "httpsRedirect",
]);
export const requestCertificateAction = consoleAction(consoleCore(LB_REQUEST_CERTIFICATE), [
  "loadBalancerId",
  "requestId",
  "domain",
]);
export const refreshCertificateAction = consoleAction(consoleCore(LB_REFRESH_CERTIFICATE), [
  "loadBalancerId",
  "requestId",
]);
