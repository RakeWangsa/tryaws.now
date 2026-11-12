"use server";

import { guardAction, serverOpsActionDeps } from "../../../../../server/action-deps.ts";
import { pick } from "../../../../../server/action-state.ts";
import type { FormState } from "../../../../../server/action-state.ts";
import {
  addFirewallRuleCore,
  attachStaticIpCore,
  detachStaticIpCore,
  rebootServerCore,
  removeFirewallRuleCore,
  renameServerCore,
  startServerCore,
  stopServerCore,
} from "../../../../../server/server-actions.ts";
import type { ServerOpsDeps, ServerOpsResult } from "../../../../../server/server-actions.ts";

// The thin Server Actions of a server's header and Networking tab (16.10, WPU-G2). Each one checks
// the origin, calls its core (which follows R9) and turns the result into a FormState with a fixed
// key (U6). Nothing here knows AWS (R1).

function stateOf(result: ServerOpsResult): FormState {
  if (!result.ok) {
    return { error: result.error, ...(result.fields ? { fields: result.fields } : {}) };
  }
  return { done: result.done };
}

type Core = (deps: ServerOpsDeps, raw: unknown) => Promise<ServerOpsResult>;

const run =
  (core: Core, names: readonly string[]) =>
  async (_previous: FormState, form: FormData): Promise<FormState> => {
    if (!(await guardAction())) return { error: "unauthenticated" };
    return stateOf(await core(serverOpsActionDeps(), pick(form, names)));
  };

const SERVER = ["serverId", "requestId"] as const;

export const rebootServerAction = run(rebootServerCore, SERVER);
export const stopServerAction = run(stopServerCore, SERVER);
export const startServerAction = run(startServerCore, SERVER);
export const renameServerAction = run(renameServerCore, [...SERVER, "displayName"]);
export const addFirewallRuleAction = run(addFirewallRuleCore, [
  ...SERVER,
  "preset",
  "protocol",
  "fromPort",
  "toPort",
  "sourceMode",
  "sources",
]);
export const removeFirewallRuleAction = run(removeFirewallRuleCore, [...SERVER, "ruleKey"]);
export const attachStaticIpAction = run(attachStaticIpCore, SERVER);
export const detachStaticIpAction = run(detachStaticIpCore, [...SERVER, "acknowledge"]);
